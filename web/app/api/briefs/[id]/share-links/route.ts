import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";
import { newId, randomShareToken } from "@/lib/password";
import {
  SHARE_LINK_TTL_OPTIONS,
  ttlToExpiresAt,
  type ShareLinkTtl,
} from "@/lib/publicBrief";
import { recentSuccessfulShareEmails } from "@/lib/shareEmails";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

type LinkSummary = {
  id: string;
  token: string;
  created_at: number;
  expires_at: number | null;
  last_accessed_at: number | null;
  access_count: number;
  recent_emails: Array<{ recipient: string; created_at: number }>;
};

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

  const rows = db()
    .prepare(
      `SELECT id, token, created_at, expires_at, last_accessed_at, access_count
       FROM brief_share_links
       WHERE brief_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(params.id) as LinkSummary[];

  const now = Date.now();
  const liveRows = rows.filter(
    (r) => r.expires_at === null || r.expires_at > now,
  );
  const recentByLink = recentSuccessfulShareEmails(liveRows.map((r) => r.id));
  const links = liveRows.map((r) => ({
    ...r,
    recent_emails: recentByLink.get(r.id) ?? [],
  }));
  return NextResponse.json({ links });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

  const brief = db()
    .prepare(`SELECT id, audience FROM briefs WHERE id = ?`)
    .get(params.id) as { id: string; audience: string } | undefined;
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (brief.audience === "internal") {
    return NextResponse.json(
      {
        error:
          "Public links are disabled for internal briefs. Switch the brief to 'customer-shareable' first.",
        code: "audience_internal",
      },
      { status: 409 },
    );
  }

  let body: { ttl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ttl = body.ttl as ShareLinkTtl | undefined;
  if (!ttl || !SHARE_LINK_TTL_OPTIONS.some((o) => o.id === ttl)) {
    return NextResponse.json(
      {
        error: `ttl must be one of: ${SHARE_LINK_TTL_OPTIONS.map((o) => o.id).join(", ")}`,
      },
      { status: 400 },
    );
  }

  const id = newId();
  const token = randomShareToken();
  const now = Date.now();
  const expiresAt = ttlToExpiresAt(ttl, now);

  db()
    .prepare(
      `INSERT INTO brief_share_links
        (id, brief_id, token, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, params.id, token, user.id, now, expiresAt);

  return NextResponse.json({
    link: {
      id,
      token,
      created_at: now,
      expires_at: expiresAt,
      last_accessed_at: null,
      access_count: 0,
      recent_emails: [],
    } satisfies LinkSummary,
  });
}

