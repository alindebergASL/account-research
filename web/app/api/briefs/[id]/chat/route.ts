import { BRIEF_CHAT_MODEL } from "@/lib/models";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { db, type BriefChatRow, type BriefRow } from "@/lib/db";
import {
  HttpError,
  canCollaborateBrief,
  canReadBrief,
  canWriteBrief,
  findUserById,
  publicUser,
  requireUser,
} from "@/lib/auth";
import { Brief, type Brief as BriefT } from "@/lib/schema";
import { applyPatches, type BriefPatch } from "@/lib/briefPatches";
import { createBriefEventStrict } from "@/lib/briefEvents";
import { runChatViaHermes, selectChatPath } from "@/lib/hermes/chatAdapter";
import { friendlyAnthropicError } from "@/lib/anthropicError";
import {
  buildBriefChatDocumentContext,
  buildBriefChatSystemPrompt,
} from "@/lib/briefChatContext";
import { listRecentDocumentsForBrief } from "@/lib/journalDocuments";
import {
  BriefUpdateProposalError,
  insertPreparedBriefUpdateCandidates,
  patchesFromWholeBrief,
  prepareBriefUpdateCandidates,
} from "@/lib/briefUpdateReviewBoundary";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { assertProviderCallsEnabled, providerAccessErrorResponse } from "@/lib/providerAccess";
import { providerConcurrencyErrorResponse, withProviderConcurrency } from "@/lib/providerConcurrency";

export const runtime = "nodejs";
export const maxDuration = 120;

type Patch = BriefPatch;

type BriefChatClient = Pick<Anthropic, "messages">;
let testChatClient: BriefChatClient | null = null;

export function __setTestBriefChatClient(client: BriefChatClient | null) {
  testChatClient = client;
}

function chatClient(): BriefChatClient {
  assertProviderCallsEnabled();
  return testChatClient ?? new Anthropic({ timeout: 90_000, maxRetries: 1 });
}

const MAX_CHAT_TEXT_BYTES = 12 * 1024;
const MAX_CHAT_PROVIDER_CONTENT_BYTES = 256 * 1024;
export const CHAT_HISTORY_CONTEXT_ROWS = 40;
export const CHAT_HISTORY_RETAINED_ROWS = 200;
export const CHAT_HISTORY_CONTEXT_BYTES = 96 * 1024;
export const CHAT_SYSTEM_CONTEXT_BYTES = 192 * 1024;

function boundedChatText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_CHAT_TEXT_BYTES) {
    throw new Error(`${label} is invalid or too large`);
  }
  return trimmed;
}

function assertChatProviderContentBounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value ?? null), "utf8") > MAX_CHAT_PROVIDER_CONTENT_BYTES) {
    throw new Error("Chat output is too large");
  }
}

const updateBriefTool = {
  name: "update_brief",
  description:
    "Propose account brief changes for human review; this never edits the brief. Use 'append' to propose an item for an array field and 'set' to propose replacing a field. Multiple patches per call are allowed. Always also propose a citation source when adding factual content.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      patches: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            op: { type: "string", enum: ["set", "append"] },
            field: { type: "string" },
            value: {},
          },
          required: ["op", "field", "value"],
        },
      },
      summary: { type: "string" },
    },
    required: ["patches", "summary"],
  },
} as const;

function loadBrief(briefId: string): { brief: BriefT; briefJson: string } | null {
  const row = db()
    .prepare(`SELECT * FROM briefs WHERE id = ?`)
    .get(briefId) as BriefRow | undefined;
  if (!row) return null;
  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  return parsed.success ? { brief: parsed.data, briefJson: row.brief_json } : null;
}

function loadHistory(briefId: string): BriefChatRow[] {
  const newest = db()
    .prepare(
      `SELECT * FROM (
         SELECT *, rowid AS _rowid FROM brief_chats WHERE brief_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, _rowid ASC`,
    )
    .all(briefId, CHAT_HISTORY_CONTEXT_ROWS) as BriefChatRow[];
  let bytes = 0;
  const kept: BriefChatRow[] = [];
  for (let index = newest.length - 1; index >= 0; index -= 1) {
    const row = newest[index];
    const rowBytes = Buffer.byteLength(row.content, "utf8");
    if (bytes + rowBytes > CHAT_HISTORY_CONTEXT_BYTES) break;
    bytes += rowBytes;
    kept.push(row);
  }
  return kept.reverse();
}

function assertChatContextBounded(value: string): void {
  if (Buffer.byteLength(value, "utf8") > CHAT_SYSTEM_CONTEXT_BYTES) {
    throw new Error("Chat context is too large");
  }
}

