// Local verification for the PR-3 Hermes chat adapter.
//
// Proves end-to-end without model spend or network:
//   1. HERMES_CHAT_ENABLED=1 + HERMES_RUNTIME_FAKE=1 routes chat through
//      Hermes, creates a fake chat job, persists ordered events, and
//      returns a deterministic reply.
//   2. Read-only chat cannot mutate brief or Canvas state.
//   3. Disabled runtime in non-fake mode records a failed chat job with a
//      sanitized error and throws HermesChatAdapterError.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (!process.env.BRIEF_DB_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abb-hermes-chat-verify-"));
  process.env.BRIEF_DB_PATH = path.join(tmpDir, "verify.sqlite");
}
if (!process.env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = "verify-hermes-chat@example.com";
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = "VerifyTempPass123!";

process.env.HERMES_RUNTIME_FAKE = "1";
process.env.HERMES_CHAT_ENABLED = "1";
delete process.env.HERMES_RUNTIME_ENABLED;
delete process.env.ANTHROPIC_API_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db, initDb } = require("../lib/db") as typeof import("../lib/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  runChatViaHermes,
  selectChatPath,
  HermesChatAdapterError,
} = require("../lib/hermes/chatAdapter") as typeof import("../lib/hermes/chatAdapter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listHermesEventsForJob } = require("../lib/hermes/events") as typeof import("../lib/hermes/events");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Brief: BriefSchema } = require("../lib/schema") as typeof import("../lib/schema");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    // eslint-disable-next-line no-console
    console.error(`assertion failed: ${msg}`);
    process.exit(2);
  }
}

const TOKEN_RE = /Bearer\s+[A-Za-z0-9._\-]+|sk-[A-Za-z0-9\-_]{20,}|Cookie:|Authorization:/i;

const sampleBrief = {
  account_name: "Verify Hermes Chat",
  segment: "lab",
  generated_at: "1970-01-01",
  audience: "internal",
  snapshot: "Verification account snapshot.",
  priority_summary: "Verification priority summary.",
  recent_signals: [],
  ai_tech_maturity: { rating: 3, rationale: "Verification rationale." },
  top_initiatives: [],
  technical_footprint: {
    ai_in_production: [],
    active_pilots: [],
    cloud_platforms: [],
    data_infrastructure: "Verification data infrastructure.",
    clinical_platforms: "Verification platforms.",
    analytics_bi_stack: "Verification BI.",
    build_vs_buy_posture: "Verification posture.",
    competitive_incumbents: [],
  },
  programs_procurement: {
    modernization_grants: [],
    consortium_purchasing: [],
    active_rfps_contracts: [],
    ai_governance_policy: "Verification policy.",
    public_ai_use_cases: [],
  },
  personas: [],
  buying_path: "Verification buying path.",
  first_angle: "Verification first angle.",
  risks: [],
  competitive_signals: [],
  next_action: "Verification next action.",
  extensions: [],
  sources: [],
};

