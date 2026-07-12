import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "journal-promotion-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const auth = require("../web/lib/auth") as typeof import("../web/lib/auth");
const promotion = require("../web/lib/journalPromotion") as typeof import("../web/lib/journalPromotion");
const decisions = require("../web/lib/journalDecisions") as typeof import("../web/lib/journalDecisions");
const candidates = require("../web/lib/journalReviewCandidates") as typeof import("../web/lib/journalReviewCandidates");
const promoteRoute = require("../web/app/api/briefs/[id]/journal/review-candidates/[candidateId]/promote/route") as typeof import("../web/app/api/briefs/[id]/journal/review-candidates/[candidateId]/promote/route");
const tasksRoute = require("../web/app/api/briefs/[id]/journal/tasks/route") as typeof import("../web/app/api/briefs/[id]/journal/tasks/route");
const taskRoute = require("../web/app/api/briefs/[id]/journal/tasks/[taskId]/route") as typeof import("../web/app/api/briefs/[id]/journal/tasks/[taskId]/route");
const briefRoute = require("../web/app/api/briefs/[id]/route") as typeof import("../web/app/api/briefs/[id]/route");
initDb();

function user(id: string, role = "member", disabledAt: number | null = null) {
  db().prepare(`INSERT INTO users (id,email,password_hash,role,display_name,created_at,must_change_password,disabled_at) VALUES (?,?, 'h',?,?,?,0,?)`)
    .run(id, `${id}@example.com`, role, id, Date.now(), disabledAt);
}
function brief(id: string, owner: string, json = '{"stable":true}') {
  db().prepare(`INSERT INTO briefs (id,user_id,account_name,segment,audience,generated_at,created_at,brief_json) VALUES (?,?,'Acme','Tech','internal',?,?,?)`)
    .run(id, owner, new Date().toISOString(), Date.now(), json);
}
function share(briefId: string, userId: string, role: "reader" | "editor") {
  db().prepare(`INSERT INTO brief_shares (brief_id,user_id,granted_by,created_at,role) VALUES (?,?,?,?,?)`)
    .run(briefId, userId, "owner", Date.now(), role);
}
function candidate(id: string, briefId: string, type: string, status = "accepted") {
  db().prepare(`INSERT INTO journal_review_candidates
    (id,brief_id,user_id,source_entry_id,candidate_type,status,title,proposed_text,target,current_baseline,evidence,confidence,risk,created_at,updated_at)
    VALUES (?,?,?,NULL,?,?,?,?,'sales','old','CRM evidence','high','confirm scope',?,?)`)
    .run(id, briefId, "owner", type, status, `Title ${id}`, `Do ${id}`, Date.now(), Date.now());
}
function req(sessionId: string, body: any, onJson?: () => void): any {
  return { cookies: { get: (name: string) => name === auth.SESSION_COOKIE ? { value: sessionId } : undefined }, json: async () => { onJson?.(); return body; } };
}

user("owner"); user("editor"); user("reader"); user("outsider"); user("disabled", "member", Date.now());
brief("brief", "owner"); brief("other", "outsider");
share("brief", "editor", "editor"); share("brief", "reader", "reader"); share("brief", "disabled", "editor");
const ownerSession = auth.createSession("owner").id;
const editorSession = auth.createSession("editor").id;
const readerSession = auth.createSession("reader").id;

