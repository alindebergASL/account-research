import { NextRequest, NextResponse } from "next/server";
import { db, type ResearchJobRow } from "@/lib/db";
import { HttpError, canManageBrief, canReadBrief, requireUser } from "@/lib/auth";
import { listBriefEventsForBrief } from "@/lib/briefEvents";

export const runtime = "nodejs";

function trimError(err: string | null): string | null {
  if (!err) return null;
  const firstLine = err.split(/\r?\n/)[0].trim();
  return firstLine.length > 500 ? firstLine.slice(0, 500) : firstLine;
}

// GET /api/research-jobs/[id] — job detail for owner / admin / brief-manager.
export async function GET(
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

  const conn = db();
  const job = conn
    .prepare(`SELECT * FROM research_jobs WHERE id = ?`)
    .get(params.id) as ResearchJobRow | undefined;
  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // canManageBrief requires a non-null brief id; queued create jobs have
  // neither brief_id nor target_brief_id, so the null guard matters.
  const linkedBriefId = job.target_brief_id ?? job.brief_id;
  const isOwner = job.user_id === user.id;
  const isAdmin = user.role === "admin";
  const canManageLinked =
    linkedBriefId !== null && canManageBrief(user, linkedBriefId);
  if (!isOwner && !isAdmin && !canManageLinked) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let queuePosition: number | null = null;
  if (job.status === "queued") {
    const { n } = conn
      .prepare(
        `SELECT COUNT(*) AS n FROM research_jobs
         WHERE status = 'queued' AND created_at <= ?`,
      )
      .get(job.created_at) as { n: number };
    queuePosition = n;
  } else if (job.status === "running") {
    queuePosition = 0;
  }

  // Job ownership grants access to the job's own fields, but the linked
  // brief's event feed requires CURRENT brief access: an admin who kicked off
  // a refresh on someone else's brief and was later demoted keeps the job row
  // yet must not keep reading that brief's activity through it.
  const recentEvents =
    linkedBriefId && canReadBrief(user, linkedBriefId)
      ? listBriefEventsForBrief(linkedBriefId, 10)
      : [];

  return NextResponse.json({
    id: job.id,
    account_name: job.account_name,
    account_segment: job.account_segment,
    region: job.region,
    goal: job.goal,
    mode: job.mode,
    status: job.status,
    intent: job.intent ?? "create",
    target_brief_id: job.target_brief_id ?? null,
    brief_id: job.brief_id,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    cost_usd_cents: job.cost_usd_cents,
    error: trimError(job.error),
    queue_position: queuePosition,
    recent_events: recentEvents,
  });
}

// DELETE /api/research-jobs/[id] — cancel a job.
//   queued  → mark cancelled; worker will skip it.
//   running → best-effort cancel; worker checks status before saving brief.
//             If pipeline finishes after cancel, brief is discarded.
//   already terminal → 409.
//   non-owner / non-admin → 404 (avoid leaking existence).
export async function DELETE(
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

  const row = db()
    .prepare(`SELECT * FROM research_jobs WHERE id = ?`)
    .get(params.id) as ResearchJobRow | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.user_id !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (row.status !== "queued" && row.status !== "running") {
    return NextResponse.json(
      { error: "Job is not cancellable", status: row.status },
      { status: 409 },
    );
  }

  const wasRunning = row.status === "running";
  db()
    .prepare(
      `UPDATE research_jobs
       SET status = 'cancelled', finished_at = ?
       WHERE id = ? AND status IN ('queued','running')`,
    )
    .run(Date.now(), row.id);

  return NextResponse.json({
    status: "cancelled",
    ...(wasRunning ? { note: "best_effort_running" } : {}),
  });
}
