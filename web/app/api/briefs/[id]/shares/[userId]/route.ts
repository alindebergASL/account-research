import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";

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
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const result = db()
    .prepare(
      `DELETE FROM brief_shares WHERE brief_id = ? AND user_id = ?`,
    )
    .run(params.id, params.userId);
  return NextResponse.json({ deleted: result.changes });
}

export async function PATCH(
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
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.role !== "viewer" && body.role !== "editor") {
    return NextResponse.json(
      { error: "role must be 'viewer' or 'editor'" },
      { status: 400 },
    );
  }
  const result = db()
    .prepare(
      `UPDATE brief_shares SET role = ? WHERE brief_id = ? AND user_id = ?`,
    )
    .run(body.role, params.id, params.userId);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, role: body.role });
}
