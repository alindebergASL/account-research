import { isActiveBriefMember } from "@/lib/briefAccess";
import { createBriefEventStrict } from "@/lib/briefEvents";
import { db, type JournalReviewCandidateRow, type JournalTaskRow, type JournalDecisionRow } from "@/lib/db";
import { insertDecision, MAX_DECISION_FIELD_CHARS, type JournalDecisionDto } from "@/lib/journalDecisions";
import { insertTask, MAX_TASK_EVIDENCE_CHARS, type JournalTaskDto } from "@/lib/journalTasks";

export type PromotionResult =
  | { kind: "task"; task: JournalTaskDto; created: boolean }
  | { kind: "decision"; decision: JournalDecisionDto; created: boolean };

const FORBIDDEN_INPUT_FIELDS = [
  "source_candidate_id", "source_entry_id", "evidence_snapshot", "promoted_by", "promoted_at", "created_by",
];

const SNAPSHOT_MAX_CHARS = Math.min(MAX_TASK_EVIDENCE_CHARS, MAX_DECISION_FIELD_CHARS);
const TRUNCATION_MARKER = "[truncated]";
const SNAPSHOT_FREE_TEXT_FIELDS = [
  "title", "proposed_text", "target", "current_baseline", "evidence", "confidence", "risk",
] as const;

