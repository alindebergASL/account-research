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
  logBriefMonitored,
  logBriefRefreshed,
  logBriefVersionSnapshot,
  logJobCompleted,
} from "./briefEvents";
import { applyPatches, type BriefPatch } from "./briefPatches";
import { runMonitorScan } from "./monitor";
import { insertJournalEntry } from "./journal";
import { listBriefEmailRecipients } from "./briefRecipients";
import { sendBriefMonitorUpdateEmail } from "./email";
import { maybeRunDailySchedule } from "./monitorScheduler";
import { neutralizeSourceLegendMarkers } from "./journalSourceLegend";

const POLL_INTERVAL_MS = 2000;
const MONITOR_ALLOWED_PATCH_FIELDS = new Set([
  "snapshot",
  "priority_summary",
  "recent_signals",
  "top_initiatives",
  "programs_procurement",
  "competitive_signals",
  "sources",
  "extensions",
]);

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

// Mark a monitor no-op done atomically only if it is still enabled/running.
function markMonitorNoopDone(job: ResearchJobRow, now: number): boolean {
  if (!job.target_brief_id) return false;
  const conn = db();
  const tx = conn.transaction(() => {
    const state = conn
      .prepare(
        `SELECT j.status AS job_status, b.monitor_enabled AS monitor_enabled
           FROM research_jobs j
           JOIN briefs b ON b.id = j.target_brief_id
          WHERE j.id = ? AND b.id = ?`,
      )
      .get(job.id, job.target_brief_id) as
      | { job_status: string; monitor_enabled: number }
      | undefined;
    if (!state || state.job_status !== "running" || state.monitor_enabled !== 1) {
      return false;
    }
    conn
      .prepare(`UPDATE briefs SET last_monitored_at = ? WHERE id = ?`)
      .run(now, job.target_brief_id);
    conn
      .prepare(
        `UPDATE research_jobs SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(now, job.id);
    return true;
  });
  return tx();
}

function commitMonitorUpdate(
  job: ResearchJobRow,
  now: number,
  previousBriefJson: string,
  updatedBriefJson: string,
): { versionId: string; versionNo: number } | "stale" | null {
  if (!job.target_brief_id) return null;
  const conn = db();
  const tx = conn.transaction(() => {
    const state = conn
      .prepare(
        `SELECT j.status AS job_status, b.monitor_enabled AS monitor_enabled, b.brief_json AS brief_json
           FROM research_jobs j
           JOIN briefs b ON b.id = j.target_brief_id
          WHERE j.id = ? AND b.id = ?`,
      )
      .get(job.id, job.target_brief_id) as
      | { job_status: string; monitor_enabled: number; brief_json: string }
      | undefined;
    if (!state || state.job_status !== "running" || state.monitor_enabled !== 1) {
      return null;
    }
    if (state.brief_json !== previousBriefJson) {
      return "stale";
    }
    const versionId = newId();
    const versionRow = conn
      .prepare(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM brief_versions WHERE brief_id = ?`)
      .get(job.target_brief_id) as { n: number } | undefined;
    const versionNo = versionRow?.n ?? 1;
    conn
      .prepare(
        `INSERT INTO brief_versions
          (id, brief_id, version_no, brief_json, reason, triggered_by, refresh_job_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        job.target_brief_id,
        versionNo,
        previousBriefJson,
        "pre-monitor",
        job.user_id,
        job.id,
        now,
      );
    conn
      .prepare(`UPDATE briefs SET brief_json = ?, last_monitored_at = ? WHERE id = ?`)
      .run(updatedBriefJson, now, job.target_brief_id);
    conn
      .prepare(
        `UPDATE research_jobs SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(now, job.id);
    return { versionId, versionNo };
  });
  return tx();
}

function markMonitorSkipped(job: ResearchJobRow, now: number) {
  db()
    .prepare(
      `UPDATE research_jobs SET status = 'done', error = NULL, finished_at = ? WHERE id = ?`,
    )
    .run(now, job.id);
}

function safePatchFieldForLog(field: unknown): string {
  return typeof field === "string" && MONITOR_ALLOWED_PATCH_FIELDS.has(field)
    ? field
    : "disallowed";
}

function monitorFieldLabel(field: string): string {
  return field.replace(/_/g, " ");
}

function formatMonitorJournalBody(args: {
  summary: string;
  touchedFields: string[];
  patchesApplied: number;
  versionNo: number;
}): string {
  const changed = args.touchedFields.length > 0
    ? args.touchedFields.map(monitorFieldLabel).join(", ")
    : "brief";
  return [
    "Daily monitor update",
    "",
    neutralizeSourceLegendMarkers(args.summary),
    "",
    `Changed sections: ${changed}`,
    `Applied changes: ${args.patchesApplied}`,
    `Previous brief snapshot: v${args.versionNo}`,
  ].join("\n");
}

const MONITOR_TRACKING_QUERY_PREFIXES = ["utm_"];
const MONITOR_TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "ref_src",
]);

function normalizeMonitorUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const params = Array.from(u.searchParams.entries())
      .filter(([key]) => {
        const k = key.toLowerCase();
        return !MONITOR_TRACKING_QUERY_PARAMS.has(k)
          && !MONITOR_TRACKING_QUERY_PREFIXES.some((prefix) => k.startsWith(prefix));
      })
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length > 0
      ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
      : "";
    return `${host}${path || "/"}${query}`;
  } catch {
    return null;
  }
}

function urlsFromString(value: string): string[] {
  const urls = value.match(/https?:\/\/[^\s)\]}>"']+/gi) ?? [];
  const direct = normalizeMonitorUrl(value);
  return [...(direct ? [direct] : []), ...urls.map(normalizeMonitorUrl).filter((u): u is string => !!u)];
}

function collectMonitorUrls(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const u of urlsFromString(value)) out.add(u);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMonitorUrls(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectMonitorUrls(v, out);
  }
  return out;
}

const MONITOR_TEXT_STOPWORDS = new Set([
  "about", "across", "after", "again", "also", "another", "article", "court", "daily",
  "from", "found", "into", "lead", "local", "monitor", "news", "official", "public",
  "said", "says", "site", "story", "that", "their", "there", "this", "update", "with",
  "work", "will", "would", "yesterday",
]);
const MONITOR_EVENT_TOKENS = new Set([
  "appointed",
  "approved",
  "awarded",
  "delayed",
  "hired",
  "launched",
  "named",
  "resigned",
  "selected",
]);

function normalizeMonitorText(raw: string): string[] {
  const expanded = raw
    .toLowerCase()
    .replace(/chief\s+information\s+officer/g, "cio")
    .replace(/chief\s+technology\s+officer/g, "cto")
    .replace(/\bhired\b/g, "appointed")
    .replace(/\bnamed\b/g, "appointed");
  return Array.from(
    new Set(
      expanded
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 3 && !MONITOR_TEXT_STOPWORDS.has(token)),
    ),
  );
}

function salientMonitorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(salientMonitorText).join(" ");
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  return [obj.text, obj.title, obj.detail, obj.body, obj.heading, obj.why_included]
    .map(salientMonitorText)
    .filter(Boolean)
    .join(" ");
}

function collectMonitorTexts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectMonitorTexts(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    const text = salientMonitorText(value);
    if (text) out.push(text);
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(v)) collectMonitorTexts(v, out);
    }
  }
  return out;
}

function monitorTextsAreDuplicates(a: string, b: string): boolean {
  const aTokens = normalizeMonitorText(a);
  const bTokens = normalizeMonitorText(b);
  if (aTokens.length < 4 || bTokens.length < 4) return false;
  const bSet = new Set(bTokens);
  const intersection = aTokens.filter((t) => bSet.has(t)).length;
  const aEvents = aTokens.filter((t) => MONITOR_EVENT_TOKENS.has(t));
  const bEvents = bTokens.filter((t) => MONITOR_EVENT_TOKENS.has(t));
  if (aEvents.length > 0 || bEvents.length > 0) {
    const bEventSet = new Set(bEvents);
    if (!aEvents.some((t) => bEventSet.has(t))) return false;
  }
  return intersection >= 5 && intersection / Math.min(aTokens.length, bTokens.length) >= 0.85;
}

