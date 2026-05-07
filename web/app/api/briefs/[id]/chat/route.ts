import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { db, type BriefChatRow, type BriefRow } from "@/lib/db";
import { getUserId, setUserCookie } from "@/lib/user";
import { Brief, type Brief as BriefT } from "@/lib/schema";
import { BRIEF_CHAT_SYSTEM_PROMPT } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 120;

type Patch = {
  op: "set" | "append";
  field: string;
  value: any;
};

const ALLOWED_FIELDS = new Set([
  "snapshot",
  "priority_summary",
  "recent_signals",
  "ai_tech_maturity",
  "top_initiatives",
  "technical_footprint",
  "programs_procurement",
  "personas",
  "buying_path",
  "first_angle",
  "risks",
  "competitive_signals",
  "next_action",
  "sources",
]);

const updateBriefTool = {
  name: "update_brief",
  description:
    "Update the account brief in place. Use 'append' to add an item to an array field (e.g. personas, recent_signals, sources). Use 'set' to replace a string or object field. Multiple patches per call are allowed. Always also append a citation source when you add new factual content.",
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

function applyPatches(brief: BriefT, patches: Patch[]): BriefT {
  const out: any = { ...brief };
  for (const p of patches) {
    if (!ALLOWED_FIELDS.has(p.field)) {
      throw new Error(`field not allowed: ${p.field}`);
    }
    if (p.op === "set") {
      out[p.field] = p.value;
    } else if (p.op === "append") {
      const cur = out[p.field];
      if (!Array.isArray(cur)) {
        throw new Error(`cannot append to non-array field: ${p.field}`);
      }
      out[p.field] = [...cur, p.value];
    } else {
      throw new Error(`unknown op: ${(p as any).op}`);
    }
  }
  return out as BriefT;
}

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

function loadBrief(briefId: string, userId: string): BriefT | null {
  const row = db()
    .prepare(`SELECT * FROM briefs WHERE id = ? AND user_id = ?`)
    .get(briefId, userId) as BriefRow | undefined;
  if (!row) return null;
  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  return parsed.success ? parsed.data : null;
}

function loadHistory(briefId: string, userId: string): BriefChatRow[] {
  return db()
    .prepare(
      `SELECT * FROM brief_chats WHERE brief_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 100`,
    )
    .all(briefId, userId) as BriefChatRow[];
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

function saveBrief(briefId: string, userId: string, brief: BriefT) {
  db()
    .prepare(
      `UPDATE briefs SET brief_json = ?, segment = ?, audience = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      JSON.stringify(brief),
      brief.segment,
      brief.audience,
      briefId,
      userId,
    );
}

// Build the messages array Claude sees: prior history + new user message.
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

// ---- GET: history ----------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { userId, isNew } = getUserId(req);
  if (isNew) {
    const res = NextResponse.json({ messages: [] });
    setUserCookie(res, userId);
    return res;
  }
  const brief = loadBrief(params.id, userId);
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const rows = loadHistory(params.id, userId);
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
  const { userId, isNew } = getUserId(req);
  if (isNew) {
    const res = NextResponse.json({ deleted: 0 });
    setUserCookie(res, userId);
    return res;
  }
  const brief = loadBrief(params.id, userId);
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const result = db()
    .prepare(`DELETE FROM brief_chats WHERE brief_id = ? AND user_id = ?`)
    .run(params.id, userId);
  return NextResponse.json({ deleted: result.changes });
}

// ---- POST: send a message --------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { userId, isNew } = getUserId(req);

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

  const brief = loadBrief(params.id, userId);
  if (!brief) {
    const res = NextResponse.json({ error: "Not found" }, { status: 404 });
    if (isNew) setUserCookie(res, userId);
    return res;
  }

  const history = loadHistory(params.id, userId);
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

  try {
    // Manual tool-use loop for the custom update_brief tool. web_search runs
    // server-side and doesn't enter this loop. Cap iterations to avoid runaway.
    for (let i = 0; i < 6; i++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        cache_control: { type: "ephemeral" } as any,
        system,
        tools: [
          { type: "web_search_20260209" as const, name: "web_search" } as any,
          updateBriefTool as any,
        ],
        messages,
      });

      const toolUses = response.content.filter(
        (b: any) => b.type === "tool_use" && b.name === "update_brief",
      ) as any[];

      // Always append the assistant turn to history before resolving tools
      messages = [
        ...messages,
        { role: "assistant", content: response.content as any },
      ];

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
        continue; // give the model a chance to write its final reply
      }

      // end_turn (or pause_turn we don't continue) — collect the text and exit
      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      finalText = text || "(no reply)";
      break;
    }

    if (!finalText) finalText = "(no reply)";

    // Persist any brief changes
    if (appliedPatches.length > 0) {
      saveBrief(params.id, userId, workingBrief);
    }

    // Persist chat turns
    appendChat(params.id, userId, "user", userMessage);
    appendChat(
      params.id,
      userId,
      "assistant",
      finalText,
      appliedPatches.length > 0 ? appliedPatches : undefined,
    );

    const res = NextResponse.json({
      reply: finalText,
      patches_applied: appliedPatches,
      patch_errors: patchErrors,
      brief: appliedPatches.length > 0 ? workingBrief : undefined,
    });
    if (isNew) setUserCookie(res, userId);
    return res;
  } catch (err: any) {
    const msg = friendlyError(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
