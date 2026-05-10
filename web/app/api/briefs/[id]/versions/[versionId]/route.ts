import { NextRequest, NextResponse } from "next/server";
import { db, type BriefVersionRow } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";
import { Brief } from "@/lib/schema";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; versionId: string } },
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

  const row = db()
    .prepare(`SELECT * FROM brief_versions WHERE id = ? AND brief_id = ?`)
    .get(params.versionId, params.id) as BriefVersionRow | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  if (!parsed.success) {
    return NextResponse.json({ error: "Stored version failed validation" }, { status: 500 });
  }
  return NextResponse.json({ version: { ...row, brief: parsed.data } });
}