test("migration 030 adds promotion columns, decision constraints, and partial unique indexes", () => {
  const columns = new Set((db().prepare("PRAGMA table_info(journal_tasks)").all() as any[]).map((row) => row.name));
  for (const name of ["owner_text", "assignee_user_id", "due_at", "priority", "source_candidate_id", "source_entry_id", "evidence_snapshot", "promoted_by", "promoted_at"]) assert.ok(columns.has(name));
  const indexes = db().prepare("SELECT name, sql FROM sqlite_master WHERE type='index'").all() as Array<{ name: string; sql: string }>;
  assert.match(indexes.find((index) => index.name === "idx_journal_tasks_live_source_candidate")!.sql, /WHERE source_candidate_id IS NOT NULL AND deleted_at IS NULL/);
  assert.match(indexes.find((index) => index.name === "idx_journal_decisions_live_source_candidate")!.sql, /WHERE source_candidate_id IS NOT NULL AND deleted_at IS NULL/);
  assert.throws(() => db().prepare(`INSERT INTO journal_decisions (id,brief_id,title,decision_statement,decision_at,lifecycle,created_at,updated_at) VALUES ('bad','brief','x','x',1,'pending',1,1)`).run(), /CHECK constraint/);
  const foreignKeys = db().prepare("PRAGMA foreign_key_list(journal_decisions)").all() as Array<{ from: string; on_delete: string }>;
  for (const field of ["supersedes_id", "superseded_by_id"]) {
    assert.equal(foreignKeys.find((key) => key.from === field)?.on_delete, "NO ACTION");
  }
});

test("promotion rejects unaccepted and wrong-type candidates", () => {
  candidate("unaccepted", "brief", "action_item", "reviewing");
  assert.throws(() => promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "unaccepted", actorUserId: "owner", input: {} }), /accepted/);
  candidate("wrong", "brief", "brief_update");
  assert.throws(() => promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "wrong", actorUserId: "owner", input: {} }), /type cannot/);
});

test("unauthorized promotion fails before body parsing or writes", async () => {
  candidate("auth-candidate", "brief", "action_item");
  let parsed = false;
  const response = await promoteRoute.POST(req(readerSession, {}, () => { parsed = true; }), { params: { id: "brief", candidateId: "auth-candidate" } });
  assert.equal(response.status, 403); assert.equal(parsed, false);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM journal_tasks WHERE source_candidate_id = ?").get("auth-candidate").n, 0);
});

test("double task promotion is idempotent, freezes evidence, decorates DTO, and never changes brief_json", () => {
  candidate("action", "brief", "action_item");
  const before = (db().prepare("SELECT brief_json FROM briefs WHERE id='brief'").get() as any).brief_json;
  const first = promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "action", actorUserId: "owner", input: { body: "Call buyer", owner_text: "AE", assignee_user_id: "editor", due_at: 12345, priority: "high" } });
  const second = promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "action", actorUserId: "owner", input: { body: "ignored retry" } });
  assert.equal(first.kind, "task"); assert.equal(second.kind, "task");
  assert.equal(first.task.id, second.task.id); assert.equal(first.created, true); assert.equal(second.created, false);
  assert.equal(first.task.assignee_user_id, "editor"); assert.equal(first.task.priority, "high");
  const taskPromotionEvent = db().prepare("SELECT metadata_json FROM brief_events WHERE event_type = 'journal_candidate_promoted_to_task' AND brief_id = ? ORDER BY rowid DESC LIMIT 1").get("brief") as any;
  assert.deepEqual(JSON.parse(taskPromotionEvent.metadata_json), {
    candidate_id: "action", task_id: first.task.id, owner_set: true,
    assignee_user_id: "editor", due_at: 12345, priority: "high", evidence_frozen: true,
  });
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM brief_events WHERE event_type = 'journal_task_metadata_updated' AND metadata_json LIKE ?").get(`%${first.task.id}%`) as any).n, 0);
  const frozen = first.task.evidence_snapshot;
  db().prepare("UPDATE journal_review_candidates SET evidence='changed', deleted_at=? WHERE id='action'").run(Date.now());
  assert.equal((db().prepare("SELECT evidence_snapshot FROM journal_tasks WHERE id=?").get(first.task.id) as any).evidence_snapshot, frozen);
  assert.match(frozen!, /CRM evidence/);
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id='brief'").get() as any).brief_json, before);
  // Retry continues to resolve after source deletion.
  assert.equal(promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "action", actorUserId: "owner", input: {} }).task.id, first.task.id);
  assert.throws(
    () => promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "action", actorUserId: "owner", input: { source_candidate_id: "spoof" } }),
    /promotion-managed/,
  );

  candidate("linked", "brief", "action_item");
  const linked = promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "linked", actorUserId: "owner", input: {} });
  const dto = candidates.getReviewCandidate("brief", "linked");
  assert.equal(dto.promoted_task_id, linked.kind === "task" ? linked.task.id : null);
  assert.equal(dto.promoted_decision_id, null);
});