function boundedJsonString(value: string | null, serializedBudget: number): string | null {
  if (value == null || JSON.stringify(value).length <= serializedBudget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(`${value.slice(0, middle)}${TRUNCATION_MARKER}`).length <= serializedBudget) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${TRUNCATION_MARKER}`;
}

function snapshot(candidate: JournalReviewCandidateRow): string {
  // Bound identifier fields defensively, then distribute the remaining JSON
  // budget evenly across free text by serialized length. Measuring the JSON
  // representation (not raw input) accounts for quotes, slashes and newlines.
  const envelope = {
    schema_version: 1,
    candidate_id: boundedJsonString(candidate.id, 514),
    candidate_type: boundedJsonString(candidate.candidate_type, 130),
    title: candidate.title,
    proposed_text: candidate.proposed_text,
    target: candidate.target,
    current_baseline: candidate.current_baseline,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    risk: candidate.risk,
    source_entry_id: boundedJsonString(candidate.source_entry_id, 514),
    candidate_created_at: candidate.created_at,
    candidate_accepted_at_snapshot: candidate.updated_at,
  };
  const serialized = JSON.stringify(envelope);
  if (serialized.length <= SNAPSHOT_MAX_CHARS) return serialized;

  const minimum = { ...envelope };
  for (const field of SNAPSHOT_FREE_TEXT_FIELDS) {
    if (minimum[field] != null) minimum[field] = "";
  }
  const minimumLength = JSON.stringify(minimum).length;
  const populated = SNAPSHOT_FREE_TEXT_FIELDS.filter((field) => envelope[field] != null);
  const perFieldBudget = 2 + Math.floor((SNAPSHOT_MAX_CHARS - minimumLength) / Math.max(1, populated.length));
  for (const field of populated) {
    Object.assign(envelope, { [field]: boundedJsonString(envelope[field], perFieldBudget) });
  }
  return JSON.stringify(envelope);
}

function existingPromotion(briefId: string, candidateId: string): PromotionResult | null {
  const task = db().prepare(
    `SELECT * FROM journal_tasks WHERE brief_id = ? AND source_candidate_id = ? AND deleted_at IS NULL`,
  ).get(briefId, candidateId) as JournalTaskRow | undefined;
  if (task) {
    const all = insertlessTaskDto(task);
    return { kind: "task", task: all, created: false };
  }
  const decision = db().prepare(
    `SELECT * FROM journal_decisions WHERE brief_id = ? AND source_candidate_id = ? AND deleted_at IS NULL`,
  ).get(briefId, candidateId) as JournalDecisionRow | undefined;
  if (decision) {
    const { brief_id: _briefId, deleted_at: _deletedAt, ...dto } = decision;
    return { kind: "decision", decision: dto, created: false };
  }
  return null;
}

function insertlessTaskDto(row: JournalTaskRow): JournalTaskDto {
  return {
    id: row.id, parent_id: row.parent_id, body: row.body, done: row.done === 1,
    done_by: row.done_by, done_at: row.done_at, position: row.position,
    created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at,
    owner_text: row.owner_text, assignee_user_id: row.assignee_user_id, due_at: row.due_at,
    priority: row.priority, source_candidate_id: row.source_candidate_id,
    source_entry_id: row.source_entry_id, evidence_snapshot: row.evidence_snapshot,
    promoted_by: row.promoted_by, promoted_at: row.promoted_at, children: [],
  };
}

function validateEnvelope(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("promotion input must be an object");
  const body = input as Record<string, unknown>;
  for (const field of FORBIDDEN_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) throw new Error(`${field} is promotion-managed`);
  }
  return body;
}

export function promoteReviewCandidate(args: {
  briefId: string;
  candidateId: string;
  actorUserId: string;
  input: unknown;
}): PromotionResult {
  const input = validateEnvelope(args.input);

  try {
    return db().transaction((): PromotionResult => {
      const raced = existingPromotion(args.briefId, args.candidateId);
      if (raced) return raced;
      const candidate = db().prepare(
        `SELECT * FROM journal_review_candidates WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
      ).get(args.candidateId, args.briefId) as JournalReviewCandidateRow | undefined;
      if (!candidate) throw new Error("Review candidate not found");
      if (candidate.status !== "accepted") throw new Error("candidate must be accepted before promotion");
      if (candidate.candidate_type !== "action_item" && candidate.candidate_type !== "decision") {
        throw new Error("candidate type cannot be promoted");
      }
      const allowed = new Set(candidate.candidate_type === "action_item"
        ? ["body", "owner_text", "assignee_user_id", "due_at", "priority"]
        : ["title", "decision_statement", "rationale", "owner_text", "decision_at"]);
      for (const field of Object.keys(input)) {
        if (!allowed.has(field)) throw new Error(`${field} is not valid for ${candidate.candidate_type} promotion`);
      }
      const evidenceSnapshot = snapshot(candidate);
      if (candidate.candidate_type === "action_item") {
        const assignee = input.assignee_user_id;
        if (assignee != null && assignee !== "") {
          if (typeof assignee !== "string" || !isActiveBriefMember(assignee, args.briefId)) {
            throw new Error("assignee must be an active member with brief access");
          }
        }
        const task = insertTask({
          briefId: args.briefId,
          body: input.body ?? candidate.proposed_text,
          ownerText: input.owner_text,
          assigneeUserId: input.assignee_user_id,
          dueAt: input.due_at,
          priority: input.priority,
          evidenceSnapshot,
          createdBy: args.actorUserId,
          sourceCandidateId: candidate.id,
          sourceEntryId: candidate.source_entry_id,
          promotedBy: args.actorUserId,
          promotedAt: Date.now(),
        });
        createBriefEventStrict({
          brief_id: args.briefId, actor_user_id: args.actorUserId,
          event_type: "journal_candidate_promoted_to_task", title: "Journal action item promoted to to-do",
          metadata: {
            candidate_id: candidate.id,
            task_id: task.id,
            owner_set: !!task.owner_text,
            assignee_user_id: task.assignee_user_id,
            due_at: task.due_at,
            priority: task.priority,
            evidence_frozen: true,
          },
        });
        return { kind: "task", task, created: true };
      }
      const decision = insertDecision({
        briefId: args.briefId,
        title: input.title ?? candidate.title,
        decisionStatement: input.decision_statement ?? candidate.proposed_text,
        rationale: input.rationale ?? candidate.risk,
        ownerText: input.owner_text,
        decisionAt: input.decision_at ?? Date.now(),
        createdBy: args.actorUserId,
        sourceCandidateId: candidate.id,
        sourceEntryId: candidate.source_entry_id,
        evidenceSnapshot,
        auditEventType: "journal_candidate_promoted_to_decision",
      });
      return { kind: "decision", decision, created: true };
    })();
  } catch (error: any) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/.test(String(error?.message ?? error))) {
      const durable = existingPromotion(args.briefId, args.candidateId);
      if (durable) return durable;
    }
    throw error;
  }
}
