import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "journal-threads-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const journalLib = require("../web/lib/journal") as typeof import("../web/lib/journal");
const journalRoute = require("../web/app/api/briefs/[id]/journal/route") as typeof import("../web/app/api/briefs/[id]/journal/route");

initDb();

function seedUser(id: string, email: string) {
  db()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, display_name, created_at, must_change_password)
       VALUES (?, ?, 'h', 'member', ?, ?, 0)`,
    )
    .run(id, email, email.split("@")[0], Date.now());
}
function seedBrief(id: string, ownerId: string) {
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, 'Acme', 'Tech', 'internal', ?, ?, '{}')`,
    )
    .run(id, ownerId, new Date().toISOString(), Date.now());
}
function makeReq(opts: { sessionId?: string; body?: any }): any {
  return {
    cookies: {
      get(name: string) {
        if (opts.sessionId && name === authMod.SESSION_COOKIE) return { value: opts.sessionId };
        return undefined;
      },
    },
    async json() {
      if (opts.body === undefined) throw new Error("no body");
      return opts.body;
    },
  };
}

seedUser("owner-1", "owner@example.com");
seedBrief("brief-1", "owner-1");
const ownerSession = authMod.createSession("owner-1").id;

async function post(body: any) {
  const res = await journalRoute.POST(makeReq({ sessionId: ownerSession, body }), { params: { id: "brief-1" } });
  return { status: res.status, data: await res.json() };
}

test("a non-AI reply sets reply_to to the target entry (becomes the thread root)", async () => {
  const root = await post({ body: "root note" });
  const rootId = root.data.entries[0].id;
  assert.equal(root.data.entries[0].reply_to, null);

  const reply = await post({ body: "a reply", reply_to: rootId });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.entries[0].reply_to, rootId);
});

test("replying to a reply collapses onto the original root (single-level)", async () => {
  const root = await post({ body: "thread head" });
  const rootId = root.data.entries[0].id;
  const reply = await post({ body: "first reply", reply_to: rootId });
  const replyId = reply.data.entries[0].id;

  // Reply to the reply — reply_to should normalize back to the root.
  const nested = await post({ body: "reply to reply", reply_to: replyId });
  assert.equal(nested.status, 200);
  assert.equal(nested.data.entries[0].reply_to, rootId);
});

test("an unknown or soft-deleted reply target is rejected with 400", async () => {
  const missing = await post({ body: "orphan", reply_to: "does-not-exist" });
  assert.equal(missing.status, 400);

  const root = await post({ body: "to be deleted" });
  const rootId = root.data.entries[0].id;
  db().prepare(`UPDATE journal_entries SET deleted_at = ? WHERE id = ?`).run(Date.now(), rootId);
  const toDeleted = await post({ body: "reply to ghost", reply_to: rootId });
  assert.equal(toDeleted.status, 400);
});

test("resolveThreadRoot returns the root for a reply and null for unknown ids", () => {
  const root = journalLib.insertJournalEntry({ briefId: "brief-1", userId: "owner-1", authorType: "user", body: "r", replyTo: null });
  const reply = journalLib.insertJournalEntry({ briefId: "brief-1", userId: "owner-1", authorType: "user", body: "rep", replyTo: root });
  assert.equal(journalLib.resolveThreadRoot("brief-1", root), root);
  assert.equal(journalLib.resolveThreadRoot("brief-1", reply), root);
  assert.equal(journalLib.resolveThreadRoot("brief-1", "nope"), null);
  // Wrong brief → null (boundary respected).
  assert.equal(journalLib.resolveThreadRoot("other-brief", root), null);
});

test("listThreadEntryRows returns root + replies oldest-first, excluding deleted", () => {
  const root = journalLib.insertJournalEntry({ briefId: "brief-1", userId: "owner-1", authorType: "user", body: "head", replyTo: null });
  const r1 = journalLib.insertJournalEntry({ briefId: "brief-1", userId: "owner-1", authorType: "assistant", body: "reply-1", replyTo: root });
  const r2 = journalLib.insertJournalEntry({ briefId: "brief-1", userId: "owner-1", authorType: "user", body: "reply-2", replyTo: root });
  db().prepare(`UPDATE journal_entries SET deleted_at = ? WHERE id = ?`).run(Date.now(), r1);

  const thread = journalLib.listThreadEntryRows("brief-1", root);
  const ids = thread.map((r) => r.id);
  assert.deepEqual(ids, [root, r2]);
  assert.ok(!ids.includes(r1));
});
