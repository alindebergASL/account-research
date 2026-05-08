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

  return NextResponse.json({
    brief: parsed.data,
    created_at: row.created_at,
    is_owner: isOwner,
    can_write: canWrite,
    role,
    shared_by_email: sharedByEmail,
  });
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
