import test from "node:test";
process.env.PROVIDER_CALLS_ENABLED = "1"; // Explicitly enable only deterministic fake clients in this suite.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const root = path.join(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const tmp = mkdtempSync(path.join(os.tmpdir(), "endgame-ai-boundary-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "endgame-admin@example.com";
process.env.ADMIN_PASSWORD = "test-password";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.HERMES_CHAT_ENABLED;
delete process.env.HERMES_RUNTIME_ENABLED;

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const auth = require("../web/lib/auth") as typeof import("../web/lib/auth");
const chat = require("../web/app/api/briefs/[id]/chat/route") as typeof import("../web/app/api/briefs/[id]/chat/route");
const chatProvider = require("../web/lib/briefChatProviderClient") as typeof import("../web/lib/briefChatProviderClient");
const hermesClient = require("../web/lib/hermes/client") as typeof import("../web/lib/hermes/client");
const worker = require("../web/lib/researchWorker") as typeof import("../web/lib/researchWorker");
const researchPipeline = require("../web/lib/researchPipeline") as typeof import("../web/lib/researchPipeline");
const monitor = require("../web/lib/monitor") as typeof import("../web/lib/monitor");
const radarManifest = require("../web/lib/journalRadarManifest") as typeof import("../web/lib/journalRadarManifest");
const boundary = require("../web/lib/briefUpdateReviewBoundary") as typeof import("../web/lib/briefUpdateReviewBoundary");

initDb();

function sampleBrief(name: string) {
  return {
    account_name: name, segment: "Technology", audience: "internal" as const,
    generated_at: "2026-07-12", snapshot: "Stable baseline", priority_summary: "Stable priority",
    recent_signals: [], ai_tech_maturity: { rating: 2, rationale: "Baseline" }, top_initiatives: [],
    technical_footprint: { ai_in_production: [], active_pilots: [], cloud_platforms: [], data_infrastructure: "", clinical_platforms: "", analytics_bi_stack: "", build_vs_buy_posture: "", competitive_incumbents: [] },
    programs_procurement: { modernization_grants: [], consortium_purchasing: [], active_rfps_contracts: [], ai_governance_policy: "", public_ai_use_cases: [] },
    personas: [], buying_path: "", first_angle: "", risks: [], competitive_signals: [], next_action: "", extensions: [], sources: [],
  };
}