function monitorSourceSupportsFinding(sourceText: string, findingTexts: string[]): boolean {
  const sourceTokens = normalizeMonitorText(sourceText);
  if (sourceTokens.length < 3) return false;
  const sourceSet = new Set(sourceTokens);
  return findingTexts.some((findingText) => {
    const findingTokens = normalizeMonitorText(findingText);
    if (findingTokens.length < 3) return false;
    const intersection = findingTokens.filter((t) => sourceSet.has(t)).length;
    return intersection >= 3 && intersection / Math.min(sourceTokens.length, findingTokens.length) >= 0.6;
  });
}

function isDuplicateAcceptedRecentSignal(existingSignals: unknown[], patch: BriefPatch): boolean {
  if (patch.op !== "append" || patch.field !== "recent_signals") return false;
  const patchText = salientMonitorText(patch.value);
  if (!patchText) return false;
  return collectMonitorTexts(existingSignals).some((existing) => monitorTextsAreDuplicates(patchText, existing));
}

function isDuplicateMonitorAppend(current: Brief, patch: BriefPatch): boolean {
  if (patch.op !== "append") return false;

  const existingUrls = collectMonitorUrls(current);
  const hasKnownUrl = Array.from(collectMonitorUrls(patch.value)).some((u) => existingUrls.has(u));
  if (patch.field === "sources") return hasKnownUrl;

  if (patch.field !== "recent_signals") return false;
  return isDuplicateAcceptedRecentSignal(current.recent_signals, patch);
}

function monitorMayCommit(job: ResearchJobRow, briefId: string): boolean {
  if (currentStatus(job.id) !== "running") {
    // eslint-disable-next-line no-console
    console.log(`[worker] monitor skip commit job=${job.id} (no longer running)`);
    return false;
  }
  const row = db()
    .prepare(`SELECT monitor_enabled FROM briefs WHERE id = ?`)
    .get(briefId) as { monitor_enabled: number } | undefined;
  if (!row || row.monitor_enabled !== 1) {
    markMonitorSkipped(job, Date.now());
    // eslint-disable-next-line no-console
    console.log(`[worker] monitor skip commit disabled job=${job.id} brief=${briefId}`);
    return false;
  }
  return true;
}

