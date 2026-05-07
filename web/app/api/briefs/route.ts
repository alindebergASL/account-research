import { NextRequest, NextResponse } from "next/server";
import { db, BriefSummary } from "@/lib/db";
import { getUserId, setUserCookie } from "@/lib/user";
import { Brief } from "@/lib/schema";

export const runtime = "nodejs";

// GET /api/briefs — list current user's briefs, most recent first.
export async function GET(req: NextRequest) {
  const { userId, isNew } = getUserId(req);
  const rows = isNew
    ? []
    : (db()
        .prepare(
          `SELECT id, account_name, segment, audience, generated_at, created_at
           FROM briefs
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 100`,
        )
        .all(userId) as BriefSummary[]);
  const res = NextResponse.json({ briefs: rows });
  if (isNew) setUserCookie(res, userId);
  return res;
}

// POST /api/briefs — save a fully-validated brief, return its id.
export async function POST(req: NextRequest) {
  const { userId, isNew } = getUserId(req);
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
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : require("crypto").randomUUID();
  db()
    .prepare(
      `INSERT INTO briefs
        (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      brief.account_name,
      brief.segment,
      brief.audience,
      brief.generated_at,
      Date.now(),
      JSON.stringify(brief),
    );
  const res = NextResponse.json({ id });
  if (isNew) setUserCookie(res, userId);
  return res;
}
