import { db, type BriefCommentRow } from "@/lib/db";

// Shared row-shape returned from the comment list query. Includes the
// joined display_name / email columns from `users`. The DTO mappers
// below decide which of these are safe to expose for a given audience.
export type CommentListRow = BriefCommentRow & {
  author_display_name: string | null;
  author_email: string;
};

// Full DTO surfaced to AUTHENTICATED readers of a brief. Mirrors the
// historical shape returned by `/api/briefs/[id]/comments`. Author id
// and email are included because the client uses them to detect "is
// this my comment" and to render a fallback when display_name is empty.
export type AuthenticatedCommentDto = {
  id: string;
  parent_id: string | null;
  body: string | null;
  ai_assisted: boolean;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  author: { id: string; display_name: string | null; email: string };
};

// Reduced DTO surfaced to ANONYMOUS public-share readers. The author's
// internal id and email MUST NOT leak across the public boundary — only
// the display_name is exposed. Deleted rows expose no author at all.
// The shape otherwise mirrors AuthenticatedCommentDto so the same
// CommentsThread renderer can consume both.
export type PublicCommentDto = {
  id: string;
  parent_id: string | null;
  body: string | null;
  ai_assisted: boolean;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  author_display_name: string | null;
};

// Shared SQL — both the authenticated and the share-view list endpoints
// MUST return the same comment set in the same order, otherwise the two
// surfaces would diverge and confuse cross-referencing reviewers.
export function listCommentRowsForBrief(briefId: string): CommentListRow[] {
  return db()
    .prepare(
      `SELECT c.*, u.display_name AS author_display_name, u.email AS author_email
         FROM brief_comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.brief_id = ?
        ORDER BY c.created_at ASC`,
    )
    .all(briefId) as CommentListRow[];
}

export function rowToAuthenticatedDto(r: CommentListRow): AuthenticatedCommentDto {
  const deleted = r.deleted_at !== null;
  return {
    id: r.id,
    parent_id: r.parent_id,
    body: deleted ? null : r.body,
    ai_assisted: !!r.ai_assisted,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted_at: r.deleted_at,
    author: deleted
      ? { id: r.user_id, display_name: null, email: "" }
      : {
          id: r.user_id,
          display_name: r.author_display_name,
          email: r.author_email,
        },
  };
}

// Public-share variant: blanks the body for deleted comments (matching
// the authenticated GET), strips user_id / email entirely, and only
// surfaces display_name. Deleted comments expose no author at all.
export function rowToPublicDto(r: CommentListRow): PublicCommentDto {
  const deleted = r.deleted_at !== null;
  return {
    id: r.id,
    parent_id: r.parent_id,
    body: deleted ? null : r.body,
    ai_assisted: !!r.ai_assisted,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted_at: r.deleted_at,
    author_display_name: deleted ? null : r.author_display_name,
  };
}