function applyValidMonitorPatches(
  base: Brief,
  patches: BriefPatch[],
): { brief: Brief; patches: BriefPatch[]; skipped: number; duplicates: number } {
  let current = base;
  const applied: BriefPatch[] = [];
  let skipped = 0;
  let duplicates = 0;
  const duplicateFindingUrls = new Set<string>();
  const duplicateFindingTexts: string[] = [];
  const appliedFindingUrls = new Set<string>();
  const appliedFindingTexts: string[] = [];
  const appliedSourceUrls = new Set<string>();
  const deferredSourcePatches: BriefPatch[] = [];
  for (const patch of patches) {
    if (patch && patch.field !== "sources" && isDuplicateMonitorAppend(base, patch)) {
      for (const u of collectMonitorUrls(patch.value)) duplicateFindingUrls.add(u);
      const text = salientMonitorText(patch.value);
      if (text) duplicateFindingTexts.push(text);
    }
  }

  for (const patch of patches) {
    try {
      if (!MONITOR_ALLOWED_PATCH_FIELDS.has(patch.field)) {
        throw new Error("monitor field not allowed");
      }
      if (patch.field === "sources") {
        deferredSourcePatches.push(patch);
        continue;
      }
      const patchUrls = collectMonitorUrls(patch.value);
      if (isDuplicateMonitorAppend(current, patch)) {
        duplicates += 1;
        for (const u of patchUrls) duplicateFindingUrls.add(u);
        const text = salientMonitorText(patch.value);
        if (text) duplicateFindingTexts.push(text);
        continue;
      }
      current = applyPatches(current, [patch]);
      for (const u of patchUrls) appliedFindingUrls.add(u);
      const text = salientMonitorText(patch.value);
      if (text) appliedFindingTexts.push(text);
      applied.push(patch);
    } catch (err: any) {
      skipped += 1;
      // A single malformed model-supplied patch should not fail the whole
      // monitor run. Keep any valid targeted updates and ignore the bad patch.
      // Do not log patch values; they can contain model/user content.
      // eslint-disable-next-line no-console
      console.warn(
        `[worker] monitor skipped malformed patch field=${safePatchFieldForLog(patch?.field)} err=patch_validation_failed`,
      );
    }
  }

  for (const patch of deferredSourcePatches) {
    try {
      const patchUrls = collectMonitorUrls(patch.value);
      const sourceText = salientMonitorText(patch.value);
      const supportsAcceptedFinding = Array.from(patchUrls).some((u) => appliedFindingUrls.has(u))
        || monitorSourceSupportsFinding(sourceText, appliedFindingTexts);
      const supportsDuplicateFinding = !supportsAcceptedFinding
        && (Array.from(patchUrls).some((u) => duplicateFindingUrls.has(u))
          || monitorSourceSupportsFinding(sourceText, duplicateFindingTexts));
      const duplicateAppend = isDuplicateMonitorAppend(base, patch)
        || Array.from(patchUrls).some((u) => appliedSourceUrls.has(u));
      if (supportsDuplicateFinding || duplicateAppend) {
        duplicates += 1;
        continue;
      }
      current = applyPatches(current, [patch]);
      for (const u of patchUrls) appliedSourceUrls.add(u);
      applied.push(patch);
    } catch (err: any) {
      skipped += 1;
      // A single malformed model-supplied patch should not fail the whole
      // monitor run. Keep any valid targeted updates and ignore the bad patch.
      // Do not log patch values; they can contain model/user content.
      // eslint-disable-next-line no-console
      console.warn(
        `[worker] monitor skipped malformed patch field=${safePatchFieldForLog(patch?.field)} err=patch_validation_failed`,
      );
    }
  }

  return { brief: current, patches: applied, skipped, duplicates };
}

