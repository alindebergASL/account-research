export type JournalCockpitCandidateType = "brief_update" | "action_item" | "decision" | "open_question";
export type JournalCockpitCandidateStatus =
  | "new"
  | "reviewing"
  | "accepted"
  | "sent_to_brief_chat"
  | "applied"
  | "dismissed";

export type JournalCockpitCandidate = {
  id: string;
  candidate_type: JournalCockpitCandidateType;
  status: JournalCockpitCandidateStatus;
  title: string;
  proposed_text: string;
  target: string | null;
  current_baseline?: string | null;
  evidence: string | null;
  confidence: string | null;
  risk: string | null;
  source_entry_id?: string | null;
  created_at: number;
  updated_at: number;
};

export type JournalCockpitSummary = {
  reviewedCount: number;
  pendingCount: number;
  dismissedCount: number;
  priorityCards: JournalCockpitCandidate[];
  cardsByType: Record<JournalCockpitCandidateType, JournalCockpitCandidate[]>;
};

export const REVIEWED_COCKPIT_STATUSES: readonly JournalCockpitCandidateStatus[] = [
  "accepted",
  "sent_to_brief_chat",
  "applied",
];

const COCKPIT_TYPES: JournalCockpitCandidateType[] = [
  "brief_update",
  "action_item",
  "decision",
  "open_question",
];

function byMostRecent(a: JournalCockpitCandidate, b: JournalCockpitCandidate): number {
  return b.updated_at - a.updated_at || b.created_at - a.created_at;
}

export function buildJournalCockpitSummary(candidates: JournalCockpitCandidate[]): JournalCockpitSummary {
  const reviewedStatuses = new Set(REVIEWED_COCKPIT_STATUSES);
  const reviewed = candidates
    .filter((candidate) => reviewedStatuses.has(candidate.status))
    .sort(byMostRecent);
  const pendingCount = candidates.filter(
    (candidate) => candidate.status === "new" || candidate.status === "reviewing",
  ).length;
  const dismissedCount = candidates.filter((candidate) => candidate.status === "dismissed").length;
  const cardsByType = Object.fromEntries(
    COCKPIT_TYPES.map((type) => [
      type,
      reviewed.filter((candidate) => candidate.candidate_type === type),
    ]),
  ) as Record<JournalCockpitCandidateType, JournalCockpitCandidate[]>;

  return {
    reviewedCount: reviewed.length,
    pendingCount,
    dismissedCount,
    priorityCards: reviewed.slice(0, 4),
    cardsByType,
  };
}
