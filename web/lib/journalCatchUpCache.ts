import { createHash, randomUUID } from "node:crypto";

import { db, type JournalCatchUpCacheRow, type JournalCockpitReadModelRow } from "@/lib/db";
import type { JournalCatchUpWindow } from "@/lib/journalCatchUp";
import { listReviewCandidates } from "@/lib/journalReviewCandidates";
import {
  buildJournalCockpitReadModel,
  saveJournalCockpitReadModel,
} from "@/lib/journalCockpitReadModel";

export type JournalCatchUpCacheKey = {
  briefId: string;
  window: JournalCatchUpWindow;
  contextSince: number | null;
  excludedDocumentKey: string;
  scopedDocumentKey: string;
  cockpitSourceFingerprint: string;
};

export type SaveJournalCatchUpCacheInput = JournalCatchUpCacheKey & {
  summaryText: string;
  sourceEntryId?: string | null;
  now?: number;
};

export function journalCatchUpExcludedDocumentKey(ids: string[]): string {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort().join("\u0000");
}

export function journalCatchUpScopedDocumentKey(ids: string[], explicitScope: boolean): string {
  if (!explicitScope) return "recent";
  const normalized = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort();
  return `scope:${normalized.join("\u0000")}`;
}

export function isJournalCatchUpWindow(value: unknown): value is JournalCatchUpWindow {
  return value === "24h" || value === "7d" || value === "all";
}

function normalizedContextSince(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : -1;
}

function briefUpdatedAt(briefId: string): number | null {
  const row = db()
    .prepare(`SELECT created_at FROM briefs WHERE id = ?`)
    .get(briefId) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

function latestJournalEntryAt(briefId: string): number | null {
  const row = db()
    .prepare(
      `SELECT MAX(COALESCE(edited_at, created_at)) AS latest
         FROM journal_entries
        WHERE brief_id = ? AND deleted_at IS NULL`,
    )
    .get(briefId) as { latest: number | null } | undefined;
  return row?.latest ?? null;
}

function latestSourceUpdatedAt(briefId: string): number | null {
  const row = db()
    .prepare(
      `SELECT MAX(d.created_at) AS latest
         FROM journal_documents d
         JOIN journal_entries j ON j.id = d.journal_entry_id
        WHERE d.brief_id = ?
          AND j.brief_id = ?
          AND j.deleted_at IS NULL`,
    )
    .get(briefId, briefId) as { latest: number | null } | undefined;
  return row?.latest ?? null;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function journalEntryFingerprint(briefId: string): string {
  const rows = db()
    .prepare(
      `SELECT id, created_at, edited_at, deleted_at
         FROM journal_entries
        WHERE brief_id = ?
        ORDER BY id`,
    )
    .all(briefId) as Array<{ id: string; created_at: number; edited_at: number | null; deleted_at: number | null }>;
  return stableHash(rows);
}

function sourceFingerprint(briefId: string): string {
  const rows = db()
    .prepare(
      `SELECT d.id, d.journal_entry_id, d.created_at, j.deleted_at AS entry_deleted_at
         FROM journal_documents d
         JOIN journal_entries j ON j.id = d.journal_entry_id
        WHERE d.brief_id = ?
        ORDER BY d.id`,
    )
    .all(briefId) as Array<{ id: string; journal_entry_id: string; created_at: number; entry_deleted_at: number | null }>;
  return stableHash(rows);
}

export function refreshCockpitSourceFingerprint(briefId: string): string {
  const model = buildJournalCockpitReadModel({
    briefId,
    candidates: listReviewCandidates(briefId),
    invalidation: {
      briefUpdatedAt: briefUpdatedAt(briefId),
      latestJournalEntryAt: latestJournalEntryAt(briefId),
      latestSourceUpdatedAt: latestSourceUpdatedAt(briefId),
      journalEntryFingerprint: journalEntryFingerprint(briefId),
      sourceFingerprint: sourceFingerprint(briefId),
    },
  });
  saveJournalCockpitReadModel(model);
  return model.source_fingerprint;
}

export function currentCockpitSourceFingerprint(briefId: string): string | null {
  const row = db()
    .prepare(`SELECT source_fingerprint FROM journal_cockpit_read_models WHERE brief_id = ?`)
    .get(briefId) as Pick<JournalCockpitReadModelRow, "source_fingerprint"> | undefined;
  return row?.source_fingerprint ?? null;
}

export function loadJournalCatchUpCache(input: JournalCatchUpCacheKey): JournalCatchUpCacheRow | null {
  const row = db()
    .prepare(
      `SELECT * FROM journal_catch_up_cache
        WHERE brief_id = ?
          AND window = ?
          AND context_since = ?
          AND excluded_document_key = ?
          AND scoped_document_key = ?
          AND cockpit_source_fingerprint = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(
      input.briefId,
      input.window,
      normalizedContextSince(input.contextSince),
      input.excludedDocumentKey,
      input.scopedDocumentKey,
      input.cockpitSourceFingerprint,
    ) as JournalCatchUpCacheRow | undefined;
  return row ?? null;
}

export function saveJournalCatchUpCache(input: SaveJournalCatchUpCacheInput): JournalCatchUpCacheRow {
  const now = input.now ?? Date.now();
  const contextSince = normalizedContextSince(input.contextSince);
  const existing = loadJournalCatchUpCache({
    briefId: input.briefId,
    window: input.window,
    contextSince,
    excludedDocumentKey: input.excludedDocumentKey,
    scopedDocumentKey: input.scopedDocumentKey,
    cockpitSourceFingerprint: input.cockpitSourceFingerprint,
  });
  const id = existing?.id ?? randomUUID();
  db()
    .prepare(
      `INSERT INTO journal_catch_up_cache
         (id, brief_id, window, context_since, excluded_document_key, scoped_document_key,
          cockpit_source_fingerprint, summary_text, source_entry_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(brief_id, window, context_since, excluded_document_key, scoped_document_key, cockpit_source_fingerprint)
       DO UPDATE SET
          summary_text = excluded.summary_text,
          source_entry_id = excluded.source_entry_id,
          updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.briefId,
      input.window,
      contextSince,
      input.excludedDocumentKey,
      input.scopedDocumentKey,
      input.cockpitSourceFingerprint,
      input.summaryText,
      input.sourceEntryId ?? null,
      existing?.created_at ?? now,
      now,
    );
  const saved = loadJournalCatchUpCache({
    briefId: input.briefId,
    window: input.window,
    contextSince,
    excludedDocumentKey: input.excludedDocumentKey,
    scopedDocumentKey: input.scopedDocumentKey,
    cockpitSourceFingerprint: input.cockpitSourceFingerprint,
  });
  if (!saved) throw new Error("Failed to save journal catch-up cache");
  return saved;
}
