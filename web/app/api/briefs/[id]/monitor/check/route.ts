import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { enqueueMonitorJobOrThrow } from "@/lib/monitorScheduler";
import { assertProviderCallsEnabled, providerAccessErrorResponse } from "@/lib/providerAccess";
import { researchQueueErrorResponse } from "@/lib/researchQueueLimits";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

// On-demand "Check now": enqueue a monitor job immediately (deduped against any
// queued/running job). Only when monitoring is enabled. Editor-or-better.
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
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const row = db()
    .prepare(`SELECT monitor_enabled FROM briefs WHERE id = ?`)
    .get(params.id) as { monitor_enabled: number } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.monitor_enabled !== 1) {
    return NextResponse.json(
      { error: "Monitoring is off for this brief" },
      { status: 409 },
    );
  }

  try {
    assertProviderCallsEnabled();
  } catch (error) {
    return providerAccessErrorResponse(error)!;
  }

  let queuedJobId: string | null;
  try {
    queuedJobId = enqueueMonitorJobOrThrow(params.id, user.id);
  } catch (error) {
    const response = researchQueueErrorResponse(error);
    if (response) return response;
    throw error;
  }
  return NextResponse.json({ ok: true, queued_job_id: queuedJobId });
}
