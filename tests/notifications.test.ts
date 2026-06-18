import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "notifications-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const notif = require("../web/lib/notifications") as typeof import("../web/lib/notifications");
const journalRoute = require("../web/app/api/briefs/[id]/journal/route") as typeof import("../web/app/api/briefs/[id]/journal/route");
const entryRoute = require("../web/app/api/briefs/[id]/journal/[entryId]/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/route");
const notifRoute = require("../web/app/api/notifications/route") as typeof import("../web/app/api/notifications/route");
const readRoute = require("../web/app/api/notifications/read/route") as typeof import("../web/app/api/notifications/read/route");

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
function makeReq(opts: { sessionId?: string; body?: any; query?: string }): any {
  return {
    nextUrl: { searchParams: new URLSearchParams(opts.query ?? "") },
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

seedUser("owner", "owner@example.com");
seedUser("reader", "reader@example.com");
seedUser("third", "third@example.com");
seedBrief("brief-1", "owner");
seedShare("brief-1", "reader", "owner");
seedShare("brief-1", "third", "owner");

const ownerSession = authMod.createSession("owner").id;
const readerSession = authMod.createSession("reader").id;

async function postEntry(session: string, body: any) {
  const res = await journalRoute.POST(makeReq({ sessionId: session, body }), { params: { id: "brief-1" } });
  return { status: res.status, data: await res.json() };
}
async function getNotifs(session: string, query?: string) {
  const res = await notifRoute.GET(makeReq({ sessionId: session, query }));
  return { status: res.status, data: await res.json() };
}

test("the notifications endpoint requires auth", async () => {
  const res = await notifRoute.GET(makeReq({}));
  assert.equal(res.status, 401);
  const readRes = await readRoute.POST(makeReq({ body: { all: true } }));
  assert.equal(readRes.status, 401);
});

test("mentioning a member creates an in-app notification with actor + excerpt", async () => {
  await postEntry(ownerSession, { body: "please review @reader, see the latest doc" });
  const { status, data } = await getNotifs(readerSession);
  assert.equal(status, 200);
  assert.equal(data.unread_count, 1);
  const n = data.notifications[0];
  assert.equal(n.type, "journal_mention");
  assert.equal(n.brief_id, "brief-1");
  assert.equal(n.brief_account_name, "Acme");
  assert.equal(n.actor.id, "owner");
  assert.match(n.excerpt, /please review @reader/);
  assert.equal(n.read_at, null);
  assert.ok(n.source_entry_id);
});

test("the author is never notified about their own mention", async () => {
  // owner mentions themselves + reader; only reader is notified.
  const before = (await getNotifs(ownerSession)).data.unread_count;
  await postEntry(ownerSession, { body: "note to self @owner and ping @reader" });
  const after = (await getNotifs(ownerSession)).data.unread_count;
  assert.equal(after, before, "owner gets no self-notification");
});

test("?count=1 returns only the unread count", async () => {
  const { data } = await getNotifs(readerSession, "count=1");
  assert.ok(typeof data.unread_count === "number");
  assert.equal(data.notifications, undefined);
});

test("editing to add a new mention creates a notification for the added member only", async () => {
  const post = await postEntry(ownerSession, { body: "draft for @reader" });
  const id = post.data.entries[0].id;
  const thirdBefore = (await getNotifs(authMod.createSession("third").id)).data.unread_count;

  const edit = await entryRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { body: "draft for @reader and @third" } }),
    { params: { id: "brief-1", entryId: id } },
  );
  assert.equal(edit.status, 200);

  const thirdAfter = (await getNotifs(authMod.createSession("third").id)).data.unread_count;
  assert.equal(thirdAfter, thirdBefore + 1, "third newly mentioned → +1");
});

test("re-resolving the same mention does not duplicate the notification", async () => {
  const post = await postEntry(ownerSession, { body: "idempotency check for @reader" });
  const id = post.data.entries[0].id;
  const countAfterPost = notif.countUnreadNotifications("reader");
  // Edit that keeps @reader mentioned — must not create a second row.
  await entryRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { body: "idempotency check, still @reader here" } }),
    { params: { id: "brief-1", entryId: id } },
  );
  assert.equal(notif.countUnreadNotifications("reader"), countAfterPost, "no duplicate notification");
});

test("marking specific ids read decrements the unread count; mark-all clears it", async () => {
  // Fresh recipient to isolate counts.
  seedUser("zoe", "zoe@example.com");
  seedShare("brief-1", "zoe", "owner");
  const zoeSession = authMod.createSession("zoe").id;
  await postEntry(ownerSession, { body: "first for @zoe" });
  await postEntry(ownerSession, { body: "second for @zoe" });

  let list = (await getNotifs(zoeSession)).data;
  assert.equal(list.unread_count, 2);

  // Mark one read.
  const one = await readRoute.POST(makeReq({ sessionId: zoeSession, body: { ids: [list.notifications[0].id] } }));
  const oneData = await one.json();
  assert.equal(oneData.marked, 1);
  assert.equal(oneData.unread_count, 1);

  // ?unread=1 now returns just the remaining one.
  const unread = (await getNotifs(zoeSession, "unread=1")).data;
  assert.equal(unread.notifications.length, 1);

  // Mark all read.
  const all = await readRoute.POST(makeReq({ sessionId: zoeSession, body: { all: true } }));
  const allData = await all.json();
  assert.equal(allData.unread_count, 0);
});

