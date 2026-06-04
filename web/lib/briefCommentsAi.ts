// AI-assist helper for the brief comments thread. This is a separate
// surface from `brief_chats` (the AI-edit chat). The model here NEVER
// proposes brief edits or runs tools — it only drafts discussion text.
//
// Costs/caps:
//   - BRIEF_INPUT_CHAR_CAP: brief JSON is hard-truncated to this many chars
//     before being placed in the system prompt.
//   - THREAD_CONTEXT_COMMENTS_MAX: max comments included from the thread.
//   - MAX_OUTPUT_TOKENS: model output ceiling.
//
// The shape `assistClient` lets tests inject a stub Anthropic-compatible
// client without depending on a live API key. In production the route
// passes `undefined` and a fresh `new Anthropic()` is used (same pattern
// as `web/app/api/briefs/[id]/chat/route.ts`).

import Anthropic from "@anthropic-ai/sdk";

export const BRIEF_INPUT_CHAR_CAP = 4000;
export const THREAD_CONTEXT_COMMENTS_MAX = 12;
export const MAX_OUTPUT_TOKENS = 600;

export type AssistMode =
  | "draft_reply"
  | "summarize_thread"
  | "extract_actions"
  | "suggest_followups";

export const ASSIST_MODES: readonly AssistMode[] = [
  "draft_reply",
  "summarize_thread",
  "extract_actions",
  "suggest_followups",
];

export function isAssistMode(v: unknown): v is AssistMode {
  return typeof v === "string" && (ASSIST_MODES as readonly string[]).includes(v);
}

export type ThreadComment = {
  id: string;
  parent_id: string | null;
  author_display_name: string | null;
  body: string;
  created_at: number;
};

export type AssistInput = {
  mode: AssistMode;
  brief_json: unknown;
  thread: ThreadComment[];
  parent_id?: string | null;
};

export const BRIEF_COMMENTS_SYSTEM_PROMPT = `You are an assistant helping users discuss findings in a sales research brief.

You DO NOT propose changes to the brief. You DO NOT call any tools. You DO NOT invent facts beyond what appears in the brief or the thread provided.

Your jobs:
- draft_reply: Draft a concise, professional reply to the parent comment in the thread. Stay grounded in the brief content and the thread context.
- summarize_thread: Summarize the discussion so far in 3-6 bullet points. Be neutral; do not editorialize.
- extract_actions: List concrete action items implied by the thread. Format as a short bulleted list. Mark owner if it can be inferred from the discussion.
- suggest_followups: Suggest 3-5 follow-up questions the team should be asking, grounded in the brief and the thread.

Output plain text or simple Markdown. No preamble like "Sure, here is...". Just produce the text the user will paste into the compose box.`;

function modeInstruction(mode: AssistMode): string {
  switch (mode) {
    case "draft_reply":
      return "Draft a reply to the most recent / parent comment.";
    case "summarize_thread":
      return "Summarize the discussion so far.";
    case "extract_actions":
      return "Extract concrete action items.";
    case "suggest_followups":
      return "Suggest follow-up questions.";
  }
}

// Truncate the brief JSON to the input cap. Truncation marker is appended so
// the model knows context was cut. Returned string is what gets embedded in
// the system prompt — callers must NOT bypass this for the live API.
export function truncateBriefForPrompt(briefJson: unknown): string {
  const raw = JSON.stringify(briefJson, null, 2);
  if (raw.length <= BRIEF_INPUT_CHAR_CAP) return raw;
  return raw.slice(0, BRIEF_INPUT_CHAR_CAP) + "\n…[truncated]";
}

// Pick the most relevant slice of the thread. If `parent_id` is set we
// include the parent + its siblings (other replies to the same parent) +
// the parent's parent if any. Otherwise we include the last N comments.
export function selectThreadContext(
  thread: ThreadComment[],
  parentId: string | null | undefined,
): ThreadComment[] {
  if (!parentId) {
    return thread.slice(-THREAD_CONTEXT_COMMENTS_MAX);
  }
  const byId = new Map(thread.map((c) => [c.id, c]));
  const parent = byId.get(parentId);
  const out: ThreadComment[] = [];
  if (parent?.parent_id) {
    const grand = byId.get(parent.parent_id);
    if (grand) out.push(grand);
  }
  if (parent) out.push(parent);
  for (const c of thread) {
    if (c.parent_id === parentId && c.id !== parent?.id) out.push(c);
  }
  return out.slice(-THREAD_CONTEXT_COMMENTS_MAX);
}

function formatThread(thread: ThreadComment[]): string {
  if (thread.length === 0) return "(no prior comments)";
  return thread
    .map((c) => {
      const author = c.author_display_name || "User";
      const indent = c.parent_id ? "  ↳ " : "";
      return `${indent}[${author}] ${c.body}`;
    })
    .join("\n");
}

export function buildAssistMessages(input: AssistInput): {
  system: string;
  user: string;
} {
  const briefStr = truncateBriefForPrompt(input.brief_json);
  const ctx = selectThreadContext(input.thread, input.parent_id ?? null);
  const threadStr = formatThread(ctx);
  const system = `${BRIEF_COMMENTS_SYSTEM_PROMPT}

---
BRIEF:
${briefStr}

---
THREAD CONTEXT:
${threadStr}`;
  const user = modeInstruction(input.mode);
  return { system, user };
}

// Minimal client shape the assist function depends on. Lets tests inject a
// stub without pulling in a real Anthropic SDK instance.
export interface AssistClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

export type AssistResult = {
  text: string;
  mode: AssistMode;
  ai_assisted_marker: true;
};

// Test seam: when set, `runAssist` uses this client instead of a fresh
// `new Anthropic()`. Lets tests inject a stub without a live API key. Route
// handlers don't accept extra exports under Next.js' route type-check, so
// the seam lives here on the helper module.
let _testClient: AssistClient | null = null;
export function __setTestAssistClient(c: AssistClient | null) {
  _testClient = c;
}

export async function runAssist(
  input: AssistInput,
  client?: AssistClient,
): Promise<AssistResult> {
  const { system, user } = buildAssistMessages(input);
  const c: AssistClient =
    client ?? _testClient ?? (new Anthropic() as unknown as AssistClient);
  const response = await c.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text =
    response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim() || "(no suggestion)";
  return { text, mode: input.mode, ai_assisted_marker: true };
}
