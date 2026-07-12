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

function proposedValues(briefId: string, target: string): any[] {
  const rows = db().prepare(
    "SELECT proposed_text FROM journal_review_candidates WHERE brief_id = ? AND target = ? ORDER BY created_at",
  ).all(briefId, target) as Array<{ proposed_text: string }>;
  return rows.map((row) => JSON.parse(row.proposed_text).value);
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
  assert.equal(after.recent_signals.some((s: any) => s.text === "Allowed public update"), false);
  assert.equal(proposedValues(briefId, "recent_signals").some((s: any) => s.text === "Allowed public update"), true);
});

test("monitor treats already-known source URLs as no-op duplicate updates", async () => {
  const owner = ownerId();
  const brief = makeBrief("Duplicate URL Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was hired as CIO to lead the court modernization program.",
    source: "https://news.example.com/cio-hire?utm_source=newsletter",
    confidence: "High" as const,
  });
  brief.sources.push({
    title: "CIO hire announcement",
    url: "https://news.example.com/cio-hire?utm_source=newsletter",
    accessed: "2026-06-04",
  });
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
            summary: "Duplicate CIO hire article resurfaced.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "Jane Doe was hired as CIO to lead the court modernization program.", source: "https://news.example.com/cio-hire#story", confidence: "High" } },
              { op: "append", field: "sources", value: { title: "CIO hire announcement duplicate", url: "https://news.example.com/cio-hire#story", accessed: "2026-06-05" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Duplicate URL Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const rowAfter = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  const after = JSON.parse(rowAfter.brief_json);
  assert.equal(rowAfter.last_monitored_at != null, true);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal(after.sources.filter((s: any) => /cio-hire/.test(s.url)).length, 1);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor treats syndicated same-person leadership news as a duplicate even with a new URL", async () => {
  const owner = ownerId();
  const brief = makeBrief("Duplicate Text Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was appointed chief information officer to lead digital modernization across the court.",
    source: "https://official.example.com/jane-doe-cio",
    confidence: "High" as const,
  });
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
            summary: "Syndicated CIO hire story appeared on another site.",
            patches: [{ op: "append", field: "recent_signals", value: { text: "Jane Doe named CIO to lead the court's digital modernization work.", source: "https://syndicated.example.com/local/court-technology-leader", confidence: "High" } }],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Duplicate Text Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const rowAfter = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  const after = JSON.parse(rowAfter.brief_json);
  assert.equal(rowAfter.last_monitored_at != null, true);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor does not collapse distinct article IDs carried in URL query parameters", async () => {
  const owner = ownerId();
  const brief = makeBrief("Distinct Query URL Monitor");
  brief.sources.push({
    title: "Prior article",
    url: "https://news.example.com/article?id=100",
    accessed: "2026-06-04",
  });
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
            summary: "A different article ID reported a new procurement milestone.",
            patches: [{ op: "append", field: "sources", value: { title: "New article", url: "https://news.example.com/article?id=101&utm_source=monitor", accessed: "2026-06-05" } }],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Distinct Query URL Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.sources.some((s: any) => s.url.includes("id=101")), false);
  assert.equal(proposedValues(briefId, "sources").some((s: any) => s.url.includes("id=101")), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor does not treat same-person different leadership event as duplicate", async () => {
  const owner = ownerId();
  const brief = makeBrief("Different Event Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was appointed chief information officer to lead digital modernization across the court.",
    source: "https://official.example.com/jane-doe-cio",
    confidence: "High" as const,
  });
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
            summary: "Jane Doe resigned as CIO after the modernization program changed direction.",
            patches: [{ op: "append", field: "recent_signals", value: { text: "Jane Doe resigned as CIO after digital modernization program delays.", source: "https://new.example.com/jane-doe-resigns-cio", confidence: "High" } }],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Different Event Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.some((s: any) => /resigned as CIO/.test(s.text)), false);
  assert.equal(proposedValues(briefId, "recent_signals").some((s: any) => /resigned as CIO/.test(s.text)), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor applies non-signal append patches even when text overlaps existing signal context", async () => {
  const owner = ownerId();
  const brief = makeBrief("Cross Field Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was appointed CIO to lead digital modernization across the court.",
    source: "https://official.example.com/jane-doe-cio",
    confidence: "High" as const,
  });
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
            summary: "The CIO modernization work became a funded initiative.",
            patches: [{ op: "append", field: "top_initiatives", value: { title: "CIO digital modernization initiative", detail: "Funded workstream under Jane Doe.", confidence: "High", source: "https://budget.example.com/funded-modernization" } }],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Cross Field Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.top_initiatives.some((i: any) => i.title === "CIO digital modernization initiative"), false);
  assert.equal(proposedValues(briefId, "top_initiatives").some((i: any) => i.title === "CIO digital modernization initiative"), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor drops supporting source patches when their only finding was duplicate text", async () => {
  const owner = ownerId();
  const brief = makeBrief("Duplicate Signal With Source Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was appointed chief information officer to lead digital modernization across the court.",
    source: "https://official.example.com/jane-doe-cio",
    confidence: "High" as const,
  });
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
            summary: "Syndicated CIO hire story appeared with a new URL.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "Jane Doe named CIO to lead the court's digital modernization work.", source: "https://syndicated.example.com/local/court-technology-leader", confidence: "High" } },
              { op: "append", field: "sources", value: { title: "Syndicated duplicate", url: "https://syndicated.example.com/local/court-technology-leader", accessed: "2026-06-05" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Duplicate Signal With Source Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const rowAfter = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  const after = JSON.parse(rowAfter.brief_json);
  assert.equal(rowAfter.last_monitored_at != null, true);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal(after.sources.some((s: any) => /syndicated/.test(s.url)), false);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor preserves source-before-signal ordering for genuinely new findings", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Source Before Signal Monitor"), true);
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
            summary: "A new CIO appointment was announced.",
            patches: [
              { op: "append", field: "sources", value: { title: "New CIO announcement", url: "https://new.example.com/jane-doe-appointed-cio", accessed: "2026-06-05" } },
              { op: "append", field: "recent_signals", value: { text: "Jane Doe was appointed CIO to lead digital modernization.", source: "https://new.example.com/jane-doe-appointed-cio", confidence: "High" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Source Before Signal Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.sources.some((s: any) => /jane-doe-appointed-cio/.test(s.url)), false);
  assert.equal(after.recent_signals.some((s: any) => /appointed CIO/.test(s.text)), false);
  assert.equal(proposedValues(briefId, "sources").some((s: any) => /jane-doe-appointed-cio/.test(s.url)), true);
  assert.equal(proposedValues(briefId, "recent_signals").some((s: any) => /appointed CIO/.test(s.text)), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor drops source-before-signal batches when the later signal is duplicate", async () => {
  const owner = ownerId();
  const brief = makeBrief("Source Before Duplicate Signal Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was appointed chief information officer to lead digital modernization across the court.",
    source: "https://official.example.com/jane-doe-cio",
    confidence: "High" as const,
  });
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
            summary: "Syndicated duplicate emitted source before signal.",
            patches: [
              { op: "append", field: "sources", value: { title: "Syndicated duplicate", url: "https://syndicated.example.com/source-before-duplicate", accessed: "2026-06-05" } },
              { op: "append", field: "recent_signals", value: { text: "Jane Doe named CIO to lead the court's digital modernization work.", source: "https://syndicated.example.com/source-before-duplicate", confidence: "High" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Source Before Duplicate Signal Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const rowAfter = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  const after = JSON.parse(rowAfter.brief_json);
  assert.equal(rowAfter.last_monitored_at != null, true);
  assert.equal(after.sources.some((s: any) => /source-before-duplicate/.test(s.url)), false);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor applies new signal that cites an existing canonical source page", async () => {
  const owner = ownerId();
  const brief = makeBrief("Canonical Source New Signal Monitor");
  brief.sources.push({
    title: "Agency news page",
    url: "https://agency.example.com/news",
    accessed: "2026-06-04",
  });
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
            summary: "The canonical news page now reports a new budget approval.",
            patches: [{ op: "append", field: "recent_signals", value: { text: "Board approved a new case-management modernization budget.", source: "https://agency.example.com/news", confidence: "High" } }],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Canonical Source New Signal Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.some((s: any) => /modernization budget/.test(s.text)), false);
  assert.equal(proposedValues(briefId, "recent_signals").some((s: any) => /modernization budget/.test(s.text)), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor applies only one copy of duplicate new signals within the same batch", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Same Batch Duplicate Monitor"), true);
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
            summary: "A new CIO appointment was reported twice by the model.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "Jane Doe was appointed CIO to lead digital modernization.", source: "https://new.example.com/jane-doe-appointed-cio", confidence: "High" } },
              { op: "append", field: "recent_signals", value: { text: "Jane Doe named CIO to lead digital modernization work.", source: "https://new.example.com/jane-doe-appointed-cio?utm_source=monitor", confidence: "High" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Same Batch Duplicate Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 0);
  assert.equal(proposedValues(briefId, "recent_signals").filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor preserves signal-before-source ordering for genuinely new findings", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Signal Before Source Monitor"), true);
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
            summary: "New budget finding emitted signal before source.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "Board approved a new case-management modernization budget.", source: "https://agency.example.com/news/new-budget", confidence: "High" } },
              { op: "append", field: "sources", value: { title: "Budget approval", url: "https://agency.example.com/news/new-budget", accessed: "2026-06-05" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Signal Before Source Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.some((s: any) => /modernization budget/.test(s.text)), false);
  assert.equal(after.sources.some((s: any) => /new-budget/.test(s.url)), false);
  assert.equal(proposedValues(briefId, "recent_signals").some((s: any) => /modernization budget/.test(s.text)), true);
  assert.equal(proposedValues(briefId, "sources").some((s: any) => /new-budget/.test(s.url)), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor preserves source when accepted finding is followed by a duplicate copy", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Accepted Plus Duplicate Source Monitor"), true);
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
            summary: "Model emitted a new signal, duplicate copy, then supporting source.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "Jane Doe was appointed CIO to lead digital modernization.", source: "https://new.example.com/jane-doe-cio", confidence: "High" } },
              { op: "append", field: "recent_signals", value: { text: "Jane Doe named CIO to lead digital modernization work.", source: "https://new.example.com/jane-doe-cio", confidence: "High" } },
              { op: "append", field: "sources", value: { title: "Jane Doe CIO appointment", url: "https://new.example.com/jane-doe-cio", accessed: "2026-06-05" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Accepted Plus Duplicate Source Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 0);
  assert.equal(after.sources.some((s: any) => /jane-doe-cio/.test(s.url)), false);
  assert.equal(proposedValues(briefId, "recent_signals").filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal(proposedValues(briefId, "sources").some((s: any) => /jane-doe-cio/.test(s.url)), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor drops source-before-duplicate when duplicate follows an accepted same-batch finding", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Accepted Then Duplicate Source Monitor"), true);
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
            summary: "Accepted finding plus later duplicate with a different syndicated source.",
            patches: [
              { op: "append", field: "sources", value: { title: "Original CIO report", url: "https://new.example.com/original-cio", accessed: "2026-06-05" } },
              { op: "append", field: "recent_signals", value: { text: "Jane Doe was appointed CIO to lead digital modernization.", source: "https://new.example.com/original-cio", confidence: "High" } },
              { op: "append", field: "sources", value: { title: "Syndicated duplicate CIO report", url: "https://wire.example.com/duplicate-cio", accessed: "2026-06-05" } },
              { op: "append", field: "recent_signals", value: { text: "Jane Doe named CIO to lead digital modernization work.", source: "https://wire.example.com/duplicate-cio", confidence: "High" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Accepted Then Duplicate Source Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 0);
  assert.equal(after.sources.some((s: any) => /original-cio/.test(s.url)), false);
  assert.equal(after.sources.some((s: any) => /duplicate-cio/.test(s.url)), false);
  assert.equal(proposedValues(briefId, "recent_signals").filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal(proposedValues(briefId, "sources").some((s: any) => /original-cio/.test(s.url)), true);
  assert.equal(proposedValues(briefId, "sources").some((s: any) => /duplicate-cio/.test(s.url)), false);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor drops duplicate supporting source when duplicate signal omits URL", async () => {
  const owner = ownerId();
  const brief = makeBrief("Duplicate No URL Signal Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was appointed chief information officer to lead digital modernization across the court.",
    source: "Original public notice",
    confidence: "High" as const,
  });
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
            summary: "Duplicate signal omitted URL but included a separate source patch.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "Jane Doe named CIO to lead digital modernization work.", source: "Syndicated newsletter", confidence: "High" } },
              { op: "append", field: "sources", value: { title: "Jane Doe CIO appointment", url: "https://wire.example.com/no-url-duplicate-cio", accessed: "2026-06-05" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Duplicate No URL Signal Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.filter((s: any) => /Jane Doe/.test(s.text)).length, 1);
  assert.equal(after.sources.some((s: any) => /no-url-duplicate-cio/.test(s.url)), false);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor applies distinct signals that cite the same canonical source URL", async () => {
  const owner = ownerId();
  const brief = makeBrief("Same Source New Signal Monitor");
  brief.recent_signals.push({
    text: "Jane Doe was appointed chief information officer to lead digital modernization across the court.",
    source: "https://agency.example.com/newsroom",
    confidence: "High" as const,
  });
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
            summary: "Same canonical newsroom URL has a materially different new finding.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "The court awarded a new e-filing modernization contract to CivicTech Systems.", source: "https://agency.example.com/newsroom", confidence: "High" } },
            ],
          },
        }],
      }),
    },
  });

  const job = insertMonitorJob(briefId, owner, "Same Source New Signal Monitor");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const after = JSON.parse((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json);
  assert.equal(after.recent_signals.some((s: any) => /e-filing modernization contract/.test(s.text)), false);
  assert.equal(proposedValues(briefId, "recent_signals").some((s: any) => /e-filing modernization contract/.test(s.text)), true);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
});

