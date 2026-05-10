import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow, type ResearchJobRow } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";
import { Brief } from "@/lib/schema";
import { newId } from "@/lib/password";

export const runtime = "nodejs";

type Body = { notes?: string; mode?: "quick" | "standard" | "deep" };

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
  const row = db()
    .prepare(
      `SELECT mode FROM research_jobs
       WHERE (brief_id = ? OR target_brief_id = ?)
         AND status = 'done'
       ORDER BY COALESCE(finished_at, created_at) DESC
       LIMIT 1`,
    )
    .get(params.id, params.id) as { mode: "quick" | "standard" | "deep" } | undefined;
  return NextResponse.json({ defaultMode: row?.mode ?? "standard" });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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

  const active = db()
    .prepare(
      `SELECT id FROM research_jobs
       WHERE intent = 'refresh'
         AND target_brief_id = ?
         AND status IN ('queued','running')
       LIMIT 1`,
    )
    .get(params.id) as { id: string } | undefined;
  if (active) {
    return NextResponse.json(
      { error: "Refresh already queued or running", jobId: active.id },
      { status: 429 },
    );
  }

  const row = db().prepare(`SELECT * FROM briefs WHERE id = ?`).get(params.id) as BriefRow | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  if (!parsed.success) {
    return NextResponse.json({ error: "Stored brief failed validation" }, { status: 500 });
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const previousJob = db()
    .prepare(
      `SELECT * FROM research_jobs
       WHERE (brief_id = ? OR target_brief_id = ?)
         AND status = 'done'
       ORDER BY COALESCE(finished_at, created_at) DESC
       LIMIT 1`,
    )
    .get(params.id, params.id) as ResearchJobRow | undefined;
  const mode =
    body.mode === "quick" || body.mode === "standard" || body.mode === "deep"
      ? body.mode
      : previousJob?.mode ?? "standard";

  const brief = parsed.data;
  const intake = {
    account: brief.account_name,
    segment: brief.segment || undefined,
    notes: body.notes?.trim() || undefined,
    audience: brief.audience,
    mode,
  };

  const jobId = newId();
  db()
    .prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal,
         intake_json, mode, status, created_at, intent, target_brief_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'refresh', ?)`,
    )
    .run(
      jobId,
      user.id,
      brief.account_name,
      brief.segment,
      null,
      body.notes?.trim() || null,
      JSON.stringify(intake),
      mode,
      Date.now(),
      params.id,
    );

  return NextResponse.json({ jobId, status: "queued", intent: "refresh" }, { status: 202 });
}
