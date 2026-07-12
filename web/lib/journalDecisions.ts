import { createBriefEventStrict } from "@/lib/briefEvents";
import { db, type JournalDecisionRow } from "@/lib/db";
import { newId } from "@/lib/password";

export const DECISION_LIFECYCLES = ["active", "superseded", "revoked"] as const;
export type DecisionLifecycle = (typeof DECISION_LIFECYCLES)[number];
export const MAX_DECISION_TITLE_CHARS = 160;
export const MAX_DECISION_FIELD_CHARS = 8000;

export type JournalDecisionDto = Omit<JournalDecisionRow, "brief_id" | "deleted_at">;

function text(value: unknown, field: string, max: number, required = false): string | null {
  if (value == null) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (trimmed.length > max) throw new Error(`${field} is too long`);
  return trimmed;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer timestamp`);
  }
  return value;
}

function rowToDto(row: JournalDecisionRow): JournalDecisionDto {
  const { brief_id: _briefId, deleted_at: _deletedAt, ...dto } = row;
  return dto;
}

function row(briefId: string, decisionId: string): JournalDecisionRow | null {
  return (db()
    .prepare(`SELECT * FROM journal_decisions WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`)
    .get(decisionId, briefId) as JournalDecisionRow | undefined) ?? null;
}

export function getDecision(briefId: string, decisionId: string): JournalDecisionDto {
  const found = row(briefId, decisionId);
  if (!found) throw new Error("decision not found");
  return rowToDto(found);
}

export function listDecisions(briefId: string): JournalDecisionDto[] {
  return (db()
    .prepare(
      `SELECT * FROM journal_decisions
        WHERE brief_id = ? AND deleted_at IS NULL
        ORDER BY CASE lifecycle WHEN 'active' THEN 0 WHEN 'superseded' THEN 1 ELSE 2 END,
                 decision_at DESC, created_at DESC`,
    )
    .all(briefId) as JournalDecisionRow[]).map(rowToDto);
}

export type CreateDecisionArgs = {
  briefId: string;
  title: unknown;
  decisionStatement: unknown;
  rationale?: unknown;
  ownerText?: unknown;
  decisionAt: unknown;
  supersedesId?: string | null;
  createdBy: string | null;
  sourceCandidateId?: string | null;
  sourceEntryId?: string | null;
  evidenceSnapshot?: unknown;
  auditEventType?: "journal_candidate_promoted_to_decision";
};

export function insertDecision(args: CreateDecisionArgs): JournalDecisionDto {
  const title = text(args.title, "title", MAX_DECISION_TITLE_CHARS, true)!;
  const statement = text(args.decisionStatement, "decision_statement", MAX_DECISION_FIELD_CHARS, true)!;
  const rationale = text(args.rationale, "rationale", MAX_DECISION_FIELD_CHARS);
  const ownerText = text(args.ownerText, "owner_text", MAX_DECISION_TITLE_CHARS);
  const evidence = text(args.evidenceSnapshot, "evidence_snapshot", MAX_DECISION_FIELD_CHARS);
  const decisionAt = timestamp(args.decisionAt, "decision_at");
  const supersedesId = args.supersedesId ?? null;
  const id = newId();
  const now = Date.now();

  const create = db().transaction(() => {
    let prior: JournalDecisionRow | null = null;
    if (supersedesId) {
      prior = row(args.briefId, supersedesId);
      if (!prior) throw new Error("superseded decision not found");
      if (prior.lifecycle !== "active" || prior.superseded_by_id) {
        throw new Error("only an active decision can be superseded");
      }
      // A valid chain always points backwards. Walking it also fails closed on
      // pre-existing corrupt cycles rather than extending one.
      const seen = new Set<string>([id]);
      let cursor: JournalDecisionRow | null = prior;
      while (cursor) {
        if (seen.has(cursor.id)) throw new Error("decision supersession cycle detected");
        seen.add(cursor.id);
        cursor = cursor.supersedes_id ? row(args.briefId, cursor.supersedes_id) : null;
      }
    }

    db().prepare(
      `INSERT INTO journal_decisions
       (id, brief_id, title, decision_statement, rationale, owner_text, decision_at,
        lifecycle, source_candidate_id, source_entry_id, evidence_snapshot,
        supersedes_id, superseded_by_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      id, args.briefId, title, statement, rationale, ownerText, decisionAt,
      args.sourceCandidateId ?? null, args.sourceEntryId ?? null, evidence,
      supersedesId, args.createdBy, now, now,
    );
    if (prior) {
      const changed = db().prepare(
        `UPDATE journal_decisions
            SET lifecycle = 'superseded', superseded_by_id = ?, updated_at = ?
          WHERE id = ? AND brief_id = ? AND lifecycle = 'active'
            AND superseded_by_id IS NULL AND deleted_at IS NULL`,
      ).run(id, now, prior.id, args.briefId);
      if (changed.changes !== 1) throw new Error("decision was superseded concurrently");
    }
    createBriefEventStrict({
      brief_id: args.briefId,
      actor_user_id: args.createdBy,
      event_type: supersedesId
        ? "journal_decision_superseded"
        : args.auditEventType ?? "journal_decision_created",
      title: supersedesId
        ? "Journal decision superseded"
        : args.auditEventType === "journal_candidate_promoted_to_decision"
          ? "Journal candidate promoted to decision"
          : "Journal decision recorded",
      metadata: { decision_id: id, supersedes_id: supersedesId, source_candidate_id: args.sourceCandidateId ?? null },
    });
    return rowToDto(row(args.briefId, id)!);
  });
  return create();
}