function seedActorAndBrief(suffix: string) {
  const userId = `user-${suffix}`;
  const briefId = `brief-${suffix}`;
  db().prepare(`INSERT INTO users (id,email,password_hash,role,display_name,created_at,must_change_password)
    VALUES (?,?,'h','member',?, ?,0)`).run(userId, `${userId}@example.com`, userId, Date.now());
  const brief = sampleBrief(`Account ${suffix}`);
  const briefJson = JSON.stringify(brief);
  db().prepare(`INSERT INTO briefs
    (id,user_id,account_name,segment,audience,generated_at,created_at,brief_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(briefId, userId, brief.account_name, brief.segment, brief.audience, brief.generated_at, Date.now(), briefJson);
  return { userId, briefId, brief, briefJson, sessionId: auth.createSession(userId).id };
}

function chatRequest(sessionId: string, message = "Propose an update"): any {
  return {
    cookies: { get: (name: string) => name === auth.SESSION_COOKIE ? { value: sessionId } : undefined },
    json: async () => ({ message }),
  };
}

function seedRefreshJob(seeded: ReturnType<typeof seedActorAndBrief>, suffix: string) {
  const id = `refresh-${suffix}`;
  db().prepare(`INSERT INTO research_jobs
    (id,user_id,account_name,intake_json,mode,status,created_at,intent,target_brief_id)
    VALUES (?,?,? ,?,'standard','running',?,'refresh',?)`)
    .run(id, seeded.userId, seeded.brief.account_name, JSON.stringify({ account: seeded.brief.account_name }), Date.now(), seeded.briefId);
  return db().prepare("SELECT * FROM research_jobs WHERE id=?").get(id) as any;
}

function seedMonitorJob(seeded: ReturnType<typeof seedActorAndBrief>, suffix: string) {
  db().prepare("UPDATE briefs SET monitor_enabled=1 WHERE id=?").run(seeded.briefId);
  const id = `monitor-${suffix}`;
  db().prepare(`INSERT INTO research_jobs
    (id,user_id,account_name,intake_json,mode,status,created_at,intent,target_brief_id)
    VALUES (?,?,?,?,'standard','running',?,'monitor',?)`)
    .run(id, seeded.userId, seeded.brief.account_name, JSON.stringify({ account: seeded.brief.account_name }), Date.now(), seeded.briefId);
  return db().prepare("SELECT * FROM research_jobs WHERE id=?").get(id) as any;
}

function patchChatClient(onFirstCall?: () => void) {
  let calls = 0;
  return {
    messages: { create: async () => {
      calls += 1;
      if (calls === 1) {
        onFirstCall?.();
        return {
          stop_reason: "tool_use", container: null, usage: {},
          content: [{ type: "tool_use", name: "update_brief", id: "tool-1", input: {
            patches: [{ op: "set", field: "priority_summary", value: "Human review required" }],
            summary: "Proposed priority update",
          } }],
        };
      }
      return { stop_reason: "end_turn", container: null, usage: {}, content: [{ type: "text", text: "Queued for human review." }] };
    } },
  } as any;
}

test("enabled existing-Brief AI paths contain no direct brief_json write", () => {
  const chat = read("web/app/api/briefs/[id]/chat/route.ts");
  const worker = read("web/lib/researchWorker.ts");

  assert.doesNotMatch(chat, /function saveBrief\b/);
  assert.doesNotMatch(chat, /UPDATE\s+briefs[\s\S]{0,200}?brief_json/i);
  assert.doesNotMatch(worker, /UPDATE\s+briefs[\s\S]{0,200}?brief_json/i);
  assert.doesNotMatch(worker, /function refreshBriefAndMarkJobDone\b/);
  assert.doesNotMatch(worker, /function commitMonitorUpdate\b/);
  assert.doesNotMatch(worker, /pre-refresh|pre-monitor/);
});

test("AI Brief-write paths use the review boundary", () => {
  const boundary = read("web/lib/briefUpdateReviewBoundary.ts");
  const chat = read("web/app/api/briefs/[id]/chat/route.ts");
  const worker = read("web/lib/researchWorker.ts");

  assert.match(boundary, /createHash\(["']sha256["']\)/);
  assert.match(chat, /briefUpdateReviewBoundary/);
  assert.match(worker, /briefUpdateReviewBoundary/);
});

test("chat route keeps test injection outside the Next.js route export surface", () => {
  const route = read("web/app/api/briefs/[id]/chat/route.ts");
  const providerClient = read("web/lib/briefChatProviderClient.ts");
  assert.doesNotMatch(route, /export\s+(?:function|const)\s+__setTest/);
  assert.doesNotMatch(route, /export\s+const\s+CHAT_/);
  assert.match(route, /briefChatClient as chatClient/);
  assert.match(providerClient, /export function __setTestBriefChatClient/);
});

test("direct chat keeps brief_json byte-identical and atomically queues bounded provenance/history/audit", async () => {
  const seeded = seedActorAndBrief("direct");
  chatProvider.__setTestBriefChatClient(patchChatClient());
  try {
    const response = await chat.POST(chatRequest(seeded.sessionId), { params: Promise.resolve({ id: seeded.briefId }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).candidates_queued, 1);
  } finally {
    chatProvider.__setTestBriefChatClient(null);
  }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  const candidate = db().prepare("SELECT * FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any;
  assert.equal(candidate.target, "priority_summary");
  assert.match(candidate.current_baseline, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(candidate.risk).origin, "direct_chat");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_chats WHERE brief_id=?").get(seeded.briefId) as any).n, 2);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_events WHERE brief_id=? AND event_type='brief_update_candidates_queued'").get(seeded.briefId) as any).n, 1);
});

test("reader Q&A receives no write tools or proposals and persists only bounded history", async () => {
  const seeded = seedActorAndBrief("reader-owner");
  const readerId = "reader-chat";
  db().prepare(`INSERT INTO users (id,email,password_hash,role,display_name,created_at,must_change_password)
    VALUES (?,?,'h','member',?, ?,0)`).run(readerId, `${readerId}@example.com`, readerId, Date.now());
  db().prepare("INSERT INTO brief_shares (brief_id,user_id,granted_by,created_at,role) VALUES (?,?,?,?, 'reader')")
    .run(seeded.briefId, readerId, seeded.userId, Date.now());
  const readerSession = auth.createSession(readerId).id;
  let suppliedTools: unknown = "not-called";
  chatProvider.__setTestBriefChatClient({ messages: { create: async (args: any) => {
    suppliedTools = args.tools;
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Read-only answer." }] };
  } } } as any);
  try {
    const response = await chat.POST(chatRequest(readerSession, "What is the priority?"), { params: Promise.resolve({ id: seeded.briefId }) });
    assert.equal(response.status, 200);
  } finally { chatProvider.__setTestBriefChatClient(null); }
  assert.equal(suppliedTools, undefined);
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_chats WHERE brief_id=?").get(seeded.briefId) as any).n, 2);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_events WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
});

test("review boundary rejects excess candidate count without truncating meaning", () => {
  const brief = sampleBrief("Boundary limits");
  const briefJson = JSON.stringify(brief);
  assert.throws(() => boundary.prepareBriefUpdateCandidates({
    baselineJson: briefJson, baseline: brief,
    patches: Array.from({ length: boundary.BRIEF_UPDATE_REVIEW_LIMITS.maxCandidates + 1 }, (_, index) => ({
      op: "set" as const, field: "priority_summary", value: `proposal-${index}`,
    })),
    context: { origin: "direct_chat", source: "anthropic", actorUserId: "actor" },
  }), /count/i);
});

test("whole-Brief array prefix growth prepares only bounded appends and rejects non-prefix changes", () => {
  const existingSources = Array.from({ length: 8 }, (_, index) => ({
    title: `Existing source ${index} ${"x".repeat(180)}`,
    url: `https://example.com/existing-${index}`,
    accessed: "2026-07-12",
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(existingSources), "utf8") > boundary.BRIEF_UPDATE_REVIEW_LIMITS.maxValueBytes);
  const brief = { ...sampleBrief("Large array baseline"), sources: existingSources };
  const briefJson = JSON.stringify(brief);
  const appended = { title: "Small new source", url: "https://example.com/new", accessed: "2026-07-13" };

  const patches = boundary.patchesFromWholeBrief(brief, {
    ...brief,
    sources: [...existingSources, appended],
  });
  assert.deepEqual(patches, [{ op: "append", field: "sources", value: appended }]);
  const prepared = boundary.prepareBriefUpdateCandidates({
    baselineJson: briefJson,
    baseline: brief,
    patches,
    context: { origin: "refresh", source: "research_pipeline", jobId: "array-job", actorUserId: "actor" },
  });
  assert.equal(prepared.length, 1);
  assert.equal(JSON.parse(prepared[0].proposedText).op, "append");
  assert.equal(JSON.stringify(brief), briefJson);

  assert.throws(() => boundary.patchesFromWholeBrief(brief, {
    ...brief,
    sources: [existingSources[1], existingSources[0], ...existingSources.slice(2), appended],
  }), /array|prefix|replace/i);
});

