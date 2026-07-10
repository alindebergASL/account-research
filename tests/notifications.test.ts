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
const commentsRoute = require("../web/app/api/briefs/[id]/comments/route") as typeof import("../web/app/api/briefs/[id]/comments/route");
const jobRoute = require("../web/app/api/research-jobs/[id]/route") as typeof import("../web/app/api/research-jobs/[id]/route");

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

  // The write path agrees too: mark-all must not clear (or even count) the now
  // hidden notification — marked: 0 reveals nothing about its existence.
  const markAll = await readRoute.POST(makeReq({ sessionId: revSession, body: { all: true } }));
  const markAllData = await markAll.json();
  assert.equal(markAllData.marked, 0, "mark-all after revoke touches no hidden rows");
});

test("mark-read by id is a no-op for a notification whose brief access was revoked", async () => {
  seedUser("revid", "revid@example.com");
  seedBrief("brief-revid", "owner");
  seedShare("brief-revid", "revid", "owner");
  const session = authMod.createSession("revid").id;
  const post = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "capture me @revid" } }),
    { params: { id: "brief-revid" } },
  );
  assert.equal(post.status, 200);
  // Capture the id while still accessible.
  const id = (await getNotifs(session)).data.notifications.find(
    (x: any) => x.brief_id === "brief-revid",
  ).id;

  db().prepare(`DELETE FROM brief_shares WHERE brief_id = ? AND user_id = ?`).run("brief-revid", "revid");

  const res = await readRoute.POST(makeReq({ sessionId: session, body: { ids: [id] } }));
  const data = await res.json();
  assert.equal(data.marked, 0, "stale id for a revoked brief cannot be marked read");
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

async function postComment(session: string, briefId: string, body: any) {
  const res = await commentsRoute.POST(makeReq({ sessionId: session, body }), {
    params: { id: briefId },
  });
  return { status: res.status, data: await res.json() };
}

test("a top-level comment notifies the brief owner in-app", async () => {
  const before = notif.countUnreadNotifications("owner");
  const post = await postComment(readerSession, "brief-1", { body: "great research, one question" });
  assert.equal(post.status, 200);
  assert.equal(notif.countUnreadNotifications("owner"), before + 1);
  const n = notif.listNotifications("owner")[0];
  assert.equal(n.type, "brief_comment");
  assert.equal(n.actor?.id, "reader");
  assert.equal(n.source_entry_id, post.data.comment.id);
  assert.match(n.excerpt ?? "", /great research/);
});

test("a comment on your own brief does not notify you", async () => {
  const before = notif.countUnreadNotifications("owner");
  await postComment(ownerSession, "brief-1", { body: "note on my own brief" });
  assert.equal(notif.countUnreadNotifications("owner"), before);
});

test("a reply notifies the parent comment's author, not the brief owner", async () => {
  const parent = await postComment(readerSession, "brief-1", { body: "parent comment" });
  const ownerBefore = notif.countUnreadNotifications("owner");
  const readerBefore = notif.countUnreadNotifications("reader");
  await postComment(ownerSession, "brief-1", {
    body: "replying to you",
    parent_id: parent.data.comment.id,
  });
  assert.equal(notif.countUnreadNotifications("reader"), readerBefore + 1);
  assert.equal(notif.countUnreadNotifications("owner"), ownerBefore, "owner not notified for a reply");
  const n = notif.listNotifications("reader")[0];
  assert.equal(n.type, "comment_reply");
  assert.equal(n.actor?.id, "owner");
});

test("a soft-deleted comment keeps the notification but drops its excerpt", async () => {
  const post = await postComment(readerSession, "brief-1", { body: "soon deleted" });
  const commentId = post.data.comment.id;
  db().prepare(`UPDATE brief_comments SET deleted_at = ? WHERE id = ?`).run(Date.now(), commentId);
  const n = notif
    .listNotifications("owner")
    .find((x) => x.source_entry_id === commentId);
  assert.ok(n, "notification survives comment deletion");
  assert.equal(n!.entry_deleted, true);
  assert.equal(n!.excerpt, null);
});

