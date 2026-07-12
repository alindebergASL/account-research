import test from "node:test";
process.env.PROVIDER_CALLS_ENABLED = "1"; // Explicitly enable only deterministic fake clients in this suite.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "brief-authority-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "bootstrap-admin@example.com";
process.env.ADMIN_PASSWORD = "test-only-password";
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const auth = require("../web/lib/auth") as typeof import("../web/lib/auth");
const comments = require("../web/app/api/briefs/[id]/comments/route") as typeof import("../web/app/api/briefs/[id]/comments/route");
const comment = require("../web/app/api/briefs/[id]/comments/[commentId]/route") as typeof import("../web/app/api/briefs/[id]/comments/[commentId]/route");
const commentAssist = require("../web/app/api/briefs/[id]/comments/ai-assist/route") as typeof import("../web/app/api/briefs/[id]/comments/ai-assist/route");
const journal = require("../web/app/api/briefs/[id]/journal/route") as typeof import("../web/app/api/briefs/[id]/journal/route");
const journalItem = require("../web/app/api/briefs/[id]/journal/[entryId]/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/route");
const candidates = require("../web/app/api/briefs/[id]/journal/review-candidates/route") as typeof import("../web/app/api/briefs/[id]/journal/review-candidates/route");
const candidateItem = require("../web/app/api/briefs/[id]/journal/review-candidates/[candidateId]/route") as typeof import("../web/app/api/briefs/[id]/journal/review-candidates/[candidateId]/route");
const tasks = require("../web/app/api/briefs/[id]/journal/tasks/route") as typeof import("../web/app/api/briefs/[id]/journal/tasks/route");
const taskItem = require("../web/app/api/briefs/[id]/journal/tasks/[taskId]/route") as typeof import("../web/app/api/briefs/[id]/journal/tasks/[taskId]/route");
const pin = require("../web/app/api/briefs/[id]/journal/[entryId]/pin/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/pin/route");
const tags = require("../web/app/api/briefs/[id]/journal/[entryId]/tags/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/tags/route");
const checkpoint = require("../web/app/api/briefs/[id]/journal/radar/checkpoint/route") as typeof import("../web/app/api/briefs/[id]/journal/radar/checkpoint/route");
const documents = require("../web/app/api/briefs/[id]/journal/documents/route") as typeof import("../web/app/api/briefs/[id]/journal/documents/route");
const chat = require("../web/app/api/briefs/[id]/chat/route") as typeof import("../web/app/api/briefs/[id]/chat/route");
const shares = require("../web/app/api/briefs/[id]/shares/route") as typeof import("../web/app/api/briefs/[id]/shares/route");
const roleRoute = require("../web/app/api/admin/users/[id]/role/route") as typeof import("../web/app/api/admin/users/[id]/role/route");
const radarManifest = require("../web/lib/journalRadarManifest") as typeof import("../web/lib/journalRadarManifest");

initDb();