test("direct chat stale baseline and audit failure roll back candidates, history, and audit", async () => {
  const stale = seedActorAndBrief("stale");
  chatProvider.__setTestBriefChatClient(patchChatClient(() => {
    const edited = { ...stale.brief, snapshot: "Concurrent human edit" };
    db().prepare("UPDATE briefs SET brief_json=? WHERE id=?").run(JSON.stringify(edited), stale.briefId);
  }));
  try {
    const response = await chat.POST(chatRequest(stale.sessionId), { params: Promise.resolve({ id: stale.briefId }) });
    assert.equal(response.status, 409);
  } finally { chatProvider.__setTestBriefChatClient(null); }
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(stale.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_chats WHERE brief_id=?").get(stale.briefId) as any).n, 0);

  const audit = seedActorAndBrief("audit-fail");
  db().exec(`CREATE TRIGGER endgame_fail_event BEFORE INSERT ON brief_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`);
  chatProvider.__setTestBriefChatClient(patchChatClient());
  try {
    const response = await chat.POST(chatRequest(audit.sessionId), { params: Promise.resolve({ id: audit.briefId }) });
    assert.equal(response.status, 500);
  } finally {
    chatProvider.__setTestBriefChatClient(null);
    db().exec("DROP TRIGGER endgame_fail_event");
  }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(audit.briefId) as any).brief_json, audit.briefJson);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(audit.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_chats WHERE brief_id=?").get(audit.briefId) as any).n, 0);
});

