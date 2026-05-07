import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  HttpError,
  deleteUserSessions,
  requireAdmin,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let admin;
  try {
    admin = requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }
  if (params.id === admin.id) {
    return NextResponse.json(
      { error: "You cannot disable your own account" },
      { status: 400 },
    );
  }
  const result = db()
    .prepare(
      `UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`,
    )
    .run(Date.now(), params.id);
  if (result.changes > 0) deleteUserSessions(params.id);
  return NextResponse.json({ ok: true });
}
