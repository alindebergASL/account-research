import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "journal-mentions-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const journalLib = require("../web/lib/journal") as typeof import("../web/lib/journal");
const mentions = require("../web/lib/journalMentions") as typeof import("../web/lib/journalMentions");
const journalRoute = require("../web/app/api/briefs/[id]/journal/route") as typeof import("../web/app/api/briefs/[id]/journal/route");
const entryRoute = require("../web/app/api/briefs/[id]/journal/[entryId]/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/route");
const membersRoute = require("../web/app/api/briefs/[id]/journal/members/route") as typeof import("../web/app/api/briefs/[id]/journal/members/route");
const renderHelpers = require("../web/app/brief/[id]/journal/helpers") as typeof import("../web/app/brief/[id]/journal/helpers");

initDb();

function seedUser(id: string, email: string, displayName?: string, disabled = false) {
  db()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, display_name, created_at, must_change_password, disabled_at)
       VALUES (?, ?, 'h', 'member', ?, ?, 0, ?)`,
    )
    .run(id, email, displayName ?? email.split("@")[0], Date.now(), disabled ? Date.now() : null);
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
function makeReq(opts: { sessionId?: string; body?: any; query?: string }): any {
  return {
    nextUrl: opts.query !== undefined
      ? { searchParams: new URLSearchParams(opts.query) }
      : undefined,
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

// Brief members: owner + two shared readers (one with a spaced display name) +
// a disabled share. An outsider has no access and must never be mentionable.
seedUser("owner", "owner@example.com");
seedUser("reader", "reader@example.com");
seedUser("alice", "asmith@example.com", "Alice Smith");
seedUser("ghost", "ghost@example.com", undefined, /* disabled */ true);
seedUser("outsider", "outsider@example.com");
seedBrief("brief-1", "owner");
seedShare("brief-1", "reader", "owner");
seedShare("brief-1", "alice", "owner");
seedShare("brief-1", "ghost", "owner");

const ownerSession = authMod.createSession("owner").id;
const readerSession = authMod.createSession("reader").id;

async function listEntries(sessionId: string, query?: string) {
  const res = await journalRoute.GET(makeReq({ sessionId, query }), { params: { id: "brief-1" } });
  return { status: res.status, data: await res.json() };
}

test("listBriefMembers returns owner + active shares, excludes disabled and outsiders", () => {
  const ids = new Set(mentions.listBriefMembers("brief-1").map((m) => m.id));
  assert.ok(ids.has("owner"));
  assert.ok(ids.has("reader"));
  assert.ok(ids.has("alice"));
  assert.ok(!ids.has("ghost"), "disabled member excluded");
  assert.ok(!ids.has("outsider"), "non-member excluded");
});

test("parseMentionHandles extracts distinct handles, ignores mid-token @ (emails)", () => {
  assert.deepEqual(mentions.parseMentionHandles("hi @reader and @reader again"), ["reader"]);
  assert.deepEqual(mentions.parseMentionHandles("ping @owner cc @alice.smith"), ["owner", "alice.smith"]);
  // An email address should not register its domain as a handle.
  assert.deepEqual(mentions.parseMentionHandles("mail me at bob@example.com"), []);
});

test("resolveMentionedUserIds matches members by email local-part and display name", () => {
  assert.deepEqual(mentions.resolveMentionedUserIds("brief-1", "hey @reader"), ["reader"]);
  // Email local-part of asmith@ and the normalized display name both resolve.
  assert.deepEqual(mentions.resolveMentionedUserIds("brief-1", "hi @asmith"), ["alice"]);
  assert.deepEqual(mentions.resolveMentionedUserIds("brief-1", "hi @alicesmith"), ["alice"]);
});

test("resolveMentionedUserIds ignores non-members and unknown handles, dedupes", () => {
  assert.deepEqual(mentions.resolveMentionedUserIds("brief-1", "@outsider @nobody"), []);
  assert.deepEqual(
    mentions.resolveMentionedUserIds("brief-1", "@reader @owner @reader"),
    ["reader", "owner"],
  );
});

test("posting an entry surfaces resolved mentions in the feed DTO", async () => {
  const res = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "morning @reader and @asmith, see notes" } }),
    { params: { id: "brief-1" } },
  );
  assert.equal(res.status, 200);
  const entry = (await res.json()).entries[0];
  const ids = entry.mentions.map((m: any) => m.user_id);
  assert.deepEqual(ids, ["reader", "alice"]);
  // Mention DTO carries display name + email for rendering.
  const reader = entry.mentions.find((m: any) => m.user_id === "reader");
  assert.equal(reader.email, "reader@example.com");
});

test("mentioning a non-member is silently dropped", async () => {
  const res = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "cc @outsider — should not resolve" } }),
    { params: { id: "brief-1" } },
  );
  const entry = (await res.json()).entries[0];
  assert.deepEqual(entry.mentions, []);
});

test("editing an entry re-resolves mentions (add and remove)", async () => {
  const post = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "draft @reader" } }),
    { params: { id: "brief-1" } },
  );
  const id = (await post.json()).entries[0].id;

  const edit = await entryRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { body: "updated @alicesmith now" } }),
    { params: { id: "brief-1", entryId: id } },
  );
  assert.equal(edit.status, 200);

  const feed = await listEntries(ownerSession);
  const row = feed.data.entries.find((e: any) => e.id === id);
  assert.deepEqual(row.mentions.map((m: any) => m.user_id), ["alice"]);
});

test("soft-deleted entry exposes no mentions", async () => {
  const post = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "temp @reader" } }),
    { params: { id: "brief-1" } },
  );
  const id = (await post.json()).entries[0].id;
  const del = await entryRoute.DELETE(makeReq({ sessionId: ownerSession }), {
    params: { id: "brief-1", entryId: id },
  });
  assert.equal(del.status, 200);

  const feed = await listEntries(ownerSession);
  const row = feed.data.entries.find((e: any) => e.id === id);
  assert.deepEqual(row.mentions, []);
});

test("?mentions=me filters to the viewer's mentions and keeps whole threads", async () => {
  // A root that does NOT mention reader, with a reply that DOES — the reader's
  // filtered feed should still include the root so the reply has context.
  const rootRes = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "thread root, no mention here" } }),
    { params: { id: "brief-1" } },
  );
  const rootId = (await rootRes.json()).entries[0].id;
  const replyRes = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "follow-up for @reader", reply_to: rootId } }),
    { params: { id: "brief-1" } },
  );
  const replyId = (await replyRes.json()).entries[0].id;

  const filtered = await listEntries(readerSession, "mentions=me");
  assert.equal(filtered.status, 200);
  const ids = new Set(filtered.data.entries.map((e: any) => e.id));
  assert.ok(ids.has(replyId), "reply that mentions reader is included");
  assert.ok(ids.has(rootId), "its root is included for context");

  // An owner-only thread (no mention of reader anywhere) is excluded.
  const otherRes = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "unrelated note for nobody" } }),
    { params: { id: "brief-1" } },
  );
  const otherId = (await otherRes.json()).entries[0].id;
  const filtered2 = await listEntries(readerSession, "mentions=me");
  assert.ok(
    !filtered2.data.entries.some((e: any) => e.id === otherId),
    "unrelated thread excluded from mentions-me feed",
  );
});

test("?mentions=me ignores soft-deleted entries as the matching trigger", async () => {
  // A live root whose only mention of reader is in a reply we then delete.
  const rootRes = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "soft-delete trigger root" } }),
    { params: { id: "brief-1" } },
  );
  const rootId = (await rootRes.json()).entries[0].id;
  const replyRes = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "transient ping @reader", reply_to: rootId } }),
    { params: { id: "brief-1" } },
  );
  const replyId = (await replyRes.json()).entries[0].id;

  // While the reply is live, the thread surfaces for reader.
  let filtered = await listEntries(readerSession, "mentions=me");
  assert.ok(filtered.data.entries.some((e: any) => e.id === rootId));

  // Soft-delete the only mentioning entry; the thread must drop out entirely.
  const del = await entryRoute.DELETE(makeReq({ sessionId: ownerSession }), {
    params: { id: "brief-1", entryId: replyId },
  });
  assert.equal(del.status, 200);

  filtered = await listEntries(readerSession, "mentions=me");
  const ids = new Set(filtered.data.entries.map((e: any) => e.id));
  assert.ok(!ids.has(rootId), "root no longer surfaces once its only mention is deleted");
  assert.ok(!ids.has(replyId), "deleted reply itself is not surfaced");

  // A root that itself mentions reader but is soft-deleted also stays out.
  const selfRes = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "deleted root pinging @reader" } }),
    { params: { id: "brief-1" } },
  );
  const selfId = (await selfRes.json()).entries[0].id;
  await entryRoute.DELETE(makeReq({ sessionId: ownerSession }), {
    params: { id: "brief-1", entryId: selfId },
  });
  filtered = await listEntries(readerSession, "mentions=me");
  assert.ok(
    !filtered.data.entries.some((e: any) => e.id === selfId),
    "soft-deleted root mentioning the viewer is excluded",
  );
});

test("members endpoint returns owner + active shares with handles, 404 for non-readers", async () => {
  const ok = await membersRoute.GET(makeReq({ sessionId: ownerSession }), { params: { id: "brief-1" } });
  assert.equal(ok.status, 200);
  const { members } = await ok.json();
  const byId = new Map<string, any>(members.map((m: any) => [m.id, m]));
  assert.ok(byId.has("owner") && byId.has("reader") && byId.has("alice"));
  assert.ok(!byId.has("ghost"), "disabled member excluded");
  assert.ok(!byId.has("outsider"), "non-member excluded");
  // Handle is the email local-part (always resolvable).
  assert.equal(byId.get("alice").handle, "asmith");

  const outsiderSession = authMod.createSession("outsider").id;
  const denied = await membersRoute.GET(makeReq({ sessionId: outsiderSession }), { params: { id: "brief-1" } });
  assert.equal(denied.status, 404);
});

test("splitBodyMentions highlights only resolved handles, leaves the rest plain", () => {
  const mentionsList = [
    { user_id: "reader", display_name: "reader", email: "reader@example.com" },
  ];
  const segs = renderHelpers.splitBodyMentions("hi @reader and @ghost ok", mentionsList);
  assert.deepEqual(
    segs,
    [
      { kind: "text", text: "hi " },
      { kind: "mention", text: "@reader", member: mentionsList[0] },
      { kind: "text", text: " and @ghost ok" },
    ],
  );
  // No mentions on the entry → a single plain text run.
  assert.deepEqual(renderHelpers.splitBodyMentions("plain @reader", []), [
    { kind: "text", text: "plain @reader" },
  ]);
  // Null body → empty.
  assert.deepEqual(renderHelpers.splitBodyMentions(null, mentionsList), []);
});

test("assistant entries never carry user mentions even if body contains a handle", () => {
  const aiId = journalLib.insertJournalEntry({
    briefId: "brief-1",
    userId: "owner",
    authorType: "assistant",
    body: "Assistant reply that literally says @reader in prose",
    replyTo: null,
  });
  // The route only syncs mentions for user-authored bodies; nothing was stored.
  assert.deepEqual(mentions.listMentionsForEntry(aiId), []);
});
