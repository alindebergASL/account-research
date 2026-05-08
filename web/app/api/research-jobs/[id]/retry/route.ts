import { NextRequest, NextResponse } from "next/server";
import { db, type ResearchJobRow } from "@/lib/db";
import { HttpError, canStartResearch, requireUser } from "@/lib/auth";
import { newId } from "@/lib/password";

export const runtime = "nodejs";

// POST /api/research-jobs/[id]/retry — re-enqueue a failed/cancelled job.
//
// Same intake_json, fresh row, status='queued'. Sets retry_of_job_id so the
// chain is auditable. Owner or admin only; viewers are blocked since they
// can't start research at all.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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

  const newJobId = newId();
  db()
    .prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal,
         intake_json, mode, status, created_at, retry_of_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      newJobId,
      row.user_id,
      row.account_name,
      row.account_segment,
      row.region,
      row.goal,
      row.intake_json,
      row.mode,
      Date.now(),
      row.id,
    );
  return NextResponse.json({ jobId: newJobId, status: "queued" }, { status: 202 });
}
