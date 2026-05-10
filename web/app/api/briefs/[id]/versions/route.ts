import { NextRequest, NextResponse } from "next/server";
import { db, type BriefVersionRow } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
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

  const rows = db()
    .prepare(
      `SELECT id, brief_id, version_no, reason, triggered_by, refresh_job_id, created_at
       FROM brief_versions
       WHERE brief_id = ?
       ORDER BY created_at DESC`,
    )
    .all(params.id) as BriefVersionRow[];
  return NextResponse.json({ versions: rows.map(({ brief_json, ...row }) => row) });
}
