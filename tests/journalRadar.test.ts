import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Database from "../web/node_modules/better-sqlite3";

const tmp = mkdtempSync(path.join(os.tmpdir(), "journal-radar-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "radar-admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb, repairJournalRadarCheckpointMigration } = require("../web/lib/db") as typeof import("../web/lib/db");
const auth = require("../web/lib/auth") as typeof import("../web/lib/auth");
const manifestLib = require("../web/lib/journalRadarManifest") as typeof import("../web/lib/journalRadarManifest");
const radarLib = require("../web/lib/journalRadar") as typeof import("../web/lib/journalRadar");
const checkpointLib = require("../web/lib/journalRadarCheckpoints") as typeof import("../web/lib/journalRadarCheckpoints");
const radarRoute = require("../web/app/api/briefs/[id]/journal/radar/route") as typeof import("../web/app/api/briefs/[id]/journal/radar/route");
const checkpointRoute = require("../web/app/api/briefs/[id]/journal/radar/checkpoint/route") as typeof import("../web/app/api/briefs/[id]/journal/radar/checkpoint/route");
initDb();

function user(id: string) {
  db().prepare(`INSERT INTO users (id,email,password_hash,role,display_name,created_at,must_change_password)
    VALUES (?,?, 'h','member',?,?,0)`).run(id, `${id}@example.com`, id, Date.now());
}
function brief(id: string, owner: string, createdAt = 111) {
  db().prepare(`INSERT INTO briefs (id,user_id,account_name,segment,audience,generated_at,created_at,brief_json)
    VALUES (?,?,'Acme','Tech','internal','2026-01-01',?,'{"unchanged":true}')`).run(id, owner, createdAt);
}
function share(briefId: string, userId: string) {
  db().prepare(`INSERT INTO brief_shares (brief_id,user_id,granted_by,created_at,role)
    VALUES (?,?,?,1,'reader')`).run(briefId, userId, "owner");
}
function req(sessionId: string, body?: unknown, onJson?: () => void): any {
  return {
    cookies: { get: (name: string) => name === auth.SESSION_COOKIE ? { value: sessionId } : undefined },
    json: async () => { onJson?.(); return body; },
  };
}

user("owner"); user("reader"); user("outsider");
brief("brief", "owner"); share("brief", "reader");
const ownerSession = auth.createSession("owner").id;
const readerSession = auth.createSession("reader").id;
const outsiderSession = auth.createSession("outsider").id;

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function emptyManifest() { return manifestLib.buildJournalRadarManifest("brief").manifest; }
function one(bucket: keyof ReturnType<typeof radarLib.emptyJournalRadarBuckets>, before: any, after: any) {
  const result = radarLib.compareJournalRadarManifests({ checkpoint: before, current: after, reviewedAt: 1 });
  assert.equal(result.state, "changes");
  assert.equal(result.buckets[bucket].count, 1, `${String(bucket)} should contain exactly one change`);
}

test("migration 031 creates one checkpoint per brief/user with useful index and cascading FKs", () => {
  const columns = new Set((db().prepare("PRAGMA table_info(journal_radar_checkpoints)").all() as any[]).map((r) => r.name));
  for (const name of ["brief_id", "user_id", "manifest_schema_version", "manifest_json", "manifest_hash", "reviewed_at", "created_at", "updated_at"]) assert.ok(columns.has(name));
  const pk = db().prepare("PRAGMA table_info(journal_radar_checkpoints)").all() as Array<{ name: string; pk: number }>;
  assert.deepEqual(pk.filter((r) => r.pk).sort((a, b) => a.pk - b.pk).map((r) => r.name), ["brief_id", "user_id"]);
  const fks = db().prepare("PRAGMA foreign_key_list(journal_radar_checkpoints)").all() as Array<{ from: string; on_delete: string }>;
  assert.equal(fks.find((r) => r.from === "brief_id")?.on_delete, "CASCADE");
  assert.equal(fks.find((r) => r.from === "user_id")?.on_delete, "CASCADE");
  assert.ok((db().prepare("PRAGMA index_list(journal_radar_checkpoints)").all() as any[]).some((r) => r.name === "idx_journal_radar_checkpoints_user_reviewed"));
  user("cascade-user"); brief("cascade-brief", "cascade-user");
  db().prepare(`INSERT INTO journal_radar_checkpoints VALUES ('cascade-brief','cascade-user',1,'{}',?,1,1,1)`).run("a".repeat(64));
  assert.throws(() => db().prepare(`INSERT INTO journal_radar_checkpoints VALUES ('cascade-brief','cascade-user',1,'{}',?,2,2,2)`).run("b".repeat(64)), /UNIQUE constraint/);
  db().prepare("DELETE FROM briefs WHERE id='cascade-brief'").run();
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_radar_checkpoints WHERE brief_id='cascade-brief'").get() as any).n, 0);
  brief("cascade-brief-2", "cascade-user");
  db().prepare(`INSERT INTO journal_radar_checkpoints VALUES ('cascade-brief-2','cascade-user',1,'{}',?,1,1,1)`).run("b".repeat(64));
  db().prepare("DELETE FROM users WHERE id='cascade-user'").run();
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_radar_checkpoints WHERE user_id='cascade-user'").get() as any).n, 0);
});

function migration031Fixture(): { conn: Database.Database; close: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "journal-radar-repair-"));
  const conn = new Database(path.join(dir, "repair.sqlite"));
  conn.pragma("foreign_keys = ON");
  conn.exec(`
    CREATE TABLE briefs (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES ('031_journal_radar_checkpoints', 1);
  `);
  return { conn, close: () => { conn.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("migration 031 health gate repairs a ledger-marked missing table", () => {
  const f = migration031Fixture();
  try {
    repairJournalRadarCheckpointMigration(f.conn);
    assert.equal((f.conn.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '031_journal_radar_checkpoints'").get() as any).n, 1);
    assert.equal((f.conn.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('journal_radar_checkpoints')").get() as any).n, 8);
  } finally { f.close(); }
});

test("migration 031 health gate repairs only a missing index", () => {
  const f = migration031Fixture();
  try {
    repairJournalRadarCheckpointMigration(f.conn);
    f.conn.exec("DROP INDEX idx_journal_radar_checkpoints_user_reviewed");
    repairJournalRadarCheckpointMigration(f.conn);
    assert.ok((f.conn.prepare("PRAGMA index_list(journal_radar_checkpoints)").all() as any[])
      .some((row) => row.name === "idx_journal_radar_checkpoints_user_reviewed"));
  } finally { f.close(); }
});

test("migration 031 health gate transactionally rebuilds an empty incompatible partial table", () => {
  const f = migration031Fixture();
  try {
    f.conn.exec("CREATE TABLE journal_radar_checkpoints (brief_id TEXT)");
    repairJournalRadarCheckpointMigration(f.conn);
    const pk = f.conn.prepare("PRAGMA table_info(journal_radar_checkpoints)").all() as Array<{ name: string; pk: number }>;
    assert.deepEqual(pk.filter((row) => row.pk).sort((a, b) => a.pk - b.pk).map((row) => row.name), ["brief_id", "user_id"]);
  } finally { f.close(); }
});

test("migration 031 health gate fails closed and preserves a nonempty incompatible table", () => {
  const f = migration031Fixture();
  try {
    f.conn.exec("CREATE TABLE journal_radar_checkpoints (brief_id TEXT); INSERT INTO journal_radar_checkpoints VALUES ('preserve-me')");
    assert.throws(() => repairJournalRadarCheckpointMigration(f.conn), /nonempty incompatible table/);
    assert.deepEqual(f.conn.prepare("SELECT * FROM journal_radar_checkpoints").all(), [{ brief_id: "preserve-me" }]);
    assert.deepEqual((f.conn.prepare("PRAGMA table_info(journal_radar_checkpoints)").all() as any[]).map((row) => row.name), ["brief_id"]);
    assert.equal((f.conn.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '031_journal_radar_checkpoints'").get() as any).n, 1);
  } finally { f.close(); }
});

test("canonical JSON and SHA-256 are stable, sorted, body-free, and bounded", () => {
  db().prepare(`INSERT INTO journal_entries (id,brief_id,user_id,author_type,body,created_at) VALUES
    ('z-entry','brief','owner','user','private z',20),('a-entry','brief','owner','user','private a',10)`).run();
  db().prepare(`INSERT INTO journal_documents
    (id,brief_id,journal_entry_id,user_id,filename,mime_type,byte_size,content_hash,content_text,source_url,created_at)
    VALUES ('doc','brief','a-entry','owner','private.pdf','application/pdf',12,'doc-hash','FULL EXTRACTED SECRET','https://secret.example/path',30)`).run();
  const first = manifestLib.buildJournalRadarManifest("brief");
  const second = manifestLib.buildJournalRadarManifest("brief");
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.manifest.entries.map((entry) => entry.id), ["a-entry", "z-entry"]);
  assert.doesNotMatch(first.canonicalJson, /private a|private z|FULL EXTRACTED SECRET|secret\.example/);
  assert.ok(Buffer.byteLength(first.canonicalJson) <= manifestLib.JOURNAL_RADAR_MAX_MANIFEST_BYTES);
  const reversed = clone(first.manifest);
  reversed.entries.reverse(); reversed.documents.reverse();
  assert.equal(manifestLib.canonicalizeJournalRadarManifest(reversed), first.canonicalJson);
  db().prepare("DELETE FROM journal_documents WHERE id='doc'").run();
  db().prepare("DELETE FROM journal_entries WHERE id IN ('a-entry','z-entry')").run();
  db().prepare(`INSERT INTO journal_entries (id,brief_id,user_id,author_type,body,created_at) VALUES
    ('a-entry','brief','owner','user','private a',10),('z-entry','brief','owner','user','private z',20)`).run();
  db().prepare(`INSERT INTO journal_documents
    (id,brief_id,journal_entry_id,user_id,filename,mime_type,byte_size,content_hash,content_text,source_url,created_at)
    VALUES ('doc','brief','a-entry','owner','private.pdf','application/pdf',12,'doc-hash','FULL EXTRACTED SECRET','https://secret.example/path',30)`).run();
  const reinserted = manifestLib.buildJournalRadarManifest("brief");
  assert.equal(reinserted.canonicalJson, first.canonicalJson);
  assert.equal(reinserted.hash, first.hash);
  const oversized = clone(first.manifest);
  oversized.brief_versions.push({ id: "huge", version_no: 99, reason: "x".repeat(manifestLib.JOURNAL_RADAR_MAX_MANIFEST_BYTES), triggered_by: "owner", refresh_job_id: null, created_at: 1 });
  assert.throws(() => manifestLib.canonicalizeJournalRadarManifest(oversized), /maximum is/);
});

test("every deterministic comparison category is detected independently, including soft deletion", () => {
  const base = emptyManifest();
  let next = clone(base);
  next.entries.push({ id: "new", author_type: "user", created_at: 1, edited_at: null, deleted_at: null, content_hash: "a" });
  one("new_entries", base, next);
  next = clone(base); next.entries = [{ id: "e", author_type: "user", created_at: 1, edited_at: 2, deleted_at: null, content_hash: "b" }];
  const priorEntry = clone(base); priorEntry.entries = [{ ...next.entries[0], edited_at: null, content_hash: "a" }];
  one("edited_entries", priorEntry, next);
  next = clone(priorEntry); next.entries[0].deleted_at = 3;
  one("removed_entries", priorEntry, next);
  assert.equal(radarLib.compareJournalRadarManifests({ checkpoint: priorEntry, current: next, reviewedAt: 1 }).buckets.removed_entries.items[0].destination.hash, null);

  next = clone(base); next.documents.push({ id: "d", journal_entry_id: "e", filename_hash: "f", mime_type: "text/plain", byte_size: 1, content_hash: "c", source_url_hash: null, created_at: 1, effectively_removed_at: null });
  one("source_changes", base, next);
  const priorDoc = clone(next); next = clone(priorDoc); next.documents[0].effectively_removed_at = 4; one("source_changes", priorDoc, next);

  next = clone(base); next.candidates.push({ id: "c", candidate_type: "action_item", status: "new", created_at: 1, updated_at: 1, deleted_at: null });
  one("candidates_awaiting_review", base, next);
  const priorCandidate = clone(next); next = clone(priorCandidate); next.candidates[0].status = "accepted"; next.candidates[0].updated_at = 2; one("candidate_status_transitions", priorCandidate, next);
  const accepted = clone(next); next = clone(accepted); next.candidates[0].deleted_at = 3; one("candidate_status_transitions", accepted, next);

  next = clone(base); next.tasks.push({ id: "t", created_at: 1, updated_at: 1, deleted_at: null, done: false, done_at: null, owner_text_hash: null, assignee_user_id: null, priority: null, due_at: null, content_hash: "a" });
  one("new_tasks", base, next);
  const priorTask = clone(next); next = clone(priorTask); next.tasks[0].done = true; next.tasks[0].done_at = 2; one("completed_tasks", priorTask, next);
  next = clone(priorTask); next.tasks[0].deleted_at = 3;
  one("removed_tasks", priorTask, next);
  assert.equal(radarLib.compareJournalRadarManifests({ checkpoint: priorTask, current: next, reviewedAt: 1 }).buckets.removed_tasks.items[0].destination.hash, null);
  next = clone(priorTask); next.tasks[0].owner_text_hash = "x"; next.tasks[0].assignee_user_id = "reader"; next.tasks[0].priority = "high"; next.tasks[0].due_at = 9; next.tasks[0].updated_at = 4; one("task_detail_changes", priorTask, next);

  next = clone(base); next.decisions.push({ id: "x", created_at: 1, updated_at: 1, deleted_at: null, lifecycle: "active", owner_text_hash: null, decision_at: 1, supersedes_id: null, superseded_by_id: null, content_hash: "a" });
  one("new_decisions", base, next);
  const priorDecision = clone(next); next = clone(priorDecision); next.decisions[0].lifecycle = "revoked"; next.decisions[0].updated_at = 2; one("decision_lifecycle_changes", priorDecision, next);
  next = clone(priorDecision); next.decisions[0].deleted_at = 3;
  one("decision_lifecycle_changes", priorDecision, next);
  assert.equal(radarLib.compareJournalRadarManifests({ checkpoint: priorDecision, current: next, reviewedAt: 1 }).buckets.decision_lifecycle_changes.items[0].destination.hash, null);

  next = clone(base); next.brief_versions.push({ id: "v", version_no: 1, reason: "refresh", triggered_by: "owner", refresh_job_id: null, created_at: 5 });
  one("brief_version_changes", base, next);
  next = clone(base); next.monitor_updates.push({ id: "m", ran_at: 6, patches_applied: 1, pre_version_id: null });
  one("monitor_updates", base, next);
});

test("absent, mismatched, and corrupt checkpoints return honest empty no_checkpoint state", async () => {
  const current = emptyManifest();
  for (const checkpoint of [null, { ...clone(current), schema_version: 999 }]) {
    const result = radarLib.compareJournalRadarManifests({ checkpoint, current, reviewedAt: null });
    assert.equal(result.state, "no_checkpoint");
    assert.equal(radarLib.totalJournalRadarChanges(result.buckets), 0);
  }
  db().prepare(`INSERT INTO journal_radar_checkpoints
    (brief_id,user_id,manifest_schema_version,manifest_json,manifest_hash,reviewed_at,created_at,updated_at)
    VALUES ('brief','owner',1,'not-json',?,1,1,1)`).run("f".repeat(64));
  assert.equal(checkpointLib.readJournalRadarCheckpoint("brief", "owner").state, "invalid");
  const response = await radarRoute.GET(req(ownerSession), { params: { id: "brief" } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.review_state.state, "no_checkpoint");
  assert.equal(payload.review_state.no_checkpoint_reason, "incompatible");
  assert.equal(radarLib.totalJournalRadarChanges(payload.review_state.buckets), 0);
});

test("manifest tracks Plan 3 task/decision changes and Brief evidence only from versions/updated monitor runs", () => {
  const before = manifestLib.buildJournalRadarManifest("brief");
  db().prepare("UPDATE briefs SET created_at = ? WHERE id = 'brief'").run(999999);
  assert.equal(manifestLib.buildJournalRadarManifest("brief").hash, before.hash, "brief creation timestamp is not radar evidence");
  db().prepare(`INSERT INTO brief_versions (id,brief_id,version_no,brief_json,reason,triggered_by,created_at) VALUES ('v1','brief',1,'{}','manual','owner',10)`).run();
  db().prepare(`INSERT INTO monitor_runs (id,brief_id,ran_at,outcome,patches_applied) VALUES
    ('noop','brief',11,'no_updates',0),('failed','brief',12,'failed',0),('updated','brief',13,'updated',2)`).run();
  const after = manifestLib.buildJournalRadarManifest("brief").manifest;
  assert.deepEqual(after.brief_versions.map((v) => v.id), ["v1"]);
  assert.deepEqual(after.monitor_updates.map((r) => r.id), ["updated"]);
});

test("GET is read-only and per-user checkpoints are isolated", async () => {
  db().prepare("DELETE FROM journal_radar_checkpoints WHERE brief_id='brief'").run();
  const cockpitBefore = (db().prepare("SELECT COUNT(*) AS n FROM journal_cockpit_read_models").get() as any).n;
  const catchUpBefore = (db().prepare("SELECT COUNT(*) AS n FROM journal_catch_up_cache").get() as any).n;
  const briefJsonBefore = (db().prepare("SELECT brief_json FROM briefs WHERE id='brief'").get() as any).brief_json;
  const nearExpiry = Date.now() + 1000;
  db().prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(nearExpiry, ownerSession);
  const denied = await radarRoute.GET(req(outsiderSession), { params: { id: "brief" } });
  assert.equal(denied.status, 404);
  const first = await radarRoute.GET(req(ownerSession), { params: { id: "brief" } });
  assert.equal(first.status, 200); assert.equal((await first.json()).review_state.state, "no_checkpoint");
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_radar_checkpoints").get() as any).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_cockpit_read_models").get() as any).n, cockpitBefore);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_catch_up_cache").get() as any).n, catchUpBefore);
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id='brief'").get() as any).brief_json, briefJsonBefore);
  assert.equal((db().prepare("SELECT expires_at FROM sessions WHERE id = ?").get(ownerSession) as any).expires_at, nearExpiry);
  const current = manifestLib.buildJournalRadarManifest("brief");
  checkpointLib.saveJournalRadarCheckpoint({ briefId: "brief", userId: "owner", expectedHash: current.hash, expectedSchemaVersion: current.manifest.schema_version, now: 20 });
  assert.equal(checkpointLib.readJournalRadarCheckpoint("brief", "owner").state, "valid");
  assert.equal(checkpointLib.readJournalRadarCheckpoint("brief", "reader").state, "missing");
});

test("POST authorizes before parsing, requires explicit valid body, and stale CAS preserves checkpoint", async () => {
  let parsed = false;
  const outsiderExpiry = Date.now() + 1000;
  db().prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(outsiderExpiry, outsiderSession);
  const denied = await checkpointRoute.POST(req(outsiderSession, {}, () => { parsed = true; }), { params: { id: "brief" } });
  assert.equal(denied.status, 404); assert.equal(parsed, false);
  assert.equal((db().prepare("SELECT expires_at FROM sessions WHERE id = ?").get(outsiderSession) as any).expires_at, outsiderExpiry);
  const malformed = await checkpointRoute.POST(req(readerSession, []), { params: { id: "brief" } });
  assert.equal(malformed.status, 400);
  const shown = manifestLib.buildJournalRadarManifest("brief");
  const catchUpBefore = (db().prepare("SELECT COUNT(*) AS n FROM journal_catch_up_cache").get() as any).n;
  const briefJsonBefore = (db().prepare("SELECT brief_json FROM briefs WHERE id='brief'").get() as any).brief_json;
  const accepted = await checkpointRoute.POST(req(readerSession, { manifest_hash: shown.hash, manifest_schema_version: shown.manifest.schema_version }), { params: { id: "brief" } });
  assert.equal(accepted.status, 200);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM journal_catch_up_cache").get() as any).n, catchUpBefore);
  assert.equal((db().prepare("SELECT brief_json FROM briefs WHERE id='brief'").get() as any).brief_json, briefJsonBefore);
  const storedBefore = checkpointLib.readJournalRadarCheckpoint("brief", "reader");
  db().prepare(`INSERT INTO journal_entries (id,brief_id,user_id,author_type,body,created_at) VALUES ('later','brief','owner','user','later',999)`).run();
  const stale = await checkpointRoute.POST(req(readerSession, { manifest_hash: shown.hash, manifest_schema_version: shown.manifest.schema_version }), { params: { id: "brief" } });
  assert.equal(stale.status, 409);
  assert.deepEqual(checkpointLib.readJournalRadarCheckpoint("brief", "reader"), storedBefore);
});

test("oversized manifests fail with a bounded 413 and do not leak storage details", async () => {
  db().prepare(`INSERT INTO brief_versions (id,brief_id,version_no,brief_json,reason,triggered_by,created_at)
    VALUES ('oversized-radar-version','brief',99,'{}',?,'owner',99)`).run("x".repeat(manifestLib.JOURNAL_RADAR_MAX_MANIFEST_BYTES));
  const getResponse = await radarRoute.GET(req(ownerSession), { params: { id: "brief" } });
  assert.equal(getResponse.status, 413);
  assert.deepEqual(await getResponse.json(), { error: "Journal radar history is too large to review safely" });
  const postResponse = await checkpointRoute.POST(req(ownerSession, {
    manifest_hash: "a".repeat(64),
    manifest_schema_version: manifestLib.JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION,
  }), { params: { id: "brief" } });
  assert.equal(postResponse.status, 413);
  assert.deepEqual(await postResponse.json(), { error: "Journal radar history is too large to review safely" });
  db().prepare("DELETE FROM brief_versions WHERE id='oversized-radar-version'").run();
});

test("UI contract has no mount POST and exposes explicit accessible Mark reviewed action", () => {
  const component = readFileSync(new URL("../web/app/brief/[id]/journal/JournalRadar.tsx", import.meta.url), "utf8");
  const section = readFileSync(new URL("../web/app/brief/[id]/JournalSection.tsx", import.meta.url), "utf8");
  assert.match(component, /No review checkpoint yet/);
  assert.match(component, /Mark reviewed/);
  assert.match(component, /method:\s*["']POST["']/);
  assert.match(component, /manifest_hash/);
  assert.match(component, /aria-live|role=["']status["']/);
  assert.match(component, /response\.status === 409/);
  for (const responsiveContract of ["overflow-hidden", "min-w-0", "w-full", "sm:w-auto"]) assert.ok(component.includes(responsiveContract));
  const effects = [...component.matchAll(/useEffect\([\s\S]*?\},\s*\[[^\]]*\]\);/g)].map((m) => m[0]).join("\n");
  assert.doesNotMatch(effects, /method:\s*["']POST["']/);
  assert.match(section, /<JournalRadar/);
  assert.match(section, /await load\(\)/);
  assert.match(section, /await loadReviewCandidates\(\)/);
  assert.match(section, /window\.history\.pushState\(null,\s*["']["'],\s*targetHref\)/);
  assert.match(section, /window\.history\.replaceState\(null,\s*["']["'],\s*targetHref\)/);
  assert.match(section, /new HashChangeEvent\(["']hashchange["']\)/);
});

test("source change language stays structural and never claims semantic conflict or supersession", () => {
  const source = readFileSync(new URL("../web/lib/journalRadar.ts", import.meta.url), "utf8");
  for (const label of ["Source added", "Source metadata changed", "Source removed with its Journal entry"]) assert.ok(source.includes(label));
  assert.doesNotMatch(source, /source (?:conflict|contradiction|supersed)/i);
});
