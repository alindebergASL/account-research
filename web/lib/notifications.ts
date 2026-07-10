import { db } from "@/lib/db";
import { newId } from "@/lib/password";
import { canUserAccessBrief } from "@/lib/briefAccess";

// In-app notification types. Generic table shared by journal @mentions and
// brief comments; the shape (actor + brief + source row) is reusable.
//   journal_mention — you were @mentioned in a journal entry
//   brief_comment   — someone commented top-level on a brief you own
//   comment_reply   — someone replied to your comment
export type NotificationType = "journal_mention" | "brief_comment" | "comment_reply";

const EXCERPT_CHARS = 160;
// Retention: notifications are an inbox, not an archive. On every create we
// prune the recipient's read notifications older than RETENTION_DAYS and cap
// the total per user, so the table can't grow unbounded without needing a cron.
const RETENTION_DAYS = 90;
const MAX_PER_USER = 500;

export type NotificationDto = {
  id: string;
  type: NotificationType;
  brief_id: string | null;
  brief_account_name: string | null;
  source_entry_id: string | null;
  entry_deleted: boolean;
  excerpt: string | null;
  actor: { id: string; display_name: string | null; email: string } | null;
  created_at: number;
  read_at: number | null;
};

function truncate(s: string, n: number): string {
  const clean = s.replace(/<!--\s*JOURNAL_SOURCE_LEGEND:[\s\S]*?-->/g, "").trim();
  return clean.length <= n ? clean : clean.slice(0, n).trimEnd() + "…";
}

// Create one in-app notification per recipient for a journal mention. Idempotent
// via UNIQUE (user_id, type, source_entry_id): re-resolving or editing an entry
// never duplicates a recipient's row. The actor is never notified about their
// own mention. Recipients are expected to already be brief members (the journal
// route resolves mentions against membership), so no access check is repeated
// here — callers pass a trusted list.
export function createMentionNotifications(args: {
  briefId: string;
  entryId: string;
  actorId: string;
  recipientUserIds: string[];
}): number {
  if (args.recipientUserIds.length === 0) return 0;
  const insert = db().prepare(
    `INSERT OR IGNORE INTO notifications
       (id, user_id, type, brief_id, source_entry_id, actor_id, created_at)
     VALUES (?, ?, 'journal_mention', ?, ?, ?, ?)`,
  );
  const now = Date.now();
  let created = 0;
  const seen = new Set<string>();
  for (const userId of args.recipientUserIds) {
    if (userId === args.actorId || seen.has(userId)) continue;
    seen.add(userId);
    const res = insert.run(newId(), userId, args.briefId, args.entryId, args.actorId, now);
    created += res.changes;
    if (res.changes) pruneNotifications(userId);
  }
  return created;
}