test("writer chat with zero candidates does not emit a candidate-queued audit event", async () => {
  const seeded = seedActorAndBrief("chat-zero-candidates");
  chatProvider.__setTestBriefChatClient({ messages: { create: async () => ({
    stop_reason: "end_turn", container: null, usage: {},
    content: [{ type: "text", text: "No update candidate was proposed." }],
  }) } } as any);
  try {
    const response = await chat.POST(chatRequest(seeded.sessionId), { params: Promise.resolve({ id: seeded.briefId }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).candidates_queued, 0);
  } finally { chatProvider.__setTestBriefChatClient(null); }
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_events WHERE brief_id=? AND event_type='brief_update_candidates_queued'").get(seeded.briefId) as any).n, 0);
});

test("authority revoked during direct provider wait produces no durable chat outcome", async () => {
  const seeded = seedActorAndBrief("revoked");
  chatProvider.__setTestBriefChatClient(patchChatClient(() => {
    db().prepare("UPDATE users SET role='viewer' WHERE id=?").run(seeded.userId);
  }));
  try {
    const response = await chat.POST(chatRequest(seeded.sessionId), { params: Promise.resolve({ id: seeded.briefId }) });
    assert.equal(response.status, 403);
  } finally { chatProvider.__setTestBriefChatClient(null); }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_chats WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
});

test("hostile Hermes whole-Brief result is rejected without Brief/candidate/history/audit writes", async () => {
  const seeded = seedActorAndBrief("hermes-hostile");
  process.env.HERMES_CHAT_ENABLED = "1";
  hermesClient.__setTestHermesChatRunner(async () => ({
    reply: "Hostile oversized proposal",
    patches_applied: [], patch_errors: [],
    brief: { ...seeded.brief, snapshot: "x".repeat(2000) },
  } as any));
  try {
    const response = await chat.POST(chatRequest(seeded.sessionId), { params: Promise.resolve({ id: seeded.briefId }) });
    assert.equal(response.status, 500);
  } finally {
    hermesClient.__setTestHermesChatRunner(null);
    delete process.env.HERMES_CHAT_ENABLED;
  }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_chats WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_events WHERE brief_id=? AND event_type='brief_update_candidates_queued'").get(seeded.briefId) as any).n, 0);
});

test("valid Hermes whole-Brief result becomes field proposals while brief_json stays byte-identical", async () => {
  const seeded = seedActorAndBrief("hermes-valid");
  process.env.HERMES_CHAT_ENABLED = "1";
  hermesClient.__setTestHermesChatRunner(async () => ({
    reply: "Queued a whole-Brief result for review.", patches_applied: [], patch_errors: [],
    brief: { ...seeded.brief, next_action: "Manually review this proposed next action" },
  } as any));
  try {
    const response = await chat.POST(chatRequest(seeded.sessionId), { params: Promise.resolve({ id: seeded.briefId }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).candidates_queued, 1);
  } finally {
    hermesClient.__setTestHermesChatRunner(null);
    delete process.env.HERMES_CHAT_ENABLED;
  }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  const candidate = db().prepare("SELECT target,risk FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any;
  assert.equal(candidate.target, "next_action");
  assert.equal(JSON.parse(candidate.risk).origin, "hermes_chat");
});

test("refresh queues field candidates, marks the job done, and creates no Brief version/applied side effects", async () => {
  const seeded = seedActorAndBrief("refresh");
  const job = seedRefreshJob(seeded, "success");
  researchPipeline.__setTestResearchPipelineRunner(async () => ({
    brief: { ...seeded.brief, generated_at: "2026-07-13", priority_summary: "Fresh research proposal" },
    stages: [],
    quality: { filled: 8, total: 8, low: false, repaired: false, research_attempts: 1, source_candidates: 0, mode: "standard" },
  }));
  try { await worker.executeResearchJob(job); }
  finally { researchPipeline.__setTestResearchPipelineRunner(null); }

  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id=?").get(job.id) as any).status, "done");
  const candidate = db().prepare("SELECT target,risk FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any;
  assert.equal(candidate.target, "priority_summary");
  assert.equal(JSON.parse(candidate.risk).job_id, job.id);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_versions WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  const event = db().prepare("SELECT event_type,title,summary,metadata_json FROM brief_events WHERE brief_id=?").get(seeded.briefId) as any;
  assert.equal(event.event_type, "brief_update_candidates_queued");
  assert.doesNotMatch(`${event.title} ${event.summary}`, /applied|updated/i);
  assert.deepEqual(JSON.parse(event.metadata_json), {
    origin: "refresh", job_id: job.id, candidate_count: 1, touched_fields: ["priority_summary"],
  });
});

test("refresh provider failure leaves no orphan version/candidate and stale authority fails closed", async () => {
  const failed = seedActorAndBrief("refresh-failure");
  const failedJob = seedRefreshJob(failed, "provider-failure");
  researchPipeline.__setTestResearchPipelineRunner(async () => { throw new Error("provider test failure"); });
  try { await worker.executeResearchJob(failedJob); }
  finally { researchPipeline.__setTestResearchPipelineRunner(null); }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(failed.briefId) as any).brief_json, failed.briefJson);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id=?").get(failedJob.id) as any).status, "failed");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_versions WHERE brief_id=?").get(failed.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(failed.briefId) as any).n, 0);

  const insertFailure = seedActorAndBrief("refresh-insert-failure");
  const insertFailureJob = seedRefreshJob(insertFailure, "insert-failure");
  db().exec(`CREATE TRIGGER endgame_fail_candidate BEFORE INSERT ON journal_review_candidates BEGIN SELECT RAISE(ABORT, 'test candidate failure'); END`);
  researchPipeline.__setTestResearchPipelineRunner(async () => ({
    brief: { ...insertFailure.brief, next_action: "Must roll back" }, stages: [],
    quality: { filled: 8, total: 8, low: false, repaired: false, research_attempts: 1, source_candidates: 0, mode: "standard" },
  }));
  try { await worker.executeResearchJob(insertFailureJob); }
  finally {
    researchPipeline.__setTestResearchPipelineRunner(null);
    db().exec("DROP TRIGGER endgame_fail_candidate");
  }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(insertFailure.briefId) as any).brief_json, insertFailure.briefJson);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id=?").get(insertFailureJob.id) as any).status, "failed");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(insertFailure.briefId) as any).n, 0);

  const revoked = seedActorAndBrief("refresh-revoked");
  const revokedJob = seedRefreshJob(revoked, "revoked");
  researchPipeline.__setTestResearchPipelineRunner(async () => {
    db().prepare("UPDATE users SET role='viewer' WHERE id=?").run(revoked.userId);
    return {
      brief: { ...revoked.brief, priority_summary: "Must not queue" }, stages: [],
      quality: { filled: 8, total: 8, low: false, repaired: false, research_attempts: 1, source_candidates: 0, mode: "standard" },
    };
  });
  try { await worker.executeResearchJob(revokedJob); }
  finally { researchPipeline.__setTestResearchPipelineRunner(null); }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(revoked.briefId) as any).brief_json, revoked.briefJson);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id=?").get(revokedJob.id) as any).status, "failed");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(revoked.briefId) as any).n, 0);
});

