import { db } from "./db";
import { newId } from "./password";

export function nextBriefVersionNo(briefId: string): number {
  const row = db()
    .prepare(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM brief_versions WHERE brief_id = ?`)
    .get(briefId) as { n: number } | undefined;
  return row?.n ?? 1;
}

export function snapshotBriefVersion(args: {
  briefId: string;
  briefJson: string;
  reason: "pre-refresh" | "pre-revert" | string;
  triggeredBy: string;
  refreshJobId?: string | null;
}): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO brief_versions
        (id, brief_id, version_no, brief_json, reason, triggered_by, refresh_job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.briefId,
      nextBriefVersionNo(args.briefId),
      args.briefJson,
      args.reason,
      args.triggeredBy,
      args.refreshJobId ?? null,
      Date.now(),
    );
  return id;
}
