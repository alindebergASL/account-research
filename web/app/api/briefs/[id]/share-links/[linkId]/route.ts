import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; linkId: string } },
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
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Soft-revoke: keep the row for audit, set revoked_at.
  const result = db()
    .prepare(
      `UPDATE brief_share_links
       SET revoked_at = ?
       WHERE id = ? AND brief_id = ? AND revoked_at IS NULL`,
    )
    .run(Date.now(), params.linkId, params.id);

  if (result.changes === 0) {
    return NextResponse.json(
      { error: "Link not found or already revoked" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
