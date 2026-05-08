import { NextRequest, NextResponse } from "next/server";
import { db, type ResearchJobRow } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

const ACTIVE_STATUSES = ["queued", "running"] as const;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export type ResearchJobView = {
  id: string;
  account_name: string;
  account_segment: string | null;
  mode: ResearchJobRow["mode"];
  status: ResearchJobRow["status"];
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  brief_id: string | null;
  error: string | null;
  cost_usd_cents: number | null;
  queue_position: number | null;
  retry_of_job_id: string | null;
};

function viewFromRow(
  row: ResearchJobRow,
  queuePosition: number | null,
): ResearchJobView {
  return {
    id: row.id,
    account_name: row.account_name,
    account_segment: row.account_segment,
    mode: row.mode,
    status: row.status,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    brief_id: row.brief_id,
    error: row.error,
    cost_usd_cents: row.cost_usd_cents,
    queue_position: queuePosition,
    retry_of_job_id: row.retry_of_job_id,
  };
}

// GET /api/research-jobs — current user's jobs.
//   active = queued | running
//   recent = done | failed | cancelled within last 24h
export async function GET(req: NextRequest) {
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
  const active = conn
    .prepare(
      `SELECT * FROM research_jobs
       WHERE user_id = ? AND status IN ('queued','running')
       ORDER BY created_at ASC`,
    )
    .all(user.id) as ResearchJobRow[];

  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = conn
    .prepare(
      `SELECT * FROM research_jobs
       WHERE user_id = ?
         AND status IN ('done','failed','cancelled')
         AND COALESCE(finished_at, created_at) >= ?
       ORDER BY COALESCE(finished_at, created_at) DESC
       LIMIT 50`,
    )
    .all(user.id, cutoff) as ResearchJobRow[];

  // Compute queue position for each queued job: COUNT of queued jobs
  // (across ALL users, since the worker is serial) created at or before
  // this one. For running rows, queue_position = 0.
  const positionStmt = conn.prepare(
    `SELECT COUNT(*) AS n FROM research_jobs
     WHERE status = 'queued' AND created_at <= ?`,
  );

  const activeView = active.map((row) => {
    if (row.status === "queued") {
      const { n } = positionStmt.get(row.created_at) as { n: number };
      return viewFromRow(row, n);
    }
    return viewFromRow(row, 0);
  });

  return NextResponse.json({
    active: activeView,
    recent: recent.map((r) => viewFromRow(r, null)),
  });
}

void ACTIVE_STATUSES;
