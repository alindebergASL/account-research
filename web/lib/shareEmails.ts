import { db } from "./db";
import { newId } from "./password";

export type ShareEmailStatus = "sent" | "failed";

export type ShareEmailRow = {
  id: string;
  link_id: string;
  brief_id: string;
  sender_user_id: string;
  recipient: string;
  send_status: ShareEmailStatus;
  created_at: number;
  error: string | null;
};

export type ShareEmailLimit = {
  allowed: boolean;
  dayLimit: number;
  weekLimit: number;
  sentLastDay: number;
  sentLastWeek: number;
};

export function shareEmailLimitPerDay(): number {
  return positiveInt(process.env.SHARE_EMAIL_LIMIT_PER_DAY, 20);
}

export function shareEmailLimitPerWeek(): number {
  return positiveInt(process.env.SHARE_EMAIL_LIMIT_PER_WEEK, 100);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function checkShareEmailLimit(
  senderUserId: string,
  now = Date.now(),
): ShareEmailLimit {
  const dayLimit = shareEmailLimitPerDay();
  const weekLimit = shareEmailLimitPerWeek();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const row = db()
    .prepare(
      `SELECT
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS sentLastDay,
         COUNT(*) AS sentLastWeek
       FROM brief_share_emails
       WHERE sender_user_id = ?
         AND send_status = 'sent'
         AND created_at >= ?`,
    )
    .get(dayAgo, senderUserId, weekAgo) as
    | { sentLastDay: number | null; sentLastWeek: number | null }
    | undefined;
  const sentLastDay = Number(row?.sentLastDay ?? 0);
  const sentLastWeek = Number(row?.sentLastWeek ?? 0);
  return {
    allowed: sentLastDay < dayLimit && sentLastWeek < weekLimit,
    dayLimit,
    weekLimit,
    sentLastDay,
    sentLastWeek,
  };
}

export function insertShareEmail(args: {
  linkId: string;
  briefId: string;
  senderUserId: string;
  recipient: string;
  sendStatus: ShareEmailStatus;
  error?: string | null;
  now?: number;
}): ShareEmailRow {
  const id = newId();
  const createdAt = args.now ?? Date.now();
  const error = args.error ? args.error.slice(0, 500) : null;
  db()
    .prepare(
      `INSERT INTO brief_share_emails
        (id, link_id, brief_id, sender_user_id, recipient, send_status, created_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.linkId,
      args.briefId,
      args.senderUserId,
      args.recipient.trim().toLowerCase(),
      args.sendStatus,
      createdAt,
      error,
    );
  return {
    id,
    link_id: args.linkId,
    brief_id: args.briefId,
    sender_user_id: args.senderUserId,
    recipient: args.recipient.trim().toLowerCase(),
    send_status: args.sendStatus,
    created_at: createdAt,
    error,
  };
}

export function recentSuccessfulShareEmails(linkIds: string[]): Map<string, Array<{ recipient: string; created_at: number }>> {
  const out = new Map<string, Array<{ recipient: string; created_at: number }>>();
  if (linkIds.length === 0) return out;
  const placeholders = linkIds.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT link_id, recipient, created_at
       FROM (
         SELECT link_id, recipient, created_at,
                ROW_NUMBER() OVER (PARTITION BY link_id ORDER BY created_at DESC) AS rn
         FROM brief_share_emails
         WHERE send_status = 'sent'
           AND link_id IN (${placeholders})
       )
       WHERE rn <= 3
       ORDER BY link_id, created_at DESC`,
    )
    .all(...linkIds) as Array<{
    link_id: string;
    recipient: string;
    created_at: number;
  }>;
  for (const row of rows) {
    const list = out.get(row.link_id) ?? [];
    list.push({ recipient: row.recipient, created_at: row.created_at });
    out.set(row.link_id, list);
  }
  return out;
}
