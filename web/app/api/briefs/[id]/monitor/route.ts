import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import {
  cancelActiveMonitorJobsForBrief,
  enqueueMonitorJobOrThrow,
  isMonitorCadence,
  nextScheduledCheckAt,
} from "@/lib/monitorScheduler";
import { listMonitorRuns } from "@/lib/monitorRuns";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { assertProviderCallsEnabled, providerAccessErrorResponse } from "@/lib/providerAccess";
import { researchQueueErrorResponse } from "@/lib/researchQueueLimits";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

// Read the per-brief monitoring status + recent run history for the Monitoring
// panel. Available to any reader of the brief.
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
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const row = db()
    .prepare(
      `SELECT monitor_enabled, monitor_cadence, last_monitored_at FROM briefs WHERE id = ?`,
    )
    .get(params.id) as
    | { monitor_enabled: number; monitor_cadence: string; last_monitored_at: number | null }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const enabled = row.monitor_enabled === 1;
  const cadence = row.monitor_cadence || "daily";
  return NextResponse.json({
    enabled,
    cadence,
    last_monitored_at: row.last_monitored_at ?? null,
    next_check_at: enabled
      ? nextScheduledCheckAt(row.last_monitored_at, cadence)
      : null,
    runs: listMonitorRuns(params.id, 20),
  });
}

// Toggle the per-brief daily monitor. Available to admins + editors (owner /
// admin / editor) via canWriteBrief. Enabling (false -> true) also enqueues an
// immediate monitor check so the first run happens right away.
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
  // Hide existence from non-readers; gate the write on editor-or-better.
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: { enabled?: unknown; cadence?: unknown };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  // Optional per-brief cadence: daily | every_3_days | weekly. Omitted = leave
  // the current cadence unchanged.
  if (body.cadence !== undefined && !isMonitorCadence(body.cadence)) {
    return NextResponse.json(
      { error: "cadence must be daily, every_3_days, or weekly" },
      { status: 400 },
    );
  }

  const row = db()
    .prepare(`SELECT monitor_enabled, monitor_cadence FROM briefs WHERE id = ?`)
    .get(params.id) as
    | { monitor_enabled: number; monitor_cadence: string }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const wasEnabled = row.monitor_enabled === 1;
  const enabled = body.enabled;
  if (enabled && !wasEnabled) {
    try {
      assertProviderCallsEnabled();
    } catch (error) {
      return providerAccessErrorResponse(error)!;
    }
  }
  db()
    .prepare(`UPDATE briefs SET monitor_enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, params.id);
  if (isMonitorCadence(body.cadence)) {
    db()
      .prepare(`UPDATE briefs SET monitor_cadence = ? WHERE id = ?`)
      .run(body.cadence, params.id);
  }
  const cadence = isMonitorCadence(body.cadence)
    ? body.cadence
    : row.monitor_cadence || "daily";

  // First enable → run a check immediately (deduped if one is already queued).
  let queuedJobId: string | null = null;
  if (enabled && !wasEnabled) {
    try {
      queuedJobId = enqueueMonitorJobOrThrow(params.id, user.id);
    } catch (error) {
      db().prepare(`UPDATE briefs SET monitor_enabled = ?, monitor_cadence = ? WHERE id = ?`)
        .run(wasEnabled ? 1 : 0, row.monitor_cadence, params.id);
      const response = researchQueueErrorResponse(error);
      if (response) return response;
      throw error;
    }
  } else if (!enabled) {
    cancelActiveMonitorJobsForBrief(params.id);
  }

  return NextResponse.json({ ok: true, enabled, cadence, queued_job_id: queuedJobId });
}
