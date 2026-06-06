// AI participant for the per-brief journal. Unlike the comments AI-assist
// helper (which only drafts text for a human to paste), this surface posts
// the model's reply directly into the shared journal as an `assistant` entry.
// It is read-only with respect to the brief: it NEVER proposes edits and calls
// NO tools — brief mutation stays the job of `BriefChat` / the chat route.
//
// Caps mirror briefCommentsAi.ts so cost behavior is predictable:
//   - BRIEF_INPUT_CHAR_CAP: brief JSON hard-truncated before prompt embedding.
//   - JOURNAL_CONTEXT_MAX: max prior entries included as context.
//   - MAX_OUTPUT_TOKENS: model output ceiling.

import Anthropic from "@anthropic-ai/sdk";
import {
  formatDocumentContextForPrompt,
  type JournalDocumentRow,
} from "@/lib/journalDocuments";

export const BRIEF_INPUT_CHAR_CAP = 4000;
export const JOURNAL_CONTEXT_MAX = 12;
export const MAX_OUTPUT_TOKENS = 800;

export type JournalContextEntry = {
  author_type: "user" | "assistant";
  author_display_name: string | null;
  body: string;
  created_at: number;
};

export type JournalReplyInput = {
  brief_json: unknown;
  // Prior entries in chronological order. The latest user entry (the one being
  // answered) should be included as the final element.
  entries: JournalContextEntry[];
  documents?: JournalDocumentRow[];
};

export const JOURNAL_SYSTEM_PROMPT = `You are the assistant participating in the journal of a sales account research brief.

The journal is a shared space where the account team logs updates, asks questions, and chats with you. Several teammates may be present, so write as a helpful participant addressing the team.

Rules:
- Ground every answer in the BRIEF content, JOURNAL CONTEXT, and UPLOADED JOURNAL DOCUMENTS provided below. Do NOT invent facts beyond them.
- Cite source labels like [J1] or [D1] for factual claims that come from journal entries or uploaded documents. Use multiple labels when useful.
- You DO NOT edit the brief and you DO NOT call any tools. If asked to change the brief, explain that edits happen in the brief chat, then answer what you can.
- Be concise and professional. Answer the most recent entry directly. If the brief lacks the information needed, say so plainly rather than guessing.
- For account update, action item, brief update, follow-up, digest, or open-question requests, use clear headings and separate evidence from recommendations.

Output plain text or simple Markdown. No preamble like "Sure, here is...".`;

// Truncate the brief JSON to the input cap (same contract as briefCommentsAi).
export function truncateBriefForPrompt(briefJson: unknown): string {
  const raw = JSON.stringify(briefJson, null, 2);
  if (raw.length <= BRIEF_INPUT_CHAR_CAP) return raw;
  return raw.slice(0, BRIEF_INPUT_CHAR_CAP) + "\n…[truncated]";
}

// Keep the most recent slice of the journal so context stays bounded.
export function selectJournalContext(
  entries: JournalContextEntry[],
): JournalContextEntry[] {
  return entries.slice(-JOURNAL_CONTEXT_MAX);
}

function formatEntries(entries: JournalContextEntry[]): string {
  if (entries.length === 0) return "(no prior entries)";
  return entries
    .map((e, idx) => {
      const who =
        e.author_type === "assistant"
          ? "Assistant"
          : e.author_display_name || "User";
      return `[J${idx + 1}] [${who}] ${e.body}`;
    })
    .join("\n");
}

export function buildJournalMessages(input: JournalReplyInput): {
  system: string;
  user: string;
} {
  const briefStr = truncateBriefForPrompt(input.brief_json);
  const ctx = selectJournalContext(input.entries);
  const journalStr = formatEntries(ctx);
  const system = `${JOURNAL_SYSTEM_PROMPT}

---
BRIEF:
${briefStr}

---
JOURNAL CONTEXT (oldest to newest):
${journalStr}

---
UPLOADED JOURNAL DOCUMENTS:
${formatDocumentContextForPrompt(input.documents ?? [])}`;
  const user = "Reply to the most recent journal entry.";
  return { system, user };
}

// Minimal client shape so tests can inject a stub without a real SDK instance.
export interface JournalClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

export type JournalReplyResult = { text: string };

// Test seam: when set, runJournalReply uses this client instead of a fresh
// `new Anthropic()`. Route files can't export non-route symbols under Next.js,
// so the seam lives on this helper module (same pattern as briefCommentsAi).
let _testClient: JournalClient | null = null;
export function __setTestJournalClient(c: JournalClient | null) {
  _testClient = c;
}

export async function runJournalReply(
  input: JournalReplyInput,
  client?: JournalClient,
): Promise<JournalReplyResult> {
  const { system, user } = buildJournalMessages(input);
  const c: JournalClient =
    client ?? _testClient ?? (new Anthropic() as unknown as JournalClient);
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
      .trim() || "(no reply)";
  return { text };
}
