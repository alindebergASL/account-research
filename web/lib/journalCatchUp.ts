export type JournalCatchUpWindow = "24h" | "7d" | "all";

export type JournalCatchUpEntry = {
  id: string;
  author_type?: string;
  body?: string | null;
  created_at?: number | null;
  author?: { display_name?: string | null; email?: string | null } | null;
  documents?: Array<{ id: string; filename?: string | null }>;
};

export type JournalCatchUpSource = {
  id: string;
  filename?: string | null;
  content_preview?: string | null;
  entryBody?: string | null;
  created_at?: number | null;
  entryCreatedAt?: number | null;
};

export type JournalCatchUpReviewCandidate = {
  id: string;
  candidate_type?: string | null;
  status?: string | null;
  title?: string | null;
  proposed_text?: string | null;
  evidence?: string | null;
  updated_at?: number | null;
  created_at?: number | null;
};

export type JournalCatchUpContext = {
  window: JournalCatchUpWindow;
  windowLabel: string;
  since: number | null;
  entryIds: string[];
  sourceIds: string[];
  reviewedCandidateIds: string[];
  pendingCandidateIds: string[];
  recallSourceDocumentIds: string[];
  omittedExcludedSourceCount: number;
};

const REVIEWED_STATUSES = new Set(["accepted", "sent_to_brief_chat", "applied"]);
const PENDING_STATUSES = new Set(["new", "reviewing"]);
const MAX_RECALL_SOURCE_DOCUMENTS = 5;
const MAX_PROMPT_CHARS = 3900;

export function journalCatchUpWindowLabel(window: JournalCatchUpWindow): string {
  if (window === "24h") return "last 24 hours";
  if (window === "7d") return "last 7 days";
  return "all loaded Journal history";
}

export function journalCatchUpSince(window: JournalCatchUpWindow, now = Date.now()): number | null {
  if (window === "24h") return now - 24 * 60 * 60 * 1000;
  if (window === "7d") return now - 7 * 24 * 60 * 60 * 1000;
  return null;
}

function timestampInWindow(value: number | null | undefined, since: number | null): boolean {
  if (since === null) return true;
  return typeof value === "number" && Number.isFinite(value) && value >= since;
}

function sourceTimestamp(source: JournalCatchUpSource): number | null | undefined {
  return source.created_at ?? source.entryCreatedAt;
}

function candidateTimestamp(candidate: JournalCatchUpReviewCandidate): number | null | undefined {
  return candidate.updated_at ?? candidate.created_at;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function entryUsesExcludedDocument(entry: JournalCatchUpEntry, excluded: Set<string>): boolean {
  return (entry.documents ?? []).some((doc) => excluded.has(doc.id));
}

function entryMentionsExcludedSource(entry: JournalCatchUpEntry, excludedSourceNeedles: string[]): boolean {
  if (excludedSourceNeedles.length === 0) return false;
  const haystack = normalizedText([
    entry.body,
    ...(entry.documents ?? []).map((doc) => doc.filename),
  ].join(" "));
  return excludedSourceNeedles.some((needle) => needle.length > 0 && haystack.includes(needle));
}

function candidateMentionsExcludedSource(
  candidate: JournalCatchUpReviewCandidate,
  excludedSourceNeedles: string[],
): boolean {
  if (excludedSourceNeedles.length === 0) return false;
  const haystack = normalizedText([
    candidate.title,
    candidate.proposed_text,
    candidate.evidence,
  ].join(" "));
  return excludedSourceNeedles.some((needle) => needle.length > 0 && haystack.includes(needle));
}

export function buildJournalCatchUpContext(input: {
  window: JournalCatchUpWindow;
  now?: number;
  entries: JournalCatchUpEntry[];
  sources: JournalCatchUpSource[];
  reviewCandidates: JournalCatchUpReviewCandidate[];
  excludedDocumentIds?: string[];
}): JournalCatchUpContext {
  const now = input.now ?? Date.now();
  const since = journalCatchUpSince(input.window, now);
  const excluded = new Set(input.excludedDocumentIds ?? []);
  const includedSources = input.sources.filter(
    (source) => timestampInWindow(sourceTimestamp(source), since) && !excluded.has(source.id),
  );
  const excludedSourceMatches = input.sources.filter(
    (source) => timestampInWindow(sourceTimestamp(source), since) && excluded.has(source.id),
  );
  const allExcludedSources = input.sources.filter((source) => excluded.has(source.id));
  const excludedSourceNeedles = allExcludedSources.flatMap((source) => [
    normalizedText(source.id),
    normalizedText(source.filename),
  ]).filter(Boolean);
  const candidatesInWindow = input.reviewCandidates.filter(
    (candidate) => timestampInWindow(candidateTimestamp(candidate), since)
      && !candidateMentionsExcludedSource(candidate, excludedSourceNeedles),
  );

  return {
    window: input.window,
    windowLabel: journalCatchUpWindowLabel(input.window),
    since,
    entryIds: input.entries
      .filter((entry) => timestampInWindow(entry.created_at, since)
        && !entryUsesExcludedDocument(entry, excluded)
        && !entryMentionsExcludedSource(entry, excludedSourceNeedles))
      .map((entry) => entry.id),
    sourceIds: includedSources.map((source) => source.id),
    reviewedCandidateIds: candidatesInWindow
      .filter((candidate) => REVIEWED_STATUSES.has(String(candidate.status ?? "")))
      .map((candidate) => candidate.id),
    pendingCandidateIds: candidatesInWindow
      .filter((candidate) => PENDING_STATUSES.has(String(candidate.status ?? "")))
      .map((candidate) => candidate.id),
    recallSourceDocumentIds: includedSources.map((source) => source.id).slice(0, MAX_RECALL_SOURCE_DOCUMENTS),
    omittedExcludedSourceCount: excludedSourceMatches.length,
  };
}

function compact(value: unknown, max = 160): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Not provided";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function byIds<T extends { id: string }>(items: T[], ids: string[], limit: number): T[] {
  const idSet = new Set(ids);
  return items.filter((item) => idSet.has(item.id)).slice(0, limit);
}

