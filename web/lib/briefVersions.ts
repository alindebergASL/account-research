import { db } from "./db";
import { newId } from "./password";
import { logBriefVersionSnapshot, type ActorType } from "./briefEvents";

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
  actorType?: ActorType;
}): string {
  const id = newId();
  const versionNo = nextBriefVersionNo(args.briefId);
  db()
    .prepare(
      `INSERT INTO brief_versions
        (id, brief_id, version_no, brief_json, reason, triggered_by, refresh_job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.briefId,
      versionNo,
      args.briefJson,
      args.reason,
      args.triggeredBy,
      args.refreshJobId ?? null,
      Date.now(),
    );
  logBriefVersionSnapshot({
    briefId: args.briefId,
    versionId: id,
    versionNo,
    reason: args.reason,
    refreshJobId: args.refreshJobId ?? null,
    actorUserId: args.triggeredBy,
    actorType: args.actorType ?? (args.reason === "pre-refresh" ? "worker" : "user"),
  });
  return id;
}
