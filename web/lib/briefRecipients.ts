import { db } from "./db";

export type BriefRecipient = {
  id: string;
  email: string;
  display_name: string | null;
};

// Everyone who should receive an email about activity on a brief: the owner
// plus users the brief is explicitly shared with (reader/editor). Admins are
// intentionally NOT included here — they have implicit read access to every
// brief and would otherwise be emailed about every monitored account.
//
// Excludes disabled accounts and anyone who has turned off email
// notifications (`email_notifications_enabled = 0`), matching the filtering
// in commentNotifications.ts. Deduped by user id.
export function listBriefEmailRecipients(briefId: string): BriefRecipient[] {
  return db()
    .prepare(
      `SELECT DISTINCT u.id, u.email, u.display_name
         FROM users u
        WHERE u.disabled_at IS NULL
          AND u.email_notifications_enabled = 1
          AND (
                u.id = (SELECT user_id FROM briefs WHERE id = @briefId)
             OR u.id IN (SELECT user_id FROM brief_shares WHERE brief_id = @briefId)
          )`,
    )
    .all({ briefId }) as BriefRecipient[];
}
