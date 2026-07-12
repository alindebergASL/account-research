import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { db } from "./db";

export const JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION = 1 as const;
export const JOURNAL_RADAR_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export type JournalRadarManifest = {
  schema_version: typeof JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION;
  brief: { id: string };
  entries: Array<{ id: string; author_type: string; created_at: number; edited_at: number | null; deleted_at: number | null; content_hash: string }>;
  documents: Array<{ id: string; journal_entry_id: string; filename_hash: string; mime_type: string; byte_size: number; content_hash: string; source_url_hash: string | null; created_at: number; effectively_removed_at: number | null }>;
  candidates: Array<{ id: string; candidate_type: string; status: string; created_at: number; updated_at: number; deleted_at: number | null }>;
  tasks: Array<{ id: string; created_at: number; updated_at: number; deleted_at: number | null; done: boolean; done_at: number | null; owner_text_hash: string | null; assignee_user_id: string | null; priority: string | null; due_at: number | null; content_hash: string }>;
  decisions: Array<{ id: string; created_at: number; updated_at: number; deleted_at: number | null; lifecycle: string; owner_text_hash: string | null; decision_at: number; supersedes_id: string | null; superseded_by_id: string | null; content_hash: string }>;
  brief_versions: Array<{ id: string; version_no: number; reason: string; triggered_by: string; refresh_job_id: string | null; created_at: number }>;
  monitor_updates: Array<{ id: string; ran_at: number; patches_applied: number; pre_version_id: string | null }>;
};

export type BuiltJournalRadarManifest = {
  manifest: JournalRadarManifest;
  canonicalJson: string;
  hash: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashNullable(value: string | null): string | null {
  return value === null ? null : sha256(value);
}

function sorted<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Explicit object assembly fixes both key order and array order. Do not replace
// this with a generic recursive stringify: schema evolution must remain visible.
export function canonicalizeJournalRadarManifest(input: JournalRadarManifest): string {
  const manifest: JournalRadarManifest = {
    schema_version: JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION,
    brief: { id: input.brief.id },
    entries: sorted(input.entries).map((row) => ({
      id: row.id, author_type: row.author_type, created_at: row.created_at,
      edited_at: row.edited_at, deleted_at: row.deleted_at, content_hash: row.content_hash,
    })),
    documents: sorted(input.documents).map((row) => ({
      id: row.id, journal_entry_id: row.journal_entry_id, filename_hash: row.filename_hash,
      mime_type: row.mime_type, byte_size: row.byte_size, content_hash: row.content_hash,
      source_url_hash: row.source_url_hash, created_at: row.created_at,
      effectively_removed_at: row.effectively_removed_at,
    })),
    candidates: sorted(input.candidates).map((row) => ({
      id: row.id, candidate_type: row.candidate_type, status: row.status,
      created_at: row.created_at, updated_at: row.updated_at, deleted_at: row.deleted_at,
    })),
    tasks: sorted(input.tasks).map((row) => ({
      id: row.id, created_at: row.created_at, updated_at: row.updated_at,
      deleted_at: row.deleted_at, done: row.done, done_at: row.done_at,
      owner_text_hash: row.owner_text_hash, assignee_user_id: row.assignee_user_id,
      priority: row.priority, due_at: row.due_at, content_hash: row.content_hash,
    })),
    decisions: sorted(input.decisions).map((row) => ({
      id: row.id, created_at: row.created_at, updated_at: row.updated_at,
      deleted_at: row.deleted_at, lifecycle: row.lifecycle,
      owner_text_hash: row.owner_text_hash, decision_at: row.decision_at,
      supersedes_id: row.supersedes_id, superseded_by_id: row.superseded_by_id,
      content_hash: row.content_hash,
    })),
    brief_versions: sorted(input.brief_versions).map((row) => ({
      id: row.id, version_no: row.version_no, reason: row.reason,
      triggered_by: row.triggered_by, refresh_job_id: row.refresh_job_id,
      created_at: row.created_at,
    })),
    monitor_updates: sorted(input.monitor_updates).map((row) => ({
      id: row.id, ran_at: row.ran_at, patches_applied: row.patches_applied,
      pre_version_id: row.pre_version_id,
    })),
  };
  const json = JSON.stringify(manifest);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > JOURNAL_RADAR_MAX_MANIFEST_BYTES) {
    throw new Error(`Journal radar manifest is ${bytes} bytes; maximum is ${JOURNAL_RADAR_MAX_MANIFEST_BYTES}`);
  }
  return json;
}

