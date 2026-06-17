import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "journal-mention-notify-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db, initDb } = require("../web/lib/db") as typeof import("../web/lib/db");
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const emailMod = require("../web/lib/email") as typeof import("../web/lib/email");
const notifyMod = require("../web/lib/journalMentionNotifications") as typeof import("../web/lib/journalMentionNotifications");
const journalRoute = require("../web/app/api/briefs/[id]/journal/route") as typeof import("../web/app/api/briefs/[id]/journal/route");
const entryRoute = require("../web/app/api/briefs/[id]/journal/[entryId]/route") as typeof import("../web/app/api/briefs/[id]/journal/[entryId]/route");

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
function setEmailPref(userId: string, enabled: boolean) {
  db()
    .prepare(`UPDATE users SET email_notifications_enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, userId);
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

type SentMail = { to: string; subject: string; text: string; html: string };
function installMailerStub(): { sent: SentMail[] } {
  const sent: SentMail[] = [];
  emailMod.__setTestMailer(async (args) => {
    sent.push({ to: args.to, subject: args.subject, text: args.text, html: args.html });
  });
  return { sent };
}
async function flushNotify() {
  const p = notifyMod.__getLastNotifyPromise();
  if (p) await p;
}

seedUser("owner", "owner@example.com");
seedUser("reader", "reader@example.com");
seedUser("opted-out", "muted@example.com");
seedUser("third", "third@example.com");
seedUser("outsider", "outsider@example.com");
seedBrief("brief-1", "owner");
seedShare("brief-1", "reader", "owner");
seedShare("brief-1", "opted-out", "owner");
seedShare("brief-1", "third", "owner");
setEmailPref("opted-out", false);

const ownerSession = authMod.createSession("owner").id;

test("mentioning a member emails them once; author is never self-notified", async () => {
  const { sent } = installMailerStub();
  try {
    const res = await journalRoute.POST(
      makeReq({ sessionId: ownerSession, body: { body: "heads up @reader and @owner" } }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
    await flushNotify();
    assert.equal(sent.length, 1, "only the mentioned non-author is emailed");
    assert.equal(sent[0].to, "reader@example.com");
    assert.match(sent[0].subject, /mentioned you/);
    assert.ok(sent[0].text.includes("heads up @reader"));
    assert.match(sent[0].html, /#journal-entry-/);
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("mentioning several members fans out one email each", async () => {
  const { sent } = installMailerStub();
  try {
    await journalRoute.POST(
      makeReq({ sessionId: ownerSession, body: { body: "sync @reader @third" } }),
      { params: { id: "brief-1" } },
    );
    await flushNotify();
    assert.deepEqual(sent.map((m) => m.to).sort(), ["reader@example.com", "third@example.com"]);
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("a mentioned member who disabled email notifications gets nothing", async () => {
  const { sent } = installMailerStub();
  try {
    await journalRoute.POST(
      makeReq({ sessionId: ownerSession, body: { body: "fyi @muted" } }),
      { params: { id: "brief-1" } },
    );
    await flushNotify();
    assert.equal(sent.length, 0);
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("mentioning a non-member sends nothing (never resolves)", async () => {
  const { sent } = installMailerStub();
  try {
    await journalRoute.POST(
      makeReq({ sessionId: ownerSession, body: { body: "cc @outsider" } }),
      { params: { id: "brief-1" } },
    );
    await flushNotify();
    assert.equal(sent.length, 0);
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("editing to add a mention notifies only the newly added member", async () => {
  // Post mentioning reader; reader is emailed.
  const post = await journalRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "draft @reader" } }),
    { params: { id: "brief-1" } },
  );
  const id = (await post.json()).entries[0].id;
  await flushNotify();

  const { sent } = installMailerStub();
  try {
    // Edit keeps reader and adds third — only third should be notified.
    const edit = await entryRoute.PATCH(
      makeReq({ sessionId: ownerSession, body: { body: "draft @reader @third" } }),
      { params: { id: "brief-1", entryId: id } },
    );
    assert.equal(edit.status, 200);
    await flushNotify();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "third@example.com");
  } finally {
    emailMod.__setTestMailer(null);
  }
});