test("a reply does not create a notification for a parent author who lost access", async () => {
  seedUser("gone", "gone@example.com");
  seedBrief("brief-gone", "owner");
  seedShare("brief-gone", "gone", "owner");
  const goneSession = authMod.createSession("gone").id;
  const parent = await postComment(goneSession, "brief-gone", { body: "posted while shared" });
  db().prepare(`DELETE FROM brief_shares WHERE brief_id = ? AND user_id = ?`).run("brief-gone", "gone");
  const before = db()
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'gone'`)
    .get() as { c: number };
  await postComment(ownerSession, "brief-gone", {
    body: "reply after revocation",
    parent_id: parent.data.comment.id,
  });
  const after = db()
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'gone'`)
    .get() as { c: number };
  assert.equal(after.c, before.c, "no notification row accrues for a revoked recipient");
});

test("creating a notification prunes the recipient's read notifications past retention", async () => {
  // Plant a read notification 91 days old, then trigger any create for owner.
  db()
    .prepare(
      `INSERT INTO notifications (id, user_id, type, brief_id, source_entry_id, actor_id, created_at, read_at)
       VALUES ('stale-n', 'owner', 'journal_mention', 'brief-1', 'stale-src', 'reader', ?, ?)`,
    )
    .run(Date.now() - 91 * 24 * 60 * 60 * 1000, Date.now() - 90 * 24 * 60 * 60 * 1000);
  await postComment(readerSession, "brief-1", { body: "prune trigger" });
  const stale = db().prepare(`SELECT id FROM notifications WHERE id = 'stale-n'`).get();
  assert.equal(stale, undefined, "old read notification pruned on create");
});

test("research-job detail withholds brief events from a demoted ex-admin job owner", async () => {
  seedUser("exadmin", "exadmin@example.com");
  db().prepare(`UPDATE users SET role = 'admin' WHERE id = 'exadmin'`).run();
  seedBrief("brief-events", "owner");
  db()
    .prepare(
      `INSERT INTO research_jobs (id, user_id, account_name, intake_json, mode, status, created_at, target_brief_id, intent)
       VALUES ('job-1', 'exadmin', 'Acme', '{}', 'standard', 'succeeded', ?, 'brief-events', 'refresh')`,
    )
    .run(Date.now());
  db()
    .prepare(
      `INSERT INTO brief_events (id, brief_id, event_type, title, summary, created_at)
       VALUES ('ev-1', 'brief-events', 'refresh', 'Brief refreshed', 'fields: personas', ?)`,
    )
    .run(Date.now());

  const adminSession = authMod.createSession("exadmin").id;
  const asAdmin = await jobRoute.GET(makeReq({ sessionId: adminSession }), { params: { id: "job-1" } });
  const adminData = await asAdmin.json();
  assert.equal(adminData.recent_events.length, 1, "admin sees the linked brief's events");

  // Demote. The job row still names exadmin as owner, so the job itself stays
  // visible — but the linked brief's event feed must not.
  db().prepare(`UPDATE users SET role = 'member' WHERE id = 'exadmin'`).run();
  const demotedSession = authMod.createSession("exadmin").id;
  const asDemoted = await jobRoute.GET(makeReq({ sessionId: demotedSession }), { params: { id: "job-1" } });
  assert.equal(asDemoted.status, 200, "job detail itself remains accessible to the job owner");
  const demotedData = await asDemoted.json();
  assert.equal(demotedData.recent_events.length, 0, "brief events withheld without current brief access");
});

test("disabled recipients are suppressed for mentions and comments", async () => {
  seedUser("sleeper", "sleeper@example.com");
  seedShare("brief-1", "sleeper", "owner");
  db().prepare(`UPDATE users SET disabled_at = ? WHERE id = 'sleeper'`).run(Date.now());

  await postEntry(ownerSession, { body: "hey @sleeper are you there" });
  assert.equal(notif.countUnreadNotifications("sleeper"), 0, "no mention notification for a disabled user");

  // Disable the brief owner and comment on their brief: no comment notification.
  db().prepare(`UPDATE users SET disabled_at = ? WHERE id = 'owner'`).run(Date.now());
  const ownerBefore = db()
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'owner'`)
    .get() as { c: number };
  await postComment(readerSession, "brief-1", { body: "comment while owner disabled" });
  const ownerAfter = db()
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'owner'`)
    .get() as { c: number };
  assert.equal(ownerAfter.c, ownerBefore.c, "no comment notification for a disabled owner");
  db().prepare(`UPDATE users SET disabled_at = NULL WHERE id = 'owner'`).run();
});

