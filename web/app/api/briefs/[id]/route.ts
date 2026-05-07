import { NextRequest, NextResponse } from "next/server";
import { db, BriefRow } from "@/lib/db";
import { getUserId, setUserCookie } from "@/lib/user";
import { Brief } from "@/lib/schema";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { userId, isNew } = getUserId(req);
  const row = isNew
    ? undefined
    : (db()
        .prepare(`SELECT * FROM briefs WHERE id = ? AND user_id = ?`)
        .get(params.id, userId) as BriefRow | undefined);
  if (!row) {
    const res = NextResponse.json({ error: "Not found" }, { status: 404 });
    if (isNew) setUserCookie(res, userId);
    return res;
  }
  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Stored brief failed validation", issues: parsed.error.issues },
      { status: 500 },
    );
  }
  const res = NextResponse.json({ brief: parsed.data, created_at: row.created_at });
  if (isNew) setUserCookie(res, userId);
  return res;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { userId, isNew } = getUserId(req);
  const result = db()
    .prepare(`DELETE FROM briefs WHERE id = ? AND user_id = ?`)
    .run(params.id, userId);
  const res = NextResponse.json({ deleted: result.changes });
  if (isNew) setUserCookie(res, userId);
  return res;
}