test("refresh strict audit failure rolls back candidates and done state before the job fails", async () => {
  const seeded = seedActorAndBrief("refresh-audit-rollback");
  const sentinelLastMonitoredAt = 1_700_000_000_456;
  db().prepare("UPDATE briefs SET last_monitored_at=? WHERE id=?").run(sentinelLastMonitoredAt, seeded.briefId);
  const job = seedRefreshJob(seeded, "audit-rollback");
  db().exec(`CREATE TRIGGER endgame_fail_refresh_queue_audit
    BEFORE INSERT ON brief_events
    WHEN NEW.event_type = 'brief_update_candidates_queued'
    BEGIN SELECT RAISE(ABORT, 'test refresh queue audit failure'); END`);
  researchPipeline.__setTestResearchPipelineRunner(async () => ({
    brief: { ...seeded.brief, priority_summary: "Must roll back with audit" }, stages: [],
    quality: { filled: 8, total: 8, low: false, repaired: false, research_attempts: 1, source_candidates: 0, mode: "standard" },
  }));
  try { await worker.executeResearchJob(job); }
  finally {
    researchPipeline.__setTestResearchPipelineRunner(null);
    db().exec("DROP TRIGGER endgame_fail_refresh_queue_audit");
  }

  const briefRow = db().prepare("SELECT brief_json,last_monitored_at FROM briefs WHERE id=?").get(seeded.briefId) as any;
  assert.equal(briefRow.brief_json, seeded.briefJson);
  assert.equal(briefRow.last_monitored_at, sentinelLastMonitoredAt);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_events WHERE brief_id=? AND event_type='brief_update_candidates_queued'").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM monitor_runs WHERE job_id=?").get(job.id) as any).n, 0);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id=?").get(job.id) as any).status, "failed");
});

