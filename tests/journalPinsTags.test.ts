import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "journal-pins-tags-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const journalLib = require("../web/lib/journal") as typeof import("../web/lib/journal");
const journalRoute = require("../web/app/api/briefs/[id]/journal/route") as typeof import("../web/app/api/briefs/[id]/journal/route");
const pinRoute = require("../web/app/api/briefs/[id]/journal/[entryId]/pin/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/pin/route");
const tagsRoute = require("../web/app/api/briefs/[id]/journal/[entryId]/tags/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/tags/route");

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
function seedShare(briefId: string, userId: string, by: string) {
  db()
    .prepare(
      `INSERT INTO brief_shares (brief_id, user_id, granted_by, created_at, role)
       VALUES (?, ?, ?, ?, 'reader')`,
    )
    .run(briefId, userId, by, Date.now());
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
seedUser("reader-1", "reader@example.com");
seedUser("outsider-1", "outsider@example.com");
seedBrief("brief-1", "owner-1");
seedShare("brief-1", "reader-1", "owner-1");
const ownerSession = authMod.createSession("owner-1").id;
const readerSession = authMod.createSession("reader-1").id;
const outsiderSession = authMod.createSession("outsider-1").id;

function makeEntry(body: string): string {
  return journalLib.insertJournalEntry({
    briefId: "brief-1",
    userId: "owner-1",
    authorType: "user",
    body,
    replyTo: null,
  });
}

async function listEntries(sessionId: string) {
  const res = await journalRoute.GET(makeReq({ sessionId }), { params: { id: "brief-1" } });
  return { status: res.status, data: await res.json() };
}

test("entries carry pinned_at and tags in the journal feed DTO", async () => {
  makeEntry("plain entry");
  const { status, data } = await listEntries(ownerSession);
  assert.equal(status, 200);
  const entry = data.entries[0];
  assert.equal(entry.pinned_at, null);
  assert.deepEqual(entry.tags, []);
});

test("pin and unpin an entry (team-wide), reflected in the feed", async () => {
  const id = makeEntry("pin me");
  const pin = await pinRoute.POST(makeReq({ sessionId: readerSession }), { params: { id: "brief-1", entryId: id } });
  assert.equal(pin.status, 200);
  assert.equal((await pin.json()).pinned, true);

  let feed = await listEntries(ownerSession);
  let row = feed.data.entries.find((e: any) => e.id === id);
  assert.ok(typeof row.pinned_at === "number");

  const unpin = await pinRoute.DELETE(makeReq({ sessionId: ownerSession }), { params: { id: "brief-1", entryId: id } });
  assert.equal(unpin.status, 200);
  feed = await listEntries(ownerSession);
  row = feed.data.entries.find((e: any) => e.id === id);
  assert.equal(row.pinned_at, null);
});

test("add and remove curated tags; invalid tag rejected; feed reflects tags", async () => {
  const id = makeEntry("tag me");
  const add = await tagsRoute.POST(makeReq({ sessionId: readerSession, body: { tag: "decision" } }), { params: { id: "brief-1", entryId: id } });
  assert.equal(add.status, 200);
  assert.deepEqual((await add.json()).tags, ["decision"]);

  // A second tag; curated order is preserved (risk sorts after decision).
  await tagsRoute.POST(makeReq({ sessionId: ownerSession, body: { tag: "risk" } }), { params: { id: "brief-1", entryId: id } });
  const feed = await listEntries(ownerSession);
  const row = feed.data.entries.find((e: any) => e.id === id);
  assert.deepEqual(row.tags, ["decision", "risk"]);

  // Invalid tag → 400.
  const bad = await tagsRoute.POST(makeReq({ sessionId: ownerSession, body: { tag: "nonsense" } }), { params: { id: "brief-1", entryId: id } });
  assert.equal(bad.status, 400);

  // Remove one.
  const rm = await tagsRoute.DELETE(makeReq({ sessionId: ownerSession, body: { tag: "decision" } }), { params: { id: "brief-1", entryId: id } });
  assert.equal(rm.status, 200);
  assert.deepEqual((await rm.json()).tags, ["risk"]);
});

test("adding the same tag twice is idempotent", async () => {
  const id = makeEntry("dup tag");
  await tagsRoute.POST(makeReq({ sessionId: ownerSession, body: { tag: "idea" } }), { params: { id: "brief-1", entryId: id } });
  const again = await tagsRoute.POST(makeReq({ sessionId: ownerSession, body: { tag: "idea" } }), { params: { id: "brief-1", entryId: id } });
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).tags, ["idea"]);
});

test("a soft-deleted entry exposes no pin or tags", async () => {
  const id = makeEntry("delete me");
  await pinRoute.POST(makeReq({ sessionId: ownerSession }), { params: { id: "brief-1", entryId: id } });
  await tagsRoute.POST(makeReq({ sessionId: ownerSession, body: { tag: "question" } }), { params: { id: "brief-1", entryId: id } });
  db().prepare(`UPDATE journal_entries SET deleted_at = ? WHERE id = ?`).run(Date.now(), id);

  const feed = await listEntries(ownerSession);
  const row = feed.data.entries.find((e: any) => e.id === id);
  assert.equal(row.pinned_at, null);
  assert.deepEqual(row.tags, []);
});

test("outsiders cannot pin or tag; unknown entry is 404", async () => {
  const id = makeEntry("guarded");
  const outPin = await pinRoute.POST(makeReq({ sessionId: outsiderSession }), { params: { id: "brief-1", entryId: id } });
  assert.equal(outPin.status, 404);
  const outTag = await tagsRoute.POST(makeReq({ sessionId: outsiderSession, body: { tag: "risk" } }), { params: { id: "brief-1", entryId: id } });
  assert.equal(outTag.status, 404);

  const missingPin = await pinRoute.POST(makeReq({ sessionId: ownerSession }), { params: { id: "brief-1", entryId: "nope" } });
  assert.equal(missingPin.status, 404);
  const missingTag = await tagsRoute.POST(makeReq({ sessionId: ownerSession, body: { tag: "risk" } }), { params: { id: "brief-1", entryId: "nope" } });
  assert.equal(missingTag.status, 404);
});
