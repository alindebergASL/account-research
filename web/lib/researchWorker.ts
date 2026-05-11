// Worker loop. Runs in the standalone PM2 'account-brief-worker' process.
// Picks one job at a time, runs the pipeline, persists brief + status in
// a single SQLite transaction so failures never leave orphan briefs.

import { db, type ResearchJobRow, type UserRow } from "./db";
import { newId } from "./password";
import {
  runResearchPipeline,
  PipelineError,
  type Intake,
} from "./researchPipeline";
import {
  estimateAnthropicCostCents,
  aggregateUsage,
  type StageUsage,
} from "./cost";
import {
  isEmailConfigured,
  logEmailBootStatus,
  sendJobCompleteEmail,
  sendJobFailedEmail,
} from "./email";
import { Brief as BriefSchema, type Brief } from "./schema";
import { mergeBriefs } from "./briefMerge";
import { snapshotBriefVersion } from "./briefVersions";
import {
  logBriefCreated,
  logBriefRefreshed,
  logJobCompleted,
} from "./briefEvents";

const POLL_INTERVAL_MS = 2000;

declare global {
  // eslint-disable-next-line no-var
  var __researchWorkerStarted: boolean | undefined;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickNextQueued(): ResearchJobRow | null {
  const conn = db();
  // Atomic claim: SELECT one queued row, UPDATE it to running, return it.
  // Single-worker means we don't strictly need this to be a transaction,
  // but the transaction makes it correct under any future cluster mode.
  const tx = conn.transaction(() => {
    const row = conn
      .prepare(
        `SELECT * FROM research_jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as ResearchJobRow | undefined;
    if (!row) return null;
    const now = Date.now();
    conn
      .prepare(
        `UPDATE research_jobs
         SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, row.id);
    return { ...row, status: "running" as const, started_at: now };
  });
  return tx();
}

function currentStatus(jobId: string): string | null {
  const row = db()
    .prepare(`SELECT status FROM research_jobs WHERE id = ?`)
    .get(jobId) as { status: string } | undefined;
  return row?.status ?? null;
}

function findUserForJob(userId: string): UserRow | null {
  const row = db()
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(userId) as UserRow | undefined;
  return row ?? null;
}

// Save the brief and mark the job done in one atomic transaction.
// Returns the new brief id. Used inside executeResearchJob after the final
// post-pipeline cancellation check.
function saveBriefAndMarkJobDone(
  job: ResearchJobRow,
  brief: Brief,
  stages: StageUsage[],
  costUsdCents: number | null,
): string {
  const conn = db();
  const briefId = newId();
  const usageJson = JSON.stringify({
    stages,
    total: aggregateUsage(stages),
  });
  const tx = conn.transaction(() => {
    conn
      .prepare(
        `INSERT INTO briefs
          (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        briefId,
        job.user_id,
        brief.account_name,
        brief.segment,
        brief.audience,
        brief.generated_at,
        Date.now(),
        JSON.stringify(brief),
      );
    conn
      .prepare(
        `UPDATE research_jobs
         SET status = 'done',
             brief_id = ?,
             usage_json = ?,
             cost_usd_cents = ?,
             finished_at = ?
         WHERE id = ?`,
      )
      .run(briefId, usageJson, costUsdCents, Date.now(), job.id);
  });
  tx();
  return briefId;
}

function refreshBriefAndMarkJobDone(
  job: ResearchJobRow,
  merged: Brief,
  stages: StageUsage[],
  costUsdCents: number | null,
): string {
  if (!job.target_brief_id) throw new Error("Refresh job missing target_brief_id");
  const conn = db();
  const usageJson = JSON.stringify({ stages, total: aggregateUsage(stages) });
  const tx = conn.transaction(() => {
    conn
      .prepare(
        `UPDATE briefs
         SET account_name = ?, segment = ?, audience = ?, generated_at = ?, brief_json = ?
         WHERE id = ?`,
      )
      .run(
        merged.account_name,
        merged.segment,
        merged.audience,
        merged.generated_at,
        JSON.stringify(merged),
        job.target_brief_id,
      );
    conn
      .prepare(
        `UPDATE research_jobs
         SET status = 'done',
             brief_id = ?,
             usage_json = ?,
             cost_usd_cents = ?,
             finished_at = ?
         WHERE id = ?`,
      )
      .run(job.target_brief_id, usageJson, costUsdCents, Date.now(), job.id);
  });
  tx();
  return job.target_brief_id;
}

function markJobFailed(jobId: string, errorMessage: string) {
  // Truncate + sanitize. Pipeline already does friendly mapping; this is a
  // belt-and-braces guard so we never persist an unbounded blob.
  const safe = String(errorMessage || "unknown error").slice(0, 4096);
  db()
    .prepare(
      `UPDATE research_jobs
       SET status = 'failed', error = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(safe, Date.now(), jobId);
}

export function recoverStuckJobs() {
  const res = db()
    .prepare(
      `UPDATE research_jobs
       SET status = 'failed',
           error = 'server_restarted',
           finished_at = ?
       WHERE status = 'running'`,
    )
    .run(Date.now());
  if (res.changes > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[worker] recovered stuck running jobs count=${res.changes} (marked failed: server_restarted)`,
    );
  }
}

async function executeResearchJob(job: ResearchJobRow) {
  // eslint-disable-next-line no-console
  console.log(
    `[worker] start job=${job.id} user=${job.user_id} account=${job.account_name} mode=${job.mode}`,
  );
  try {
    if (currentStatus(job.id) !== "running") {
      // eslint-disable-next-line no-console
      console.log(`[worker] skip job=${job.id} (no longer running)`);
      return;
    }

    let intake: Intake;
    try {
      intake = JSON.parse(job.intake_json);
    } catch (e: any) {
      markJobFailed(job.id, "Corrupt intake_json");
      return;
    }

    let previousBrief: Brief | null = null;
    let preRefreshVersionId: string | null = null;
    if (job.intent === "refresh") {
      if (!job.target_brief_id) {
        markJobFailed(job.id, "Refresh job missing target_brief_id");
        return;
      }
      const row = db()
        .prepare(`SELECT brief_json FROM briefs WHERE id = ?`)
        .get(job.target_brief_id) as { brief_json: string } | undefined;
      if (!row) {
        markJobFailed(job.id, "Target brief not found");
        return;
      }
      const parsed = BriefSchema.safeParse(JSON.parse(row.brief_json));
      if (!parsed.success) {
        markJobFailed(job.id, "Stored target brief failed validation");
        return;
      }
      previousBrief = parsed.data;
      preRefreshVersionId = snapshotBriefVersion({
        briefId: job.target_brief_id,
        briefJson: row.brief_json,
        reason: "pre-refresh",
        triggeredBy: job.user_id,
        refreshJobId: job.id,
      });
    }

    const { brief, stages } = await runResearchPipeline(intake);

    if (currentStatus(job.id) === "cancelled") {
      // eslint-disable-next-line no-console
      console.log(`[worker] cancelled_after_completion job=${job.id}`);
      return;
    }

    const cost = estimateAnthropicCostCents(stages);
    const isRefresh = job.intent === "refresh";
    const finalBrief = isRefresh && previousBrief ? mergeBriefs(previousBrief, brief) : brief;
    const validated = BriefSchema.parse(finalBrief);
    const briefId = isRefresh
      ? refreshBriefAndMarkJobDone(job, validated, stages, cost)
      : saveBriefAndMarkJobDone(job, validated, stages, cost);
    // eslint-disable-next-line no-console
    console.log(
      `[worker] done job=${job.id} intent=${job.intent ?? "create"} brief=${briefId} cost_cents=${cost ?? "null"}`,
    );

    // Audit-trail events (after the primary transaction commits).
    if (isRefresh) {
      logBriefRefreshed({
        briefId,
        jobId: job.id,
        actorUserId: job.user_id,
        mode: job.mode,
        costCents: cost,
        preRefreshVersionId,
      });
    } else {
      logBriefCreated({
        briefId,
        jobId: job.id,
        actorUserId: job.user_id,
        accountName: validated.account_name,
        mode: job.mode,
        costCents: cost,
        sourceCount: validated.sources?.length ?? 0,
      });
    }
    logJobCompleted({
      briefId,
      jobId: job.id,
      actorUserId: job.user_id,
      accountName: job.account_name,
      mode: job.mode,
      intent: isRefresh ? "refresh" : "create",
      costCents: cost,
    });

    if (isEmailConfigured()) {
      const user = findUserForJob(job.user_id);
      if (user && user.email_notifications_enabled) {
        await sendJobCompleteEmail(user, job, briefId, isRefresh ? "refresh" : "create");
      }
    }
  } catch (err: any) {
    const msg =
      err instanceof PipelineError
        ? err.friendly
        : String(err?.message ?? err ?? "unknown error");
    // eslint-disable-next-line no-console
    console.error(`[worker] failed job=${job.id} err=${msg.slice(0, 500)}`);
    markJobFailed(job.id, msg);
    if (isEmailConfigured()) {
      const user = findUserForJob(job.user_id);
      if (user && user.email_notifications_enabled) {
        await sendJobFailedEmail(user, { ...job, error: msg });
      }
    }
  }
}

export async function startWorker(): Promise<never> {
  if (globalThis.__researchWorkerStarted) {
    // eslint-disable-next-line no-console
    console.log("[worker] already started, skipping");
    return new Promise<never>(() => {}); // never resolves; keeps caller awaiting forever
  }
  if (process.env.RESEARCH_WORKER_ENABLED === "false") {
    // eslint-disable-next-line no-console
    console.log("[worker] disabled by env (RESEARCH_WORKER_ENABLED=false)");
    return new Promise<never>(() => {});
  }
  globalThis.__researchWorkerStarted = true;
  logEmailBootStatus();
  // eslint-disable-next-line no-console
  console.log(`[worker] started pid=${process.pid}`);

  // Loop forever. Any throw inside executeResearchJob is caught there;
  // the only way out of this loop is process exit.
  for (;;) {
    let job: ResearchJobRow | null = null;
    try {
      job = pickNextQueued();
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[worker] pickNextQueued threw err=${String(e?.message ?? e).slice(0, 500)}`);
    }
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    await executeResearchJob(job);
  }
}
