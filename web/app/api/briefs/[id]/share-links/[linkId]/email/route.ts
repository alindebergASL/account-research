import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";
import { appBaseUrl, isEmailConfigured, sendShareLinkEmail } from "@/lib/email";
import {
  checkShareEmailLimit,
  insertShareEmail,
} from "@/lib/shareEmails";
import { isShareLinkLive } from "@/lib/publicBrief";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

type LinkRow = {
  id: string;
  brief_id: string;
  token: string;
  expires_at: number | null;
  revoked_at: number | null;
  account_name: string;
};

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; linkId: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { recipient?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const recipient = (body.recipient ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(recipient)) {
    return NextResponse.json(
      { error: "Valid recipient email required", code: "bad_email" },
      { status: 400 },
    );
  }

  const link = db()
    .prepare(
      `SELECT l.id, l.brief_id, l.token, l.expires_at, l.revoked_at,
              b.account_name
       FROM brief_share_links l
       JOIN briefs b ON b.id = l.brief_id
       WHERE l.id = ? AND l.brief_id = ?`,
    )
    .get(params.linkId, params.id) as LinkRow | undefined;
  if (!link || !isShareLinkLive(link)) {
    return NextResponse.json({ error: "Link not found" }, { status: 404 });
  }

  const limit = checkShareEmailLimit(user.id);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "Share-link email limit reached",
        code: "rate_limited",
        dayLimit: limit.dayLimit,
        weekLimit: limit.weekLimit,
        sentLastDay: limit.sentLastDay,
        sentLastWeek: limit.sentLastWeek,
      },
      { status: 429 },
    );
  }

  if (!isEmailConfigured()) {
    insertShareEmail({
      linkId: link.id,
      briefId: params.id,
      senderUserId: user.id,
      recipient,
      sendStatus: "failed",
      error: "email_not_configured",
    });
    return NextResponse.json(
      { error: "Email is not configured", code: "email_not_configured" },
      { status: 503 },
    );
  }

  const linkUrl = `${appBaseUrl()}/s/${link.token}`;
  const sendResult = await sendShareLinkEmail({
    recipient,
    sharerName: user.display_name || user.email,
    accountName: link.account_name,
    linkUrl,
    expiresAt: link.expires_at,
  });

  if (!sendResult.ok) {
    insertShareEmail({
      linkId: link.id,
      briefId: params.id,
      senderUserId: user.id,
      recipient,
      sendStatus: "failed",
      error: sendResult.error,
    });
    return NextResponse.json(
      { error: "Email send failed", code: "email_send_failed" },
      { status: sendResult.code === "not_configured" ? 503 : 502 },
    );
  }

  const row = insertShareEmail({
    linkId: link.id,
    briefId: params.id,
    senderUserId: user.id,
    recipient,
    sendStatus: "sent",
  });
  return NextResponse.json({
    ok: true,
    email: { recipient: row.recipient, created_at: row.created_at },
  });
}
