export type JournalSearchEntry = {
  id: string;
  author_type?: string;
  body?: string | null;
  author?: { display_name?: string | null; email?: string | null } | null;
  documents?: Array<{ filename?: string | null; content_preview?: string | null }>;
};

export type JournalSearchSource = {
  id: string;
  filename?: string | null;
  content_preview?: string | null;
  entryBody?: string | null;
  entryAuthor?: string | null;
};

export type JournalSearchReviewCandidate = {
  id: string;
  candidate_type?: string;
  status?: string;
  title?: string | null;
  proposed_text?: string | null;
  target?: string | null;
  current_baseline?: string | null;
  evidence?: string | null;
  confidence?: string | null;
  risk?: string | null;
};

export type JournalWorkspaceSearchInput = {
  query: string;
  entries: JournalSearchEntry[];
  sources: JournalSearchSource[];
  reviewCandidates: JournalSearchReviewCandidate[];
  excludedDocumentIds?: string[];
};

export type JournalWorkspaceSearchResult = {
  query: string;
  isActive: boolean;
  entryIds: string[];
  sourceIds: string[];
  reviewCandidateIds: string[];
  recallSourceDocumentIds: string[];
  hasMatches: boolean;
};

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase().trim();
}

function labelize(value: unknown): string {
  return String(value ?? "").replace(/_/g, " ");
}

function matchesQuery(query: string, fields: unknown[]): boolean {
  const haystack = fields.map((field) => normalize(field)).join("\n");
  return haystack.includes(query);
}

function compact(value: unknown, max = 280): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function buildJournalSearchRecallPrompt(input: {
  query: string;
  entries: JournalSearchEntry[];
  sources: JournalSearchSource[];
  reviewCandidates: JournalSearchReviewCandidate[];
  result: JournalWorkspaceSearchResult;
}): string {
  const entryIds = new Set(input.result.entryIds);
  const sourceIds = new Set(input.result.sourceIds);
  const candidateIds = new Set(input.result.reviewCandidateIds);
  const entries = input.entries.filter((entry) => entryIds.has(entry.id)).slice(0, 8);
  const recalledSourceIds = new Set(input.result.recallSourceDocumentIds);
  const sources = input.sources.filter((source) => sourceIds.has(source.id) && recalledSourceIds.has(source.id)).slice(0, 8);
  const omittedSourceCount = input.result.sourceIds.filter((id) => !recalledSourceIds.has(id)).length;
  const candidates = input.reviewCandidates.filter((candidate) => candidateIds.has(candidate.id)).slice(0, 8);

  const sections = [
    `Using the current Journal search results for "${compact(input.query, 120)}", summarize what changed, what evidence supports it, what review candidates are relevant, and the next best account-team move. Cite source labels like [J1] and [D1] when available. Do not edit the brief.`,
    "",
    "SEARCH RESULT CONTEXT (user-selected, not durable brief truth):",
    entries.length > 0 ? "Timeline matches:" : "Timeline matches: none",
    ...entries.map((entry, index) =>
      `- J${index + 1}: ${compact(entry.author?.display_name || entry.author?.email || entry.author_type || "Journal")} — ${compact(entry.body)}`,
    ),
    sources.length > 0 ? "Source matches:" : "Source matches: none",
    ...sources.map((source, index) =>
      `- D${index + 1}: ${compact(source.filename)} — ${compact(source.content_preview || source.entryBody)}`,
    ),
    ...(omittedSourceCount > 0
      ? [`${omittedSourceCount} excluded source match omitted from AI context.`]
      : []),
    candidates.length > 0 ? "Review candidate matches:" : "Review candidate matches: none",
    ...candidates.map((candidate, index) =>
      `- C${index + 1}: ${compact(candidate.title)} (${compact(labelize(candidate.candidate_type))}, ${compact(labelize(candidate.status))}) — ${compact(candidate.proposed_text)} Evidence: ${compact(candidate.evidence)}`,
    ),
  ];

  return sections.join("\n");
}

export function searchJournalWorkspace(input: JournalWorkspaceSearchInput): JournalWorkspaceSearchResult {
  const query = normalize(input.query);
  const isActive = query.length > 0;
  const excluded = new Set(input.excludedDocumentIds ?? []);

  const matchingEntries = isActive
    ? input.entries.filter((entry) =>
        matchesQuery(query, [
          entry.body,
          entry.author_type,
          entry.author?.display_name,
          entry.author?.email,
          ...(entry.documents ?? []).flatMap((doc) => [doc.filename, doc.content_preview]),
        ]),
      )
    : input.entries;

  const matchingSources = isActive
    ? input.sources.filter((source) =>
        matchesQuery(query, [source.filename, source.content_preview, source.entryBody, source.entryAuthor]),
      )
    : input.sources;

  const matchingReviewCandidates = isActive
    ? input.reviewCandidates.filter((candidate) =>
        matchesQuery(query, [
          candidate.title,
          candidate.proposed_text,
          candidate.target,
          candidate.current_baseline,
          candidate.evidence,
          candidate.confidence,
          candidate.risk,
          candidate.candidate_type,
          labelize(candidate.candidate_type),
          candidate.status,
          labelize(candidate.status),
        ]),
      )
    : input.reviewCandidates;

  const recallSourceDocumentIds = matchingSources
    .map((source) => source.id)
    .filter((id) => !excluded.has(id));

  return {
    query,
    isActive,
    entryIds: matchingEntries.map((entry) => entry.id),
    sourceIds: matchingSources.map((source) => source.id),
    reviewCandidateIds: matchingReviewCandidates.map((candidate) => candidate.id),
    recallSourceDocumentIds,
    hasMatches:
      matchingEntries.length > 0 || matchingSources.length > 0 || matchingReviewCandidates.length > 0,
  };
}