test("monitor update queues visible review candidates without journal, version, or Brief writes", async () => {
  const owner = ownerId();
  const briefId = insertBrief(owner, makeBrief("Visible Monitor Update"), true);
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
            summary: "A new e-filing modernization RFP was published.",
            patches: [
              { op: "append", field: "recent_signals", value: { text: "The court published an e-filing modernization RFP.", source: "https://procurement.example.com/efiling-rfp", confidence: "High" } },
              { op: "append", field: "sources", value: { title: "E-filing modernization RFP", url: "https://procurement.example.com/efiling-rfp", accessed: "2026-06-05" } },
            ],
          },
        }],
      }),
    },
  });

  const before = (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json;
  const job = insertMonitorJob(briefId, owner, "Visible Monitor Update");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json, before);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_versions WHERE brief_id = ?").get(briefId) as any).n, 0);
  assert.equal(proposedValues(briefId, "recent_signals").some((s: any) => /e-filing modernization RFP/.test(s.text)), true);
  assert.equal(proposedValues(briefId, "sources").some((s: any) => /efiling-rfp/.test(s.url)), true);
  const run = db().prepare("SELECT outcome, patches_applied, pre_version_id FROM monitor_runs WHERE job_id = ?").get(job.id) as any;
  assert.equal(run.outcome, "candidate_queued");
  assert.equal(run.patches_applied, 0);
  assert.equal(run.pre_version_id, null);
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
