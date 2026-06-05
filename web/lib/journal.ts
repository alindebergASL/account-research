import { db, type JournalEntryRow } from "@/lib/db";

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
};

export function listEntryRowsForBrief(briefId: string): JournalListRow[] {
  return db()
    .prepare(
      `SELECT j.*, u.display_name AS author_display_name, u.email AS author_email
         FROM journal_entries j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE j.brief_id = ?
        ORDER BY j.created_at ASC`,
    )
    .all(briefId) as JournalListRow[];
}

export function rowToJournalDto(r: JournalListRow): JournalEntryDto {
  const deleted = r.deleted_at !== null;
  const base = {
    id: r.id,
    author_type: r.author_type,
    body: deleted ? null : r.body,
    reply_to: r.reply_to,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted_at: r.deleted_at,
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
