// Monitor run history. Every monitor scan — including no-op runs that change
// nothing — records one row here so the UI can show "checked yesterday, nothing
// new" as faithfully as "queued a review candidate". This is the durable
// history behind the user-facing Monitoring panel; candidate cards supply the
// corresponding Radar visibility.

import { db } from "./db";
import { newId } from "./password";

export type MonitorRunOutcome = "no_updates" | "candidate_queued" | "updated" | "failed";
export type MonitorRunTier = "triage_only" | "deep";

export type MonitorRunDto = {
  id: string;
  ran_at: number;
  outcome: MonitorRunOutcome;
  tier: MonitorRunTier;
  summary: string | null;
  patches_applied: number;
  touched_fields: string[];
  pre_version_id: string | null;
};

export function recordMonitorRun(input: {
  briefId: string;
  jobId: string | null;
  outcome: MonitorRunOutcome;
  tier?: MonitorRunTier;
  summary?: string | null;
  patchesApplied?: number;
  touchedFields?: string[];
  preVersionId?: string | null;
  usageJson?: string | null;
}): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO monitor_runs
        (id, brief_id, job_id, ran_at, outcome, tier, summary,
         patches_applied, touched_fields_json, pre_version_id, usage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.briefId,
      input.jobId ?? null,
      Date.now(),
      input.outcome,
      input.tier ?? "deep",
      input.summary ?? null,
      input.patchesApplied ?? 0,
      input.touchedFields && input.touchedFields.length > 0
        ? JSON.stringify(input.touchedFields)
        : null,
      input.preVersionId ?? null,
      input.usageJson ?? null,
    );
  return id;
}

function safeFields(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function listMonitorRuns(briefId: string, limit = 20): MonitorRunDto[] {
  const rows = db()
    .prepare(
      `SELECT id, ran_at, outcome, tier, summary, patches_applied,
              touched_fields_json, pre_version_id
         FROM monitor_runs
        WHERE brief_id = ?
        ORDER BY ran_at DESC
        LIMIT ?`,
    )
    .all(briefId, limit) as Array<{
    id: string;
    ran_at: number;
    outcome: MonitorRunOutcome;
    tier: MonitorRunTier;
    summary: string | null;
    patches_applied: number;
    touched_fields_json: string | null;
    pre_version_id: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ran_at: r.ran_at,
    outcome: r.outcome,
    tier: r.tier,
    summary: r.summary,
    patches_applied: r.patches_applied,
    touched_fields: safeFields(r.touched_fields_json),
    pre_version_id: r.pre_version_id,
  }));
}