test("task metadata validates and privileged metadata requires write access", async () => {
  const readerAssign = await tasksRoute.POST(req(readerSession, { body: "assign", assignee_user_id: "editor" }), { params: { id: "brief" } });
  assert.equal(readerAssign.status, 403);
  const badTarget = await tasksRoute.POST(req(ownerSession, { body: "assign", assignee_user_id: "outsider" }), { params: { id: "brief" } });
  assert.equal(badTarget.status, 400);
  const disabledTarget = await tasksRoute.POST(req(ownerSession, { body: "assign", assignee_user_id: "disabled" }), { params: { id: "brief" } });
  assert.equal(disabledTarget.status, 400);
  const invalid = await tasksRoute.POST(req(ownerSession, { body: "meta", priority: "critical", due_at: -1 }), { params: { id: "brief" } });
  assert.equal(invalid.status, 400);
  const readerOwner = await tasksRoute.POST(req(readerSession, { body: "owner assignment", owner_text: "Team" }), { params: { id: "brief" } });
  assert.equal(readerOwner.status, 403);
  const readerEvidence = await tasksRoute.POST(req(readerSession, { body: "reader evidence", evidence_snapshot: "manual evidence" }), { params: { id: "brief" } });
  assert.equal(readerEvidence.status, 403);
  const readerOrdinary = await tasksRoute.POST(req(readerSession, { body: "reader metadata", due_at: 42, priority: "low" }), { params: { id: "brief" } });
  assert.equal(readerOrdinary.status, 200);
  const ordinaryTask = (await readerOrdinary.json()).task;
  const readerOwnerPatch = await taskRoute.PATCH(req(readerSession, { owner_text: "Team" }), { params: { id: "brief", taskId: ordinaryTask.id } });
  assert.equal(readerOwnerPatch.status, 403);
  const readerAssignmentPatch = await taskRoute.PATCH(req(readerSession, { assignee_user_id: "editor" }), { params: { id: "brief", taskId: ordinaryTask.id } });
  assert.equal(readerAssignmentPatch.status, 403);
  const readerEvidencePatch = await taskRoute.PATCH(req(readerSession, { evidence_snapshot: "fabricated" }), { params: { id: "brief", taskId: ordinaryTask.id } });
  assert.equal(readerEvidencePatch.status, 403);
  const writerEvidencePatch = await taskRoute.PATCH(req(editorSession, { evidence_snapshot: "writer evidence" }), { params: { id: "brief", taskId: ordinaryTask.id } });
  assert.equal(writerEvidencePatch.status, 200);
  assert.equal((await writerEvidencePatch.json()).task.evidence_snapshot, "writer evidence");
  const readerCompletionPatch = await taskRoute.PATCH(req(readerSession, { done: true }), { params: { id: "brief", taskId: ordinaryTask.id } });
  assert.equal(readerCompletionPatch.status, 200);
  const spoofed = await tasksRoute.POST(req(ownerSession, { body: "spoof", source_candidate_id: "fake" }), { params: { id: "brief" } });
  assert.equal(spoofed.status, 400);
});

