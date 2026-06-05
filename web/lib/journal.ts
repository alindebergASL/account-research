import { db, type JournalEntryRow } from "@/lib/db";
import { newId } from "@/lib/password";
import {
  listDocumentsForEntries,
  type JournalDocumentDto,
} from "@/lib/journalDocuments";

// Insert a journal entry and return its id. Shared by the journal POST route
// and background jobs (e.g. the daily monitor) that post an `assistant` entry.
// `userId` is the author for 'user' rows and the triggering user for
// 'assistant' rows (nullable — assistant entries tolerate a missing user).
export function insertJournalEntry(args: {
  briefId: string;
  userId: string | null;
  authorType: "user" | "assistant";
  body: string;
  replyTo?: string | null;
}): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO journal_entries
         (id, brief_id, user_id, author_type, body, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.briefId,
      args.userId,
      args.authorType,
      args.body,
      args.replyTo ?? null,
      Date.now(),
    );
  return id;
}

// Row shape returned from the journal list query. LEFT JOINs users because
// assistant rows (and rows whose author was later deleted) have a null
// user_id — an INNER JOIN would silently drop them from the feed.
export type JournalListRow = JournalEntryRow & {
  author_display_name: string | null;
  author_email: string | null;
};

// Synthetic display name surfaced for assistant-authored entries. Kept here
// so the API and any future renderer agree on the label.
export const ASSISTANT_DISPLAY_NAME = "Assistant";

// DTO surfaced to authenticated readers of a brief. Mirrors the comments DTO
// shape (id/body/created_at/edited_at/deleted_at + author) so the client can
// reuse the same "is this mine" / relative-time rendering. Author is null for
// assistant rows and for soft-deleted rows.
export type JournalEntryDto = {
  id: string;
  author_type: "user" | "assistant";
  body: string | null;
  reply_to: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  author: { id: string; display_name: string | null; email: string } | null;
  documents: JournalDocumentDto[];
};

export function listEntryRowsForBrief(briefId: string): JournalListRow[] {
  return db()
    .prepare(
      `SELECT j.*, u.display_name AS author_display_name, u.email AS author_email
         FROM journal_entries j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE j.brief_id = ?
        ORDER BY j.created_at ASC, j.rowid ASC`,
    )
    .all(briefId) as JournalListRow[];
}

export function listRecentEntryRowsForBrief(
  briefId: string,
  limit = 24,
): JournalListRow[] {
  const rows = db()
    .prepare(
      `SELECT j.*, u.display_name AS author_display_name, u.email AS author_email
         FROM journal_entries j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE j.brief_id = ? AND j.deleted_at IS NULL
        ORDER BY j.created_at DESC, j.rowid DESC
        LIMIT ?`,
    )
    .all(briefId, limit) as JournalListRow[];
  return rows.reverse();
}

export function rowToJournalDto(
  r: JournalListRow,
  documents: JournalDocumentDto[] = [],
): JournalEntryDto {
  const deleted = r.deleted_at !== null;
  const base: Omit<JournalEntryDto, "author"> = {
    id: r.id,
    author_type: r.author_type,
    body: deleted ? null : r.body,
    reply_to: r.reply_to,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted_at: r.deleted_at,
    documents: deleted ? [] : documents,
  };
  if (deleted) {
    return { ...base, author: null };
  }
  if (r.author_type === "assistant") {
    // Assistant rows expose a synthetic label only — no user id/email leaks
    // even though one may be stored as the triggering user.
    return {
      ...base,
      author: { id: "", display_name: ASSISTANT_DISPLAY_NAME, email: "" },
    };
  }
  return {
    ...base,
    author: {
      id: r.user_id ?? "",
      display_name: r.author_display_name,
      email: r.author_email ?? "",
    },
  };
}
