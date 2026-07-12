import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "monitor-invalid-patch-"));
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
const { __setTestMonitorClient } = require("../web/lib/monitor") as typeof import("../web/lib/monitor");

initDb();

function makeBrief(name: string) {
  return {
    account_name: name,
    segment: "Public sector",
    generated_at: new Date().toISOString(),
    audience: "internal" as const,
    snapshot: "A court system.",
    priority_summary: "Watch procurement and operations changes.",
    recent_signals: [],
    ai_tech_maturity: { rating: 3, rationale: "Moderate." },
    top_initiatives: [],
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
    personas: [],
    buying_path: "TBD",
    first_angle: "TBD",
    risks: [],
    competitive_signals: [],
    next_action: "Original next action",
    extensions: [],
    sources: [{ title: "Court site", url: "https://court.example", accessed: "2026-06-05" }],
  };
}

function insertBrief(ownerId: string, brief: any): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json, monitor_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(id, ownerId, brief.account_name, brief.segment, brief.audience, brief.generated_at, Date.now(), JSON.stringify(brief));
  return id;
}

function insertRunningMonitorJob(briefId: string, userId: string, accountName: string): any {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal, intake_json, mode, status, created_at, intent, target_brief_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'standard', 'running', ?, 'monitor', ?)`,
    )
    .run(id, userId, accountName, "Public sector", null, null, JSON.stringify({ account: accountName }), Date.now(), briefId);
  return db().prepare(`SELECT * FROM research_jobs WHERE id = ?`).get(id);
}

test("monitor ignores malformed extension patches while queueing valid updates for review", async () => {
  const ownerId = (db().prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  const briefId = insertBrief(ownerId, makeBrief("Los Angeles Superior Court"));
  const beforeJson = (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as any).brief_json;

  __setTestMonitorClient({
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "record_monitor_findings",
            id: "monitor-findings",
            input: {
              has_updates: true,
              summary: "A new court update was found.",
              patches: [
                {
                  op: "append",
                  field: "extensions",
                  value: {
                    kind: "section_ref",
                    id: "bad-canvas-widget-kind",
                    title: "Invalid canvas-style widget",
                    source: "research",
                    created_at: new Date().toISOString(),
                    why_included: "Model confused Canvas widget kinds with brief extension kinds.",
                    confidence: "High",
                    sources: [{ title: "Court update", url: "https://court.example/update", accessed: "2026-06-05" }],
                    body: "This should not make the monitor job fail.",
                  },
                },
                {
                  op: "append",
                  field: "recent_signals",
                  value: { text: "New court update", source: "https://court.example/update", confidence: "High" },
                },
              ],
            },
          },
        ],
      }),
    },
  });

  const job = insertRunningMonitorJob(briefId, ownerId, "Los Angeles Superior Court");
  await executeMonitorJob(job);
  __setTestMonitorClient(null);

  const jobAfter = db().prepare("SELECT status, error FROM research_jobs WHERE id = ?").get(job.id) as any;
  assert.equal(jobAfter.status, "done");
  assert.equal(jobAfter.error, null);

  const row = db().prepare("SELECT brief_json, last_monitored_at FROM briefs WHERE id = ?").get(briefId) as any;
  const after = JSON.parse(row.brief_json);
  assert.equal(typeof row.last_monitored_at, "number");
  assert.equal(row.brief_json, beforeJson);
  assert.equal(after.extensions.length, 0);
  assert.equal(after.recent_signals.some((s: any) => s.text === "New court update"), false);
  const candidates = db().prepare(
    "SELECT candidate_type, target, proposed_text, current_baseline, risk FROM journal_review_candidates WHERE brief_id = ?",
  ).all(briefId) as any[];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidate_type, "brief_update");
  assert.equal(candidates[0].target, "recent_signals");
  assert.match(candidates[0].current_baseline, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(candidates[0].risk).origin, "monitor");
  assert.equal((db().prepare("SELECT outcome FROM monitor_runs WHERE job_id = ?").get(job.id) as any).outcome, "candidate_queued");
});