test("task metadata writes are transactionally audited with sanitized IDs and enums", async () => {
  const created = await tasksRoute.POST(req(ownerSession, {
    body: "sensitive task body", owner_text: "Secret owner label", assignee_user_id: "editor",
    due_at: 1234, priority: "urgent", evidence_snapshot: "sensitive evidence",
  }), { params: { id: "brief" } });
  assert.equal(created.status, 200);
  const task = (await created.json()).task;
  const createEvent = db().prepare("SELECT metadata_json FROM brief_events WHERE event_type = 'journal_task_metadata_updated' AND brief_id = ? ORDER BY rowid DESC LIMIT 1").get("brief") as any;
  assert.deepEqual(JSON.parse(createEvent.metadata_json), {
    task_id: task.id, operation: "created", owner_changed: true,
    assignee_user_id: "editor", due_at: 1234, priority: "urgent", evidence_updated: true,
  });
  assert.doesNotMatch(createEvent.metadata_json, /Secret owner label|sensitive task body|sensitive evidence/);

  const patched = await taskRoute.PATCH(req(editorSession, { owner_text: "Another private label", priority: "low" }), { params: { id: "brief", taskId: task.id } });
  assert.equal(patched.status, 200);
  const updateEvent = db().prepare("SELECT metadata_json FROM brief_events WHERE event_type = 'journal_task_metadata_updated' AND brief_id = ? ORDER BY rowid DESC LIMIT 1").get("brief") as any;
  assert.deepEqual(JSON.parse(updateEvent.metadata_json), {
    task_id: task.id, operation: "updated", owner_changed: true,
    assignee_user_id: "editor", due_at: 1234, priority: "low", evidence_updated: false,
  });
  assert.doesNotMatch(updateEvent.metadata_json, /Another private label/);

  db().exec(`CREATE TRIGGER fail_task_audit BEFORE INSERT ON brief_events
    WHEN NEW.event_type = 'journal_task_metadata_updated' BEGIN SELECT RAISE(ABORT, 'audit failed'); END`);
  const before = (db().prepare("SELECT COUNT(*) AS n FROM journal_tasks WHERE brief_id = ?").get("brief") as any).n;
  const failed = await tasksRoute.POST(req(ownerSession, { body: "must roll back", owner_text: "Owner" }), { params: { id: "brief" } });
  assert.equal(failed.status, 400);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_tasks WHERE brief_id = ?").get("brief") as any).n, before);
  db().exec("DROP TRIGGER fail_task_audit");
});

test("task PATCH rejects move/reorder mixed with edits or metadata", async () => {
  const created = await tasksRoute.POST(req(ownerSession, { body: "mixed patch target" }), { params: { id: "brief" } });
  const task = (await created.json()).task;
  const mixed = await taskRoute.PATCH(req(ownerSession, { parent_id: null, priority: "high" }), { params: { id: "brief", taskId: task.id } });
  assert.equal(mixed.status, 400);
  assert.match((await mixed.json()).error, /move.*edit|edit.*move/i);
  assert.equal((db().prepare("SELECT priority FROM journal_tasks WHERE id = ?").get(task.id) as any).priority, null);
});

test("promotion snapshots stay bounded for maximally escaped candidate fields", () => {
  const hostile = (`\"\\\n`).repeat(400);
  for (const [id, type] of [["escaped-action", "action_item"], ["escaped-decision", "decision"]] as const) {
    candidate(id, "brief", type);
    db().prepare(`UPDATE journal_review_candidates SET title = ?, proposed_text = ?, target = ?,
      current_baseline = ?, evidence = ?, confidence = ?, risk = ? WHERE id = ?`)
      .run(hostile.slice(0, 160), hostile, hostile, hostile, hostile, hostile, hostile, id);
    const result = promotion.promoteReviewCandidate({
      briefId: "brief", candidateId: id, actorUserId: "owner",
      input: type === "action_item" ? { body: "bounded action" } : { title: "bounded decision", decision_statement: "bounded decision" },
    });
    const snapshot = result.kind === "task" ? result.task.evidence_snapshot : result.decision.evidence_snapshot;
    assert.ok(snapshot && snapshot.length <= 8000, `${type} snapshot must fit validators`);
    const parsed = JSON.parse(snapshot!);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.candidate_id, id);
    assert.equal(parsed.candidate_type, type);
    assert.ok(Object.hasOwn(parsed, "source_entry_id"));
    assert.match(snapshot!, /\[truncated\]/);
  }
});