test("monitor queues Radar-visible candidates with candidate_queued and no applied side effects; no-op stays no_updates", async () => {
  const seeded = seedActorAndBrief("monitor");
  const job = seedMonitorJob(seeded, "candidate");
  monitor.__setTestMonitorClient({ messages: { create: async () => ({
    stop_reason: "tool_use", content: [{ type: "tool_use", name: "record_monitor_findings", id: "m1", input: {
      has_updates: true, summary: "A supported public update was found.",
      patches: [{ op: "append", field: "recent_signals", value: { text: "New public signal", source: "https://example.com/signal", confidence: "High" } }],
    } }],
  }) } } as any);
  try { await worker.executeMonitorJob(job); }
  finally { monitor.__setTestMonitorClient(null); }

  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  assert.equal((db().prepare("SELECT outcome FROM monitor_runs WHERE job_id=?").get(job.id) as any).outcome, "candidate_queued");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_versions WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_entries WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  const event = db().prepare("SELECT event_type,title,summary,metadata_json FROM brief_events WHERE brief_id=?").get(seeded.briefId) as any;
  assert.equal(event.event_type, "brief_update_candidates_queued");
  assert.doesNotMatch(`${event.title} ${event.summary}`, /applied|updated/i);
  assert.deepEqual(JSON.parse(event.metadata_json), {
    origin: "monitor", job_id: job.id, candidate_count: 1, touched_fields: ["recent_signals"],
  });
  const manifest = radarManifest.buildJournalRadarManifest(seeded.briefId).manifest;
  assert.equal(manifest.candidates.length, 1);
  assert.equal(manifest.candidates[0].status, "new");
  assert.equal(manifest.monitor_updates.length, 0);

  const noop = seedActorAndBrief("monitor-noop");
  const noopJob = seedMonitorJob(noop, "noop");
  monitor.__setTestMonitorClient({ messages: { create: async () => ({
    stop_reason: "tool_use", content: [{ type: "tool_use", name: "record_monitor_findings", id: "m2", input: {
      has_updates: false, summary: "Nothing materially new.", patches: [],
    } }],
  }) } } as any);
  try { await worker.executeMonitorJob(noopJob); }
  finally { monitor.__setTestMonitorClient(null); }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(noop.briefId) as any).brief_json, noop.briefJson);
  assert.equal((db().prepare("SELECT outcome FROM monitor_runs WHERE job_id=?").get(noopJob.id) as any).outcome, "no_updates");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(noop.briefId) as any).n, 0);
});