export async function executeMonitorJob(job: ResearchJobRow) {
  // eslint-disable-next-line no-console
  console.log(
    `[worker] monitor start job=${job.id} brief=${job.target_brief_id} account=${job.account_name}`,
  );
  if (!job.target_brief_id) {
    markJobFailed(job.id, "Monitor job missing target_brief_id");
    return;
  }
  const briefId = job.target_brief_id;

  try {
    const row = db()
      .prepare(`SELECT brief_json, last_monitored_at, monitor_enabled FROM briefs WHERE id = ?`)
      .get(briefId) as
      | { brief_json: string; last_monitored_at: number | null; monitor_enabled: number }
      | undefined;
    if (!row) {
      markJobFailed(job.id, "Target brief not found");
      return;
    }
    if (row.monitor_enabled !== 1) {
      markMonitorSkipped(job, Date.now());
      // eslint-disable-next-line no-console
      console.log(`[worker] monitor skipped disabled job=${job.id} brief=${briefId}`);
      return;
    }

    let rawBrief: unknown;
    try {
      rawBrief = JSON.parse(row.brief_json);
    } catch {
      markJobFailed(job.id, "Stored target brief JSON is corrupt");
      return;
    }
    const parsed = BriefSchema.safeParse(rawBrief);
    if (!parsed.success) {
      markJobFailed(job.id, "Stored target brief failed validation");
      return;
    }

    const findings = await runMonitorScan({
      brief: parsed.data,
      lastMonitoredAt: row.last_monitored_at,
    });
    const now = Date.now();
    if (!monitorMayCommit(job, briefId)) return;

    if (!findings.has_updates || findings.patches.length === 0) {
      // Nothing materially new — touch last_monitored_at only. Change nothing
      // else: no version, no event, no journal, no email.
      if (!markMonitorNoopDone(job, now)) {
        // eslint-disable-next-line no-console
        console.log(`[worker] monitor no-op skipped job=${job.id} brief=${briefId}`);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[worker] monitor no-op job=${job.id} brief=${briefId}`);
      return;
    }

    // Apply targeted patches that validate; a malformed optional patch from
    // the model should not fail the whole monitor run or block valid updates.
    const applied = applyValidMonitorPatches(parsed.data, findings.patches);
    const updated = applied.brief;
    if (applied.patches.length === 0) {
      if (!markMonitorNoopDone(job, now)) {
        // eslint-disable-next-line no-console
        console.log(
          `[worker] monitor no-op skipped job=${job.id} brief=${briefId} malformed_patches=${applied.skipped}`,
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `[worker] monitor no-op job=${job.id} brief=${briefId} malformed_patches=${applied.skipped}`,
      );
      return;
    }
    const touchedFields = Array.from(
      new Set(applied.patches.map((p) => p.field)),
    );

    // Snapshot the pre-update brief and persist the update in one conditional
    // transaction so a late disable/cancel cannot be overwritten as done.
    const commit = commitMonitorUpdate(job, now, row.brief_json, JSON.stringify(updated));
    if (commit === "stale") {
      markJobFailed(job.id, "Brief changed during scan; monitor update skipped");
      // eslint-disable-next-line no-console
      console.log(`[worker] monitor stale skipped job=${job.id} brief=${briefId}`);
      return;
    }
    if (!commit) {
      // eslint-disable-next-line no-console
      console.log(`[worker] monitor update skipped job=${job.id} brief=${briefId}`);
      return;
    }
    const committed = commit as { versionId: string; versionNo: number };
    logBriefVersionSnapshot({
      briefId,
      versionId: committed.versionId,
      versionNo: committed.versionNo,
      reason: "pre-monitor",
      refreshJobId: job.id,
      actorUserId: job.user_id,
      actorType: "worker",
    });
    // eslint-disable-next-line no-console
    console.log(
      `[worker] monitor update job=${job.id} brief=${briefId} patches=${applied.patches.length} malformed_patches=${applied.skipped}`,
    );

    logBriefMonitored({
      briefId,
      jobId: job.id,
      actorUserId: job.user_id,
      preMonitorVersionId: committed.versionId,
      patchesApplied: applied.patches.length,
      touchedFields,
    });

    // Post the "what changed" note into the Journal as an assistant entry.
    insertJournalEntry({
      briefId,
      userId: job.user_id,
      authorType: "assistant",
      body: formatMonitorJournalBody({
        summary: findings.summary,
        touchedFields,
        patchesApplied: applied.patches.length,
        versionNo: committed.versionNo,
      }),
    });

    // Email owner + shared users (notification prefs respected in the query).
    const emailRow = db()
      .prepare(`SELECT monitor_enabled FROM briefs WHERE id = ?`)
      .get(briefId) as { monitor_enabled: number } | undefined;
    if (isEmailConfigured() && emailRow?.monitor_enabled === 1) {
      const recipients = listBriefEmailRecipients(briefId);
      for (const r of recipients) {
        await sendBriefMonitorUpdateEmail({
          to: r.email,
          recipientName: r.display_name,
          accountName: parsed.data.account_name,
          briefId,
          summary: findings.summary,
        });
      }
    }
  } catch (err: any) {
    // Do not persist or print raw provider/model/request text for automated
    // monitor failures; those strings can include model-controlled content.
    // eslint-disable-next-line no-console
    console.error(`[worker] monitor failed job=${job.id} err=monitor_failed`);
    markJobFailed(job.id, "Monitor job failed");
  }
}

async function executeResearchJob(job: ResearchJobRow) {
  if (job.intent === "monitor") {
    return executeMonitorJob(job);
  }
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

    const { brief, stages } = await runResearchPipeline(intake, {
      user_id: job.user_id,
      brief_id: job.target_brief_id ?? null,
    });

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
    // Daily-monitor scheduler tick. Cheap and self-throttling: enqueues the
    // 2 AM batch at most once per local day, then short-circuits.
    try {
      const enqueued = maybeRunDailySchedule();
      if (enqueued > 0) {
        // eslint-disable-next-line no-console
        console.log(`[worker] daily monitor enqueued count=${enqueued}`);
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[worker] monitor schedule threw err=${String(e?.message ?? e).slice(0, 500)}`);
    }

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