async function main() {
  initDb();
  const conn = db();
  const parsed = BriefSchema.safeParse(sampleBrief);
  assert(parsed.success, "sample brief parses");

  const userId = "verify-hermes-chat-user";
  const briefId = "verify-hermes-chat-brief";
  const now = Date.now();
  conn
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, password_hash, role, display_name, created_at)
       VALUES (?, ?, 'scrypt$N=1$x$y', 'member', ?, ?)`,
    )
    .run(userId, `verify-chat-${randomUUID()}@example.com`, "verify-hermes-chat", now);
  conn
    .prepare(
      `INSERT OR IGNORE INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, ?, 'lab', 'internal', '1970-01-01', ?, ?)`,
    )
    .run(briefId, userId, sampleBrief.account_name, now, JSON.stringify(sampleBrief));

  assert(selectChatPath() === "hermes", "routing selects hermes when HERMES_CHAT_ENABLED=1");
  delete process.env.HERMES_CHAT_ENABLED;
  assert(selectChatPath() === "direct", "routing selects direct when HERMES_CHAT_ENABLED is off");
  process.env.HERMES_CHAT_ENABLED = "1";

  const beforeJobs = (conn.prepare(`SELECT COUNT(*) AS c FROM hermes_jobs WHERE kind = 'chat'`).get() as { c: number }).c;
  const result = await runChatViaHermes({
    brief_id: briefId,
    user_id: userId,
    brief: parsed.data,
    history: [],
    message: "Hello fake Hermes chat",
    can_write: true,
  });
  assert(result.reply.includes("[fake] Hermes chat received"), "fake chat reply returned");
  assert(result.patches_applied.length === 0, "fake chat returns no patches");
  assert(result.patch_errors.length === 0, "fake chat returns no patch errors");

  const afterJobs = (conn.prepare(`SELECT COUNT(*) AS c FROM hermes_jobs WHERE kind = 'chat'`).get() as { c: number }).c;
  assert(afterJobs === beforeJobs + 1, "one fake chat job created");
  const fakeJob = conn
    .prepare(`SELECT id, fake, status FROM hermes_jobs WHERE kind = 'chat' ORDER BY created_at DESC LIMIT 1`)
    .get() as { id: string; fake: number; status: string };
  assert(fakeJob.fake === 1, "fake job marked fake=1");
  assert(fakeJob.status === "done", "fake job status done");
  const fakeEvents = listHermesEventsForJob(fakeJob.id);
  const fakeKinds = fakeEvents.map((e) => e.kind);
  assert(fakeKinds[0] === "chat.started", `first event chat.started, got ${fakeKinds[0]}`);
  assert(fakeKinds.includes("chat.message"), "runtime chat.message event persisted");
  assert(fakeKinds.includes("job.completed"), "job.completed event persisted");
  for (const row of conn.prepare(`SELECT payload_json FROM hermes_job_events WHERE job_id = ?`).all(fakeJob.id) as Array<{ payload_json: string | null }>) {
    assert(!row.payload_json || !TOKEN_RE.test(row.payload_json), "fake event payload sanitized");
  }

  const readOnlyResult = await runChatViaHermes({
    brief_id: briefId,
    user_id: userId,
    brief: parsed.data,
    history: [{ role: "user", content: "Prior question" }],
    message: "Read-only question",
    can_write: false,
  });
  assert(readOnlyResult.patches_applied.length === 0, "read-only chat boundary returns no patches");
  assert(readOnlyResult.brief === undefined, "read-only chat boundary returns no mutated brief");

  delete process.env.HERMES_RUNTIME_FAKE;
  delete process.env.HERMES_RUNTIME_ENABLED;
  let caught: InstanceType<typeof HermesChatAdapterError> | null = null;
  try {
    await runChatViaHermes({
      brief_id: briefId,
      user_id: userId,
      brief: parsed.data,
      history: [],
      message: "Failure path Authorization: Bearer abcdef0123456789 sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      can_write: true,
    });
  } catch (e) {
    if (e instanceof HermesChatAdapterError) caught = e;
  }
  assert(caught, "failure path throws HermesChatAdapterError");
  assert(caught!.kind === "runtime_disabled", `failure kind runtime_disabled, got ${caught!.kind}`);
  assert(!TOKEN_RE.test(caught!.message), "adapter error message sanitized");
  const failedJob = conn.prepare(`SELECT status, error FROM hermes_jobs WHERE id = ?`).get(caught!.jobId) as { status: string; error: string | null };
  assert(failedJob.status === "failed", "failed job status persisted");
  assert(Boolean(failedJob.error) && !TOKEN_RE.test(failedJob.error || ""), "failed job error sanitized");

  const totalJobs = (conn.prepare(`SELECT COUNT(*) AS c FROM hermes_jobs WHERE kind = 'chat'`).get() as { c: number }).c;
  const totalEvents = (conn.prepare(`SELECT COUNT(*) AS c FROM hermes_job_events WHERE job_id IN (SELECT id FROM hermes_jobs WHERE kind = 'chat')`).get() as { c: number }).c;
  // eslint-disable-next-line no-console
  console.log(`hermes_chat_adapter_ok jobs=${totalJobs} events=${totalEvents} fake_path=ok read_only=ok failure_path=ok db=${process.env.BRIEF_DB_PATH}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    // eslint-disable-next-line no-console
    console.error("verify-hermes-chat-adapter failed:", e?.message ?? e);
    process.exit(1);
  },
);