type EntryRow = { id: string; author_type: string; body: string; created_at: number; edited_at: number | null; deleted_at: number | null };
type DocumentRow = { id: string; journal_entry_id: string; filename: string; mime_type: string; byte_size: number; content_hash: string; source_url: string | null; created_at: number; parent_deleted_at: number | null };
type CandidateRow = { id: string; candidate_type: string; status: string; created_at: number; updated_at: number; deleted_at: number | null };
type TaskRow = { id: string; body: string; created_at: number; updated_at: number; deleted_at: number | null; done: number; done_at: number | null; owner_text: string | null; assignee_user_id: string | null; priority: string | null; due_at: number | null };
type DecisionRow = { id: string; title: string; decision_statement: string; rationale: string | null; created_at: number; updated_at: number; deleted_at: number | null; lifecycle: string; owner_text: string | null; decision_at: number; supersedes_id: string | null; superseded_by_id: string | null };

export function buildJournalRadarManifest(
  briefId: string,
  connection: Database.Database = db(),
): BuiltJournalRadarManifest {
  const brief = connection.prepare("SELECT id FROM briefs WHERE id = ?").get(briefId) as { id: string } | undefined;
  if (!brief) throw new Error("Brief not found");

  const entries = connection.prepare(`SELECT id, author_type, body, created_at, edited_at, deleted_at
    FROM journal_entries WHERE brief_id = ?`).all(briefId) as EntryRow[];
  const documents = connection.prepare(`SELECT d.id, d.journal_entry_id, d.filename, d.mime_type,
      d.byte_size, d.content_hash, d.source_url, d.created_at, j.deleted_at AS parent_deleted_at
    FROM journal_documents d JOIN journal_entries j ON j.id = d.journal_entry_id
    WHERE d.brief_id = ? AND j.brief_id = ?`).all(briefId, briefId) as DocumentRow[];
  const candidates = connection.prepare(`SELECT id, candidate_type, status, created_at, updated_at, deleted_at
    FROM journal_review_candidates WHERE brief_id = ?`).all(briefId) as CandidateRow[];
  const tasks = connection.prepare(`SELECT id, body, created_at, updated_at, deleted_at, done, done_at,
      owner_text, assignee_user_id, priority, due_at FROM journal_tasks WHERE brief_id = ?`).all(briefId) as TaskRow[];
  const decisions = connection.prepare(`SELECT id, title, decision_statement, rationale, created_at,
      updated_at, deleted_at, lifecycle, owner_text, decision_at, supersedes_id, superseded_by_id
    FROM journal_decisions WHERE brief_id = ?`).all(briefId) as DecisionRow[];
  const versions = connection.prepare(`SELECT id, version_no, reason, triggered_by, refresh_job_id, created_at
    FROM brief_versions WHERE brief_id = ?`).all(briefId) as JournalRadarManifest["brief_versions"];
  const monitorUpdates = connection.prepare(`SELECT id, ran_at, patches_applied, pre_version_id
    FROM monitor_runs WHERE brief_id = ? AND outcome = 'updated'`).all(briefId) as JournalRadarManifest["monitor_updates"];

  const manifest: JournalRadarManifest = {
    schema_version: JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION,
    brief: { id: brief.id },
    entries: entries.map((row) => ({
      id: row.id, author_type: row.author_type, created_at: row.created_at,
      edited_at: row.edited_at, deleted_at: row.deleted_at, content_hash: sha256(row.body),
    })),
    documents: documents.map((row) => ({
      id: row.id, journal_entry_id: row.journal_entry_id,
      filename_hash: sha256(row.filename), mime_type: row.mime_type,
      byte_size: row.byte_size, content_hash: row.content_hash,
      source_url_hash: hashNullable(row.source_url), created_at: row.created_at,
      effectively_removed_at: row.parent_deleted_at,
    })),
    candidates: candidates.map((row) => ({ ...row })),
    tasks: tasks.map((row) => ({
      id: row.id, created_at: row.created_at, updated_at: row.updated_at,
      deleted_at: row.deleted_at, done: row.done === 1, done_at: row.done_at,
      owner_text_hash: hashNullable(row.owner_text), assignee_user_id: row.assignee_user_id,
      priority: row.priority, due_at: row.due_at, content_hash: sha256(row.body),
    })),
    decisions: decisions.map((row) => ({
      id: row.id, created_at: row.created_at, updated_at: row.updated_at,
      deleted_at: row.deleted_at, lifecycle: row.lifecycle,
      owner_text_hash: hashNullable(row.owner_text), decision_at: row.decision_at,
      supersedes_id: row.supersedes_id, superseded_by_id: row.superseded_by_id,
      content_hash: sha256(JSON.stringify([row.title, row.decision_statement, row.rationale])),
    })),
    brief_versions: versions,
    monitor_updates: monitorUpdates,
  };
  const canonicalJson = canonicalizeJournalRadarManifest(manifest);
  return { manifest: JSON.parse(canonicalJson) as JournalRadarManifest, canonicalJson, hash: sha256(canonicalJson) };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): boolean => value === null || isString(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNullableNumber = (value: unknown): boolean => value === null || isNumber(value);
const isRows = (value: unknown, check: (row: Record<string, unknown>) => boolean): boolean =>
  Array.isArray(value) && value.every((row) => !!row && typeof row === "object" && !Array.isArray(row) && check(row as Record<string, unknown>));

export function isJournalRadarManifest(value: unknown): value is JournalRadarManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  const brief = m.brief as Record<string, unknown> | undefined;
  return m.schema_version === JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION && !!brief && isString(brief.id)
    && isRows(m.entries, (r) => isString(r.id) && isString(r.author_type) && isNumber(r.created_at) && isNullableNumber(r.edited_at) && isNullableNumber(r.deleted_at) && isString(r.content_hash))
    && isRows(m.documents, (r) => isString(r.id) && isString(r.journal_entry_id) && isString(r.filename_hash) && isString(r.mime_type) && isNumber(r.byte_size) && isString(r.content_hash) && isNullableString(r.source_url_hash) && isNumber(r.created_at) && isNullableNumber(r.effectively_removed_at))
    && isRows(m.candidates, (r) => isString(r.id) && isString(r.candidate_type) && isString(r.status) && isNumber(r.created_at) && isNumber(r.updated_at) && isNullableNumber(r.deleted_at))
    && isRows(m.tasks, (r) => isString(r.id) && isNumber(r.created_at) && isNumber(r.updated_at) && isNullableNumber(r.deleted_at) && typeof r.done === "boolean" && isNullableNumber(r.done_at) && isNullableString(r.owner_text_hash) && isNullableString(r.assignee_user_id) && isNullableString(r.priority) && isNullableNumber(r.due_at) && isString(r.content_hash))
    && isRows(m.decisions, (r) => isString(r.id) && isNumber(r.created_at) && isNumber(r.updated_at) && isNullableNumber(r.deleted_at) && isString(r.lifecycle) && isNullableString(r.owner_text_hash) && isNumber(r.decision_at) && isNullableString(r.supersedes_id) && isNullableString(r.superseded_by_id) && isString(r.content_hash))
    && isRows(m.brief_versions, (r) => isString(r.id) && isNumber(r.version_no) && isString(r.reason) && isString(r.triggered_by) && isNullableString(r.refresh_job_id) && isNumber(r.created_at))
    && isRows(m.monitor_updates, (r) => isString(r.id) && isNumber(r.ran_at) && isNumber(r.patches_applied) && isNullableString(r.pre_version_id));
}
