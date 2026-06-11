// Daily-monitor scheduler. Lives inside the long-running worker process: the
// worker loop calls maybeRunDailySchedule() each tick. The date check makes it
// fire the enqueue exactly once per local calendar day, on/after 2 AM, and it
// survives restarts via the monitor_schedule singleton row.
//
// Enqueued jobs land in the same research_jobs queue the worker already drains
// one at a time, so monitor checks run sequentially after 2 AM.

import { db } from "./db";
import { newId } from "./password";

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
  const active = db()
    .prepare(
      `SELECT id FROM research_jobs
        WHERE intent = 'monitor'
          AND target_brief_id = ?
          AND status IN ('queued','running')
        LIMIT 1`,
    )
    .get(briefId) as { id: string } | undefined;
  if (active) return null;

  const brief = db()
    .prepare(`SELECT account_name, segment FROM briefs WHERE id = ?`)
    .get(briefId) as { account_name: string; segment: string | null } | undefined;
  if (!brief) return null;

  const jobId = newId();
  const intake = {
    account: brief.account_name,
    segment: brief.segment || undefined,
  };
  db()
    .prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal,
         intake_json, mode, status, created_at, intent, target_brief_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'monitor', ?)`,
    )
    .run(
      jobId,
      userId,
      brief.account_name,
      brief.segment,
      null,
      null,
      JSON.stringify(intake),
      "standard",
      Date.now(),
      briefId,
    );
  return jobId;
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

// Enqueue a monitor job for every monitor-enabled brief, attributed to the
// brief owner. Deduped per brief. Returns the number of jobs enqueued.
export function enqueueAllMonitorJobs(now: number = Date.now()): number {
  const briefs = db()
    .prepare(
      `SELECT id, user_id, monitor_cadence, last_monitored_at
         FROM briefs WHERE monitor_enabled = 1`,
    )
    .all() as Array<{
    id: string;
    user_id: string;
    monitor_cadence: string;
    last_monitored_at: number | null;
  }>;
  let count = 0;
  for (const b of briefs) {
    // Per-brief cadence: only enqueue when the brief is actually due. The 2 AM
    // gate still bounds this to at most one enqueue per brief per day.
    if (now < dueAt(b.last_monitored_at, b.monitor_cadence)) continue;
    if (enqueueMonitorJob(b.id, b.user_id)) count++;
  }
  return count;
}

// Called every worker tick. Once per local day, on/after 2 AM, enqueue the
// daily batch. Cheap and self-throttling — the date comparison short-circuits
// the rest of the day. Exposed `now` for deterministic testing.
export function maybeRunDailySchedule(now: Date = new Date()): number {
  if (now.getHours() < MONITOR_HOUR) return 0;
  const today = localDateKey(now);

  const row = db()
    .prepare(`SELECT last_run_date FROM monitor_schedule WHERE id = ?`)
    .get(SCHEDULE_ID) as { last_run_date: string | null } | undefined;
  if (row?.last_run_date === today) return 0;

  const count = enqueueAllMonitorJobs(now.getTime());

  // Record the run regardless of count so we don't re-scan all day even when
  // there are zero enabled briefs.
  db()
    .prepare(
      `INSERT INTO monitor_schedule (id, last_run_date) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET last_run_date = excluded.last_run_date`,
    )
    .run(SCHEDULE_ID, today);
  return count;
}
