export type ReviewInboxTab = "pending" | "history";
export type ReviewInboxCandidateType =
  | "brief_update"
  | "action_item"
  | "decision"
  | "open_question";
export type ReviewInboxTypeFilter = "all" | ReviewInboxCandidateType;
export type ReviewInboxCandidateStatus =
  | "new"
  | "reviewing"
  | "accepted"
  | "sent_to_brief_chat"
  | "applied"
  | "dismissed";

type InboxCandidate = {
  id: string;
  status: ReviewInboxCandidateStatus;
  candidate_type: ReviewInboxCandidateType;
};

const PENDING_STATUSES = new Set<ReviewInboxCandidateStatus>(["new", "reviewing"]);
const TYPES: ReviewInboxCandidateType[] = [
  "brief_update",
  "action_item",
  "decision",
  "open_question",
];

export function reviewInboxTabForStatus(status: ReviewInboxCandidateStatus): ReviewInboxTab {
  return PENDING_STATUSES.has(status) ? "pending" : "history";
}

export function partitionReviewInbox<T extends InboxCandidate>(candidates: readonly T[]): {
  pending: T[];
  history: T[];
} {
  const pending: T[] = [];
  const history: T[] = [];
  for (const candidate of candidates) {
    (reviewInboxTabForStatus(candidate.status) === "pending" ? pending : history).push(candidate);
  }
  return { pending, history };
}

export function countReviewInbox<T extends InboxCandidate>(
  candidates: readonly T[],
  activeTab: ReviewInboxTab,
): {
  pending: number;
  history: number;
  types: Record<ReviewInboxTypeFilter, number>;
} {
  const partition = partitionReviewInbox(candidates);
  const active = partition[activeTab];
  const types = {
    all: active.length,
    brief_update: 0,
    action_item: 0,
    decision: 0,
    open_question: 0,
  } satisfies Record<ReviewInboxTypeFilter, number>;
  for (const candidate of active) types[candidate.candidate_type] += 1;
  return { pending: partition.pending.length, history: partition.history.length, types };
}

export function filterReviewInboxCandidates<T extends InboxCandidate>(
  candidates: readonly T[],
  filters: {
    tab: ReviewInboxTab;
    type: ReviewInboxTypeFilter;
    searchMatchIds?: ReadonlySet<string>;
  },
): T[] {
  return candidates.filter((candidate) =>
    reviewInboxTabForStatus(candidate.status) === filters.tab &&
    (filters.type === "all" || candidate.candidate_type === filters.type) &&
    (!filters.searchMatchIds || filters.searchMatchIds.has(candidate.id)),
  );
}

export function selectReviewInboxTabForMatches<T extends InboxCandidate>(
  candidates: readonly T[],
  matchIds: ReadonlySet<string>,
): ReviewInboxTab {
  let hasHistory = false;
  for (const candidate of candidates) {
    if (!matchIds.has(candidate.id)) continue;
    if (reviewInboxTabForStatus(candidate.status) === "pending") return "pending";
    hasHistory = true;
  }
  return hasHistory ? "history" : "pending";
}

export const REVIEW_INBOX_TYPES = TYPES;
