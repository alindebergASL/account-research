import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { db } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string; userId: string }> }
) {
  const params = await props.params;
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
  props: { params: Promise<{ id: string; userId: string }> }
) {
  const params = await props.params;
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
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // Accept legacy 'viewer' from clients defensively (translate to 'reader').
  const role =
    body.role === "editor" ? "editor"
    : body.role === "reader" || body.role === "viewer" ? "reader"
    : null;
  if (!role) {
    return NextResponse.json(
      { error: "role must be 'reader' or 'editor'" },
      { status: 400 },
    );
  }
  const result = db()
    .prepare(
      `UPDATE brief_shares SET role = ? WHERE brief_id = ? AND user_id = ?`,
    )
    .run(role, params.id, params.userId);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, role });
}
