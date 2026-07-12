import { db, type JournalReviewCandidateRow } from "@/lib/db";
import { newId } from "@/lib/password";

export const REVIEW_CANDIDATE_TYPES = [
  "brief_update",
  "action_item",
  "decision",
  "open_question",
] as const;

export const REVIEW_CANDIDATE_STATUSES = [
  "new",
  "reviewing",
  "accepted",
  "sent_to_brief_chat",
  "applied",
  "dismissed",
] as const;

export type ReviewCandidateType = (typeof REVIEW_CANDIDATE_TYPES)[number];
export type ReviewCandidateStatus = (typeof REVIEW_CANDIDATE_STATUSES)[number];

export type ReviewCandidateDto = {
  id: string;
  candidate_type: ReviewCandidateType;
  status: ReviewCandidateStatus;
  title: string;
  proposed_text: string;
  target: string | null;
  current_baseline: string | null;
  evidence: string | null;
  confidence: string | null;
  risk: string | null;
  source_entry_id: string | null;
  created_at: number;
  updated_at: number;
  promoted_task_id: string | null;
  promoted_decision_id: string | null;
};

type DecoratedCandidateRow = JournalReviewCandidateRow & {
  promoted_task_id: string | null;
  promoted_decision_id: string | null;
};

const MAX_TITLE_CHARS = 160;
const MAX_FIELD_CHARS = 1200;

function isReviewCandidateType(value: string): value is ReviewCandidateType {
  return (REVIEW_CANDIDATE_TYPES as readonly string[]).includes(value);
}

function isReviewCandidateStatus(value: string): value is ReviewCandidateStatus {
  return (REVIEW_CANDIDATE_STATUSES as readonly string[]).includes(value);
}

function stringField(value: unknown, field: string, max: number, required = false): string | null {
  if (value == null) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (trimmed.length > max) throw new Error(`${field} is too long`);
  return trimmed;
}

export function parseCreateReviewCandidateInput(body: any): {
  candidate_type: ReviewCandidateType;
  title: string;
  proposed_text: string;
  target: string | null;
  current_baseline: string | null;
  evidence: string | null;
  confidence: string | null;
  risk: string | null;
  source_entry_id: string | null;
} {
  const rawType = typeof body?.candidate_type === "string" ? body.candidate_type : "";
  if (!isReviewCandidateType(rawType)) throw new Error("candidate_type is invalid");
  return {
    candidate_type: rawType,
    title: stringField(body?.title, "title", MAX_TITLE_CHARS, true) ?? "",
    proposed_text: stringField(body?.proposed_text, "proposed_text", MAX_FIELD_CHARS, true) ?? "",
    target: stringField(body?.target, "target", MAX_FIELD_CHARS),
    current_baseline: stringField(body?.current_baseline, "current_baseline", MAX_FIELD_CHARS),
    evidence: stringField(body?.evidence, "evidence", MAX_FIELD_CHARS),
    confidence: stringField(body?.confidence, "confidence", 80),
    risk: stringField(body?.risk, "risk", MAX_FIELD_CHARS),
    source_entry_id: stringField(body?.source_entry_id, "source_entry_id", 128),
  };
}

export function parseReviewCandidateStatus(value: unknown): ReviewCandidateStatus {
  if (typeof value !== "string" || !isReviewCandidateStatus(value)) {
    throw new Error("status is invalid");
  }
  return value;
}

export function rowToReviewCandidateDto(row: DecoratedCandidateRow): ReviewCandidateDto {
  return {
    id: row.id,
    candidate_type: row.candidate_type,
    status: row.status,
    title: row.title,
    proposed_text: row.proposed_text,
    target: row.target,
    current_baseline: row.current_baseline,
    evidence: row.evidence,
    confidence: row.confidence,
    risk: row.risk,
    source_entry_id: row.source_entry_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    promoted_task_id: row.promoted_task_id ?? null,
    promoted_decision_id: row.promoted_decision_id ?? null,
  };
}

export function listReviewCandidates(briefId: string): ReviewCandidateDto[] {
  const rows = db()
    .prepare(
      `SELECT c.*,
              (SELECT t.id FROM journal_tasks t
                WHERE t.source_candidate_id = c.id AND t.deleted_at IS NULL LIMIT 1) AS promoted_task_id,
              (SELECT d.id FROM journal_decisions d
                WHERE d.source_candidate_id = c.id AND d.deleted_at IS NULL LIMIT 1) AS promoted_decision_id
         FROM journal_review_candidates c
        WHERE c.brief_id = ? AND c.deleted_at IS NULL
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(briefId) as DecoratedCandidateRow[];
  return rows.map(rowToReviewCandidateDto);
}

export function insertReviewCandidate(args: {
  briefId: string;
  userId: string | null;
  candidate_type: ReviewCandidateType;
  title: string;
  proposed_text: string;
  target: string | null;
  current_baseline: string | null;
  evidence: string | null;
  confidence: string | null;
  risk: string | null;
  source_entry_id: string | null;
}): ReviewCandidateDto {
  const now = Date.now();
  const id = newId();
  db()
    .prepare(
      `INSERT INTO journal_review_candidates
         (id, brief_id, user_id, source_entry_id, candidate_type, status, title,
          proposed_text, target, current_baseline, evidence, confidence, risk,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.briefId,
      args.userId,
      args.source_entry_id,
      args.candidate_type,
      args.title,
      args.proposed_text,
      args.target,
      args.current_baseline,
      args.evidence,
      args.confidence,
      args.risk,
      now,
      now,
    );
  return getReviewCandidate(args.briefId, id);
}

export function getReviewCandidate(briefId: string, candidateId: string): ReviewCandidateDto {
  const row = db()
    .prepare(
      `SELECT c.*,
              (SELECT t.id FROM journal_tasks t
                WHERE t.source_candidate_id = c.id AND t.deleted_at IS NULL LIMIT 1) AS promoted_task_id,
              (SELECT d.id FROM journal_decisions d
                WHERE d.source_candidate_id = c.id AND d.deleted_at IS NULL LIMIT 1) AS promoted_decision_id
         FROM journal_review_candidates c
        WHERE c.id = ? AND c.brief_id = ? AND c.deleted_at IS NULL`,
    )
    .get(candidateId, briefId) as DecoratedCandidateRow | undefined;
  if (!row) throw new Error("Review candidate not found");
  return rowToReviewCandidateDto(row);
}

export function updateReviewCandidateStatus(
  briefId: string,
  candidateId: string,
  status: ReviewCandidateStatus,
): ReviewCandidateDto {
  const now = Date.now();
  const result = db()
    .prepare(
      `UPDATE journal_review_candidates
          SET status = ?, updated_at = ?
        WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
    )
    .run(status, now, candidateId, briefId);
  if (result.changes !== 1) throw new Error("Review candidate not found");
  return getReviewCandidate(briefId, candidateId);
}