function candidateLine(candidate: JournalCatchUpReviewCandidate): string {
  return `- ${compact(candidate.title, 96)} (${compact(candidate.candidate_type, 36)} / ${compact(candidate.status, 36)}): ${compact(candidate.proposed_text, 140)} Evidence: ${compact(candidate.evidence, 100)}`;
}

function fitPrompt(lines: string[]): string {
  const prompt = lines.filter((line) => line !== "").join("\n");
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  const suffix = "\n[Catch-up prompt truncated to fit the Journal assistant request limit. Use the included source scope and summarize only visible context.]";
  return `${prompt.slice(0, MAX_PROMPT_CHARS - suffix.length)}${suffix}`;
}

export function buildJournalCatchUpPrompt(input: {
  context: JournalCatchUpContext;
  entries: JournalCatchUpEntry[];
  sources: JournalCatchUpSource[];
  reviewCandidates: JournalCatchUpReviewCandidate[];
}): string {
  const entries = byIds(input.entries, input.context.entryIds, 6);
  const sources = byIds(input.sources, input.context.sourceIds, MAX_RECALL_SOURCE_DOCUMENTS);
  const reviewed = byIds(input.reviewCandidates, input.context.reviewedCandidateIds, 5);
  const pending = byIds(input.reviewCandidates, input.context.pendingCandidateIds, 5);
  const omitted = input.context.omittedExcludedSourceCount > 0
    ? `Excluded source matches omitted: ${input.context.omittedExcludedSourceCount}. Do not use or infer from omitted excluded uploads.`
    : "";

  return fitPrompt([
    `What changed in the ${input.context.windowLabel}?`,
    "Use the current brief baseline plus the Journal context below. Produce sections: What changed, Evidence, Reviewed account signals, Pending review, Risks/open questions, Suggested next move.",
    "Do not edit the brief, create review candidates, mark actions official, or change source inclusion/exclusion state. Treat pending/new/reviewing candidates as drafts only.",
    "Cite source labels like [J1] and [D1] when available; otherwise cite filenames or Journal entry descriptions. Saved candidate evidence labels are historical and not global source indexes.",
    "",
    entries.length > 0 ? "Journal entries:" : "Journal entries: none in this window",
    ...entries.map((entry, index) => `- J${index + 1}: ${compact(entry.author?.display_name || entry.author?.email || entry.author_type || "Journal", 72)} — ${compact(entry.body)}`),
    "",
    sources.length > 0 ? "Included uploaded sources:" : "Included uploaded sources: none in this window",
    ...sources.map((source, index) => `- D${index + 1}: ${compact(source.filename, 96)} — ${compact(source.content_preview || source.entryBody)}`),
    omitted,
    "",
    reviewed.length > 0 ? "Accepted/applied review candidates:" : "Accepted/applied review candidates: none in this window",
    ...reviewed.map(candidateLine),
    "",
    pending.length > 0 ? "Pending review candidates:" : "Pending review candidates: none in this window",
    ...pending.map(candidateLine),
  ]);
}
