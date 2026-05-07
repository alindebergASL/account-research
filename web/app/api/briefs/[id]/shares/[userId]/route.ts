import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canWriteBrief, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; userId: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const result = db()
    .prepare(
      `DELETE FROM brief_shares WHERE brief_id = ? AND user_id = ?`,
    )
    .run(params.id, params.userId);
  return NextResponse.json({ deleted: result.changes });
}
