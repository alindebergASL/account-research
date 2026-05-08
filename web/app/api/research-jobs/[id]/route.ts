import { NextRequest, NextResponse } from "next/server";
import { db, type ResearchJobRow } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

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
