import { NextRequest, NextResponse } from "next/server";
import { db, BriefRow } from "@/lib/db";
import {
  HttpError,
  canManageBrief,
  canReadBrief,
  canWriteBrief,
  getShareRole,
  requireUser,
} from "@/lib/auth";
import { Brief } from "@/lib/schema";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

export async function GET(
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

  const row = db()
    .prepare(`SELECT * FROM briefs WHERE id = ?`)
    .get(params.id) as BriefRow | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Stored brief failed validation", issues: parsed.error.issues },
      { status: 500 },
    );
  }

  const isOwner = row.user_id === user.id;
  const canWrite = canWriteBrief(user, params.id);
  const canManage = canManageBrief(user, params.id);
  const role: "owner" | "reader" | "editor" | null = isOwner
    ? "owner"
    : (getShareRole(params.id, user.id) ?? null);

  let sharedByEmail: string | null = null;
  if (!isOwner) {
    const ownerRow = db()
      .prepare(`SELECT email FROM users WHERE id = ?`)
      .get(row.user_id) as { email: string } | undefined;
    sharedByEmail = ownerRow?.email ?? null;
  }

  // Most-recent successful refresh job for this brief, if any.
  const lastRefresh = db()
    .prepare(
      `SELECT MAX(finished_at) AS t FROM research_jobs
       WHERE target_brief_id = ? AND status = 'done' AND intent = 'refresh'`,
    )
    .get(params.id) as { t: number | null } | undefined;
  const lastRefreshedAt = lastRefresh?.t ?? null;

  const versionsCountRow = db()
    .prepare(`SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?`)
    .get(params.id) as { n: number } | undefined;
  const versionsCount = versionsCountRow?.n ?? 0;

  return NextResponse.json({
    brief: parsed.data,
    created_at: row.created_at,
    is_owner: isOwner,
    can_write: canWrite,
    can_manage: canManage,
    role,
    shared_by_email: sharedByEmail,
    last_refreshed_at: lastRefreshedAt,
    versions_count: versionsCount,
  });
}

export async function PATCH(
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
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { audience?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const audience =
    body.audience === "shareable" || body.audience === "internal"
      ? body.audience
      : null;
  if (!audience) {
    return NextResponse.json(
      { error: "audience must be 'shareable' or 'internal'" },
      { status: 400 },
    );
  }

  const row = db()
    .prepare(`SELECT brief_json FROM briefs WHERE id = ?`)
    .get(params.id) as { brief_json: string } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Keep the column and the JSON blob in sync — the canvas reads
  // `brief.audience` from the parsed JSON, while listings read the
  // column.
  let parsedJson: any;
  try {
    parsedJson = JSON.parse(row.brief_json);
  } catch {
    return NextResponse.json(
      { error: "Stored brief JSON is corrupt" },
      { status: 500 },
    );
  }
  parsedJson.audience = audience;

  db()
    .prepare(
      `UPDATE briefs SET audience = ?, brief_json = ? WHERE id = ?`,
    )
    .run(audience, JSON.stringify(parsedJson), params.id);

  return NextResponse.json({ ok: true, audience });
}

export async function DELETE(
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

  if (!canManageBrief(user, params.id)) {
    return NextResponse.json(
      { error: "Not authorized" },
      { status: 403 },
    );
  }
  const result = db()
    .prepare(`DELETE FROM briefs WHERE id = ?`)
    .run(params.id);
  return NextResponse.json({ deleted: result.changes });
}
