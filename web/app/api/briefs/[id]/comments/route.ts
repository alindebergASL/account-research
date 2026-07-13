import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { db } from "@/lib/db";
import { HttpError, canCollaborateBrief, canReadBrief, requireUser } from "@/lib/auth";
import { newId } from "@/lib/password";
import { notifyCommentCreated } from "@/lib/commentNotifications";
import { createCommentNotification } from "@/lib/notifications";
import {
  listCommentRowsForBrief,
  rowToAuthenticatedDto,
  type CommentListRow,
} from "@/lib/briefComments";

export const runtime = "nodejs";

const MAX_BODY_CHARS = 4000;

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

// Local alias preserves the existing call sites in this file while the
// underlying mapper lives in @/lib/briefComments so it can be reused by
// the public share-view list endpoint.
const rowToDto = rowToAuthenticatedDto;

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

  const rows = listCommentRowsForBrief(params.id);
  return NextResponse.json({ comments: rows.map(rowToDto) });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    // Mirror the brief-detail route: hide existence behind 404 for
    // non-readers rather than leaking "you don't have permission".
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canCollaborateBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { body?: unknown; parent_id?: unknown; ai_assisted?: unknown };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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

  let parentId: string | null = null;
  if (body.parent_id != null) {
    if (typeof body.parent_id !== "string") {
      return NextResponse.json(
        { error: "parent_id must be a string" },
        { status: 400 },
      );
    }
    const parent = db()
      .prepare(
        `SELECT id, brief_id, parent_id FROM brief_comments WHERE id = ?`,
      )
      .get(body.parent_id) as
      | { id: string; brief_id: string; parent_id: string | null }
      | undefined;
    if (!parent || parent.brief_id !== params.id) {
      return NextResponse.json(
        { error: "Invalid parent_id" },
        { status: 400 },
      );
    }
    // One-level threading only — anchor replies at the top-level parent.
    parentId = parent.parent_id ?? parent.id;
  }

  const id = newId();
  const now = Date.now();
  const aiAssisted = body.ai_assisted === true ? 1 : 0;
  // One transaction for the comment and its in-app notification (reply ->
  // parent author, top-level -> brief owner; never the author): either both
  // land or neither does, so a failure can't leave a comment nobody was told
  // about — or a notification pointing at a comment that was never created.
  db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO brief_comments
           (id, brief_id, user_id, parent_id, body, ai_assisted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, params.id, user.id, parentId, text, aiAssisted, now);
    createCommentNotification({
      briefId: params.id,
      commentId: id,
      parentCommentId: parentId,
      actorId: user.id,
    });
  })();

  const row = db()
    .prepare(
      `SELECT c.*, u.display_name AS author_display_name, u.email AS author_email
         FROM brief_comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.id = ?`,
    )
    .get(id) as CommentListRow;

  // Fire-and-forget: notification path must never block or fail the POST.
  // Any error inside notifyCommentCreated is already swallowed there; the
  // extra .catch is belt-and-suspenders for unexpected sync throws.
  void notifyCommentCreated({
    comment: {
      id: row.id,
      brief_id: row.brief_id,
      user_id: row.user_id,
      parent_id: row.parent_id,
      body: row.body,
      created_at: row.created_at,
    },
    authorId: user.id,
    authorDisplayName: row.author_display_name,
    authorEmail: row.author_email,
  }).catch((err) =>
    // eslint-disable-next-line no-console
    console.error("[comment-notify] failed", err),
  );

  return NextResponse.json({ comment: rowToDto(row) });
}