test("createCommentNotification is idempotent per comment", async () => {
  const post = await postComment(readerSession, "brief-1", { body: "idempotent comment" });
  const commentId = post.data.comment.id;
  // The route already created the notification once; calling the helper again
  // with the same args must be a no-op.
  const again = notif.createCommentNotification({
    briefId: "brief-1",
    commentId,
    parentCommentId: null,
    actorId: "reader",
  });
  assert.equal(again, 0);
  const rows = db()
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE source_entry_id = ?`)
    .get(commentId) as { c: number };
  assert.equal(rows.c, 1);
});

test("comment insert and notification are atomic: a notification failure rolls back the comment", async () => {
  db().exec(
    `CREATE TRIGGER test_fail_notif BEFORE INSERT ON notifications
     BEGIN SELECT RAISE(ABORT, 'injected notification failure'); END`,
  );
  try {
    await assert.rejects(
      commentsRoute.POST(
        makeReq({ sessionId: readerSession, body: { body: "must roll back" } }),
        { params: { id: "brief-1" } },
      ),
      /injected notification failure/,
    );
    const orphan = db()
      .prepare(`SELECT COUNT(*) AS c FROM brief_comments WHERE body = 'must roll back'`)
      .get() as { c: number };
    assert.equal(orphan.c, 0, "comment insert rolled back with the failed notification");
  } finally {
    db().exec(`DROP TRIGGER test_fail_notif`);
  }
});

test("the per-user cap prunes past 500 notifications on create", async () => {
  seedUser("hoarder", "hoarder@example.com");
  seedShare("brief-1", "hoarder", "owner");
  const insert = db().prepare(
    `INSERT INTO notifications (id, user_id, type, brief_id, source_entry_id, actor_id, created_at)
     VALUES (?, 'hoarder', 'journal_mention', 'brief-1', ?, 'owner', ?)`,
  );
  const base = Date.now() - 1_000_000;
  for (let i = 0; i < 520; i++) insert.run(`bulk-${i}`, `bulk-src-${i}`, base + i);
  // Any create for this user triggers the prune.
  await postEntry(ownerSession, { body: "cap trigger @hoarder" });
  const count = db()
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'hoarder'`)
    .get() as { c: number };
  assert.equal(count.c, 500, "inbox capped at 500");
  const oldest = db()
    .prepare(`SELECT id FROM notifications WHERE id = 'bulk-0'`)
    .get();
  assert.equal(oldest, undefined, "oldest rows were the ones dropped");
  const newest = db()
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'hoarder' AND source_entry_id LIKE 'bulk-src-51%'`)
    .get() as { c: number };
  assert.ok(newest.c > 0, "newest bulk rows survive");
});

test("type-aware joins resolve the right source when a journal entry and comment share an id", async () => {
  seedUser("collide", "collide@example.com");
  seedShare("brief-1", "collide", "owner");
  const sharedId = "same-id-both-tables";
  db()
    .prepare(
      `INSERT INTO journal_entries (id, brief_id, user_id, body, created_at)
       VALUES (?, 'brief-1', 'owner', 'JOURNAL BODY', ?)`,
    )
    .run(sharedId, Date.now());
  db()
    .prepare(
      `INSERT INTO brief_comments (id, brief_id, user_id, body, ai_assisted, created_at)
       VALUES (?, 'brief-1', 'owner', 'COMMENT BODY', 0, ?)`,
    )
    .run(sharedId, Date.now());
  db()
    .prepare(
      `INSERT INTO notifications (id, user_id, type, brief_id, source_entry_id, actor_id, created_at)
       VALUES ('n-mention', 'collide', 'journal_mention', 'brief-1', ?, 'owner', ?),
              ('n-comment', 'collide', 'brief_comment', 'brief-1', ?, 'owner', ?)`,
    )
    .run(sharedId, Date.now(), sharedId, Date.now() + 1);
  const list = notif.listNotifications("collide");
  const mention = list.find((n) => n.id === "n-mention");
  const comment = list.find((n) => n.id === "n-comment");
  assert.equal(mention?.excerpt, "JOURNAL BODY");
  assert.equal(comment?.excerpt, "COMMENT BODY");
});

test("a notification whose source row no longer exists reads as deleted", async () => {
  seedUser("dangler", "dangler@example.com");
  seedShare("brief-1", "dangler", "owner");
  db()
    .prepare(
      `INSERT INTO notifications (id, user_id, type, brief_id, source_entry_id, actor_id, created_at)
       VALUES ('n-dangling', 'dangler', 'brief_comment', 'brief-1', 'no-such-row', 'owner', ?)`,
    )
    .run(Date.now());
  const n = notif.listNotifications("dangler").find((x) => x.id === "n-dangling");
  assert.ok(n);
  assert.equal(n!.entry_deleted, true, "missing source treated as deleted");
  assert.equal(n!.excerpt, null);
});

test("a notification outlives its mention: ?mentions=me omits the entry, the full feed restores it", async () => {
  // The deep-link recovery scenario: mention -> notification -> the entry is
  // edited to REMOVE the mention. The notification is durable, but the
  // server-side "Mentions me" feed no longer contains the entry — clearing
  // that filter (the state machine's clear-mentions step) must restore it.
  const post = await postEntry(ownerSession, { body: "please check this @reader" });
  const entryId = post.data.entries[0].id;
  const n = notif
    .listNotifications("reader")
    .find((x) => x.source_entry_id === entryId);
  assert.ok(n, "mention created a durable notification");

  const edit = await entryRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { body: "please check this (mention removed)" } }),
    { params: { id: "brief-1", entryId } },
  );
  assert.equal(edit.status, 200);

  // Filtered feed (what the client has loaded while "Mentions me" is on):
  // the target entry is absent — client-side widening could never find it.
  const filteredRes = await journalRoute.GET(
    makeReq({ sessionId: readerSession, query: "mentions=me" }),
    { params: { id: "brief-1" } },
  );
  const filtered = await filteredRes.json();
  assert.ok(
    !filtered.entries.some((e: any) => e.id === entryId),
    "?mentions=me omits the entry once the mention is edited away",
  );

  // Full feed (after the clear-mentions refetch): the target is back, so the
  // normal expand-root -> scroll sequence can land the deep link.
  const fullRes = await journalRoute.GET(makeReq({ sessionId: readerSession }), {
    params: { id: "brief-1" },
  });
  const full = await fullRes.json();
  assert.ok(
    full.entries.some((e: any) => e.id === entryId),
    "the unfiltered feed still contains the entry",
  );

  // And the notification itself remains listed (with the edited excerpt).
  const still = notif
    .listNotifications("reader")
    .find((x) => x.source_entry_id === entryId);
  assert.ok(still, "notification survives the mention removal");
  assert.match(still!.excerpt ?? "", /mention removed/);
});

test("notifications are scoped per-user (no cross-user leakage)", async () => {
  await postEntry(ownerSession, { body: "scoped ping @reader only" });
  const readerList = (await getNotifs(readerSession)).data;
  // Every row the API returns for reader must actually belong to reader in the DB.
  for (const n of readerList.notifications) {
    const row = db()
      .prepare(`SELECT user_id FROM notifications WHERE id = ?`)
      .get(n.id) as { user_id: string } | undefined;
    assert.equal(row?.user_id, "reader");
  }
  // owner should not see reader's notifications in their own feed
  const ownerList = (await getNotifs(ownerSession)).data;
  const readerEntryIds = new Set(readerList.notifications.map((n: any) => n.id));
  assert.ok(ownerList.notifications.every((n: any) => !readerEntryIds.has(n.id)));
});
