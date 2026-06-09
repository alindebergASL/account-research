// Static lookup tables and prompt catalogs for the Journal section.
// Extracted verbatim from JournalSection.tsx (behavior-preserving).
import type {
  IntelligenceAction,
  ReviewCandidateStatus,
  ReviewCandidateType,
  TimelineFilter,
} from "./types";

export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export const timelineFilterLabels: Record<TimelineFilter, string> = {
  all: "All entries",
  notes: "Notes",
  assistant: "Assistant",
  documents: "Documents",
};

export const candidateTypeLabels: Record<ReviewCandidateType, string> = {
  brief_update: "Brief update",
  action_item: "Action item",
  decision: "Decision",
  open_question: "Open question",
};

export const candidateStatusLabels: Record<ReviewCandidateStatus, string> = {
  new: "New",
  reviewing: "Reviewing",
  accepted: "Accepted",
  sent_to_brief_chat: "Sent to brief chat",
  applied: "Applied",
  dismissed: "Dismissed",
};

export const STRUCTURED_REVIEW_BOARDS: Array<{
  type: ReviewCandidateType;
  title: string;
  description: string;
  empty: string;
}> = [
  {
    type: "action_item",
    title: "Actions board",
    description: "Follow-ups, owners, deliverables, and next moves that need human review.",
    empty: "No action item candidates yet.",
  },
  {
    type: "decision",
    title: "Decisions log",
    description: "Accepted or pending decisions with evidence before they become account truth.",
    empty: "No decision candidates yet.",
  },
  {
    type: "open_question",
    title: "Open questions",
    description: "Unknowns and follow-up questions that still need evidence or owner input.",
    empty: "No open question candidates yet.",
  },
  {
    type: "brief_update",
    title: "Brief updates",
    description: "Field-level account brief changes to send through the normal versioned brief flow.",
    empty: "No brief update candidates yet.",
  },
];

export const INTELLIGENCE_ACTIONS: IntelligenceAction[] = [
  {
    label: "Catch me up",
    description: "Concise account catch-up grounded in recent evidence.",
    primary: true,
    prompt:
      "Catch me up on this account using the current brief baseline plus recent journal notes and uploaded documents. Use sections: Current state, What changed, What needs attention, Suggested next move, Evidence. Cite source labels like [J1] and [D1].",
  },
  {
    label: "What changed since the last brief version",
    description: "New evidence, challenged assumptions, and stale fields.",
    prompt:
      "Explain what changed since the last brief version based on recent journal notes and uploaded documents. Identify new facts, changed assumptions, stale brief fields, unresolved questions, and recommended brief-update candidates. Cite source labels like [J1] and [D1].",
  },
  {
    label: "What needs attention",
    description: "Prioritized risks, blockers, and next actions.",
    prompt:
      "Identify what needs attention for this account now. Rank the highest-priority risks, blockers, open questions, and next actions. For each item include why it matters, evidence source labels like [J1] or [D1], and whether it should become a review candidate.",
  },
  {
    label: "Generate account update",
    description: "What changed, why it matters, and recommended moves.",
    primary: true,
    prompt:
      "Generate an account update from the recent journal notes and uploaded documents, explicitly comparing it to the current brief baseline. Use sections: What changed, Current brief baseline, Evidence, Recommended next moves. Cite source labels like [J1] and [D1] for factual claims.",
  },
  {
    label: "Extract action items",
    description: "Owners, deliverables, dates, and evidence.",
    prompt:
      "Extract action items from the recent journal notes and uploaded documents. For each action item include owner if stated, deliverable, due date or trigger if stated, and supporting source labels like [J1] or [D1]. If ownership or dates are missing, say so explicitly.",
  },
  {
    label: "Find brief update candidates",
    description: "Field-level suggestions to send to brief chat.",
    prompt:
      "Find brief update candidates supported by the recent journal notes and uploaded documents. For each candidate include the target brief section or field, which current brief claim it supports, contradicts, or updates, proposed change, confidence, and evidence source labels like [J1] or [D1]. Do not claim you edited the brief.",
  },
  {
    label: "Draft follow-up",
    description: "A concise stakeholder-ready note.",
    prompt:
      "Draft a concise follow-up message for the account team based on recent journal notes and uploaded documents. Include key context, next steps, and source labels like [J1] or [D1] in a short evidence section.",
  },
  {
    label: "Open questions",
    description: "Gaps to resolve before outreach or brief edits.",
    prompt:
      "Identify open questions and evidence gaps from the recent journal notes and uploaded documents. Group by account strategy, stakeholders, technical fit, procurement, and next action. Cite source labels where a gap is based on a specific note or document.",
  },
];

export const REVIEW_QUEUE_ACTIONS: IntelligenceAction[] = [
  {
    label: "Review brief update candidates",
    description: "Proposed brief changes with target fields, confidence, and evidence.",
    primary: true,
    prompt:
      "Create a review queue of brief update candidates from recent journal notes and uploaded documents. For each candidate include: target brief section or field, current brief baseline or claim, proposed text, evidence source labels like [J1] or [D1], confidence, risk of applying, and suggested reviewer action. Do not claim you edited the brief; this is a human-review queue only.",
  },
  {
    label: "Review action items",
    description: "Suggested tasks that need owner/date review before becoming durable.",
    prompt:
      "Create a human-review queue of action item candidates from recent journal notes and uploaded documents. For each candidate include: task, owner if stated, due date or trigger if stated, evidence source labels like [J1] or [D1], missing fields, confidence, and suggested reviewer action. Do not assign anyone or create durable tasks.",
  },
  {
    label: "Review decisions",
    description: "Potential decisions, rationale, reversals, and contradictions.",
    prompt:
      "Create a human-review queue of decision candidates from recent journal notes and uploaded documents. For each candidate include: decision statement, date or timing if known, decider or owner if stated, rationale, evidence source labels like [J1] or [D1], alternatives or reversal conditions if present, confidence, and suggested reviewer action. Do not mark anything official.",
  },
  {
    label: "Review open questions",
    description: "Unresolved account questions to ask, answer, or convert to brief updates.",
    prompt:
      "Create a human-review queue of open questions from recent journal notes and uploaded documents. Group by account strategy, stakeholders, technical fit, procurement, budget/timing, competitors, and next meeting prep. For each question include evidence source labels like [J1] or [D1], why it matters, whether it blocks outreach or brief edits, and suggested reviewer action.",
  },
];