test("decision promotion is idempotent and decision supersession is deterministic and auditable", () => {
  candidate("decision-candidate", "brief", "decision");
  const promoted = promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "decision-candidate", actorUserId: "owner", input: { title: "Choose annual", decision_statement: "Use annual term", decision_at: 1000, rationale: "Discount" } });
  assert.equal(promoted.kind, "decision");
  const promotionEvent = db().prepare("SELECT event_type, metadata_json FROM brief_events WHERE brief_id = ? ORDER BY rowid DESC LIMIT 1").get("brief") as any;
  assert.equal(promotionEvent.event_type, "journal_candidate_promoted_to_decision");
  assert.deepEqual(JSON.parse(promotionEvent.metadata_json), { decision_id: promoted.decision.id, supersedes_id: null, source_candidate_id: "decision-candidate" });
  const retry = promotion.promoteReviewCandidate({ briefId: "brief", candidateId: "decision-candidate", actorUserId: "owner", input: {} });
  assert.equal(retry.decision.id, promoted.decision.id); assert.equal(retry.created, false);
  assert.equal(candidates.getReviewCandidate("brief", "decision-candidate").promoted_decision_id, promoted.decision.id);

  const replacement = decisions.insertDecision({ briefId: "brief", title: "Choose monthly", decisionStatement: "Use monthly", rationale: "Flexibility", decisionAt: 2000, supersedesId: promoted.decision.id, createdBy: "owner" });
  const old = decisions.getDecision("brief", promoted.decision.id);
  assert.equal(old.lifecycle, "superseded"); assert.equal(old.superseded_by_id, replacement.id); assert.equal(replacement.supersedes_id, old.id);
  assert.throws(() => decisions.insertDecision({ briefId: "brief", title: "Bad", decisionStatement: "Bad", decisionAt: 3, supersedesId: old.id, createdBy: "owner" }), /active/);
  assert.throws(() => decisions.insertDecision({ briefId: "other", title: "Cross", decisionStatement: "Cross", decisionAt: 3, supersedesId: replacement.id, createdBy: "outsider" }), /not found/);
  db().prepare("UPDATE journal_decisions SET supersedes_id = ? WHERE id = ?").run(replacement.id, old.id);
  assert.throws(() => decisions.insertDecision({ briefId: "brief", title: "Cycle", decisionStatement: "Cycle", decisionAt: 4, supersedesId: replacement.id, createdBy: "owner" }), /cycle/);
  db().prepare("UPDATE journal_decisions SET supersedes_id = NULL WHERE id = ?").run(old.id);
  const event = db().prepare("SELECT metadata_json FROM brief_events WHERE event_type='journal_decision_superseded' AND brief_id='brief' ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.match(event.metadata_json, new RegExp(replacement.id));
  assert.throws(() => decisions.updateDecision({ briefId: "brief", decisionId: old.id, title: "rewrite history", actorUserId: "owner" }), /immutable/);
});

test("deleting a brief cascades through a mutually linked supersession pair", async () => {
  brief("delete-me", "owner");
  const first = decisions.insertDecision({ briefId: "delete-me", title: "First", decisionStatement: "First", decisionAt: 1, createdBy: "owner" });
  decisions.insertDecision({ briefId: "delete-me", title: "Second", decisionStatement: "Second", decisionAt: 2, supersedesId: first.id, createdBy: "owner" });
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_decisions WHERE brief_id = ?").get("delete-me") as any).n, 2);
  const response = await briefRoute.DELETE(req(ownerSession, undefined), { params: { id: "delete-me" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, 1);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_decisions WHERE brief_id = ?").get("delete-me") as any).n, 0);
});

test("promotion surfaces the per-brief task cap", async () => {
  brief("capped", "owner"); candidate("capped-candidate", "capped", "action_item");
  const insert = db().prepare(`INSERT INTO journal_tasks (id,brief_id,body,done,position,created_at,updated_at) VALUES (?, 'capped', 'x', 0, ?, 1, 1)`);
  db().transaction(() => { for (let i = 0; i < 500; i++) insert.run(`cap-${i}`, i); })();
  assert.throws(() => promotion.promoteReviewCandidate({ briefId: "capped", candidateId: "capped-candidate", actorUserId: "owner", input: {} }), /task limit/);
  const response = await promoteRoute.POST(req(ownerSession, {}), { params: { id: "capped", candidateId: "capped-candidate" } });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /task limit/);
});
