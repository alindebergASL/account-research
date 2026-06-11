// Local verification for the per-brief Daily Monitor.
//
// Proves end-to-end without model spend or network:
//   1. Update path: a stubbed scan returning has_updates=true applies the
//      patches, snapshots a pre-monitor version, logs a monitor_update event,
//      posts a Journal assistant entry, emails owner + shared users (not all
//      admins, honoring email_notifications_enabled), sets last_monitored_at,
//      and marks the job done.
//   2. No-op path: has_updates=false changes nothing but last_monitored_at —
//      no version, event, journal entry, or email.
//   3. Scheduler: maybeRunDailySchedule at 02:30 enqueues one queued monitor
//      job per enabled brief, dedupes, and is a no-op on a second same-day run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (!process.env.BRIEF_DB_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abb-monitor-verify-"));
  process.env.BRIEF_DB_PATH = path.join(tmpDir, "verify.sqlite");
}
if (!process.env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = "owner@example.com";
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = "VerifyTempPass123!";
// Make isEmailConfigured() true so the worker's email branch runs; the test
// mailer below intercepts the actual send (no SMTP connection is made).
process.env.SMTP_HOST = "localhost";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "u";
process.env.SMTP_PASS = "p";
process.env.MAIL_FROM = "noreply@example.com";
delete process.env.ANTHROPIC_API_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db, initDb } = require("../lib/db") as typeof import("../lib/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { newId, hashPassword } = require("../lib/password") as typeof import("../lib/password");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { executeMonitorJob } = require("../lib/researchWorker") as typeof import("../lib/researchWorker");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __setTestMonitorClient } = require("../lib/monitor") as typeof import("../lib/monitor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __setTestMailer } = require("../lib/email") as typeof import("../lib/email");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { maybeRunDailySchedule, enqueueAllMonitorJobs } = require("../lib/monitorScheduler") as typeof import("../lib/monitorScheduler");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listBriefEmailRecipients } = require("../lib/briefRecipients") as typeof import("../lib/briefRecipients");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function makeBrief(name: string) {
  return {
    account_name: name,
    segment: "Enterprise",
    generated_at: new Date().toISOString(),
    audience: "internal" as const,
    snapshot: "A company.",
    priority_summary: "Why now.",
    recent_signals: [{ text: "Existing signal", source: "https://x.test", confidence: "Medium" as const }],
    ai_tech_maturity: { rating: 3, rationale: "Mid." },
    top_initiatives: [],
    technical_footprint: {
      ai_in_production: [], active_pilots: [], cloud_platforms: [],
      data_infrastructure: "", clinical_platforms: "", analytics_bi_stack: "",
      build_vs_buy_posture: "", competitive_incumbents: [],
    },
    programs_procurement: {
      modernization_grants: [], consortium_purchasing: [], active_rfps_contracts: [],
      ai_governance_policy: "", public_ai_use_cases: [],
    },
    personas: [],
    buying_path: "TBD",
    first_angle: "TBD",
    risks: [],
    competitive_signals: [],
    next_action: "Original next action",
    extensions: [],
    sources: [{ title: "x", url: "https://x.test", accessed: "2026-06-05" }],
  };
}

function addUser(email: string, role: "admin" | "member", notif: 0 | 1): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, display_name, created_at, email_notifications_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, email, hashPassword("Pass123!Pass"), role, email, Date.now(), notif);
  return id;
}

function insertBrief(ownerId: string, brief: any, monitorEnabled: boolean): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json, monitor_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ownerId, brief.account_name, brief.segment, brief.audience, brief.generated_at, Date.now(), JSON.stringify(brief), monitorEnabled ? 1 : 0);
  return id;
}