type Role = "admin" | "member" | "viewer";
function seedUser(id: string, role: Role) {
  db().prepare(`INSERT INTO users
    (id,email,password_hash,role,display_name,created_at,must_change_password)
    VALUES (?,?, 'h',?,?,?,0)`).run(id, `${id}@example.com`, role, id, Date.now());
}
function seedBrief(id: string, ownerId: string, monitorEnabled = 0) {
  const brief = {
    account_name: "Authority Account", segment: "Technology", audience: "internal",
    generated_at: new Date().toISOString(), snapshot: "stable", priority_summary: "stable",
    recent_signals: [], ai_tech_maturity: { rating: 3, rationale: "stable" }, top_initiatives: [],
    technical_footprint: { ai_in_production: [], active_pilots: [], cloud_platforms: [], data_infrastructure: "", clinical_platforms: "", analytics_bi_stack: "", build_vs_buy_posture: "", competitive_incumbents: [] },
    programs_procurement: { modernization_grants: [], consortium_purchasing: [], active_rfps_contracts: [], ai_governance_policy: "", public_ai_use_cases: [] },
    personas: [], buying_path: "", first_angle: "", risks: [], competitive_signals: [], next_action: "", extensions: [], sources: [],
  };
  db().prepare(`INSERT INTO briefs
    (id,user_id,account_name,segment,audience,generated_at,created_at,brief_json,monitor_enabled)
    VALUES (?,?,'Authority Account','Technology','internal',?,?,?,?)`)
    .run(id, ownerId, brief.generated_at, Date.now(), JSON.stringify(brief), monitorEnabled);
}
function seedShare(briefId: string, userId: string, role: "reader" | "editor", grantedBy = "owner") {
  db().prepare(`INSERT INTO brief_shares (brief_id,user_id,granted_by,created_at,role) VALUES (?,?,?,?,?)`)
    .run(briefId, userId, grantedBy, Date.now(), role);
}
function session(userId: string) { return auth.createSession(userId).id; }
function request(sessionId: string, body: unknown, parsed: { json: number; form: number }): any {
  return {
    cookies: { get: (name: string) => name === auth.SESSION_COOKIE ? { value: sessionId } : undefined },
    headers: { get: (name: string) => name.toLowerCase() === "content-length" ? "100" : null },
    nextUrl: { searchParams: new URLSearchParams() },
    url: "http://localhost/api/test",
    json: async () => { parsed.json += 1; return body; },
    formData: async () => { parsed.form += 1; return new FormData(); },
  };
}
function totalChanges(): number {
  return (db().prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

seedUser("owner", "member");
seedUser("viewer-owner", "viewer");
seedUser("viewer-editor", "viewer");
seedUser("viewer-reader", "viewer");
seedUser("reader", "member");
seedUser("editor", "member");
seedUser("admin", "admin");
seedBrief("owned-by-member", "owner");
seedBrief("owned-by-viewer", "viewer-owner");
seedShare("owned-by-member", "viewer-editor", "editor");
seedShare("owned-by-member", "viewer-reader", "reader");
seedShare("owned-by-member", "reader", "reader");
seedShare("owned-by-member", "editor", "editor");
const sessions = Object.fromEntries(
  ["owner", "viewer-owner", "viewer-editor", "viewer-reader", "reader", "editor", "admin"]
    .map((id) => [id, session(id)]),
) as Record<string, string>;

test("viewer is a central write/manage ceiling and active member-reader can collaborate", () => {
  const viewerOwner = auth.publicUser(db().prepare("SELECT * FROM users WHERE id='viewer-owner'").get() as any);
  const viewerEditor = auth.publicUser(db().prepare("SELECT * FROM users WHERE id='viewer-editor'").get() as any);
  const viewerReader = auth.publicUser(db().prepare("SELECT * FROM users WHERE id='viewer-reader'").get() as any);
  const reader = auth.publicUser(db().prepare("SELECT * FROM users WHERE id='reader'").get() as any);
  const owner = auth.publicUser(db().prepare("SELECT * FROM users WHERE id='owner'").get() as any);
  const editor = auth.publicUser(db().prepare("SELECT * FROM users WHERE id='editor'").get() as any);
  const admin = auth.publicUser(db().prepare("SELECT * FROM users WHERE id='admin'").get() as any);
  assert.equal(auth.canReadBrief(viewerOwner, "owned-by-viewer"), true);
  assert.equal(auth.canManageBrief(viewerOwner, "owned-by-viewer"), false);
  assert.equal(auth.canWriteBrief(viewerOwner, "owned-by-viewer"), false);
  assert.equal(auth.canCollaborateBrief(viewerOwner, "owned-by-viewer"), false);
  assert.equal(auth.canWriteBrief(viewerEditor, "owned-by-member"), false);
  assert.equal(auth.canCollaborateBrief(viewerEditor, "owned-by-member"), false);
  assert.equal(auth.canCollaborateBrief(viewerReader, "owned-by-member"), false);
  assert.equal(auth.canWriteBrief(reader, "owned-by-member"), false);
  assert.equal(auth.canCollaborateBrief(reader, "owned-by-member"), true);
  assert.equal(auth.canWriteBrief(owner, "owned-by-member"), true);
  assert.equal(auth.canManageBrief(owner, "owned-by-member"), true);
  assert.equal(auth.canWriteBrief(editor, "owned-by-member"), true);
  assert.equal(auth.canManageBrief(editor, "owned-by-member"), false);
  assert.equal(auth.canWriteBrief(admin, "owned-by-member"), true);
  assert.equal(auth.canManageBrief(admin, "owned-by-member"), true);
  db().prepare("UPDATE users SET disabled_at=? WHERE id='reader'").run(Date.now());
  assert.equal(auth.canCollaborateBrief(reader, "owned-by-member"), false);
  db().prepare("UPDATE users SET disabled_at=NULL WHERE id='reader'").run();
});

type Mutation = {
  name: string;
  call: (req: any, briefId: string) => Promise<Response>;
};
const ordinaryMutations: Mutation[] = [
  { name: "comment create", call: (req, id) => comments.POST(req, { params: { id } } as any) },
  { name: "comment edit", call: (req, id) => comment.PATCH(req, { params: { id, commentId: "missing" } } as any) },
  { name: "comment delete", call: (req, id) => comment.DELETE(req, { params: { id, commentId: "missing" } } as any) },
  { name: "comment AI assist", call: (req, id) => commentAssist.POST(req, { params: { id } } as any) },
  { name: "journal create", call: (req, id) => journal.POST(req, { params: { id } } as any) },
  { name: "journal edit", call: (req, id) => journalItem.PATCH(req, { params: { id, entryId: "missing" } } as any) },
  { name: "journal delete", call: (req, id) => journalItem.DELETE(req, { params: { id, entryId: "missing" } } as any) },
  { name: "candidate create", call: (req, id) => candidates.POST(req, { params: { id } } as any) },
  { name: "task create", call: (req, id) => tasks.POST(req, { params: { id } } as any) },
  { name: "task edit", call: (req, id) => taskItem.PATCH(req, { params: { id, taskId: "missing" } } as any) },
  { name: "task delete", call: (req, id) => taskItem.DELETE(req, { params: { id, taskId: "missing" } } as any) },
  { name: "pin", call: (req, id) => pin.POST(req, { params: { id, entryId: "missing" } } as any) },
  { name: "unpin", call: (req, id) => pin.DELETE(req, { params: { id, entryId: "missing" } } as any) },
  { name: "tag", call: (req, id) => tags.POST(req, { params: { id, entryId: "missing" } } as any) },
  { name: "untag", call: (req, id) => tags.DELETE(req, { params: { id, entryId: "missing" } } as any) },
  { name: "Radar checkpoint", call: (req, id) => checkpoint.POST(req, { params: { id } } as any) },
];

for (const actor of [
  { id: "viewer-owner", briefId: "owned-by-viewer" },
  { id: "viewer-editor", briefId: "owned-by-member" },
  { id: "viewer-reader", briefId: "owned-by-member" },
]) {
  test(`${actor.id} is denied every ordinary collaboration mutation before parsing with zero writes`, async () => {
    for (const mutation of ordinaryMutations) {
      const parsed = { json: 0, form: 0 };
      const before = totalChanges();
      const response = await mutation.call(
        request(sessions[actor.id], { body: "should never parse", tag: "risk" }, parsed),
        actor.briefId,
      );
      assert.equal(response.status, 403, mutation.name);
      assert.deepEqual(parsed, { json: 0, form: 0 }, mutation.name);
      assert.equal(totalChanges(), before, mutation.name);
    }
  });
}

test("viewer chat, chat-history deletion, candidate disposition, and upload deny before parse with zero writes/provider seams", async () => {
  const providerCalls = { assist: 0, journal: 0 };
  const assistAi = require("../web/lib/briefCommentsAi") as typeof import("../web/lib/briefCommentsAi");
  const journalAi = require("../web/lib/journalAi") as typeof import("../web/lib/journalAi");
  assistAi.__setTestAssistClient({ messages: { create: async () => { providerCalls.assist += 1; throw new Error("must not call"); } } } as any);
  journalAi.__setTestJournalClient({ messages: { create: async () => { providerCalls.journal += 1; throw new Error("must not call"); } } } as any);
  try {
    for (const actor of [
      { id: "viewer-owner", briefId: "owned-by-viewer" },
      { id: "viewer-editor", briefId: "owned-by-member" },
      { id: "viewer-reader", briefId: "owned-by-member" },
    ]) {
      for (const mutation of [
        { name: "chat", call: (req: any) => chat.POST(req, { params: { id: actor.briefId } } as any) },
        { name: "chat delete", call: (req: any) => chat.DELETE(req, { params: { id: actor.briefId } } as any) },
        { name: "candidate disposition", call: (req: any) => candidateItem.PATCH(req, { params: { id: actor.briefId, candidateId: "missing" } } as any) },
        { name: "upload", call: (req: any) => documents.POST(req, { params: { id: actor.briefId } } as any) },
      ]) {
        const parsed = { json: 0, form: 0 };
        const before = totalChanges();
        const response = await mutation.call(request(sessions[actor.id], { message: "question", status: "accepted" }, parsed));
        assert.equal(response.status, 403, `${actor.id}: ${mutation.name}`);
        assert.deepEqual(parsed, { json: 0, form: 0 }, `${actor.id}: ${mutation.name}`);
        assert.equal(totalChanges(), before, `${actor.id}: ${mutation.name}`);
      }
    }
    assert.deepEqual(providerCalls, { assist: 0, journal: 0 });
  } finally {
    assistAi.__setTestAssistClient(null);
    journalAi.__setTestJournalClient(null);
  }
});

test("member-reader retains ordinary collaboration but not governed task fields or candidate disposition/upload", async () => {
  const parsed = { json: 0, form: 0 };
  const commentResponse = await comments.POST(request(sessions.reader, { body: "reader comment" }, parsed), { params: { id: "owned-by-member" } } as any);
  assert.equal(commentResponse.status, 200);
  const journalResponse = await journal.POST(request(sessions.reader, { body: "reader note" }, parsed), { params: { id: "owned-by-member" } } as any);
  assert.equal(journalResponse.status, 200);
  const entryId = (await journalResponse.json()).entries[0].id;
  const taskResponse = await tasks.POST(request(sessions.reader, { body: "reader task", due_at: 42, priority: "low" }, parsed), { params: { id: "owned-by-member" } } as any);
  assert.equal(taskResponse.status, 200);
  const taskId = (await taskResponse.json()).task.id;
  assert.equal((await taskItem.PATCH(request(sessions.reader, { done: true }, parsed), { params: { id: "owned-by-member", taskId } } as any)).status, 200);
  assert.equal((await pin.POST(request(sessions.reader, {}, parsed), { params: { id: "owned-by-member", entryId } } as any)).status, 200);
  assert.equal((await tags.POST(request(sessions.reader, { tag: "risk" }, parsed), { params: { id: "owned-by-member", entryId } } as any)).status, 200);
  const candidateResponse = await candidates.POST(request(sessions.reader, {
    candidate_type: "open_question", title: "Reader candidate", proposed_text: "Confirm timing",
  }, parsed), { params: { id: "owned-by-member" } } as any);
  assert.equal(candidateResponse.status, 200);
  const candidateId = (await candidateResponse.json()).candidate.id;

  const manifest = radarManifest.buildJournalRadarManifest("owned-by-member");
  assert.equal((await checkpoint.POST(request(sessions.reader, {
    manifest_hash: manifest.hash, manifest_schema_version: manifest.manifest.schema_version,
  }, parsed), { params: { id: "owned-by-member" } } as any)).status, 200);

  assert.equal((await tasks.POST(request(sessions.reader, { body: "governed", owner_text: "Sales" }, parsed), { params: { id: "owned-by-member" } } as any)).status, 403);
  assert.equal((await candidateItem.PATCH(request(sessions.reader, { status: "accepted" }, parsed), { params: { id: "owned-by-member", candidateId } } as any)).status, 403);
  const uploadParsed = { json: 0, form: 0 };
  assert.equal((await documents.POST(request(sessions.reader, {}, uploadParsed), { params: { id: "owned-by-member" } } as any)).status, 403);
  assert.equal(uploadParsed.form, 0);
});

test("owner, editor, and admin retain candidate disposition authority", async () => {
  for (const actor of ["owner", "editor", "admin"]) {
    const created = await candidates.POST(request(sessions.owner, {
      candidate_type: "open_question", title: `${actor} candidate`, proposed_text: "Review me",
    }, { json: 0, form: 0 }), { params: { id: "owned-by-member" } } as any);
    const candidateId = (await created.json()).candidate.id;
    const response = await candidateItem.PATCH(request(sessions[actor], { status: "accepted" }, { json: 0, form: 0 }), {
      params: { id: "owned-by-member", candidateId },
    } as any);
    assert.equal(response.status, 200, actor);
  }
});

test("owner, editor, and admin retain document upload authority", async () => {
  for (const actor of ["owner", "editor", "admin"]) {
    const form = new FormData();
    form.set("file", new File([`evidence from ${actor}`], `${actor}.txt`, { type: "text/plain" }));
    const parsed = { json: 0, form: 0 };
    const req = request(sessions[actor], {}, parsed);
    req.formData = async () => { parsed.form += 1; return form; };
    const response = await documents.POST(req, { params: { id: "owned-by-member" } } as any);
    assert.equal(response.status, 200, actor);
    assert.equal(parsed.form, 1, actor);
  }
});

test("Journal UI disables governed candidate and upload controls for non-writers with permission copy", () => {
  const source = readFileSync(path.join(__dirname, "../web/app/brief/[id]/JournalSection.tsx"), "utf8");
  assert.match(source, /disabled=\{reviewLoading \|\| !canWrite\}/);
  assert.match(source, /Brief writer access is required to accept, dismiss, or otherwise change candidate status/);
  assert.match(source, /disabled=\{!canWrite\}/);
  assert.match(source, /Brief writer access is required to upload evidence/);
});

test("share grant refuses editor authority for a global viewer", async () => {
  const before = totalChanges();
  const response = await shares.POST(request(sessions.owner, {
    email: "viewer-reader@example.com", role: "editor",
  }, { json: 0, form: 0 }), { params: { id: "owned-by-member" } } as any);
  assert.equal(response.status, 403);
  assert.equal((db().prepare("SELECT role FROM brief_shares WHERE brief_id=? AND user_id=?").get("owned-by-member", "viewer-reader") as any).role, "reader");
  assert.equal(totalChanges(), before);
});

function seedJob(id: string, userId: string, status: "queued" | "running" | "done") {
  db().prepare(`INSERT INTO research_jobs
    (id,user_id,account_name,intake_json,mode,status,created_at,intent,target_brief_id)
    VALUES (?,?,?,'{}','standard',?,?, 'refresh',NULL)`)
    .run(id, userId, id, status, Date.now());
}

test("admin downgrade to viewer atomically normalizes shares, owned monitors, and active jobs", async () => {
  seedUser("downgrade", "member");
  seedBrief("downgrade-owned", "downgrade", 1);
  seedShare("owned-by-member", "downgrade", "editor");
  seedJob("downgrade-queued", "downgrade", "queued");
  seedJob("downgrade-running", "downgrade", "running");
  seedJob("downgrade-done", "downgrade", "done");

  const response = await roleRoute.POST(request(sessions.admin, { role: "viewer" }, { json: 0, form: 0 }), { params: { id: "downgrade" } } as any);
  assert.equal(response.status, 200);
  assert.equal((db().prepare("SELECT role FROM users WHERE id='downgrade'").get() as any).role, "viewer");
  assert.equal((db().prepare("SELECT role FROM brief_shares WHERE user_id='downgrade'").get() as any).role, "reader");
  assert.equal((db().prepare("SELECT monitor_enabled FROM briefs WHERE id='downgrade-owned'").get() as any).monitor_enabled, 0);
  const jobs = db().prepare("SELECT id,status,finished_at FROM research_jobs WHERE user_id='downgrade' ORDER BY id").all() as any[];
  assert.deepEqual(jobs.map((row) => [row.id, row.status, row.finished_at !== null]), [
    ["downgrade-done", "done", false],
    ["downgrade-queued", "cancelled", true],
    ["downgrade-running", "cancelled", true],
  ]);
});

test("viewer downgrade rolls the whole immediate transaction back on an injected failure", async () => {
  seedUser("rollback", "member");
  seedBrief("rollback-owned", "rollback", 1);
  seedShare("owned-by-member", "rollback", "editor");
  seedJob("rollback-job", "rollback", "running");
  db().exec(`CREATE TRIGGER fail_downgrade_share BEFORE UPDATE ON brief_shares
    WHEN OLD.user_id = 'rollback' BEGIN SELECT RAISE(ABORT, 'injected downgrade failure'); END`);
  try {
    await assert.rejects(
      () => roleRoute.POST(request(sessions.admin, { role: "viewer" }, { json: 0, form: 0 }), { params: { id: "rollback" } } as any),
      /injected downgrade failure/,
    );
  } finally {
    db().exec("DROP TRIGGER fail_downgrade_share");
  }
  assert.equal((db().prepare("SELECT role FROM users WHERE id='rollback'").get() as any).role, "member");
  assert.equal((db().prepare("SELECT role FROM brief_shares WHERE user_id='rollback'").get() as any).role, "editor");
  assert.equal((db().prepare("SELECT monitor_enabled FROM briefs WHERE id='rollback-owned'").get() as any).monitor_enabled, 1);
  assert.equal((db().prepare("SELECT status FROM research_jobs WHERE id='rollback-job'").get() as any).status, "running");
});
