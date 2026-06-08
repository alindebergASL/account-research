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
  target: /^\s*(?:target|target brief section|target field)\s*:\s*(.+)$/i,
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

function trustedEvidenceLabels(body: string, sourceEntryId: string): string | null {
  const legendEntries = parseSourceLegendEntries(body);
  if (legendEntries.length === 0) return null;
  const answer = answerText(body);
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

export function buildReviewCandidateDraftFromAssistantEntry(
  entry: AssistantCandidateEntry,
): ReviewCandidateDraft | null {
  const body = trustedAssistantBody(entry);
  if (!body) return null;
  const text = answerText(body);
  if (!text) return null;
  const proposedText = fieldValue(text, "proposed_text") ?? text;
  const firstLine = stripCandidatePrefix(firstMeaningfulLine(text));
  return {
    candidate_type: detectCandidateType(text),
    title: truncate(firstLine || "Review candidate", MAX_TITLE_CHARS),
    proposed_text: proposedText.trim(),
    target: fieldValue(text, "target"),
    evidence: trustedEvidenceLabels(body, entry.id),
    confidence: fieldValue(text, "confidence"),
    risk: fieldValue(text, "risk"),
    source_entry_id: entry.id,
  };
}