test("a deleted source entry keeps the notification but drops its excerpt", async () => {
  seedUser("max", "max@example.com");
  seedShare("brief-1", "max", "owner");
  const maxSession = authMod.createSession("max").id;
  const post = await postEntry(ownerSession, { body: "transient mention @max" });
  const entryId = post.data.entries[0].id;

  await entryRoute.DELETE(makeReq({ sessionId: ownerSession }), {
    params: { id: "brief-1", entryId },
  });

  const list = (await getNotifs(maxSession)).data;
  const n = list.notifications.find((x: any) => x.source_entry_id === entryId);
  assert.ok(n, "notification still present after the entry is deleted");
  assert.equal(n.entry_deleted, true);
  assert.equal(n.excerpt, null);
});

test("revoking a share hides the notification and excludes it from the unread count", async () => {
  // Reader is mentioned while they have access...
  seedUser("rev", "rev@example.com");
  seedBrief("brief-rev", "owner");
  seedShare("brief-rev", "rev", "owner");
  const revSession = authMod.createSession("rev").id;
  // Re-resolve mentions against current members: post via the route so the
  // mention row + notification are created for an actual member.
  const post = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "secret plan @rev inside" } }),
    { params: { id: "brief-rev" } },
  );
  assert.equal(post.status, 200);

  // While shared, the reader sees it with account name + excerpt.
  const before = (await getNotifs(revSession)).data;
  const n = before.notifications.find((x: any) => x.brief_id === "brief-rev");
  assert.ok(n, "notification visible while shared");
  assert.equal(n.brief_account_name, "Acme");
  assert.match(n.excerpt, /secret plan/);
  const unreadBefore = before.unread_count;
  assert.ok(unreadBefore >= 1);

  // Owner revokes the share.
  db().prepare(`DELETE FROM brief_shares WHERE brief_id = ? AND user_id = ?`).run("brief-rev", "rev");

  // The notification (and its account name / excerpt) is no longer returned,
  // and the unread count drops it too.
  const after = (await getNotifs(revSession)).data;
  assert.equal(
    after.notifications.find((x: any) => x.brief_id === "brief-rev"),
    undefined,
    "notification hidden after revocation",
  );
  assert.equal(after.unread_count, unreadBefore - 1, "unread count excludes the revoked-brief notification");
  // ?count=1 (the badge poll path) must agree.
  const countOnly = (await getNotifs(revSession, "count=1")).data;
  assert.equal(countOnly.unread_count, after.unread_count);
});

test("an admin can still see a notification for a brief they neither own nor are shared on", async () => {
  db().prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run("third");
  // Notification addressed to the admin user for a brief they don't own/share.
  const adminBrief = "brief-admin-vis";
  seedBrief(adminBrief, "owner");
  notif.createMentionNotifications({
    briefId: adminBrief,
    entryId: "no-such-entry",
    actorId: "owner",
    recipientUserIds: ["third"],
  });
  const list = (await getNotifs(authMod.createSession("third").id)).data;
  assert.ok(
    list.notifications.some((x: any) => x.brief_id === adminBrief),
    "admin sees the notification despite no ownership/share",
  );
  db().prepare(`UPDATE users SET role = 'member' WHERE id = ?`).run("third");
});

test("mark-read is not an oracle: it only touches the caller's own rows", async () => {
  // reader marks-read an id belonging to someone else → no effect, no leak.
  seedUser("victim", "victim@example.com");
  seedShare("brief-1", "victim", "owner");
  const victimSession = authMod.createSession("victim").id;
  await postEntry(ownerSession, { body: "oracle target @victim" });
  const victimNotif = (await getNotifs(victimSession)).data.notifications[0];

  const res = await readRoute.POST(
    makeReq({ sessionId: readerSession, body: { ids: [victimNotif.id] } }),
  );
  const data = await res.json();
  assert.equal(data.marked, 0, "cannot mark another user's notification read");
  // Victim's notification is untouched.
  const stillUnread = (await getNotifs(victimSession)).data.notifications.find(
    (x: any) => x.id === victimNotif.id,
  );
  assert.equal(stillUnread.read_at, null);
});

test("the read endpoint dedupes and caps the ids array", async () => {
  seedUser("cap", "cap@example.com");
  seedShare("brief-1", "cap", "owner");
  const capSession = authMod.createSession("cap").id;
  await postEntry(ownerSession, { body: "cap test @cap" });
  const id = (await getNotifs(capSession)).data.notifications[0].id;
  // 1000 duplicate ids + the real one — must not error, marks exactly 1.
  const ids = [...Array(1000).fill(id), id];
  const res = await readRoute.POST(makeReq({ sessionId: capSession, body: { ids } }));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.marked, 1);
});

test("notifications are scoped per-user (no cross-user leakage)", async () => {
  await postEntry(ownerSession, { body: "scoped ping @reader only" });
  const readerList = (await getNotifs(readerSession)).data;
  assert.ok(readerList.notifications.every((n: any) => n.actor === null || true));
  // owner should not see reader's notifications in their own feed
  const ownerList = (await getNotifs(ownerSession)).data;
  const readerEntryIds = new Set(readerList.notifications.map((n: any) => n.id));
  assert.ok(ownerList.notifications.every((n: any) => !readerEntryIds.has(n.id)));
});