function pruneChatHistory(briefId: string): void {
  db().prepare(
    `DELETE FROM brief_chats
      WHERE brief_id = ? AND id NOT IN (
        SELECT id FROM brief_chats WHERE brief_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      )`,
  ).run(briefId, briefId, CHAT_HISTORY_RETAINED_ROWS);
}

function appendChat(
  briefId: string,
  userId: string,
  role: "user" | "assistant",
  content: string,
  patches?: Patch[],
  createdAt = Date.now(),
) {
  db()
    .prepare(
      `INSERT INTO brief_chats (id, brief_id, user_id, role, content, patches, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      briefId,
      userId,
      role,
      content,
      patches && patches.length > 0 ? JSON.stringify(patches) : null,
      createdAt,
    );
}

function buildMessages(
  history: BriefChatRow[],
  userMessage: string,
): Anthropic.Messages.MessageParam[] {
  const messages: Anthropic.Messages.MessageParam[] = history.map((h) => ({
    role: h.role,
    content: h.content,
  }));
  messages.push({ role: "user", content: userMessage });
  return messages;
}

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

function currentChatUser(userId: string, briefId: string, write: boolean) {
  const row = findUserById(userId);
  if (!row) return null;
  const user = publicUser(row);
  const allowed = write
    ? canWriteBrief(user, briefId)
    : canCollaborateBrief(user, briefId);
  return allowed ? user : null;
}

function commitChatOutcome(args: {
  briefId: string;
  userId: string;
  baselineJson: string;
  baseline: BriefT;
  userMessage: string;
  assistantReply: string;
  write: boolean;
  origin: "direct_chat" | "hermes_chat";
  source: "anthropic" | "hermes";
  patches?: Patch[];
  patchErrors?: string[];
}): { candidateIds: string[] } {
  const conn = db();
  const tx = conn.transaction(() => {
    if (!currentChatUser(args.userId, args.briefId, args.write)) {
      throw new HttpError(403, { error: "Not authorized" });
    }
    const current = conn
      .prepare(`SELECT brief_json FROM briefs WHERE id = ?`)
      .get(args.briefId) as { brief_json: string } | undefined;
    if (!current || current.brief_json !== args.baselineJson) {
      throw new HttpError(409, { error: "Brief changed while chat was running" });
    }

    let candidateIds: string[] = [];
    if (args.write && args.patches && args.patches.length > 0) {
      const prepared = prepareBriefUpdateCandidates({
        baselineJson: args.baselineJson,
        baseline: args.baseline,
        patches: args.patches,
        context: {
          origin: args.origin,
          source: args.source,
          actorUserId: args.userId,
          evidence: `AI chat proposal from ${args.source}`,
        },
      });
      candidateIds = insertPreparedBriefUpdateCandidates({
        briefId: args.briefId,
        actorUserId: args.userId,
        candidates: prepared,
      });
    }

    const outcomeAt = Date.now();
    appendChat(args.briefId, args.userId, "user", boundedChatText(args.userMessage, "message"), undefined, outcomeAt);
    appendChat(args.briefId, args.userId, "assistant", boundedChatText(args.assistantReply, "reply"), undefined, outcomeAt + 1);
    // Retention pruning is part of the same durable outcome transaction: a
    // failed candidate/audit write cannot leave partially updated history.
    pruneChatHistory(args.briefId);
    if (args.write && candidateIds.length > 0) {
      createBriefEventStrict({
        brief_id: args.briefId,
        actor_user_id: args.userId,
        actor_type: args.origin === "hermes_chat" ? "hermes" : "user",
        event_type: "brief_update_candidates_queued",
        title: "AI brief update queued for review",
        summary: `${candidateIds.length} field-level candidate(s) queued`,
        metadata: {
          origin: args.origin,
          candidate_count: candidateIds.length,
          patch_errors_count: args.patchErrors?.length ?? 0,
        },
      });
    }
    return { candidateIds };
  });
  try {
    return tx();
  } catch (error) {
    if (error instanceof HttpError || error instanceof BriefUpdateProposalError) throw error;
    throw new BriefUpdateProposalError();
  }
}

const READ_ONLY_VIEWER_ADDENDUM =
  "\n\nNote: you are answering on behalf of a read-only reader. Do NOT call update_brief or any tool. Do NOT propose edits. Only answer questions using the brief content above. Cite specific brief fields where helpful.";

async function handleReadOnlyChat({
  briefId,
  userId,
  brief,
  baselineJson,
  userMessage,
}: {
  briefId: string;
  userId: string;
  brief: BriefT;
  baselineJson: string;
  userMessage: string;
}): Promise<Response> {
  const history = loadHistory(briefId);
  const documents = listRecentDocumentsForBrief(briefId);
  if (!currentChatUser(userId, briefId, false)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const client = chatClient();
  const system =
    buildBriefChatSystemPrompt({ brief, documents, canWrite: false }) +
    READ_ONLY_VIEWER_ADDENDUM;
  try {
    assertChatContextBounded(system);
  } catch {
    return NextResponse.json({ error: "Chat context is too large" }, { status: 400 });
  }
  const messages = buildMessages(history, userMessage);
  try {
    const response = await withProviderConcurrency(`brief:${briefId}`, () => client.messages.create({
      model: BRIEF_CHAT_MODEL,
      max_tokens: 4000,
      cache_control: { type: "ephemeral" } as any,
      system,
      messages,
    }));
    assertChatProviderContentBounded(response.content);
    const finalText =
      response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim() || "(no reply)";

    commitChatOutcome({
      briefId,
      userId,
      baselineJson,
      baseline: brief,
      userMessage,
      assistantReply: finalText,
      write: false,
      origin: "direct_chat",
      source: "anthropic",
    });

    return NextResponse.json({
      reply: finalText,
      patches_applied: [],
      patch_errors: [],
    });
  } catch (err: any) {
    const denied = authError(err);
    if (denied) return denied;
    const limited = providerConcurrencyErrorResponse(err) ?? providerAccessErrorResponse(err);
    if (limited) return limited;
    return NextResponse.json(
      { error: friendlyAnthropicError(err, "Chat") },
      { status: 500 },
    );
  }
}

// ---- GET: history ----------------------------------------------------------

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const rows = loadHistory(params.id);
  return NextResponse.json({
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      patches: r.patches ? JSON.parse(r.patches) : null,
      created_at: r.created_at,
    })),
  });
}

// ---- DELETE: clear history -------------------------------------------------

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const result = db()
    .prepare(`DELETE FROM brief_chats WHERE brief_id = ?`)
    .run(params.id);
  return NextResponse.json({ deleted: result.changes });
}

// ---- POST: send a message --------------------------------------------------

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }

  if (user.role === "viewer") {
    return NextResponse.json({ error: "Read-only users cannot use AI chat" }, { status: 403 });
  }

  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canCollaborateBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { message?: string };
  try {
    body = await parseBoundedJson<{ message?: string }>(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  let userMessage: string;
  try {
    userMessage = boundedChatText(body.message ?? "", "message");
  } catch {
    return NextResponse.json({ error: "Empty or oversized message" }, { status: 400 });
  }
  const chatPath = selectChatPath();
  try {
    assertProviderCallsEnabled();
  } catch (error) {
    return providerAccessErrorResponse(error) ?? NextResponse.json({ error: "AI provider access is temporarily unavailable" }, { status: 503 });
  }
  if (chatPath === "direct" && !testChatClient && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY" },
      { status: 500 },
    );
  }

  const writer = canWriteBrief(user, params.id);
  if (!writer && !canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const loaded = loadBrief(params.id);
  if (!loaded) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { brief, briefJson: baselineJson } = loaded;

  if (chatPath === "hermes") {
    const history = loadHistory(params.id);
    const documents = listRecentDocumentsForBrief(params.id);
    const messageWithDocuments =
      documents.length > 0
        ? `${userMessage}\n\n${buildBriefChatDocumentContext({ documents, canWrite: writer })}`
        : userMessage;
    try {
      assertChatContextBounded(messageWithDocuments);
    } catch {
      return NextResponse.json({ error: "Chat context is too large" }, { status: 400 });
    }
    try {
      if (!currentChatUser(user.id, params.id, writer)) {
        return NextResponse.json({ error: "Not authorized" }, { status: 403 });
      }
      const result = await withProviderConcurrency(`brief:${params.id}`, () => runChatViaHermes({
        brief_id: params.id,
        user_id: user.id,
        brief,
        history: history.map((h) => ({ role: h.role, content: h.content })),
        message: messageWithDocuments,
        can_write: writer,
      }));

      const proposedPatches = writer && result.brief
        ? patchesFromWholeBrief(brief, result.brief)
        : writer
          ? result.patches_applied
          : [];
      const committed = commitChatOutcome({
        briefId: params.id,
        userId: user.id,
        baselineJson,
        baseline: brief,
        userMessage,
        assistantReply: result.reply,
        write: writer,
        origin: "hermes_chat",
        source: "hermes",
        patches: proposedPatches,
        patchErrors: result.patch_errors,
      });

      return NextResponse.json({
        reply: result.reply,
        patches_applied: [],
        candidates_queued: committed.candidateIds.length,
        patch_errors: result.patch_errors,
        canvas_version: writer ? result.canvas_version : undefined,
      });
    } catch (err: any) {
      const denied = authError(err);
      if (denied) return denied;
      const limited = providerConcurrencyErrorResponse(err) ?? providerAccessErrorResponse(err);
      if (limited) return limited;
      const message = err instanceof BriefUpdateProposalError
        ? "Chat proposal could not be queued for review"
        : friendlyAnthropicError(err, "Chat");
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // Sharees get a tools-less, no-patches branch — they can ask questions but
  // can't run web search or mutate the brief.
  if (!writer) {
    return handleReadOnlyChat({
      briefId: params.id,
      userId: user.id,
      brief,
      baselineJson,
      userMessage,
    });
  }

  const history = loadHistory(params.id);
  const documents = listRecentDocumentsForBrief(params.id);
  if (!currentChatUser(user.id, params.id, true)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const client = chatClient();
  const system = buildBriefChatSystemPrompt({
    brief,
    documents,
    canWrite: true,
  });
  try {
    assertChatContextBounded(system);
  } catch {
    return NextResponse.json({ error: "Chat context is too large" }, { status: 400 });
  }

  let messages = buildMessages(history, userMessage);
  let workingBrief = brief;
  const appliedPatches: Patch[] = [];
  const patchErrors: string[] = [];
  let finalText = "";
  let containerId: string | null = null;

  try {
    for (let i = 0; i < 6; i++) {
      const response: Anthropic.Messages.Message = await withProviderConcurrency(`brief:${params.id}`, () => client.messages.create({
        model: BRIEF_CHAT_MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        cache_control: { type: "ephemeral" } as any,
        ...(containerId ? { container: containerId } : {}),
        system,
        tools: [
          { type: "web_search_20260209" as const, name: "web_search" } as any,
          updateBriefTool as any,
        ],
        messages,
      }));
      assertChatProviderContentBounded(response.content);
      containerId = response.container?.id ?? containerId;

      const toolUses = response.content.filter(
        (b: any) => b.type === "tool_use" && b.name === "update_brief",
      ) as any[];

      messages = [
        ...messages,
        { role: "assistant", content: response.content as any },
      ];

      if (response.stop_reason === "pause_turn") {
        if (i < 5) continue;
        throw new Error("Anthropic server-side tool loop did not finish");
      }

      if (response.stop_reason === "tool_use" && toolUses.length > 0) {
        const toolResults: any[] = [];
        for (const tu of toolUses) {
          const patches: Patch[] = Array.isArray(tu.input?.patches)
            ? tu.input.patches
            : [];
          let nextBrief = workingBrief;
          let resultText = "";
          try {
            nextBrief = applyPatches(workingBrief, patches);
            const validated = Brief.safeParse(nextBrief);
            if (!validated.success) {
              const issues = validated.error.issues
                .slice(0, 5)
                .map((it) => `${it.path.join(".")}: ${it.message}`)
                .join("; ");
              throw new Error(`schema validation failed: ${issues}`);
            }
            workingBrief = validated.data;
            appliedPatches.push(...patches);
            resultText = `Validated ${patches.length} proposed patch${patches.length === 1 ? "" : "es"} for human review: ${tu.input?.summary || patches.map((p) => p.field).join(", ")}`;
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            patchErrors.push(msg);
            resultText = `Patch rejected: ${msg}`;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: resultText,
          });
        }
        messages = [...messages, { role: "user", content: toolResults }];
        continue;
      }

      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      finalText = text || "(no reply)";
      break;
    }

    if (!finalText) finalText = "(no reply)";

    const committed = commitChatOutcome({
      briefId: params.id,
      userId: user.id,
      baselineJson,
      baseline: brief,
      userMessage,
      assistantReply: finalText,
      write: true,
      origin: "direct_chat",
      source: "anthropic",
      patches: appliedPatches,
      patchErrors,
    });

    return NextResponse.json({
      reply: finalText,
      patches_applied: [],
      candidates_queued: committed.candidateIds.length,
      patch_errors: patchErrors,
    });
  } catch (err: any) {
    const auth = authError(err);
    if (auth) return auth;
    const limited = providerConcurrencyErrorResponse(err) ?? providerAccessErrorResponse(err);
    if (limited) return limited;
    const msg = err instanceof BriefUpdateProposalError
      ? "Chat proposal could not be queued for review"
      : friendlyAnthropicError(err, "Chat");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
