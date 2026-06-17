// Email notifications for journal @mentions.
//
// Rules:
//   * Notify each user newly @mentioned in a journal entry. On create that is
//     everyone the entry resolves to; on edit it is only the users added by the
//     edit (callers pass the delta — we never re-notify an existing mention).
//   * Never self-notify (the author is filtered out by the caller AND here).
//   * Recipient must (a) still have brief access, (b) be enabled, (c) have
//     `email_notifications_enabled = 1`.
//   * SMTP not configured / any failure -> logged and swallowed. Callers do
//     fire-and-forget (no awaiting on the request path).
//
// Mirrors commentNotifications.ts; the one structural difference is fan-out:
// an entry can mention several people, so we email each recipient.

import { db, type BriefRow, type UserRow } from "./db";
import { canUserAccessBrief } from "./briefAccess";
import {
  appBaseUrl,
  escapeHtmlExternal as escapeHtml,
  sendJournalMentionNotificationEmail,
} from "./email";

const BODY_PREVIEW_CHARS = 500;

type NotifyArgs = {
  briefId: string;
  entryId: string;
  body: string;
  createdAt: number;
  authorId: string;
  authorDisplayName: string | null;
  authorEmail: string;
  // User ids newly mentioned by this create/edit. The caller computes the delta
  // on edit so we don't re-notify someone already mentioned before.
  mentionedUserIds: string[];
};

type Recipient = { userId: string; email: string; displayName: string | null };

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

function loadBrief(
  briefId: string,
): Pick<BriefRow, "id" | "user_id" | "account_name" | "segment"> | null {
  const row = db()
    .prepare(`SELECT id, user_id, account_name, segment FROM briefs WHERE id = ?`)
    .get(briefId) as
    | { id: string; user_id: string; account_name: string; segment: string | null }
    | undefined;
  return row ?? null;
}

function loadUserForNotify(
  userId: string,
): Pick<
  UserRow,
  "id" | "email" | "display_name" | "email_notifications_enabled" | "disabled_at"
> | null {
  const row = db()
    .prepare(
      `SELECT id, email, display_name, email_notifications_enabled, disabled_at
         FROM users WHERE id = ?`,
    )
    .get(userId) as
    | {
        id: string;
        email: string;
        display_name: string | null;
        email_notifications_enabled: 0 | 1;
        disabled_at: number | null;
      }
    | undefined;
  return row ?? null;
}

function chooseRecipients(args: NotifyArgs): Recipient[] {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const userId of args.mentionedUserIds) {
    if (userId === args.authorId) continue; // no self-notify
    if (seen.has(userId)) continue;
    seen.add(userId);
    if (!canUserAccessBrief(userId, args.briefId)) continue;
    const u = loadUserForNotify(userId);
    if (!u || u.disabled_at !== null) continue;
    if (!u.email_notifications_enabled) continue;
    out.push({ userId: u.id, email: u.email, displayName: u.display_name });
  }
  return out;
}

function buildEmail(
  recipient: Recipient,
  args: NotifyArgs,
  brief: { id: string; account_name: string; segment: string | null },
): { subject: string; text: string; html: string } {
  const base = appBaseUrl();
  const link = `${base}/brief/${brief.id}#journal-entry-${args.entryId}`;
  const authorName = args.authorDisplayName || args.authorEmail;
  const recipName = recipient.displayName || recipient.email;
  const bodyPreview = truncate(args.body, BODY_PREVIEW_CHARS);
  const when = new Date(args.createdAt).toISOString();
  const segLine = brief.segment ? `Segment: ${brief.segment}\n` : "";
  const segLineHtml = brief.segment
    ? `<p>Segment: ${escapeHtml(brief.segment)}</p>`
    : "";

  const subject = `[Account Research] ${authorName} mentioned you on ${brief.account_name}`;

  const text =
    `Hi ${recipName},\n\n` +
    `${authorName} mentioned you in a journal entry on the ${brief.account_name} brief.\n\n` +
    `"${bodyPreview}"\n\n` +
    `Posted: ${when}\n` +
    `Account: ${brief.account_name}\n` +
    segLine +
    `\n${link}\n\n` +
    `— AccountBriefBuilder\n`;

  const html =
    `<p>Hi ${escapeHtml(recipName)},</p>` +
    `<p><strong>${escapeHtml(authorName)}</strong> mentioned you in a journal entry on the <strong>${escapeHtml(brief.account_name)}</strong> brief.</p>` +
    `<blockquote>${escapeHtml(bodyPreview)}</blockquote>` +
    `<p>Posted: ${escapeHtml(when)}</p>` +
    `<p>Account: ${escapeHtml(brief.account_name)}</p>` +
    segLineHtml +
    `<p><a href="${link}">Open journal entry</a></p>` +
    `<p>— AccountBriefBuilder</p>`;

  return { subject, text, html };
}

// Test seam: tests can await the most recently kicked-off fan-out so the
// fire-and-forget sends complete deterministically.
let _lastPromise: Promise<void> | null = null;

export function __getLastNotifyPromise(): Promise<void> | null {
  return _lastPromise;
}

// Public entry point. Never throws.
export async function notifyJournalMentions(args: NotifyArgs): Promise<void> {
  const p = _notifyJournalMentionsImpl(args);
  _lastPromise = p;
  return p;
}

async function _notifyJournalMentionsImpl(args: NotifyArgs): Promise<void> {
  try {
    if (args.mentionedUserIds.length === 0) return;
    const brief = loadBrief(args.briefId);
    if (!brief) return;
    const recipients = chooseRecipients(args);
    if (recipients.length === 0) return;

    for (const recipient of recipients) {
      const { subject, text, html } = buildEmail(recipient, args, brief);
      const res = await sendJournalMentionNotificationEmail({
        to: recipient.email,
        subject,
        text,
        html,
        // Scope per (entry, recipient) so the same entry to two people are
        // distinct sends for debounced-logging / dedupe purposes.
        scopeId: `${args.entryId}:${recipient.userId}`,
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.log(
          `[mention-notify] skipped entry=${args.entryId} recipient=${recipient.userId} code=${res.code}`,
        );
        continue;
      }
      // eslint-disable-next-line no-console
      console.log(
        `[mention-notify] sent entry=${args.entryId} recipient=${recipient.userId}`,
      );
    }
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(
      `[mention-notify] failed entry=${args.entryId ?? "?"} err=${String(err?.message ?? err).slice(0, 500)}`,
    );
  }
}
