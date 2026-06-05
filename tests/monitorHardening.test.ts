import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "monitor-hardening-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.MAIL_FROM;
delete process.env.ANTHROPIC_API_KEY;

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const { newId } = require("../web/lib/password") as typeof import("../web/lib/password");
const { executeMonitorJob } = require("../web/lib/researchWorker") as typeof import("../web/lib/researchWorker");
const { runMonitorScan, __setTestMonitorClient } = require("../web/lib/monitor") as typeof import("../web/lib/monitor");
const { cancelActiveMonitorJobsForBrief } = require("../web/lib/monitorScheduler") as typeof import("../web/lib/monitorScheduler");

initDb();

function makeBrief(name: string) {
  return {
    account_name: name,
    segment: "Public sector",
    generated_at: new Date().toISOString(),
    audience: "internal" as const,
    snapshot: "A court system.",
    priority_summary: "Watch public procurement and operations changes.",
    recent_signals: [{ text: "Existing public signal", source: "https://court.example/signal", confidence: "Medium" as const }],
    ai_tech_maturity: { rating: 3, rationale: "Moderate." },
    top_initiatives: [{ title: "Public e-filing modernization", detail: "Public initiative", confidence: "Medium" as const, source: "Published roadmap" }],
    technical_footprint: {
      ai_in_production: [],
      active_pilots: [],
      cloud_platforms: [],
      data_infrastructure: "",
      clinical_platforms: "",
      analytics_bi_stack: "",
      build_vs_buy_posture: "",
      competitive_incumbents: [],
    },
    programs_procurement: {
      modernization_grants: [],
      consortium_purchasing: [],
      active_rfps_contracts: [],
      ai_governance_policy: "",
      public_ai_use_cases: [],
    },
    personas: [{ name: "Internal Champion", title: "CIO", priority: "High", opener: "private persona note", confidence: "Medium" as const, source: "Internal note" }],
    buying_path: "SECRET_INTERNAL_BUYING_PATH_DO_NOT_SEND_TO_MONITOR",
    first_angle: "TBD",
    risks: ["SECRET_INTERNAL_RISK_DO_NOT_SEND_TO_MONITOR"],
    competitive_signals: [],
    next_action: "SECRET_INTERNAL_NEXT_ACTION_DO_NOT_SEND_TO_MONITOR",
    extensions: [],
    sources: [{ title: "Court site", url: "https://court.example", accessed: "2026-06-05" }],
  };
}

function ownerId(): string {
  return (db().prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
}

function insertBrief(owner: string, brief: any, monitorEnabled = true): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json, monitor_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, owner, brief.account_name, brief.segment, brief.audience, brief.generated_at, Date.now(), JSON.stringify(brief), monitorEnabled ? 1 : 0);
  return id;
}

