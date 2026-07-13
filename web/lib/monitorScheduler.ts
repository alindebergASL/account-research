// Daily-monitor scheduler. Lives inside the long-running worker process: the
// worker loop calls maybeRunDailySchedule() each tick. The date check makes it
// retry on/after 2 AM until every due brief is enqueued or deduped, then stop
// for the local calendar day. Completion survives restarts via the
// monitor_schedule singleton row.
//
// Enqueued jobs land in the same research_jobs queue the worker already drains
// one at a time, so monitor checks run sequentially after 2 AM.

import { db } from "./db";
import { newId } from "./password";
import { providerCallsEnabled } from "./providerAccess";
import { enqueueResearchJob, ResearchQueueError } from "./researchQueueLimits";

const SCHEDULE_ID = "singleton";
const MONITOR_HOUR = 2; // 2 AM, server local time
const DAY_MS = 24 * 60 * 60 * 1000;
// Slack so a cadence boundary lands a little before the exact interval: the
// scan itself takes time, so last_monitored_at is recorded a bit after 2 AM.
// Without slack, "daily" would silently become every-other-day (the next 2 AM
// is just under 24h after the previous run finished).
const CADENCE_SLACK_MS = 6 * 60 * 60 * 1000;

export type MonitorCadence = "daily" | "every_3_days" | "weekly";
export const MONITOR_CADENCES: MonitorCadence[] = [
  "daily",
  "every_3_days",
  "weekly",
];

export function isMonitorCadence(v: unknown): v is MonitorCadence {
  return typeof v === "string" && (MONITOR_CADENCES as string[]).includes(v);
}

export function monitorCadenceIntervalMs(cadence: string): number {
  switch (cadence) {
    case "weekly":
      return 7 * DAY_MS;
    case "every_3_days":
      return 3 * DAY_MS;
    case "daily":
    default:
      return DAY_MS;
  }
}

// Earliest moment a brief is "due" for its next check given its cadence.
function dueAt(lastMonitoredAt: number | null, cadence: string): number {
  if (lastMonitoredAt === null) return 0; // never checked → always due
  return lastMonitoredAt + (monitorCadenceIntervalMs(cadence) - CADENCE_SLACK_MS);
}

