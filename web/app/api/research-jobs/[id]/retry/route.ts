import { NextRequest, NextResponse } from "next/server";
import { db, type ResearchJobRow } from "@/lib/db";
import { HttpError, canStartResearch, requireUser } from "@/lib/auth";
import { newId } from "@/lib/password";
import { enqueueResearchJob, researchQueueErrorResponse } from "@/lib/researchQueueLimits";

export const runtime = "nodejs";

// POST /api/research-jobs/[id]/retry — re-enqueue a failed/cancelled job.
//
// Same intake_json, fresh row, status='queued'. Sets retry_of_job_id so the
// chain is auditable. Owner or admin only; viewers are blocked since they
// can't start research at all.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
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
  if (!canStartResearch(user)) {
    return NextResponse.json(
      { error: "Read-only users cannot retry research" },
      { status: 403 },
    );
  }

  const row = db()
    .prepare(`SELECT * FROM research_jobs WHERE id = ?`)
    .get(params.id) as ResearchJobRow | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.user_id !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status !== "failed" && row.status !== "cancelled") {
    return NextResponse.json(
      { error: "Only failed or cancelled jobs can be retried" },
      { status: 409 },
    );
  }

  let newJobId: string;
  try {
    newJobId = enqueueResearchJob({
      id: newId(), userId: row.user_id, accountName: row.account_name,
      accountSegment: row.account_segment, region: row.region, goal: row.goal,
      intakeJson: row.intake_json, mode: row.mode, intent: "research", retryOfJobId: row.id,
    });
  } catch (error) {
    const response = researchQueueErrorResponse(error);
    if (response) return response;
    throw error;
  }
  return NextResponse.json({ jobId: newJobId, status: "queued" }, { status: 202 });
}
