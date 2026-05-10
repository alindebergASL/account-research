import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { db, type BriefChatRow, type BriefRow } from "@/lib/db";
import {
  HttpError,
  canReadBrief,
  canWriteBrief,
  requireUser,
} from "@/lib/auth";
import { Brief, type Brief as BriefT } from "@/lib/schema";
import { BRIEF_CHAT_SYSTEM_PROMPT } from "@/lib/prompt";
import { applyPatches, type BriefPatch } from "@/lib/briefPatches";

export const runtime = "nodejs";
export const maxDuration = 120;

type Patch = BriefPatch;

const updateBriefTool = {
  name: "update_brief",
  description:
    "Update the account brief in place. Use 'append' to add an item to an array field (e.g. personas, recent_signals, sources, extensions). Use 'set' to replace a string or object field. Multiple patches per call are allowed. Always also append a citation source when you add new factual content.",
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

function friendlyError(err: any): string {
  const msg = String(err?.message ?? err ?? "");
  if (/credit balance/i.test(msg) && /too low|insufficient/i.test(msg)) {
    return "Chat is temporarily unavailable — the Anthropic account is out of credits. Top up at https://console.anthropic.com/billing and try again.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Anthropic rate limit reached — please retry in a moment.";
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return "Server is misconfigured (invalid Anthropic API key).";
  }
  return msg || "Chat failed";
}

function loadBrief(briefId: string): BriefT | null {
  const row = db()
    .prepare(`SELECT * FROM briefs WHERE id = ?`)
    .get(briefId) as BriefRow | undefined;
  if (!row) return null;
  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  return parsed.success ? parsed.data : null;
}

function loadHistory(briefId: string): BriefChatRow[] {
  return db()
    .prepare(
      `SELECT * FROM brief_chats WHERE brief_id = ? ORDER BY created_at ASC LIMIT 100`,
    )
    .all(briefId) as BriefChatRow[];
}

function appendChat(
  briefId: string,
  userId: string,
  role: "user" | "assistant",
  content: string,
  patches?: Patch[],
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
      Date.now(),
    );
}

function saveBrief(briefId: string, brief: BriefT) {
  db()
    .prepare(
      `UPDATE briefs SET brief_json = ?, segment = ?, audience = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(brief), brief.segment, brief.audience, briefId);
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

const READ_ONLY_VIEWER_ADDENDUM =
  "\n\nNote: you are answering on behalf of a read-only reader. Do NOT call update_brief or any tool. Do NOT propose edits. Only answer questions using the brief content above. Cite specific brief fields where helpful.";

async function handleReadOnlyChat({
  briefId,
  userId,
  brief,
  userMessage,
}: {
  briefId: string;
  userId: string;
  brief: BriefT;
  userMessage: string;
}): Promise<Response> {
  const history = loadHistory(briefId);
  const client = new Anthropic();
  const system =
    BRIEF_CHAT_SYSTEM_PROMPT.replace(
      "{{BRIEF_JSON}}",
      JSON.stringify(brief, null, 2),
    ) + READ_ONLY_VIEWER_ADDENDUM;
  const messages = buildMessages(history, userMessage);
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      cache_control: { type: "ephemeral" } as any,
      system,
      messages,
    });
    const finalText =
      response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim() || "(no reply)";

    appendChat(briefId, userId, "user", userMessage);
    appendChat(briefId, userId, "assistant", finalText);

    return NextResponse.json({
      reply: finalText,
      patches_applied: [],
      patch_errors: [],
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: friendlyError(err) },
      { status: 500 },
    );
  }
}

// ---- GET: history ----------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }

  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const userMessage = (body.message ?? "").trim();
  if (!userMessage) {
    return NextResponse.json({ error: "Empty message" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY" },
      { status: 500 },
    );
  }

  const writer = canWriteBrief(user, params.id);
  if (!writer && !canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const brief = loadBrief(params.id);
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Sharees get a tools-less, no-patches branch — they can ask questions but
  // can't run web search or mutate the brief.
  if (!writer) {
    return handleReadOnlyChat({
      briefId: params.id,
      userId: user.id,
      brief,
      userMessage,
    });
  }

  const history = loadHistory(params.id);
  const client = new Anthropic();
  const system = BRIEF_CHAT_SYSTEM_PROMPT.replace(
    "{{BRIEF_JSON}}",
    JSON.stringify(brief, null, 2),
  );

  let messages = buildMessages(history, userMessage);
  let workingBrief = brief;
  const appliedPatches: Patch[] = [];
  const patchErrors: string[] = [];
  let finalText = "";
  let containerId: string | null = null;

  try {
    for (let i = 0; i < 6; i++) {
      const response: Anthropic.Messages.Message = await client.messages.create({
        model: "claude-sonnet-4-6",
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
      });
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
            resultText = `Applied ${patches.length} patch${patches.length === 1 ? "" : "es"}: ${tu.input?.summary || patches.map((p) => p.field).join(", ")}`;
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

    if (appliedPatches.length > 0) {
      saveBrief(params.id, workingBrief);
    }

    appendChat(params.id, user.id, "user", userMessage);
    appendChat(
      params.id,
      user.id,
      "assistant",
      finalText,
      appliedPatches.length > 0 ? appliedPatches : undefined,
    );

    return NextResponse.json({
      reply: finalText,
      patches_applied: appliedPatches,
      patch_errors: patchErrors,
      brief: appliedPatches.length > 0 ? workingBrief : undefined,
    });
  } catch (err: any) {
    const msg = friendlyError(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
