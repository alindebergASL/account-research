import { NextRequest, NextResponse } from "next/server";
import { db, BriefSummary } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";
import { newId } from "@/lib/password";
import { Brief } from "@/lib/schema";

export const runtime = "nodejs";

type SharedRow = BriefSummary & {
  user_id: string;
  shared_by_email: string;
  role: "viewer" | "editor";
};

// GET /api/briefs — list current user's owned + shared briefs.
export async function GET(req: NextRequest) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  const owned = db()
    .prepare(
      `SELECT id, account_name, segment, audience, generated_at, created_at
       FROM briefs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    .all(user.id) as BriefSummary[];

  const shared = db()
    .prepare(
      `SELECT b.id, b.account_name, b.segment, b.audience, b.generated_at,
              b.created_at, owner.email AS shared_by_email, s.role
       FROM brief_shares s
       JOIN briefs b ON b.id = s.brief_id
       JOIN users owner ON owner.id = b.user_id
       WHERE s.user_id = ?
       ORDER BY b.created_at DESC
       LIMIT 200`,
    )
    .all(user.id) as SharedRow[];

  // Combined "briefs" field kept for backwards-compatible consumers
  // (e.g. the brief switcher) that just want a flat list.
  const briefs = [...owned, ...shared];

  return NextResponse.json({ owned, shared, briefs });
}

// POST /api/briefs — save a fully-validated brief, return its id.
export async function POST(req: NextRequest) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Brief.safeParse(body?.brief);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Brief failed validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const brief = parsed.data;
  const id = newId();
  db()
    .prepare(
      `INSERT INTO briefs
        (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      user.id,
      brief.account_name,
      brief.segment,
      brief.audience,
      brief.generated_at,
      Date.now(),
      JSON.stringify(brief),
    );
  return NextResponse.json({ id });
}
