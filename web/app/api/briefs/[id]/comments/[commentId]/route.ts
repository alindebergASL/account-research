import { NextRequest, NextResponse } from "next/server";
import { db, type BriefCommentRow } from "@/lib/db";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY_CHARS = 4000;

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

function loadComment(briefId: string, commentId: string): BriefCommentRow | null {
  const row = db()
    .prepare(
      `SELECT * FROM brief_comments WHERE id = ? AND brief_id = ?`,
    )
    .get(commentId, briefId) as BriefCommentRow | undefined;
  return row ?? null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; commentId: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = loadComment(params.id, params.commentId);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.deleted_at !== null) {
    return NextResponse.json(
      { error: "Comment was deleted" },
      { status: 400 },
    );
  }
  if (row.user_id !== user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  if (Date.now() - row.created_at > EDIT_WINDOW_MS) {
    return NextResponse.json(
      { error: "Edit window expired" },
      { status: 403 },
    );
  }

  let body: { body?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json(
      { error: `Comment too long (max ${MAX_BODY_CHARS} chars)` },
      { status: 400 },
    );
  }

  const now = Date.now();
  db()
    .prepare(
      `UPDATE brief_comments SET body = ?, edited_at = ? WHERE id = ?`,
    )
    .run(text, now, params.commentId);

  return NextResponse.json({ ok: true, edited_at: now });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; commentId: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = loadComment(params.id, params.commentId);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.deleted_at !== null) {
    // Idempotent: already deleted.
    return NextResponse.json({ ok: true, deleted_at: row.deleted_at });
  }
  // Author OR admin.
  if (row.user_id !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const now = Date.now();
  db()
    .prepare(`UPDATE brief_comments SET deleted_at = ? WHERE id = ?`)
    .run(now, params.commentId);

  return NextResponse.json({ ok: true, deleted_at: now });
}