test("monitor authority revoked during provider wait fails with no candidate or applied side effect", async () => {
  const seeded = seedActorAndBrief("monitor-revoked");
  const job = seedMonitorJob(seeded, "revoked");
  monitor.__setTestMonitorClient({ messages: { create: async () => {
    db().prepare("UPDATE users SET role='viewer' WHERE id=?").run(seeded.userId);
    return {
      stop_reason: "tool_use", content: [{ type: "tool_use", name: "record_monitor_findings", id: "mr", input: {
        has_updates: true, summary: "Must not queue", patches: [{ op: "set", field: "priority_summary", value: "Denied" }],
      } }],
    };
  } } } as any);
  try { await worker.executeMonitorJob(job); }
  finally { monitor.__setTestMonitorClient(null); }
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id=?").get(seeded.briefId) as any).brief_json, seeded.briefJson);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id=?").get(job.id) as any).status, "failed");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM monitor_runs WHERE job_id=?").get(job.id) as any).n, 0);
});

test("monitor strict audit failure rolls back candidates, run, timestamp, and done state before the job fails", async () => {
  const seeded = seedActorAndBrief("monitor-audit-rollback");
  const sentinelLastMonitoredAt = 1_700_000_000_123;
  db().prepare("UPDATE briefs SET last_monitored_at=? WHERE id=?").run(sentinelLastMonitoredAt, seeded.briefId);
  const job = seedMonitorJob(seeded, "audit-rollback");
  db().exec(`CREATE TRIGGER endgame_fail_monitor_queue_audit
    BEFORE INSERT ON brief_events
    WHEN NEW.event_type = 'brief_update_candidates_queued'
    BEGIN SELECT RAISE(ABORT, 'test monitor queue audit failure'); END`);
  monitor.__setTestMonitorClient({ messages: { create: async () => ({
    stop_reason: "tool_use", content: [{ type: "tool_use", name: "record_monitor_findings", id: "ma", input: {
      has_updates: true, summary: "A supported update that must roll back.",
      patches: [{ op: "append", field: "recent_signals", value: { text: "Rollback signal", source: "https://example.com/rollback", confidence: "High" } }],
    } }],
  }) } } as any);
  try { await worker.executeMonitorJob(job); }
  finally {
    monitor.__setTestMonitorClient(null);
    db().exec("DROP TRIGGER endgame_fail_monitor_queue_audit");
  }

  const briefRow = db().prepare("SELECT brief_json,last_monitored_at FROM briefs WHERE id=?").get(seeded.briefId) as any;
  assert.equal(briefRow.brief_json, seeded.briefJson);
  assert.equal(briefRow.last_monitored_at, sentinelLastMonitoredAt);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM journal_review_candidates WHERE brief_id=?").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM brief_events WHERE brief_id=? AND event_type='brief_update_candidates_queued'").get(seeded.briefId) as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM monitor_runs WHERE job_id=?").get(job.id) as any).n, 0);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id=?").get(job.id) as any).status, "failed");
});