function insertMonitorJob(briefId: string, userId: string, accountName: string, status: "queued" | "running" = "running"): any {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal, intake_json, mode, status, created_at, intent, target_brief_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'standard', ?, ?, 'monitor', ?)`,
    )
    .run(id, userId, accountName, "Public sector", null, null, JSON.stringify({ account: accountName }), status, Date.now(), briefId);
  return db().prepare(`SELECT * FROM research_jobs WHERE id = ?`).get(id);
}

test("disabled monitor job is skipped without model call, brief mutation, journal, or email side effects", async () => {
  const owner = ownerId();
  const brief = makeBrief("Disabled Court Monitor");
  const briefId = insertBrief(owner, brief, false);
  const beforeJson = (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json;
  let called = false;
  __setTestMonitorClient({
    messages: {
      create: async () => {
        called = true;
        throw new Error("monitor client should not be called for disabled briefs");
      },
    },
  });

  const job = insertMonitorJob(briefId, owner, "Disabled Court Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  assert.equal(called, false);
  const jobAfter = db().prepare("SELECT status, error FROM research_jobs WHERE id = ?").get(job.id) as any;
  assert.equal(jobAfter.status, "done");
  assert.equal(jobAfter.error, null);
  const rowAfter = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  assert.equal(rowAfter.brief_json, beforeJson);
  assert.equal(rowAfter.last_monitored_at, null);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("disabling a monitor cancels active monitor jobs for that brief only", () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Cancel Active Monitor"), true);
  const otherBriefId = insertBrief(owner, makeBrief("Other Monitor"), true);
  const queued = insertMonitorJob(briefId, owner, "Cancel Active Monitor", "queued");
  const running = insertMonitorJob(briefId, owner, "Cancel Active Monitor", "running");
  const otherQueued = insertMonitorJob(otherBriefId, owner, "Other Monitor", "queued");

  assert.equal(cancelActiveMonitorJobsForBrief(briefId), 2);

  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id = ?").get(queued.id) as any).status, "cancelled");
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id = ?").get(running.id) as any).status, "cancelled");
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id = ?").get(otherQueued.id) as any).status, "queued");
});

test("corrupt monitor brief JSON marks the job failed instead of throwing out of the worker", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Corrupt JSON Monitor"), true);
  db().prepare("UPDATE briefs SET brief_json = ? WHERE id = ?").run("{not valid json", briefId);
  const job = insertMonitorJob(briefId, owner, "Corrupt JSON Monitor");

  await executeMonitorJob(job);

  const jobAfter = db().prepare("SELECT status, error FROM research_jobs WHERE id = ?").get(job.id) as any;
  assert.equal(jobAfter.status, "failed");
  assert.match(jobAfter.error, /corrupt/i);
});

test("monitor prompt excludes internal strategy fields while preserving public monitoring context", async () => {
  const brief = makeBrief("Prompt Minimized Court");
  let systemPrompt = "";
  await runMonitorScan(
    { brief, lastMonitoredAt: Date.UTC(2026, 5, 1) },
    {
      messages: {
        create: async (args: any) => {
          systemPrompt = args.system;
          return {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", name: "record_monitor_findings", id: "t", input: { has_updates: false, summary: "", patches: [] } }],
          };
        },
      },
    },
  );

  assert.match(systemPrompt, /Prompt Minimized Court/);
  assert.match(systemPrompt, /Existing public signal/);
  assert.match(systemPrompt, /https:\/\/court\.example/);
  assert.doesNotMatch(systemPrompt, /SECRET_INTERNAL_NEXT_ACTION/);
  assert.doesNotMatch(systemPrompt, /SECRET_INTERNAL_BUYING_PATH/);
  assert.doesNotMatch(systemPrompt, /SECRET_INTERNAL_RISK/);
  assert.doesNotMatch(systemPrompt, /private persona note/);
});

test("monitor cancelled while scan is in flight exits without side effects", async () => {
  const owner = ownerId();
  const brief = makeBrief("In Flight Monitor");
  const briefId = insertBrief(owner, brief, true);
  const beforeJson = (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json;
  const job = insertMonitorJob(briefId, owner, "In Flight Monitor");
  let releaseScan!: () => void;
  let enteredScan!: () => void;
  const entered = new Promise<void>((resolve) => { enteredScan = resolve; });
  const release = new Promise<void>((resolve) => { releaseScan = resolve; });
  __setTestMonitorClient({
    messages: {
      create: async () => {
        enteredScan();
        await release;
        return {
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            name: "record_monitor_findings",
            id: "findings",
            input: {
              has_updates: true,
              summary: "Should not be persisted after cancellation.",
              patches: [{ op: "append", field: "recent_signals", value: { text: "Cancelled update", source: "https://court.example/cancelled", confidence: "High" } }],
            },
          }],
        };
      },
    },
  });

  const running = executeMonitorJob(job);
  await entered;
  db().prepare("UPDATE briefs SET monitor_enabled = 0 WHERE id = ?").run(briefId);
  cancelActiveMonitorJobsForBrief(briefId);
  releaseScan();
  await running;
  __setTestMonitorClient(null);

  const jobAfter = db().prepare("SELECT status FROM research_jobs WHERE id = ?").get(job.id) as any;
  assert.equal(jobAfter.status, "cancelled");
  const rowAfter = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  assert.equal(rowAfter.brief_json, beforeJson);
  assert.equal(rowAfter.last_monitored_at, null);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor update does not overwrite brief changes made during scan", async () => {
  const owner = ownerId();
  const brief = makeBrief("Concurrent Edit Monitor");
  const briefId = insertBrief(owner, brief, true);
  const job = insertMonitorJob(briefId, owner, "Concurrent Edit Monitor");
  let releaseScan!: () => void;
  let enteredScan!: () => void;
  const entered = new Promise<void>((resolve) => { enteredScan = resolve; });
  const release = new Promise<void>((resolve) => { releaseScan = resolve; });
  __setTestMonitorClient({
    messages: {
      create: async () => {
        enteredScan();
        await release;
        return {
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            name: "record_monitor_findings",
            id: "findings",
            input: {
              has_updates: true,
              summary: "This stale update should not be persisted.",
              patches: [{ op: "append", field: "recent_signals", value: { text: "Stale monitor update", source: "https://court.example/stale", confidence: "High" } }],
            },
          }],
        };
      },
    },
  });

  const running = executeMonitorJob(job);
  await entered;
  const editedBrief = { ...brief, priority_summary: "User edited this while monitor was scanning." };
  db().prepare("UPDATE briefs SET brief_json = ? WHERE id = ?").run(JSON.stringify(editedBrief), briefId);
  releaseScan();
  await running;
  __setTestMonitorClient(null);

  const jobAfter = db().prepare("SELECT status, error FROM research_jobs WHERE id = ?").get(job.id) as any;
  assert.equal(jobAfter.status, "failed");
  assert.match(jobAfter.error, /changed during scan/i);
  const rowAfter = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  const after = JSON.parse(rowAfter.brief_json);
  assert.equal(after.priority_summary, "User edited this while monitor was scanning.");
  assert.equal(after.recent_signals.some((s: any) => s.text === "Stale monitor update"), false);
  assert.equal(rowAfter.last_monitored_at, null);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor skips internal strategy field patches while applying allowed public updates", async () => {
  const owner = ownerId();
  const brief = makeBrief("Internal Patch Monitor");
  const briefId = insertBrief(owner, brief, true);
  __setTestMonitorClient({
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          name: "record_monitor_findings",
          id: "findings",
          input: {
            has_updates: true,
            summary: "A public update was found.",
            patches: [
              { op: "set", field: "buying_path", value: "MODEL SHOULD NOT SET INTERNAL BUYING PATH" },
              { op: "append", field: "recent_signals", value: { text: "Allowed public update", source: "https://court.example/public", confidence: "High" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Internal Patch Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.buying_path, brief.buying_path);
  assert.equal(after.recent_signals.some((s: any) => s.text === "Allowed public update"), true);
});

test("malformed monitor patch warning allowlists field names and does not log model-controlled field text", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Log Safety Monitor"), true);
  __setTestMonitorClient({
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          name: "record_monitor_findings",
          id: "findings",
          input: {
            has_updates: true,
            summary: "Malformed patch only.",
            patches: [{ op: "set", field: "SECRET_LOG_LEAK_FIELD", value: "x" }],
          },
        }],
      }),
    },
  });
  const warnings: string[] = [];
  const oldWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(" ")); };
  try {
    const job = insertMonitorJob(briefId, owner, "Log Safety Monitor");
    await executeMonitorJob(job);
  } finally {
    console.warn = oldWarn;
    __setTestMonitorClient(null);
  }

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /SECRET_LOG_LEAK_FIELD/);
  assert.match(warnings[0], /field=disallowed/);
});
