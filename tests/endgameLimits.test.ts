import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.join(__dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "endgame-limits-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "limits.sqlite");
process.env.ADMIN_EMAIL = "limits-admin@example.com";
process.env.ADMIN_PASSWORD = "test-password";
delete process.env.PROVIDER_CALLS_ENABLED;
delete process.env.ANTHROPIC_API_KEY;

const require = createRequire(import.meta.url);
const bodyLimits = require("../web/lib/httpBodyLimits") as typeof import("../web/lib/httpBodyLimits");
const concurrency = require("../web/lib/providerConcurrency") as typeof import("../web/lib/providerConcurrency");
const access = require("../web/lib/providerAccess") as typeof import("../web/lib/providerAccess");
const queue = require("../web/lib/researchQueueLimits") as typeof import("../web/lib/researchQueueLimits");
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const auth = require("../web/lib/auth") as typeof import("../web/lib/auth");
const researchRoute = require("../web/app/api/research/route") as typeof import("../web/app/api/research/route");
const chatRoute = require("../web/app/api/briefs/[id]/chat/route") as typeof import("../web/app/api/briefs/[id]/chat/route");
const chatProvider = require("../web/lib/briefChatProviderClient") as typeof import("../web/lib/briefChatProviderClient");
const hermesClient = require("../web/lib/hermes/client") as typeof import("../web/lib/hermes/client");
const researchPipeline = require("../web/lib/researchPipeline") as typeof import("../web/lib/researchPipeline");
const worker = require("../web/lib/researchWorker") as typeof import("../web/lib/researchWorker");
const scheduler = require("../web/lib/monitorScheduler") as typeof import("../web/lib/monitorScheduler");
const commentAi = require("../web/lib/briefCommentsAi") as typeof import("../web/lib/briefCommentsAi");
const journalAi = require("../web/lib/journalAi") as typeof import("../web/lib/journalAi");
const hermesChatAdapter = require("../web/lib/hermes/chatAdapter") as typeof import("../web/lib/hermes/chatAdapter");
const strategic = require("../web/lib/strategicAnalysis") as typeof import("../web/lib/strategicAnalysis");
const journalRoute = require("../web/app/api/briefs/[id]/journal/route") as typeof import("../web/app/api/briefs/[id]/journal/route");
const notificationsReadRoute = require("../web/app/api/notifications/read/route") as typeof import("../web/app/api/notifications/read/route");
const runtimeAuth = require("../web/lib/hermes/runtimeServiceAuth") as typeof import("../web/lib/hermes/runtimeServiceAuth");

initDb();
test.after(() => rmSync(tmp, { recursive: true, force: true }));
test.afterEach(() => {
  delete process.env.PROVIDER_CALLS_ENABLED;
  chatProvider.__setTestBriefChatClient(null);
  researchPipeline.__setTestResearchPipelineRunner(null);
  commentAi.__setTestAssistClient(null);
  journalAi.__setTestJournalClient(null);
  delete process.env.HERMES_RUNTIME_ENABLED;
  delete process.env.HERMES_SERVICE_TOKEN;
});

function jsonRequest(text: string, contentLength?: string): Request {
  const bytes = new TextEncoder().encode(text);
  const chunks = [bytes.slice(0, Math.ceil(bytes.length / 2)), bytes.slice(Math.ceil(bytes.length / 2))];
  return new Request("http://localhost/test", {
    method: "POST",
    headers: contentLength === undefined ? {} : { "content-length": contentLength },
    body: new ReadableStream({ pull(controller) { const chunk = chunks.shift(); chunk ? controller.enqueue(chunk) : controller.close(); } }),
    duplex: "half",
  } as RequestInit);
}

function seedUser(id: string, role: "member" | "viewer" = "member") {
  db().prepare(`INSERT INTO users (id,email,password_hash,role,display_name,created_at,must_change_password)
    VALUES (?,?, 'h', ?, ?, ?, 0)`).run(id, `${id}@example.com`, role, id, Date.now());
  return auth.createSession(id).id;
}

function fakeRequest(sessionId: string | null, value: unknown, onJson?: () => void): any {
  return {
    cookies: { get: (name: string) => sessionId && name === auth.SESSION_COOKIE ? { value: sessionId } : undefined },
    json: async () => { onJson?.(); return value; },
  };
}

function seedBrief(userId: string, id: string) {
  const brief = {
    account_name: id, segment: "Technology", audience: "internal", generated_at: "2026-07-12",
    snapshot: "Stable", priority_summary: "Stable", recent_signals: [],
    ai_tech_maturity: { rating: 2, rationale: "Stable" }, top_initiatives: [],
    technical_footprint: { ai_in_production: [], active_pilots: [], cloud_platforms: [], data_infrastructure: "", clinical_platforms: "", analytics_bi_stack: "", build_vs_buy_posture: "", competitive_incumbents: [] },
    programs_procurement: { modernization_grants: [], consortium_purchasing: [], active_rfps_contracts: [], ai_governance_policy: "", public_ai_use_cases: [] },
    personas: [], buying_path: "", first_angle: "", risks: [], competitive_signals: [], next_action: "", extensions: [], sources: [],
  };
  db().prepare(`INSERT INTO briefs (id,user_id,account_name,segment,audience,generated_at,created_at,brief_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, userId, id, "Technology", "internal", "2026-07-12", Date.now(), JSON.stringify(brief));
}

test("bounded parser counts chunked actual bytes and ignores missing/forged Content-Length", async () => {
  assert.deepEqual(await bodyLimits.parseBoundedJson(jsonRequest('{"ok":true}'), 32), { ok: true });
  assert.deepEqual(await bodyLimits.parseBoundedJson(jsonRequest('{"ok":true}', "999999"), 32), { ok: true });
  await assert.rejects(bodyLimits.parseBoundedJson(jsonRequest(JSON.stringify({ x: "x".repeat(80) }), "2"), 32),
    (error: any) => error instanceof bodyLimits.JsonBodyError && error.status === 413);
  await assert.rejects(bodyLimits.parseBoundedJson(jsonRequest('{bad'), 32),
    (error: any) => error instanceof bodyLimits.JsonBodyError && error.status === 400);
});

test("authorization runs before body parsing", async () => {
  let parsed = 0;
  const response = await researchRoute.POST(fakeRequest(null, { account: "Nope" }, () => { parsed += 1; }));
  assert.equal(response.status, 401);
  assert.equal(parsed, 0);
});

test("notifications read uses bounded JSON after authorization with fixed errors", async () => {
  let parsed = 0;
  const unauthorized = await notificationsReadRoute.POST(fakeRequest(null, { all: true }, () => { parsed += 1; }));
  assert.equal(unauthorized.status, 401);
  assert.equal(parsed, 0);

  const sessionId = seedUser("notifications-limit-user");
  const invalid = await notificationsReadRoute.POST({
    ...fakeRequest(sessionId, undefined),
    json: async () => { throw new Error("malformed"); },
  } as any);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Invalid JSON body" });

  const oversized = await notificationsReadRoute.POST(fakeRequest(sessionId, {
    ids: ["x".repeat(bodyLimits.DEFAULT_JSON_BODY_BYTES + 1)],
  }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "Request body too large" });
});

test("production Hermes fake runtime still requires and enforces service auth", () => {
  const missing = {
    nodeEnv: "production",
    runtimeEnabled: true,
    fakeMode: true,
    serviceToken: null,
  } as const;
  assert.throws(() => runtimeAuth.assertRuntimeServiceAuthConfigured(missing), /HERMES_SERVICE_TOKEN/);
  assert.equal(runtimeAuth.runtimeServiceAuthorized(missing, undefined), false);

  const configured = { ...missing, serviceToken: "runtime-secret" };
  assert.doesNotThrow(() => runtimeAuth.assertRuntimeServiceAuthConfigured(configured));
  assert.equal(runtimeAuth.runtimeServiceAuthorized(configured, "Bearer runtime-secret"), true);
  assert.equal(runtimeAuth.runtimeServiceAuthorized(configured, undefined), false);
});

test("provider gate is default-off before job insertion; viewer remains denied; fake enabled succeeds", async () => {
  const memberSession = seedUser("limits-member");
  const viewerSession = seedUser("limits-viewer", "viewer");

  const disabled = await researchRoute.POST(fakeRequest(memberSession, { account: "Acme" }));
  assert.equal(disabled.status, 503);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM research_jobs").get() as any).n, 0);

  const briefId = "gate-chat-brief";
  seedBrief("limits-member", briefId);
  let chatCalls = 0;
  chatProvider.__setTestBriefChatClient({ messages: { create: async () => { chatCalls += 1; throw new Error("must not call"); } } } as any);
  const chatDisabled = await chatRoute.POST(fakeRequest(memberSession, { message: "Question" }), { params: Promise.resolve({ id: briefId }) });
  assert.equal(chatDisabled.status, 503);
  assert.equal(chatCalls, 0);

  process.env.PROVIDER_CALLS_ENABLED = "1";
  const viewer = await researchRoute.POST(fakeRequest(viewerSession, { account: "Acme" }));
  assert.equal(viewer.status, 403);
  const enabled = await researchRoute.POST(fakeRequest(memberSession, { account: "Acme" }));
  assert.equal(enabled.status, 202);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM research_jobs").get() as any).n, 1);
});

test("default-off helper gates run before fake client calls", async () => {
  delete process.env.PROVIDER_CALLS_ENABLED;
  let calls = 0;
  const fake = { messages: { create: async () => { calls += 1; return { content: [{ type: "text", text: "no" }] }; } } };
  await assert.rejects(commentAi.runAssist({ mode: "summarize_thread", brief_json: {}, thread: [] }, fake as any), access.ProviderAccessDisabledError);
  await assert.rejects(journalAi.runJournalReply({ brief_json: {}, entries: [] }, fake as any), access.ProviderAccessDisabledError);
  await assert.rejects(strategic.runStrategicAnalysis({ brief_json: {}, prompt: "Analyze" }, { isAdmin: true, acknowledgedDataPosture: true }, fake as any), access.ProviderAccessDisabledError);
  assert.equal(calls, 0);
});

test("semaphore enforces global/key contention and releases after throw", async () => {
  const sem = new concurrency.ProviderSemaphore(2, 1);
  const releaseA = sem.tryAcquire("a");
  const releaseB = sem.tryAcquire("b");
  assert.ok(releaseA && releaseB);
  assert.equal(sem.tryAcquire("a"), null);
  assert.equal(sem.tryAcquire("c"), null);
  releaseA();
  assert.ok(sem.tryAcquire("c"));

  await assert.rejects(concurrency.withProviderConcurrency("throws", async () => { throw new Error("boom"); }), /boom/);
  await concurrency.withProviderConcurrency("throws", async () => undefined);
});

test("journal AI contention writes zero rows and provider failure releases reservation", async () => {
  process.env.PROVIDER_CALLS_ENABLED = "1";
  const userId = "journal-contention-user";
  const sessionId = seedUser(userId);
  const briefId = "journal-contention-brief";
  seedBrief(userId, briefId);
  const countRows = () => (db().prepare("SELECT COUNT(*) n FROM journal_entries WHERE brief_id=?").get(briefId) as any).n;
  const countCockpitRows = () => (db().prepare("SELECT COUNT(*) n FROM journal_cockpit_read_models WHERE brief_id=?").get(briefId) as any).n;
  const before = countRows();
  const cockpitBefore = countCockpitRows();

  const releaseBlocker = concurrency.reserveProviderConcurrency(`brief:${briefId}`);
  const denied = await journalRoute.POST(fakeRequest(sessionId, {
    body: "Ask under contention",
    ask_ai: true,
    journal_catch_up_window: "24h",
  }), {
    params: Promise.resolve({ id: briefId }),
  });
  assert.equal(denied.status, 429);
  assert.deepEqual(await denied.json(), concurrency.PROVIDER_BUSY_BODY);
  assert.equal(countRows(), before);
  assert.equal(countCockpitRows(), cockpitBefore);
  releaseBlocker();

  journalAi.__setTestJournalClient({ messages: { create: async () => {
    throw new Error("provider sk-secret raw failure");
  } } } as any);
  const failed = await journalRoute.POST(fakeRequest(sessionId, { body: "Provider fails", ask_ai: true }), {
    params: Promise.resolve({ id: briefId }),
  });
  assert.equal(failed.status, 200);
  const failedBody = await failed.json();
  assert.equal(failedBody.entries.length, 1);
  assert.equal(failedBody.ai_error, "Journal assistant failed — please retry in a moment.");
  assert.doesNotMatch(JSON.stringify(failedBody), /sk-secret|provider.*failure/i);
  const releaseAfterFailure = concurrency.reserveProviderConcurrency(`brief:${briefId}`);
  releaseAfterFailure();
});

test("queue transaction applies per-user caps and concurrent refresh dedupe", async () => {
  process.env.PROVIDER_CALLS_ENABLED = "1";
  const userId = "queue-user";
  seedUser(userId);
  const briefId = "queue-brief";
  seedBrief(userId, briefId);

  const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => Promise.resolve().then(() =>
    queue.enqueueResearchJob({ userId, accountName: "Queue", intakeJson: '{}', mode: "standard", intent: "refresh", targetBriefId: briefId }))));
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = attempts.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof queue.ResearchQueueError);
  assert.equal(rejected.reason.status, 409);

  queue.enqueueResearchJob({ userId, accountName: "Queue 2", intakeJson: '{}', mode: "quick", intent: "research" });
  queue.enqueueResearchJob({ userId, accountName: "Queue 3", intakeJson: '{}', mode: "quick", intent: "research" });
  assert.throws(() => queue.enqueueResearchJob({ userId, accountName: "Queue 4", intakeJson: '{}', mode: "quick", intent: "research" }),
    (error: any) => error instanceof queue.ResearchQueueError && error.status === 429);
});

test("Hermes runtime mode requires a token before fetch", async () => {
  process.env.PROVIDER_CALLS_ENABLED = "1";
  process.env.HERMES_RUNTIME_ENABLED = "1";
  delete process.env.HERMES_SERVICE_TOKEN;
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetches += 1; throw new Error("must not fetch"); }) as typeof fetch;
  try {
    await assert.rejects(hermesClient.runHermesChat({} as any), /HERMES_SERVICE_TOKEN/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});

test("message, prompt context, and provider output bounds fail without semantic truncation", async () => {
  process.env.PROVIDER_CALLS_ENABLED = "1";
  let chatCalls = 0;
  const userId = "bounds-user";
  const sessionId = seedUser(userId);
  const briefId = "bounds-brief";
  seedBrief(userId, briefId);
  chatProvider.__setTestBriefChatClient({ messages: { create: async () => { chatCalls += 1; throw new Error("must not call"); } } } as any);
  const oversized = "x".repeat(13 * 1024);
  const response = await chatRoute.POST(fakeRequest(sessionId, { message: oversized }), { params: Promise.resolve({ id: briefId }) });
  assert.equal(response.status, 400);
  assert.equal(chatCalls, 0);

  commentAi.__setTestAssistClient({ messages: { create: async () => ({ content: [{ type: "text", text: "x".repeat(commentAi.MAX_ASSIST_OUTPUT_BYTES + 1) }] }) } } as any);
  await assert.rejects(commentAi.runAssist({ mode: "summarize_thread", brief_json: {}, thread: [] }), /output is too large/);
  journalAi.__setTestJournalClient({ messages: { create: async () => ({ content: [{ type: "text", text: "x".repeat(journalAi.MAX_JOURNAL_OUTPUT_BYTES + 1) }] }) } } as any);
  await assert.rejects(journalAi.runJournalReply({ brief_json: {}, entries: [] }), /output is too large/);
});

test("worker and scheduler make zero provider calls or queued inserts while gate is off", async () => {
  const userId = "gate-worker-user";
  seedUser(userId);
  const briefId = "gate-worker-brief";
  seedBrief(userId, briefId);
  db().prepare("UPDATE briefs SET monitor_enabled=1 WHERE id=?").run(briefId);
  const jobId = "gate-worker-job";
  db().prepare(`INSERT INTO research_jobs (id,user_id,account_name,intake_json,mode,status,created_at,intent)
    VALUES (?,?,?,'{"account":"Gate"}','quick','running',?,'create')`).run(jobId, userId, "Gate", Date.now());
  let calls = 0;
  researchPipeline.__setTestResearchPipelineRunner(async () => { calls += 1; throw new Error("must not call"); });
  const job = db().prepare("SELECT * FROM research_jobs WHERE id=?").get(jobId) as any;
  await worker.executeResearchJob(job);
  assert.equal(calls, 0);
  const queuedBefore = (db().prepare("SELECT COUNT(*) n FROM research_jobs WHERE status='queued'").get() as any).n;
  assert.equal(scheduler.maybeRunDailySchedule(new Date(2026, 6, 12, 3)), 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM research_jobs WHERE status='queued'").get() as any).n, queuedBefore);
});

test("monitor scheduler retries capacity deferrals in stable order and completes with 409 dedupes", () => {
  process.env.PROVIDER_CALLS_ENABLED = "1";
  db().prepare("UPDATE briefs SET monitor_enabled=0").run();
  const userId = "scheduler-cap-user";
  seedUser(userId);
  const now = new Date(2026, 6, 14, 3);
  const nowMs = now.getTime();
  const briefs = [
    { id: "scheduler-cap-b", lastMonitoredAt: null },
    { id: "scheduler-cap-a", lastMonitoredAt: null },
    { id: "scheduler-cap-d", lastMonitoredAt: nowMs - 10 * 24 * 60 * 60 * 1000 },
    { id: "scheduler-cap-c", lastMonitoredAt: nowMs - 20 * 24 * 60 * 60 * 1000 },
    { id: "scheduler-cap-e", lastMonitoredAt: nowMs - 8 * 24 * 60 * 60 * 1000 },
  ];
  for (const brief of briefs) {
    seedBrief(userId, brief.id);
    db().prepare(
      "UPDATE briefs SET monitor_enabled=1, monitor_cadence='daily', last_monitored_at=? WHERE id=?",
    ).run(brief.lastMonitoredAt, brief.id);
  }
  db().prepare("DELETE FROM monitor_schedule WHERE id='singleton'").run();
  const windowStart = new Date(now);
  windowStart.setHours(2, 0, 0, 0);
  db().prepare(
    `INSERT INTO research_jobs
      (id,user_id,account_name,intake_json,mode,status,created_at,intent,target_brief_id)
     VALUES ('scheduler-cap-dedupe',?,?, '{}','standard','queued',?,'monitor','scheduler-cap-a')`,
  ).run(userId, "Scheduler dedupe", windowStart.getTime() - 1);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let firstCount: number;
  try {
    firstCount = scheduler.maybeRunDailySchedule(now);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(firstCount, queue.RESEARCH_QUEUE_LIMITS.activePerUser - 1);
  assert.deepEqual(
    (db().prepare(
      "SELECT target_brief_id FROM research_jobs WHERE user_id=? AND intent='monitor' AND status='queued' ORDER BY target_brief_id",
    ).all(userId) as Array<{ target_brief_id: string }>).map((row) => row.target_brief_id),
    ["scheduler-cap-a", "scheduler-cap-b", "scheduler-cap-c"],
  );
  assert.equal(
    (db().prepare("SELECT last_run_date FROM monitor_schedule WHERE id='singleton'").get() as any)?.last_run_date ?? null,
    null,
  );
  assert.deepEqual(warnings, ["[monitor-scheduler] capacity deferred count=2"]);

  db().prepare(
    `UPDATE research_jobs
        SET status='failed', finished_at=?, created_at=?
      WHERE user_id=? AND intent='monitor' AND id <> 'scheduler-cap-dedupe'`,
  ).run(nowMs, nowMs, userId);

  assert.equal(scheduler.maybeRunDailySchedule(now), 2);
  assert.equal(
    (db().prepare("SELECT last_run_date FROM monitor_schedule WHERE id='singleton'").get() as any).last_run_date,
    "2026-07-14",
  );
  assert.equal(
    (db().prepare("SELECT COUNT(*) n FROM research_jobs WHERE user_id=? AND intent='monitor' AND status='queued'").get(userId) as any).n,
    queue.RESEARCH_QUEUE_LIMITS.activePerUser,
  );
  assert.deepEqual(
    (db().prepare(
      "SELECT target_brief_id FROM research_jobs WHERE user_id=? AND intent='monitor' AND status='queued' ORDER BY target_brief_id",
    ).all(userId) as Array<{ target_brief_id: string }>).map((row) => row.target_brief_id),
    ["scheduler-cap-a", "scheduler-cap-d", "scheduler-cap-e"],
  );
  assert.deepEqual(
    db().prepare(
      `SELECT target_brief_id, COUNT(*) AS attempts
         FROM research_jobs
        WHERE user_id=? AND intent='monitor'
        GROUP BY target_brief_id
       HAVING COUNT(*) > 1`,
    ).all(userId),
    [],
  );
  assert.equal(scheduler.maybeRunDailySchedule(now), 0);
});

test("chat uses newest bounded history chronologically and prunes retention after durable outcome", async () => {
  process.env.PROVIDER_CALLS_ENABLED = "1";
  const userId = "history-user";
  const sessionId = seedUser(userId);
  const briefId = "history-brief";
  seedBrief(userId, briefId);
  const insert = db().prepare(`INSERT INTO brief_chats (id,brief_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)`);
  for (let i = 0; i < 205; i++) insert.run(`history-${i}`, briefId, userId, i % 2 ? "assistant" : "user", `message-${i}`, i);

  let supplied: any[] = [];
  chatProvider.__setTestBriefChatClient({ messages: { create: async (args: any) => {
    supplied = args.messages;
    return { stop_reason: "end_turn", container: null, usage: {}, content: [{ type: "text", text: "bounded reply" }] };
  } } } as any);
  const response = await chatRoute.POST(fakeRequest(sessionId, { message: "latest question" }), { params: Promise.resolve({ id: briefId }) });
  assert.equal(response.status, 200);
  assert.ok(supplied.length <= 41);
  assert.equal(supplied[0].content, "message-165");
  assert.equal(supplied.at(-1).content, "latest question");
  const retained = db().prepare("SELECT content FROM brief_chats WHERE brief_id=? ORDER BY created_at ASC, id ASC").all(briefId) as Array<{content:string}>;
  assert.equal(retained.length, 200);
  assert.equal(retained.at(-1)?.content, "bounded reply");
});

test("ResearchTray has narrow-safe width and explicit overload/unavailable state handling", () => {
  const source = readFileSync(path.join(root, "web/components/ResearchTray.tsx"), "utf8");
  assert.doesNotMatch(source, /className="[^"]*(?:^|\s)w-\[360px\]/);
  assert.match(source, /413/);
  assert.match(source, /429/);
  assert.match(source, /503/);
  assert.match(source, /w-\[calc\(100vw-\d+px\)\]/);
});

test("provider access accepts exactly the explicit enable value", () => {
  for (const value of [undefined, "", "0", "true", "yes"]) {
    if (value === undefined) delete process.env.PROVIDER_CALLS_ENABLED;
    else process.env.PROVIDER_CALLS_ENABLED = value;
    assert.equal(access.providerCallsEnabled(), false);
  }
  process.env.PROVIDER_CALLS_ENABLED = "1";
  assert.equal(access.providerCallsEnabled(), true);
});

test("Hermes adapter gate runs before provider-backed job persistence", async () => {
  delete process.env.PROVIDER_CALLS_ENABLED;
  const before = (db().prepare("SELECT COUNT(*) n FROM hermes_jobs").get() as any).n;
  await assert.rejects(hermesChatAdapter.runChatViaHermes({} as any), access.ProviderAccessDisabledError);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM hermes_jobs").get() as any).n, before);
});