export function updateDecision(args: {
  briefId: string;
  decisionId: string;
  title?: unknown;
  decisionStatement?: unknown;
  rationale?: unknown;
  ownerText?: unknown;
  decisionAt?: unknown;
  lifecycle?: unknown;
  actorUserId: string | null;
}): JournalDecisionDto {
  const current = row(args.briefId, args.decisionId);
  if (!current) throw new Error("decision not found");
  if (current.lifecycle === "superseded") throw new Error("superseded decisions are immutable");
  if (current.lifecycle === "revoked" && [
    args.title, args.decisionStatement, args.rationale, args.ownerText, args.decisionAt,
  ].some((value) => value !== undefined)) {
    throw new Error("revoked decisions are immutable");
  }
  let lifecycle = current.lifecycle;
  if (args.lifecycle !== undefined) {
    if (args.lifecycle !== "revoked") throw new Error("lifecycle may only transition to revoked");
    if (current.lifecycle !== "active") throw new Error("only an active decision can be revoked");
    lifecycle = "revoked";
  }
  const title = args.title === undefined ? current.title : text(args.title, "title", MAX_DECISION_TITLE_CHARS, true)!;
  const statement = args.decisionStatement === undefined
    ? current.decision_statement
    : text(args.decisionStatement, "decision_statement", MAX_DECISION_FIELD_CHARS, true)!;
  const rationale = args.rationale === undefined ? current.rationale : text(args.rationale, "rationale", MAX_DECISION_FIELD_CHARS);
  const ownerText = args.ownerText === undefined ? current.owner_text : text(args.ownerText, "owner_text", MAX_DECISION_TITLE_CHARS);
  const decisionAt = args.decisionAt === undefined ? current.decision_at : timestamp(args.decisionAt, "decision_at");
  const now = Date.now();
  const tx = db().transaction(() => {
    db().prepare(
      `UPDATE journal_decisions SET title = ?, decision_statement = ?, rationale = ?,
       owner_text = ?, decision_at = ?, lifecycle = ?, updated_at = ?
       WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
    ).run(title, statement, rationale, ownerText, decisionAt, lifecycle, now, args.decisionId, args.briefId);
    createBriefEventStrict({
      brief_id: args.briefId,
      actor_user_id: args.actorUserId,
      event_type: lifecycle === "revoked" && current.lifecycle !== lifecycle ? "journal_decision_revoked" : "journal_decision_updated",
      title: lifecycle === "revoked" ? "Journal decision revoked" : "Journal decision updated",
      metadata: { decision_id: args.decisionId, lifecycle },
    });
  });
  tx();
  return getDecision(args.briefId, args.decisionId);
}

export function softDeleteDecision(briefId: string, decisionId: string, actorUserId: string | null): void {
  const current = row(briefId, decisionId);
  if (!current) throw new Error("decision not found");
  if (current.supersedes_id || current.superseded_by_id) {
    throw new Error("linked decision history cannot be deleted");
  }
  const now = Date.now();
  db().transaction(() => {
    db().prepare(`UPDATE journal_decisions SET deleted_at = ?, updated_at = ? WHERE id = ? AND brief_id = ?`)
      .run(now, now, decisionId, briefId);
    createBriefEventStrict({
      brief_id: briefId, actor_user_id: actorUserId, event_type: "journal_decision_deleted",
      title: "Journal decision deleted", metadata: { decision_id: decisionId },
    });
  })();
}
