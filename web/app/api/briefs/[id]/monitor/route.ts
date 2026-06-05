import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { cancelActiveMonitorJobsForBrief, enqueueMonitorJob } from "@/lib/monitorScheduler";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

// Toggle the per-brief daily monitor. Available to admins + editors (owner /
// admin / editor) via canWriteBrief. Enabling (false -> true) also enqueues an
// immediate monitor check so the first run happens right away.
export async function POST(
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
  // Hide existence from non-readers; gate the write on editor-or-better.
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }

  const row = db()
    .prepare(`SELECT monitor_enabled FROM briefs WHERE id = ?`)
    .get(params.id) as { monitor_enabled: number } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const wasEnabled = row.monitor_enabled === 1;
  const enabled = body.enabled;
  db()
    .prepare(`UPDATE briefs SET monitor_enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, params.id);

  // First enable → run a check immediately (deduped if one is already queued).
  let queuedJobId: string | null = null;
  if (enabled && !wasEnabled) {
    queuedJobId = enqueueMonitorJob(params.id, user.id);
  } else if (!enabled) {
    cancelActiveMonitorJobsForBrief(params.id);
  }

  return NextResponse.json({ ok: true, enabled, queued_job_id: queuedJobId });
}
