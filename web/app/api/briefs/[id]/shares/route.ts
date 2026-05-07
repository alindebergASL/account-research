import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  HttpError,
  canWriteBrief,
  findUserByEmail,
  requireUser,
} from "@/lib/auth";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

type ShareListRow = {
  user_id: string;
  email: string;
  granted_by_email: string;
  created_at: number;
};

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const rows = db()
    .prepare(
      `SELECT s.user_id, u.email, granter.email AS granted_by_email, s.created_at
       FROM brief_shares s
       JOIN users u ON u.id = s.user_id
       JOIN users granter ON granter.id = s.granted_by
       WHERE s.brief_id = ?
       ORDER BY s.created_at ASC`,
    )
    .all(params.id) as ShareListRow[];
  return NextResponse.json({ shares: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const target = findUserByEmail(email);
  if (!target) {
    return NextResponse.json(
      { error: "No user with that email — ask an admin to create one" },
      { status: 404 },
    );
  }

  // Don't share with yourself or the owner.
  const owner = db()
    .prepare(`SELECT user_id FROM briefs WHERE id = ?`)
    .get(params.id) as { user_id: string } | undefined;
  if (!owner) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (target.id === owner.user_id) {
    return NextResponse.json(
      { error: "That user already owns this brief" },
      { status: 400 },
    );
  }

  db()
    .prepare(
      `INSERT OR IGNORE INTO brief_shares (brief_id, user_id, granted_by, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(params.id, target.id, user.id, Date.now());

  return NextResponse.json({
    share: {
      user_id: target.id,
      email: target.email,
      granted_by_email: user.email,
    },
  });
}