// The wall-clock time the next scheduled check should fire: the next 2 AM at or
// after the cadence due time. Used by the API to show "Next check" in the UI.
export function nextScheduledCheckAt(
  lastMonitoredAt: number | null,
  cadence: string,
  now: number = Date.now(),
): number {
  const floor = Math.max(dueAt(lastMonitoredAt, cadence), now);
  const d = new Date(floor);
  d.setHours(MONITOR_HOUR, 0, 0, 0);
  if (d.getTime() < floor) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function localDateKey(d: Date): string {
  // YYYY-MM-DD in the server's local timezone (not UTC) so "2 AM" matches the
  // operator's wall clock.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Insert a queued monitor job for a brief, deduped against any monitor job
// already queued or running for it (same guard as the refresh route). Returns
// the new job id, or null if one was already pending.
export function enqueueMonitorJob(
  briefId: string,
  userId: string,
): string | null {
  try {
    return enqueueMonitorJobOrThrow(briefId, userId);
  } catch (error) {
    if (error instanceof ResearchQueueError) return null;
    if (!providerCallsEnabled()) return null;
    throw error;
  }
}

export function enqueueMonitorJobOrThrow(
  briefId: string,
  userId: string,
): string | null {
  const brief = db()
    .prepare(`SELECT account_name, segment FROM briefs WHERE id = ?`)
    .get(briefId) as { account_name: string; segment: string | null } | undefined;
  if (!brief) return null;

  const jobId = newId();
  const intake = {
    account: brief.account_name,
    segment: brief.segment || undefined,
  };
  return enqueueResearchJob({
    id: jobId, userId, accountName: brief.account_name,
    accountSegment: brief.segment, intakeJson: JSON.stringify(intake),
    mode: "standard", intent: "monitor", targetBriefId: briefId,
  });
}

// Disable/cancel semantics: once a user turns monitoring off, active monitor
// work for that brief must not later mutate the brief or send notifications.
// Running work is marked cancelled; executeMonitorJob re-checks status after
// the scan returns before committing any side effects.
export function cancelActiveMonitorJobsForBrief(briefId: string): number {
  const res = db()
    .prepare(
      `UPDATE research_jobs
       SET status = 'cancelled', finished_at = ?
       WHERE intent = 'monitor'
         AND target_brief_id = ?
         AND status IN ('queued','running')`,
    )
    .run(Date.now(), briefId);
  return res.changes;
}

// Backwards-compatible name for callers/tests that only care about queued jobs.
export const cancelQueuedMonitorJobsForBrief = cancelActiveMonitorJobsForBrief;

type MonitorEnqueuePass = { enqueued: number; capacityDeferred: number };

function enqueueDueMonitorJobs(
  now: number,
  attemptWindowStart: number | null = null,
): MonitorEnqueuePass {
  if (!providerCallsEnabled()) return { enqueued: 0, capacityDeferred: 0 };
  const briefs = db()
    .prepare(
      `SELECT id, user_id, monitor_cadence, last_monitored_at
         FROM briefs
        WHERE monitor_enabled = 1
          AND (? IS NULL OR NOT EXISTS (
            SELECT 1 FROM research_jobs
             WHERE intent = 'monitor'
               AND target_brief_id = briefs.id
               AND created_at >= ?
          ))
        ORDER BY CASE WHEN last_monitored_at IS NULL THEN 0 ELSE 1 END,
                 last_monitored_at ASC,
                 id ASC`,
    )
    .all(attemptWindowStart, attemptWindowStart) as Array<{
    id: string;
    user_id: string;
    monitor_cadence: string;
    last_monitored_at: number | null;
  }>;
  let enqueued = 0;
  let capacityDeferred = 0;
  for (const b of briefs) {
    // Per-brief cadence: only enqueue when the brief is actually due. The 2 AM
    // gate still bounds this to at most one enqueue per brief per day.
    if (now < dueAt(b.last_monitored_at, b.monitor_cadence)) continue;
    try {
      if (enqueueMonitorJobOrThrow(b.id, b.user_id)) enqueued++;
    } catch (error) {
      if (error instanceof ResearchQueueError && error.status === 409) continue;
      if (error instanceof ResearchQueueError && error.status === 429) {
        capacityDeferred++;
        continue;
      }
      throw error;
    }
  }
  if (capacityDeferred > 0) {
    // Fixed, identifier-free signal: never include brief/account/provider/error text.
    // eslint-disable-next-line no-console
    console.warn(`[monitor-scheduler] capacity deferred count=${capacityDeferred}`);
  }
  return { enqueued, capacityDeferred };
}

// Enqueue a monitor job for every monitor-enabled brief, attributed to the
// brief owner. Deduped per brief. Returns the number of jobs enqueued.
export function enqueueAllMonitorJobs(now: number = Date.now()): number {
  const result = enqueueDueMonitorJobs(now);
  return result.enqueued;
}

// Called every worker tick. On/after 2 AM, enqueue the daily batch until a pass
// has no capacity deferrals. The completed date then short-circuits the rest of
// the day. Exposed `now` for deterministic testing.
export function maybeRunDailySchedule(now: Date = new Date()): number {
  if (!providerCallsEnabled()) return 0;
  if (now.getHours() < MONITOR_HOUR) return 0;
  const today = localDateKey(now);

  const row = db()
    .prepare(`SELECT last_run_date FROM monitor_schedule WHERE id = ?`)
    .get(SCHEDULE_ID) as { last_run_date: string | null } | undefined;
  if (row?.last_run_date === today) return 0;

  const windowStart = new Date(now);
  windowStart.setHours(MONITOR_HOUR, 0, 0, 0);
  const result = enqueueDueMonitorJobs(now.getTime(), windowStart.getTime());

  // Capacity-deferred briefs remain due. Leave today incomplete so the worker's
  // next tick retries them as active jobs drain. Dedupe-only passes are complete.
  if (result.capacityDeferred === 0) {
    db()
      .prepare(
        `INSERT INTO monitor_schedule (id, last_run_date) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET last_run_date = excluded.last_run_date`,
      )
      .run(SCHEDULE_ID, today);
  }
  return result.enqueued;
}
