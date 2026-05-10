import nodemailer, { type Transporter } from "nodemailer";
import type { ResearchJobRow, UserRow } from "./db";

let _transport: Transporter | null = null;
let _bootLogged = false;
let _lastNotConfiguredLog = 0;

const NOT_CONFIGURED_LOG_INTERVAL_MS = 60 * 60 * 1000; // once per hour

function readSmtpEnv() {
  const host = (process.env.SMTP_HOST || "").trim();
  const portStr = (process.env.SMTP_PORT || "").trim();
  const user = (process.env.SMTP_USER || "").trim();
  const pass = process.env.SMTP_PASS || "";
  const from = (process.env.MAIL_FROM || "").trim();
  return { host, portStr, user, pass, from };
}

export function isEmailConfigured(): boolean {
  const { host, portStr, user, pass, from } = readSmtpEnv();
  return !!(host && portStr && user && pass && from);
}

export function logEmailBootStatus() {
  if (_bootLogged) return;
  _bootLogged = true;
  // eslint-disable-next-line no-console
  console.log(
    `[email] ${isEmailConfigured() ? "configured" : "not_configured"}`,
  );
}

function transport(): Transporter | null {
  if (!isEmailConfigured()) return null;
  if (_transport) return _transport;
  const { host, portStr, user, pass } = readSmtpEnv();
  const port = Number(portStr);
  _transport = nodemailer.createTransport({
    host,
    port,
    // 465 is the only standard SMTPS port; everything else uses STARTTLS.
    secure: port === 465,
    auth: { user, pass },
  });
  return _transport;
}

function noteSkippedNotConfigured(scope: string, id: string) {
  const now = Date.now();
  if (now - _lastNotConfiguredLog < NOT_CONFIGURED_LOG_INTERVAL_MS) return;
  _lastNotConfiguredLog = now;
  // eslint-disable-next-line no-console
  console.log(
    `[email] skipped_not_configured scope=${scope} id=${id} (debounced — set SMTP_HOST/PORT/USER/PASS/MAIL_FROM to enable)`,
  );
}

export function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL?.replace(/\/+$/, "") || "http://127.0.0.1:3000"
  );
}

export type EmailSendResult =
  | { ok: true }
  | { ok: false; code: "not_configured" | "send_failed"; error: string };

async function send(args: {
  to: string;
  subject: string;
  text: string;
  html: string;
  scope: string;
  id: string;
}): Promise<EmailSendResult> {
  const t = transport();
  if (!t) {
    noteSkippedNotConfigured(args.scope, args.id);
    return {
      ok: false,
      code: "not_configured",
      error: "Email is not configured",
    };
  }
  const { from } = readSmtpEnv();
  try {
    await t.sendMail({
      from,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    return { ok: true };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    // eslint-disable-next-line no-console
    console.error(
      `[email] send_failed scope=${args.scope} id=${args.id} err=${msg}`,
    );
    return { ok: false, code: "send_failed", error: msg };
  }
}

export async function sendJobCompleteEmail(
  user: Pick<UserRow, "email" | "display_name" | "email_notifications_enabled">,
  job: Pick<ResearchJobRow, "id" | "account_name" | "mode">,
  briefId: string,
  kind: "create" | "refresh" = "create",
) {
  if (!user.email_notifications_enabled) return;
  const base = appBaseUrl();
  const link = `${base}/brief/${briefId}`;
  const name = user.display_name || user.email;
  const isRefresh = kind === "refresh";
  await send({
    to: user.email,
    scope: "job",
    id: job.id,
    subject: `${isRefresh ? "Brief refreshed" : "Brief ready"}: ${job.account_name}`,
    text:
      `Hi ${name},\n\n` +
      `Your ${job.mode} brief for ${job.account_name} ${isRefresh ? "has been refreshed" : "is ready"}.\n\n` +
      `${link}\n\n` +
      `— AccountBriefBuilder\n`,
    html: `<p>Hi ${escapeHtml(name)},</p>
<p>Your <strong>${escapeHtml(job.mode)}</strong> brief for <strong>${escapeHtml(job.account_name)}</strong> ${isRefresh ? "has been refreshed" : "is ready"}.</p>
<p><a href="${link}">Open brief</a></p>
<p>— AccountBriefBuilder</p>`,
  });
}

export async function sendJobFailedEmail(
  user: Pick<UserRow, "email" | "display_name" | "email_notifications_enabled">,
  job: Pick<ResearchJobRow, "id" | "account_name" | "mode" | "error">,
) {
  if (!user.email_notifications_enabled) return;
  const base = appBaseUrl();
  const link = `${base}/?failed=${encodeURIComponent(job.id)}`;
  const name = user.display_name || user.email;
  const reason = (job.error || "unknown error").slice(0, 500);
  await send({
    to: user.email,
    scope: "job",
    id: job.id,
    subject: `Brief failed: ${job.account_name}`,
    text:
      `Hi ${name},\n\n` +
      `Your ${job.mode} brief for ${job.account_name} failed:\n` +
      `  ${reason}\n\n` +
      `Retry from the in-app tray: ${link}\n\n` +
      `— AccountBriefBuilder\n`,
    html: `<p>Hi ${escapeHtml(name)},</p>
<p>Your <strong>${escapeHtml(job.mode)}</strong> brief for <strong>${escapeHtml(job.account_name)}</strong> failed:</p>
<blockquote>${escapeHtml(reason)}</blockquote>
<p><a href="${link}">Retry from the tray</a></p>
<p>— AccountBriefBuilder</p>`,
  });
}

export async function sendShareLinkEmail(args: {
  recipient: string;
  sharerName: string;
  accountName: string;
  linkUrl: string;
  expiresAt: number | null;
}): Promise<EmailSendResult> {
  const expiry = args.expiresAt ? formatExpiry(args.expiresAt) : "This link does not expire.";
  return send({
    to: args.recipient,
    scope: "share_link",
    id: args.accountName,
    subject: `${args.sharerName} shared an AccountBriefBuilder brief: ${args.accountName}`,
    text:
      `${args.sharerName} shared a public AccountBriefBuilder brief with you.\n\n` +
      `Brief: ${args.accountName}\n` +
      `${expiry}\n\n` +
      `${args.linkUrl}\n\n` +
      `— AccountBriefBuilder\n`,
    html: `<p>${escapeHtml(args.sharerName)} shared a public AccountBriefBuilder brief with you.</p>
<p><strong>${escapeHtml(args.accountName)}</strong></p>
<p>${escapeHtml(expiry)}</p>
<p><a href="${args.linkUrl}">Open public brief</a></p>
<p>— AccountBriefBuilder</p>`,
  });
}

function formatExpiry(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "This link has an expiry.";
  return `This link expires ${date.toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}.`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
