import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow, type BriefCommentRow } from "@/lib/db";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import { friendlyAnthropicError } from "@/lib/anthropicError";
import {
  isAssistMode,
  runAssist,
  type ThreadComment,
} from "@/lib/briefCommentsAi";

export const runtime = "nodejs";
export const maxDuration = 60;

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
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

  let body: { mode?: unknown; parent_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isAssistMode(body.mode)) {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }
  const parentId =
    typeof body.parent_id === "string" && body.parent_id ? body.parent_id : null;

  const briefRow = db()
    .prepare(`SELECT brief_json FROM briefs WHERE id = ?`)
    .get(params.id) as Pick<BriefRow, "brief_json"> | undefined;
  if (!briefRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  let briefJson: unknown;
  try {
    briefJson = JSON.parse(briefRow.brief_json);
  } catch {
    return NextResponse.json(
      { error: "Stored brief JSON is corrupt" },
      { status: 500 },
    );
  }

  const threadRows = db()
    .prepare(
      `SELECT c.id, c.parent_id, c.body, c.created_at, c.deleted_at,
              u.display_name AS author_display_name
         FROM brief_comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.brief_id = ?
        ORDER BY c.created_at ASC`,
    )
    .all(params.id) as Array<
    Pick<BriefCommentRow, "id" | "parent_id" | "body" | "created_at" | "deleted_at"> & {
      author_display_name: string | null;
    }
  >;
  const thread: ThreadComment[] = threadRows
    .filter((r) => r.deleted_at === null)
    .map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      author_display_name: r.author_display_name,
      body: r.body,
      created_at: r.created_at,
    }));

  // runAssist falls back to an injected test client if one is registered
  // via __setTestAssistClient (see lib/briefCommentsAi.ts), so production
  // is the only path that requires ANTHROPIC_API_KEY. We can't probe the
  // test seam from here (route files must not export non-route symbols),
  // so we attempt the call and let runAssist throw if no client is
  // available — Anthropic SDK construction fails fast on missing key.
  if (!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY" },
      { status: 500 },
    );
  }

  try {
    const result = await runAssist({
      mode: body.mode,
      brief_json: briefJson,
      thread,
      parent_id: parentId,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: friendlyAnthropicError(err, "AI assist") },
      { status: 500 },
    );
  }
}
