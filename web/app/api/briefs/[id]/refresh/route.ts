import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow, type ResearchJobRow } from "@/lib/db";
import { HttpError, canManageBrief, requireUser } from "@/lib/auth";
import { Brief } from "@/lib/schema";
import { newId } from "@/lib/password";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { enqueueResearchJob, researchQueueErrorResponse } from "@/lib/researchQueueLimits";

export const runtime = "nodejs";

type Body = { notes?: string; mode?: "quick" | "standard" | "deep" };

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

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
  if (!canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const row = db().prepare(`SELECT * FROM briefs WHERE id = ?`).get(params.id) as BriefRow | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = Brief.safeParse(JSON.parse(row.brief_json));
  if (!parsed.success) {
    return NextResponse.json({ error: "Stored brief failed validation" }, { status: 500 });
  }

  let body: Body = {};
  try {
    body = await parseBoundedJson<Body>(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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
  if (body.notes !== undefined && (typeof body.notes !== "string" || Buffer.byteLength(body.notes, "utf8") > 8_000)) {
    return NextResponse.json({ error: "Refresh note is too large or invalid" }, { status: 400 });
  }
  const intake = {
    account: brief.account_name,
    segment: brief.segment || undefined,
    notes: body.notes?.trim() || undefined,
    audience: brief.audience,
    mode,
  };

  let jobId: string;
  try {
    jobId = enqueueResearchJob({
      id: newId(), userId: user.id, accountName: brief.account_name,
      accountSegment: brief.segment, goal: body.notes?.trim() || null,
      intakeJson: JSON.stringify(intake), mode, intent: "refresh", targetBriefId: params.id,
    });
  } catch (error) {
    const response = researchQueueErrorResponse(error);
    if (response) return response;
    throw error;
  }

  return NextResponse.json({ jobId, status: "queued", intent: "refresh" }, { status: 202 });
}
