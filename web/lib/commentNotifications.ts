// Email notifications for brief comments.
//
// Rules (see PR description for the source of truth):
//   * Top-level comment  -> notify the brief owner (if owner != author).
//   * Reply              -> notify the parent comment's author (if != author).
//   * Never self-notify, never fan out to all shared users.
//   * Recipient must (a) still have brief access, (b) have
//     `email_notifications_enabled = 1` in their user row.
//   * SMTP not configured -> silent return (debounced log via send()).
//   * Any failure is logged and swallowed; callers do fire-and-forget.
//
// Call surface deliberately tiny: route handler does exactly one call,
// no awaiting. See `web/app/api/briefs/[id]/comments/route.ts`.

import { db, type BriefCommentRow, type BriefRow, type UserRow } from "./db";
import { canUserAccessBrief } from "./briefAccess";
import {
  appBaseUrl,
  escapeHtmlExternal as escapeHtml,
  isEmailConfigured,
  sendCommentNotificationEmail,
} from "./email";

const BODY_PREVIEW_CHARS = 500;

type NotifyArgs = {
  comment: Pick<
    BriefCommentRow,
    "id" | "brief_id" | "user_id" | "parent_id" | "body" | "created_at"
  >;
  // Author of the new comment. We do not look this up — caller already has it.
  authorId: string;
  authorDisplayName: string | null;
  authorEmail: string;
};

type Recipient = {
  userId: string;
  email: string;
  displayName: string | null;
  kind: "owner" | "parent_author";
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

function loadBrief(briefId: string): Pick<BriefRow, "id" | "user_id" | "account_name" | "segment"> | null {
  const row = db()
    .prepare(`SELECT id, user_id, account_name, segment FROM briefs WHERE id = ?`)
    .get(briefId) as
    | { id: string; user_id: string; account_name: string; segment: string | null }
    | undefined;
  return row ?? null;
}

function loadUserForNotify(userId: string): Pick<UserRow, "id" | "email" | "display_name" | "email_notifications_enabled" | "disabled_at"> | null {
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

function loadParentAuthorId(parentCommentId: string): string | null {
  const row = db()
    .prepare(`SELECT user_id FROM brief_comments WHERE id = ?`)
    .get(parentCommentId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

function chooseRecipient(args: NotifyArgs, briefOwnerId: string): Recipient | null {
  // Reply: notify parent author.
  if (args.comment.parent_id) {
    const parentAuthorId = loadParentAuthorId(args.comment.parent_id);
    if (!parentAuthorId) return null;
    if (parentAuthorId === args.authorId) return null; // no self-notify
    if (!canUserAccessBrief(parentAuthorId, args.comment.brief_id)) return null;
    const u = loadUserForNotify(parentAuthorId);
    if (!u || u.disabled_at !== null) return null;
    if (!u.email_notifications_enabled) return null;
    return {
      userId: u.id,
      email: u.email,
      displayName: u.display_name,
      kind: "parent_author",
    };
  }

  // Top-level: notify brief owner.
  if (briefOwnerId === args.authorId) return null;
  if (!canUserAccessBrief(briefOwnerId, args.comment.brief_id)) return null;
  const u = loadUserForNotify(briefOwnerId);
  if (!u || u.disabled_at !== null) return null;
  if (!u.email_notifications_enabled) return null;
  return {
    userId: u.id,
    email: u.email,
    displayName: u.display_name,
    kind: "owner",
  };
}

function buildEmail(
  recipient: Recipient,
  args: NotifyArgs,
  brief: { id: string; account_name: string; segment: string | null },
): { subject: string; text: string; html: string } {
  const base = appBaseUrl();
  const link = `${base}/brief/${brief.id}#comment-${args.comment.id}`;
  const authorName = args.authorDisplayName || args.authorEmail;
  const recipName = recipient.displayName || recipient.email;
  const bodyPreview = truncate(args.comment.body, BODY_PREVIEW_CHARS);
  const when = new Date(args.comment.created_at).toISOString();
  const segLine = brief.segment ? `Segment: ${brief.segment}\n` : "";
  const segLineHtml = brief.segment
    ? `<p>Segment: ${escapeHtml(brief.segment)}</p>`
    : "";

  const subject =
    recipient.kind === "parent_author"
      ? `[Account Research] Reply to your comment on ${brief.account_name}`
      : `[Account Research] New comment on ${brief.account_name} brief`;

  const text =
    `Hi ${recipName},\n\n` +
    `${authorName} ${recipient.kind === "parent_author" ? "replied to your comment" : "posted a new comment"} on the ${brief.account_name} brief.\n\n` +
    `"${bodyPreview}"\n\n` +
    `Posted: ${when}\n` +
    `Account: ${brief.account_name}\n` +
    segLine +
    `\n${link}\n\n` +
    `— AccountBriefBuilder\n`;

  const html =
    `<p>Hi ${escapeHtml(recipName)},</p>` +
    `<p><strong>${escapeHtml(authorName)}</strong> ${recipient.kind === "parent_author" ? "replied to your comment" : "posted a new comment"} on the <strong>${escapeHtml(brief.account_name)}</strong> brief.</p>` +
    `<blockquote>${escapeHtml(bodyPreview)}</blockquote>` +
    `<p>Posted: ${escapeHtml(when)}</p>` +
    `<p>Account: ${escapeHtml(brief.account_name)}</p>` +
    segLineHtml +
    `<p><a href="${link}">Open comment</a></p>` +
    `<p>— AccountBriefBuilder</p>`;

  return { subject, text, html };
}

// Test seam: tests can read the most recently kicked-off notification
// promise so they can await fire-and-forget completion deterministically.
let _lastPromise: Promise<void> | null = null;

export function __getLastNotifyPromise(): Promise<void> | null {
  return _lastPromise;
}

// Public entry point. Never throws.
export async function notifyCommentCreated(args: NotifyArgs): Promise<void> {
  const p = _notifyCommentCreatedImpl(args);
  _lastPromise = p;
  return p;
}

async function _notifyCommentCreatedImpl(args: NotifyArgs): Promise<void> {
  try {
    if (!isEmailConfigured()) {
      // send() handles the "not configured" debounced log; we still try below
      // ONLY when a test mailer is set. Detect via a dry-run: if no recipient,
      // we save the work entirely.
      // We fall through to recipient selection regardless because the test
      // mailer seam in email.ts bypasses isEmailConfigured() inside send().
    }
    const brief = loadBrief(args.comment.brief_id);
    if (!brief) return;
    const recipient = chooseRecipient(args, brief.user_id);
    if (!recipient) return;

    const { subject, text, html } = buildEmail(recipient, args, brief);
    const res = await sendCommentNotificationEmail({
      to: recipient.email,
      subject,
      text,
      html,
      scopeId: args.comment.id,
    });
    if (!res.ok) {
      // send() already logged details; add a structured marker for grepability.
      // eslint-disable-next-line no-console
      console.log(
        `[comment-notify] skipped comment=${args.comment.id} recipient=${recipient.userId} code=${res.code}`,
      );
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[comment-notify] sent comment=${args.comment.id} recipient=${recipient.userId} kind=${recipient.kind}`,
    );
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(
      `[comment-notify] failed comment=${args.comment?.id ?? "?"} err=${String(err?.message ?? err).slice(0, 500)}`,
    );
  }
}