// Create one in-app notification for a new brief comment, mirroring the email
// path's recipient rule (web/lib/commentNotifications.ts): a reply notifies the
// parent comment's author, a top-level comment notifies the brief owner. Never
// the actor, and only if the recipient can currently read the brief (the
// read-time predicate is the backstop, but a revoked user shouldn't accrue
// rows either). Unlike email this is NOT gated on email_notifications_enabled.
// Idempotent per (recipient, type, comment) via the UNIQUE constraint.
export function createCommentNotification(args: {
  briefId: string;
  commentId: string;
  parentCommentId: string | null;
  actorId: string;
}): number {
  let recipientId: string | null = null;
  let type: NotificationType;
  if (args.parentCommentId) {
    type = "comment_reply";
    const parent = db()
      .prepare(`SELECT user_id FROM brief_comments WHERE id = ?`)
      .get(args.parentCommentId) as { user_id: string } | undefined;
    recipientId = parent?.user_id ?? null;
  } else {
    type = "brief_comment";
    const brief = db()
      .prepare(`SELECT user_id FROM briefs WHERE id = ?`)
      .get(args.briefId) as { user_id: string } | undefined;
    recipientId = brief?.user_id ?? null;
  }
  if (!recipientId || recipientId === args.actorId) return 0;
  if (!canUserAccessBrief(recipientId, args.briefId)) return 0;
  const res = db()
    .prepare(
      `INSERT OR IGNORE INTO notifications
         (id, user_id, type, brief_id, source_entry_id, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), recipientId, type, args.briefId, args.commentId, args.actorId, Date.now());
  if (res.changes) pruneNotifications(recipientId);
  return res.changes;
}

// Drop a recipient's read notifications past the retention window, then trim to
// the newest MAX_PER_USER overall. Called opportunistically on create so growth
// is bounded without a scheduled job.
function pruneNotifications(userId: string): void {
  const conn = db();
  conn
    .prepare(`DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL AND created_at < ?`)
    .run(userId, Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  conn
    .prepare(
      `DELETE FROM notifications
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id FROM notifications WHERE user_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
          )`,
    )
    .run(userId, userId, MAX_PER_USER);
}

type NotificationRow = {
  id: string;
  type: NotificationType;
  brief_id: string | null;
  brief_account_name: string | null;
  source_entry_id: string | null;
  entry_body: string | null;
  entry_deleted_at: number | null;
  actor_id: string | null;
  actor_display_name: string | null;
  actor_email: string | null;
  created_at: number;
  read_at: number | null;
};

// SQL predicate that admits a notification only if the recipient can STILL read
// its brief: brief-less notifications are always theirs; otherwise owner OR
// admin OR a current brief_shares row. This mirrors canUserAccessBrief exactly
// and is applied at read time so a revoked share immediately stops leaking the
// account name / entry excerpt (the row stays, it just becomes invisible). Uses
// @userId named param so list and count bind it identically.
const ACCESSIBLE_BRIEF_CLAUSE = `(
  n.brief_id IS NULL
  OR n.brief_id IN (SELECT b2.id FROM briefs b2 WHERE b2.user_id = @userId)
  OR (SELECT u2.role FROM users u2 WHERE u2.id = @userId) = 'admin'
  OR n.brief_id IN (SELECT s.brief_id FROM brief_shares s WHERE s.user_id = @userId)
)`;

// A recipient's notifications, newest first. Joins actor, brief, and the source
// journal entry so the client renders without extra round-trips. A deleted
// source entry still lists (the mention happened) but exposes no excerpt.
// Notifications for briefs the user can no longer read are excluded.
export function listNotifications(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): NotificationDto[] {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = db()
    .prepare(
      `SELECT n.id, n.type, n.brief_id, n.source_entry_id, n.created_at, n.read_at,
              b.account_name AS brief_account_name,
              COALESCE(j.body, c.body)             AS entry_body,
              COALESCE(j.deleted_at, c.deleted_at) AS entry_deleted_at,
              a.id           AS actor_id,
              a.display_name AS actor_display_name,
              a.email        AS actor_email
         FROM notifications n
         LEFT JOIN briefs b ON b.id = n.brief_id
         LEFT JOIN journal_entries j
           ON j.id = n.source_entry_id AND n.type = 'journal_mention'
         LEFT JOIN brief_comments c
           ON c.id = n.source_entry_id AND n.type IN ('brief_comment', 'comment_reply')
         LEFT JOIN users a ON a.id = n.actor_id
        WHERE n.user_id = @userId
          ${opts.unreadOnly ? "AND n.read_at IS NULL" : ""}
          AND ${ACCESSIBLE_BRIEF_CLAUSE}
        ORDER BY n.created_at DESC, n.rowid DESC
        LIMIT @limit`,
    )
    .all({ userId, limit }) as NotificationRow[];
  return rows.map((r) => {
    const deleted = r.entry_deleted_at !== null;
    return {
      id: r.id,
      type: r.type,
      brief_id: r.brief_id,
      brief_account_name: r.brief_account_name,
      source_entry_id: r.source_entry_id,
      entry_deleted: deleted,
      excerpt: deleted || !r.entry_body ? null : truncate(r.entry_body, EXCERPT_CHARS),
      actor: r.actor_id
        ? { id: r.actor_id, display_name: r.actor_display_name, email: r.actor_email ?? "" }
        : null,
      created_at: r.created_at,
      read_at: r.read_at,
    };
  });
}

// Unread count, scoped the same way as listNotifications: a revoked share must
// not keep inflating the badge for a brief the user can no longer read.
export function countUnreadNotifications(userId: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c
         FROM notifications n
        WHERE n.user_id = @userId
          AND n.read_at IS NULL
          AND ${ACCESSIBLE_BRIEF_CLAUSE}`,
    )
    .get({ userId }) as { c: number };
  return row.c;
}

// Mark specific notifications read (scoped to the owner AND to briefs the user
// can currently read). Returns how many rows transitioned unread -> read. A
// stale id for a now-inaccessible brief is a no-op, so the marked count can't be
// used to probe the existence of a hidden notification.
export function markNotificationsRead(userId: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const idKeys = ids.map((_, i) => `@id${i}`);
  const params: Record<string, unknown> = { userId, now: Date.now() };
  ids.forEach((id, i) => (params[`id${i}`] = id));
  const res = db()
    .prepare(
      `UPDATE notifications SET read_at = @now
        WHERE id IN (
          SELECT n.id FROM notifications n
           WHERE n.user_id = @userId
             AND n.read_at IS NULL
             AND n.id IN (${idKeys.join(", ")})
             AND ${ACCESSIBLE_BRIEF_CLAUSE}
        )`,
    )
    .run(params);
  return res.changes;
}

// Mark every currently-readable unread notification read. Scoped the same way as
// the list/count so an inaccessible (revoked-share) notification is neither
// counted nor cleared — the marked total can't reveal a hidden one exists.
export function markAllNotificationsRead(userId: string): number {
  const res = db()
    .prepare(
      `UPDATE notifications SET read_at = @now
        WHERE id IN (
          SELECT n.id FROM notifications n
           WHERE n.user_id = @userId
             AND n.read_at IS NULL
             AND ${ACCESSIBLE_BRIEF_CLAUSE}
        )`,
    )
    .run({ userId, now: Date.now() });
  return res.changes;
}
