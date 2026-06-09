import { findSourceLegendBlockStart, parseSourceLegendEntries } from "@/lib/journalSourceLegend";
import type { ReviewCandidateType } from "@/lib/journalReviewCandidates";

export type AssistantCandidateEntry = {
  id: string;
  author_type: "user" | "assistant";
  reply_to: string | null;
  body: string | null;
};

export type ReviewCandidateDraft = {
  candidate_type: ReviewCandidateType;
  title: string;
  proposed_text: string;
  target: string | null;
  evidence: string | null;
  confidence: string | null;
  risk: string | null;
  source_entry_id: string;
};

const MAX_TITLE_CHARS = 120;
const FIELD_PATTERNS: Record<"target" | "proposed_text" | "confidence" | "risk", RegExp> = {
  target: /^\s*(?:target|target brief section|target field|owner|due \/ trigger|due date|trigger)\s*:\s*(.+)$/i,
  proposed_text: /^\s*(?:proposed text|proposed change|proposal|task|decision|question)\s*:\s*(.+)$/i,
  confidence: /^\s*confidence\s*:\s*(.+)$/i,
  risk: /^\s*(?:risk|risk \/ review note|review note|suggested reviewer action)\s*:\s*(.+)$/i,
};

function trustedAssistantBody(entry: AssistantCandidateEntry): string | null {
  if (entry.author_type !== "assistant" || !entry.reply_to || !entry.body) return null;
  return entry.body;
}

function answerText(body: string): string {
  const legendStart = findSourceLegendBlockStart(body);
  return (legendStart < 0 ? body : body.slice(0, legendStart)).trim();
}

function detectCandidateType(text: string): ReviewCandidateType {
  const lower = text.toLowerCase();
  if (/\b(open question|question candidate|questions?)\b/.test(lower)) return "open_question";
  if (/\b(decision|decider|rationale|reversal condition)\b/.test(lower)) return "decision";
  if (/\b(action item|next action|task|owner|due date|trigger)\b/.test(lower)) return "action_item";
  return "brief_update";
}

function firstMeaningfulLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/^[-*#\d.)\s]+/, "").trim())
      .find((line) => line.length > 0) ?? "Review candidate"
  );
}

function stripCandidatePrefix(line: string): string {
  return line.replace(/^\s*(?:brief update candidate|review candidate|candidate|action item|decision|open question)\s*:\s*/i, "").trim();
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function fieldValue(text: string, field: keyof typeof FIELD_PATTERNS): string | null {
  for (const line of text.split("\n")) {
    const match = line.match(FIELD_PATTERNS[field]);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .trim();
}

function parseMarkdownTableFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    if (/^\|\s*-+\s*\|\s*-+\s*\|?$/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => stripMarkdown(cell));
    if (cells.length < 2 || /^field$/i.test(cells[0])) continue;
    if (cells[0] && cells[1]) fields[cells[0].toLowerCase()] = cells[1];
  }
  return fields;
}

function tableField(fields: Record<string, string>, names: string[]): string | null {
  for (const name of names) {
    const value = fields[name.toLowerCase()];
    if (value?.trim()) return value.trim();
  }
  return null;
}

function splitCandidateBlocks(text: string): Array<{ title: string; body: string }> {
  const headingPattern = /^#{2,4}\s*(?:(?:candidate|action item candidate|brief update candidate|decision candidate|open question candidate)\s*\d*\s*(?:[—:-]\s*)?)(.+?)\s*$/gim;
  const matches = Array.from(text.matchAll(headingPattern));
  if (matches.length === 0) return [];
  return matches.map((match, index) => {
    const title = stripCandidatePrefix(stripMarkdown(match[1] ?? "Review candidate"));
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? text.length;
    return { title: title || "Review candidate", body: text.slice(bodyStart, bodyEnd).trim() };
  }).filter((block) => block.body.length > 0);
}

function draftFromText({
  text,
  title,
  body,
  fullBody,
  sourceEntryId,
}: {
  text: string;
  title: string;
  body: string;
  fullBody: string;
  sourceEntryId: string;
}): ReviewCandidateDraft {
  const fields = parseMarkdownTableFields(body);
  const task = tableField(fields, ["task", "proposed text", "proposed change", "proposal", "decision", "question"]);
  const owner = tableField(fields, ["owner"]);
  const due = tableField(fields, ["due / trigger", "due date", "trigger"]);
  const target = [
    owner ? `Owner: ${owner}` : null,
    due ? `Due / Trigger: ${due}` : null,
  ].filter(Boolean).join("; ") || fieldValue(body, "target");
  return {
    candidate_type: detectCandidateType(`${title}\n${body}`),
    title: truncate(stripCandidatePrefix(title) || firstMeaningfulLine(body), MAX_TITLE_CHARS),
    proposed_text: (task ?? fieldValue(body, "proposed_text") ?? text).trim(),
    target,
    evidence: trustedEvidenceLabelsForText(body, fullBody, sourceEntryId),
    confidence: tableField(fields, ["confidence"]) ?? fieldValue(body, "confidence"),
    risk: tableField(fields, ["suggested reviewer action", "risk", "review note"]) ?? fieldValue(body, "risk"),
    source_entry_id: sourceEntryId,
  };
}

function trustedEvidenceLabelsForText(answer: string, fullBody: string, sourceEntryId: string): string | null {
  const legendEntries = parseSourceLegendEntries(fullBody);
  if (legendEntries.length === 0) return null;
  const labels = new Set(legendEntries.map((entry) => entry.label));
  const citedLabels: string[] = [];
  for (const match of answer.matchAll(/\[(?:J|D)\d+\]/g)) {
    const label = match[0];
    if (labels.has(label) && !citedLabels.includes(label)) citedLabels.push(label);
  }
  return citedLabels.length > 0
    ? `Scoped to assistant reply ${sourceEntryId}: ${citedLabels.join(", ")}`
    : null;
}

function trustedEvidenceLabels(body: string, sourceEntryId: string): string | null {
  return trustedEvidenceLabelsForText(answerText(body), body, sourceEntryId);
}

export function buildReviewCandidateDraftsFromAssistantEntry(
  entry: AssistantCandidateEntry,
): ReviewCandidateDraft[] {
  const body = trustedAssistantBody(entry);
  if (!body) return [];
  const text = answerText(body);
  if (!text) return [];
  const blocks = splitCandidateBlocks(text);
  if (blocks.length > 0) {
    return blocks.map((block) => draftFromText({
      text: block.body,
      title: block.title,
      body: block.body,
      fullBody: body,
      sourceEntryId: entry.id,
    }));
  }
  const firstLine = stripCandidatePrefix(firstMeaningfulLine(text));
  return [draftFromText({
    text,
    title: firstLine || "Review candidate",
    body: text,
    fullBody: body,
    sourceEntryId: entry.id,
  })];
}

export function buildReviewCandidateDraftFromAssistantEntry(
  entry: AssistantCandidateEntry,
): ReviewCandidateDraft | null {
  return buildReviewCandidateDraftsFromAssistantEntry(entry)[0] ?? null;
}