function insertMonitorJob(briefId: string, userId: string, accountName: string): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal, intake_json, mode, status, created_at, intent, target_brief_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 'monitor', ?)`,
    )
    .run(id, userId, accountName, "Enterprise", null, null, JSON.stringify({ account: accountName }), "standard", Date.now(), briefId);
  return db().prepare(`SELECT * FROM research_jobs WHERE id = ?`).get(id) as any;
}

async function main() {
  initDb();
  const ownerId = (db().prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  const readerId = addUser("reader@example.com", "member", 1);
  const noNotifId = addUser("nonotif@example.com", "member", 0);
  const otherAdminId = addUser("admin2@example.com", "admin", 1);

  const brief = makeBrief("Acme Corp");
  const briefId = insertBrief(ownerId, brief, true);
  const now = Date.now();
  const share = db().prepare(
    `INSERT INTO brief_shares (brief_id, user_id, granted_by, created_at, role) VALUES (?, ?, ?, ?, ?)`,
  );
  share.run(briefId, readerId, ownerId, now, "reader");
  share.run(briefId, noNotifId, ownerId, now, "reader");

  // Recipients: owner + reader only (otherAdmin not shared; noNotif opted out).
  const recipients = listBriefEmailRecipients(briefId).map((r) => r.email).sort();
  assert(JSON.stringify(recipients) === JSON.stringify(["owner@example.com", "reader@example.com"]), `recipients = ${recipients.join(",")}`);

  // ---- 1. Update path -----------------------------------------------------
  const sentTo: string[] = [];
  __setTestMailer(async (a) => { sentTo.push(a.to); });
  __setTestMonitorClient({
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        content: [{
          type: "tool_use", name: "record_monitor_findings", id: "t1",
          input: {
            has_updates: true,
            summary: "Acme raised a $50M Series C.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "Raised $50M Series C", source: "https://news.test/acme", confidence: "High" } },
              { op: "set", field: "priority_summary", value: "Acme raised a Series C; monitor follow-up should focus on expansion signals." },
            ],
          },
        }],
      }),
    },
  });

  const job1 = insertMonitorJob(briefId, ownerId, "Acme Corp");
  await executeMonitorJob(job1 as any);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert(after.recent_signals.some((s: any) => /Series C/.test(s.text)), "signal appended");
  assert(/Series C/.test(after.priority_summary), "priority_summary revised");
  const ver = db().prepare("SELECT reason FROM brief_versions WHERE brief_id = ?").get(briefId) as any;
  assert(ver?.reason === "pre-monitor", "pre-monitor version snapshot taken");
  const ev = db().prepare("SELECT event_type, summary FROM brief_events WHERE brief_id = ? AND event_type = 'monitor_update'").get(briefId) as any;
  assert(!!ev, "monitor_update event logged");
  const je = db().prepare("SELECT author_type, body FROM journal_entries WHERE brief_id = ?").get(briefId) as any;
  assert(je?.author_type === "assistant" && /Series C/.test(je.body), "journal assistant entry posted with summary");
  assert(JSON.stringify(sentTo.sort()) === JSON.stringify(["owner@example.com", "reader@example.com"]), `emailed = ${sentTo.join(",")}`);
  const j1 = db().prepare("SELECT status FROM research_jobs WHERE id = ?").get((job1 as any).id) as any;
  assert(j1.status === "done", "update job marked done");
  const lm = (db().prepare("SELECT last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any).last_monitored_at;
  assert(typeof lm === "number", "last_monitored_at set");
  const updRun = db().prepare("SELECT outcome, patches_applied FROM monitor_runs WHERE brief_id = ? ORDER BY ran_at DESC LIMIT 1").get(briefId) as any;
  assert(updRun?.outcome === "updated" && updRun?.patches_applied >= 1, "update path recorded an 'updated' monitor_run");
  const updRun2 = db().prepare("SELECT tier, usage_json FROM monitor_runs WHERE brief_id = ? ORDER BY ran_at DESC LIMIT 1").get(briefId) as any;
  assert(updRun2?.tier === "deep", "update run recorded tier 'deep'");
  assert(typeof updRun2?.usage_json === "string", "update run recorded usage_json");

  // ---- 2. No-op path ------------------------------------------------------
  sentTo.length = 0;
  __setTestMonitorClient({
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "record_monitor_findings", id: "t2", input: { has_updates: false, summary: "", patches: [] } }],
      }),
    },
  });
  const versionsBefore = (db().prepare("SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?").get(briefId) as any).n;
  const journalBefore = (db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n;
  const briefBefore = (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json;

  const job2 = insertMonitorJob(briefId, ownerId, "Acme Corp");
  await executeMonitorJob(job2 as any);

  const versionsAfter = (db().prepare("SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?").get(briefId) as any).n;
  const journalAfter = (db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n;
  const briefAfter = (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json;
  assert(versionsAfter === versionsBefore, "no-op: no new version");
  assert(journalAfter === journalBefore, "no-op: no new journal entry");
  assert(briefAfter === briefBefore, "no-op: brief json unchanged");
  assert(sentTo.length === 0, "no-op: no email sent");
  const noopRun = db().prepare("SELECT outcome FROM monitor_runs WHERE brief_id = ? ORDER BY ran_at DESC LIMIT 1").get(briefId) as any;
  assert(noopRun?.outcome === "no_updates", "no-op path recorded a 'no_updates' monitor_run");

  __setTestMonitorClient(null);
  __setTestMailer(null);

  // ---- 3. Scheduler -------------------------------------------------------
  // Clear any monitor jobs so the schedule starts clean.
  db().prepare("DELETE FROM research_jobs WHERE intent = 'monitor'").run();
  // The brief was just monitored above; clear last_monitored_at so cadence
  // gating treats it as due for the daily-enqueue test.
  db().prepare("UPDATE briefs SET monitor_cadence = 'daily', last_monitored_at = NULL WHERE id = ?").run(briefId);
  const at0230 = new Date(); at0230.setHours(2, 30, 0, 0);
  const n1 = maybeRunDailySchedule(at0230);
  assert(n1 === 1, `scheduler enqueued ${n1}, expected 1`);
  const queued = (db().prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE intent='monitor' AND status='queued'").get() as any).n;
  assert(queued === 1, `expected 1 queued monitor job, got ${queued}`);
  const n2 = maybeRunDailySchedule(at0230);
  assert(n2 === 0, "scheduler is a no-op on second same-day run");

  // ---- 4. Per-brief cadence ----------------------------------------------
  db().prepare("DELETE FROM research_jobs WHERE intent = 'monitor'").run();
  const nowMs = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  // Weekly cadence checked just now → not due.
  db().prepare("UPDATE briefs SET monitor_cadence = 'weekly', last_monitored_at = ? WHERE id = ?").run(nowMs, briefId);
  const dueWeekly = enqueueAllMonitorJobs(nowMs);
  assert(dueWeekly === 0, `weekly cadence checked just now should not be due, got ${dueWeekly}`);
  db().prepare("DELETE FROM research_jobs WHERE intent = 'monitor'").run();
  // Daily cadence last checked 2 days ago → due.
  db().prepare("UPDATE briefs SET monitor_cadence = 'daily', last_monitored_at = ? WHERE id = ?").run(nowMs - 2 * DAY, briefId);
  const dueDaily = enqueueAllMonitorJobs(nowMs);
  assert(dueDaily === 1, `daily cadence 2 days stale should be due, got ${dueDaily}`);

  // ---- 5. Two-tier: triage decides nothing is new, deep scan is skipped ---
  db().prepare("UPDATE briefs SET monitor_enabled = 1, last_monitored_at = NULL WHERE id = ?").run(briefId);
  const vBefore5 = (db().prepare("SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?").get(briefId) as any).n;
  const jBefore5 = (db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n;
  __setTestMonitorClient({
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "record_triage", id: "tg", input: { anything_new: false, leads: [] } }],
      }),
    },
  });
  const job5 = insertMonitorJob(briefId, ownerId, "Acme Corp");
  await executeMonitorJob(job5 as any);
  __setTestMonitorClient(null);
  const vAfter5 = (db().prepare("SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?").get(briefId) as any).n;
  const jAfter5 = (db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n;
  assert(vAfter5 === vBefore5, "triage-skip: no new version");
  assert(jAfter5 === jBefore5, "triage-skip: no new journal entry");
  const triageRun = db().prepare("SELECT outcome, tier FROM monitor_runs WHERE brief_id = ? ORDER BY ran_at DESC LIMIT 1").get(briefId) as any;
  assert(triageRun?.outcome === "no_updates" && triageRun?.tier === "triage_only", "triage-skip recorded a 'triage_only' no_updates run");

  // eslint-disable-next-line no-console
  console.log("verify-monitor: OK");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
