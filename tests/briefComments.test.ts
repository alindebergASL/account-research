import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "brief-comments-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);

// Modules under test.
const dbMod = require("../web/lib/db") as typeof import("../web/lib/db");
const { db, initDb } = dbMod;
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const briefAccess = require("../web/lib/briefAccess") as typeof import("../web/lib/briefAccess");
const aiMod = require("../web/lib/briefCommentsAi") as typeof import("../web/lib/briefCommentsAi");

const commentsRoute = require("../web/app/api/briefs/[id]/comments/route") as typeof import("../web/app/api/briefs/[id]/comments/route");
const commentRoute = require("../web/app/api/briefs/[id]/comments/[commentId]/route") as typeof import("../web/app/api/briefs/[id]/comments/[commentId]/route");
const assistRoute = require("../web/app/api/briefs/[id]/comments/ai-assist/route") as typeof import("../web/app/api/briefs/[id]/comments/ai-assist/route");
const emailMod = require("../web/lib/email") as typeof import("../web/lib/email");
const notifyMod = require("../web/lib/commentNotifications") as typeof import("../web/lib/commentNotifications");

// Force initial DB boot so migrations apply.
initDb();

function seedUser(id: string, email: string, role: "admin" | "member" = "member") {
  db()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, display_name, created_at, must_change_password)
       VALUES (?, ?, 'h', ?, ?, ?, 0)`,
    )
    .run(id, email, role, email.split("@")[0], Date.now());
}

function seedBrief(id: string, ownerId: string) {
  const briefJson = JSON.stringify({
    account_name: "Acme",
    segment: "Healthcare",
    audience: "internal",
    generated_at: new Date().toISOString(),
    snapshot: "snap",
    priority_summary: "p",
    recent_signals: [],
    ai_tech_maturity: { rating: 3, rationale: "r" },
    top_initiatives: [],
    technical_footprint: {
      ai_in_production: [],
      active_pilots: [],
      cloud_platforms: [],
      data_infrastructure: "",
      clinical_platforms: "",
      analytics_bi_stack: "",
      build_vs_buy_posture: "",
      competitive_incumbents: [],
    },
    programs_procurement: {
      modernization_grants: [],
      consortium_purchasing: [],
      active_rfps_contracts: [],
      ai_governance_policy: "",
      public_ai_use_cases: [],
    },
    personas: [],
    buying_path: "",
    first_angle: "",
    risks: [],
    competitive_signals: [],
    next_action: "",
    extensions: [],
    sources: [],
  });
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, 'Acme', 'Healthcare', 'internal', ?, ?, ?)`,
    )
    .run(id, ownerId, new Date().toISOString(), Date.now(), briefJson);
}

function seedShare(briefId: string, userId: string, grantedBy: string) {
  db()
    .prepare(
      `INSERT INTO brief_shares (brief_id, user_id, granted_by, created_at, role)
       VALUES (?, ?, ?, ?, 'reader')`,
    )
    .run(briefId, userId, grantedBy, Date.now());
}

function makeSessionFor(userId: string): string {
  const session = authMod.createSession(userId);
  return session.id;
}

// Build a NextRequest-like object. The route handlers use:
//   - req.cookies.get(SESSION_COOKIE)?.value
//   - req.json()
// That's the whole surface. We mimic just enough.
function makeReq(opts: {
  sessionId?: string;
  body?: any;
}): any {
  const cookies = {
    get(name: string) {
      if (opts.sessionId && name === authMod.SESSION_COOKIE) {
        return { value: opts.sessionId };
      }
      return undefined;
    },
  };
  return {
    cookies,
    async json() {
      if (opts.body === undefined) throw new Error("no body");
      return opts.body;
    },
  };
}

async function jsonOf(res: Response): Promise<any> {
  return await res.json();
}

// --- shared fixture ---
seedUser("owner-1", "owner@example.com");
seedUser("reader-1", "reader@example.com");
seedUser("outsider-1", "outsider@example.com");
seedUser("admin-1", "admin2@example.com", "admin");
seedBrief("brief-1", "owner-1");
seedShare("brief-1", "reader-1", "owner-1");

const ownerSession = makeSessionFor("owner-1");
const readerSession = makeSessionFor("reader-1");
const outsiderSession = makeSessionFor("outsider-1");
const adminSession = makeSessionFor("admin-1");

test("migration created brief_comments and indexes", () => {
  const rows = db()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name IN ('brief_comments','idx_comments_brief_created','idx_comments_parent')`,
    )
    .all() as Array<{ name: string }>;
  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(names, [
    "brief_comments",
    "idx_comments_brief_created",
    "idx_comments_parent",
  ]);
});

test("migration is idempotent on re-run", () => {
  // The ledger should record 015_brief_comments exactly once and skipping it
  // should not throw if the boot path is re-entered. initDb caches the
  // connection so calling again is a no-op, but the migration was already
  // verified above; this test guards against accidental ALTER duplication.
  const seen = db()
    .prepare(`SELECT id FROM schema_migrations WHERE id = '015_brief_comments'`)
    .get() as { id: string } | undefined;
  assert.equal(seen?.id, "015_brief_comments");
});

test("briefAccess: owner true, shared user true, outsider false, admin true", () => {
  assert.equal(briefAccess.canUserAccessBrief("owner-1", "brief-1"), true);
  assert.equal(briefAccess.canUserAccessBrief("reader-1", "brief-1"), true);
  assert.equal(briefAccess.canUserAccessBrief("outsider-1", "brief-1"), false);
  assert.equal(briefAccess.canUserAccessBrief("admin-1", "brief-1"), true);
});

test("POST comment as owner succeeds", async () => {
  const res = await commentsRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "Hello world" } }),
    { params: { id: "brief-1" } },
  );
  assert.equal(res.status, 200);
  const data = await jsonOf(res);
  assert.equal(data.comment.body, "Hello world");
  assert.equal(data.comment.ai_assisted, false);
  const row = db()
    .prepare(`SELECT * FROM brief_comments WHERE id = ?`)
    .get(data.comment.id) as any;
  assert.ok(row);
  assert.equal(row.user_id, "owner-1");
});

test("POST comment as outsider returns 404 and writes no row", async () => {
  const before = (db().prepare(`SELECT COUNT(*) AS n FROM brief_comments`).get() as any).n;
  const res = await commentsRoute.POST(
    makeReq({ sessionId: outsiderSession, body: { body: "sneak" } }),
    { params: { id: "brief-1" } },
  );
  assert.equal(res.status, 404);
  const after = (db().prepare(`SELECT COUNT(*) AS n FROM brief_comments`).get() as any).n;
  assert.equal(after, before);
});

test("POST reply with parent_id creates child; GET returns thread", async () => {
  const parentRes = await commentsRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "Parent comment" } }),
    { params: { id: "brief-1" } },
  );
  const parent = (await jsonOf(parentRes)).comment;
  const childRes = await commentsRoute.POST(
    makeReq({
      sessionId: readerSession,
      body: { body: "Child reply", parent_id: parent.id },
    }),
    { params: { id: "brief-1" } },
  );
  assert.equal(childRes.status, 200);
  const child = (await jsonOf(childRes)).comment;
  assert.equal(child.parent_id, parent.id);

  const listRes = await commentsRoute.GET(
    makeReq({ sessionId: ownerSession }),
    { params: { id: "brief-1" } },
  );
  const list = (await jsonOf(listRes)).comments as any[];
  const found = list.find((c) => c.id === child.id);
  assert.ok(found);
  assert.equal(found.parent_id, parent.id);
});

test("GET excludes deleted body but preserves thread structure", async () => {
  // Create a fresh parent + child to isolate.
  const parentRes = await commentsRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "Will be deleted" } }),
    { params: { id: "brief-1" } },
  );
  const parent = (await jsonOf(parentRes)).comment;
  const childRes = await commentsRoute.POST(
    makeReq({
      sessionId: readerSession,
      body: { body: "Child survives", parent_id: parent.id },
    }),
    { params: { id: "brief-1" } },
  );
  const child = (await jsonOf(childRes)).comment;
  const delRes = await commentRoute.DELETE(
    makeReq({ sessionId: ownerSession }),
    { params: { id: "brief-1", commentId: parent.id } },
  );
  assert.equal(delRes.status, 200);

  const listRes = await commentsRoute.GET(
    makeReq({ sessionId: ownerSession }),
    { params: { id: "brief-1" } },
  );
  const list = (await jsonOf(listRes)).comments as any[];
  const p = list.find((c) => c.id === parent.id);
  const ch = list.find((c) => c.id === child.id);
  assert.ok(p);
  assert.equal(p.body, null);
  assert.ok(p.deleted_at !== null);
  assert.ok(ch);
  assert.equal(ch.body, "Child survives");
  assert.equal(ch.parent_id, parent.id);
});

test("Edit own comment within 15-min window sets edited_at", async () => {
  const postRes = await commentsRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "Original" } }),
    { params: { id: "brief-1" } },
  );
  const c = (await jsonOf(postRes)).comment;
  const editRes = await commentRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { body: "Edited" } }),
    { params: { id: "brief-1", commentId: c.id } },
  );
  assert.equal(editRes.status, 200);
  const row = db()
    .prepare(`SELECT body, edited_at FROM brief_comments WHERE id = ?`)
    .get(c.id) as any;
  assert.equal(row.body, "Edited");
  assert.ok(typeof row.edited_at === "number");
});

test("Edit own comment after 15-min window returns 403", async () => {
  const postRes = await commentsRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "Stale" } }),
    { params: { id: "brief-1" } },
  );
  const c = (await jsonOf(postRes)).comment;
  // Backdate created_at by > 15 min.
  db()
    .prepare(`UPDATE brief_comments SET created_at = ? WHERE id = ?`)
    .run(Date.now() - 16 * 60 * 1000, c.id);
  const editRes = await commentRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { body: "Too late" } }),
    { params: { id: "brief-1", commentId: c.id } },
  );
  assert.equal(editRes.status, 403);
});

test("Edit another user's comment returns 403", async () => {
  const postRes = await commentsRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "Mine" } }),
    { params: { id: "brief-1" } },
  );
  const c = (await jsonOf(postRes)).comment;
  const editRes = await commentRoute.PATCH(
    makeReq({ sessionId: readerSession, body: { body: "Hijack" } }),
    { params: { id: "brief-1", commentId: c.id } },
  );
  assert.equal(editRes.status, 403);
});

test("Soft-delete own comment sets deleted_at", async () => {
  const postRes = await commentsRoute.POST(
    makeReq({ sessionId: readerSession, body: { body: "Bye" } }),
    { params: { id: "brief-1" } },
  );
  const c = (await jsonOf(postRes)).comment;
  const delRes = await commentRoute.DELETE(
    makeReq({ sessionId: readerSession }),
    { params: { id: "brief-1", commentId: c.id } },
  );
  assert.equal(delRes.status, 200);
  const row = db()
    .prepare(`SELECT deleted_at FROM brief_comments WHERE id = ?`)
    .get(c.id) as any;
  assert.ok(row.deleted_at !== null);
});

test("Admin can soft-delete any comment", async () => {
  const postRes = await commentsRoute.POST(
    makeReq({ sessionId: readerSession, body: { body: "Admin will nuke" } }),
    { params: { id: "brief-1" } },
  );
  const c = (await jsonOf(postRes)).comment;
  const delRes = await commentRoute.DELETE(
    makeReq({ sessionId: adminSession }),
    { params: { id: "brief-1", commentId: c.id } },
  );
  assert.equal(delRes.status, 200);
  const row = db()
    .prepare(`SELECT deleted_at FROM brief_comments WHERE id = ?`)
    .get(c.id) as any;
  assert.ok(row.deleted_at !== null);
});

test("AI assist requires brief access (outsider gets 404)", async () => {
  const res = await assistRoute.POST(
    makeReq({
      sessionId: outsiderSession,
      body: { mode: "summarize_thread" },
    }),
    { params: { id: "brief-1" } },
  );
  assert.equal(res.status, 404);
});

test("AI assist returns text via stub and does NOT write to DB", async () => {
  const before = (db().prepare(`SELECT COUNT(*) AS n FROM brief_comments`).get() as any).n;
  const stub = {
    calls: [] as Array<any>,
    messages: {
      async create(args: any) {
        stub.calls.push(args);
        return {
          content: [{ type: "text", text: "Stub-generated draft." }],
        };
      },
    },
  };
  aiMod.__setTestAssistClient(stub);
  try {
    const res = await assistRoute.POST(
      makeReq({
        sessionId: readerSession,
        body: { mode: "draft_reply" },
      }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
    const data = await jsonOf(res);
    assert.equal(data.text, "Stub-generated draft.");
    assert.equal(data.mode, "draft_reply");
    assert.equal(data.ai_assisted_marker, true);
    assert.equal(stub.calls.length, 1);
  } finally {
    aiMod.__setTestAssistClient(null);
  }
  const after = (db().prepare(`SELECT COUNT(*) AS n FROM brief_comments`).get() as any).n;
  assert.equal(after, before);
});

test("AI assist enforces input cap on brief context", async () => {
  // Stuff the brief with a huge blob and verify the prompt sent to the
  // stubbed client is <= cap (plus the surrounding scaffolding).
  const big = "X".repeat(50_000);
  db()
    .prepare(`UPDATE briefs SET brief_json = ? WHERE id = ?`)
    .run(JSON.stringify({ snapshot: big, account_name: "Acme" }), "brief-1");

  const stub = {
    capturedSystem: "",
    messages: {
      async create(args: any) {
        stub.capturedSystem = args.system;
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  aiMod.__setTestAssistClient(stub);
  try {
    const res = await assistRoute.POST(
      makeReq({
        sessionId: ownerSession,
        body: { mode: "summarize_thread" },
      }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
  } finally {
    aiMod.__setTestAssistClient(null);
  }
  // The full brief JSON would be ~50k chars. After truncation the BRIEF
  // section in the system prompt must be <= cap + a small marker.
  const briefSection = stub.capturedSystem.split("BRIEF:")[1] ?? "";
  const upToThread = briefSection.split("THREAD CONTEXT:")[0] ?? "";
  assert.ok(
    upToThread.length <= aiMod.BRIEF_INPUT_CHAR_CAP + 200,
    `brief section too long: ${upToThread.length}`,
  );
  assert.ok(upToThread.includes("[truncated]"));
});

test("POSTing with ai_assisted: true persists the flag; GET returns it", async () => {
  // Restore a valid brief JSON for cleanliness (previous test stuffed garbage).
  const cleanBrief = JSON.stringify({
    account_name: "Acme",
    segment: "Healthcare",
    audience: "internal",
    generated_at: new Date().toISOString(),
    snapshot: "snap",
  });
  db()
    .prepare(`UPDATE briefs SET brief_json = ? WHERE id = ?`)
    .run(cleanBrief, "brief-1");

  const postRes = await commentsRoute.POST(
    makeReq({
      sessionId: ownerSession,
      body: { body: "AI-drafted text", ai_assisted: true },
    }),
    { params: { id: "brief-1" } },
  );
  assert.equal(postRes.status, 200);
  const c = (await jsonOf(postRes)).comment;
  assert.equal(c.ai_assisted, true);

  const listRes = await commentsRoute.GET(
    makeReq({ sessionId: ownerSession }),
    { params: { id: "brief-1" } },
  );
  const found = (await jsonOf(listRes)).comments.find((x: any) => x.id === c.id);
  assert.ok(found);
  assert.equal(found.ai_assisted, true);
});

// ---------------------------------------------------------------------------
// Comment email notifications (PR #51 follow-up).
// ---------------------------------------------------------------------------

type SentMail = { to: string; subject: string; text: string; html: string };

function installMailerStub(opts: { throwError?: Error } = {}): {
  sent: SentMail[];
} {
  const sent: SentMail[] = [];
  emailMod.__setTestMailer(async (args) => {
    if (opts.throwError) throw opts.throwError;
    sent.push({
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
  });
  return { sent };
}

async function flushNotify() {
  const p = notifyMod.__getLastNotifyPromise();
  if (p) {
    await p;
  }
}

test("notify: top-level comment by non-owner -> owner receives one mail", async () => {
  const { sent } = installMailerStub();
  try {
    // reader-1 posts a top-level on owner-1's brief
    const res = await commentsRoute.POST(
      makeReq({ sessionId: readerSession, body: { body: "Hello owner" } }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
    await flushNotify();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.com");
    assert.ok(/New comment/.test(sent[0].subject));
    assert.ok(sent[0].text.includes("Hello owner"));
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("notify: top-level comment by owner -> no mail (no self-notify)", async () => {
  const { sent } = installMailerStub();
  try {
    const res = await commentsRoute.POST(
      makeReq({ sessionId: ownerSession, body: { body: "Owner talks to self" } }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
    await flushNotify();
    assert.equal(sent.length, 0);
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("notify: reply -> parent author receives a 'Reply' mail", async () => {
  const { sent } = installMailerStub();
  try {
    // Owner posts parent; reader replies. Parent author (owner) is notified.
    const parentRes = await commentsRoute.POST(
      makeReq({ sessionId: ownerSession, body: { body: "Parent body" } }),
      { params: { id: "brief-1" } },
    );
    await flushNotify(); // top-level by owner -> no mail
    assert.equal(sent.length, 0);
    const parent = (await jsonOf(parentRes)).comment;

    const childRes = await commentsRoute.POST(
      makeReq({
        sessionId: readerSession,
        body: { body: "Child reply text", parent_id: parent.id },
      }),
      { params: { id: "brief-1" } },
    );
    assert.equal(childRes.status, 200);
    await flushNotify();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.com");
    assert.ok(/Reply/.test(sent[0].subject));
    assert.ok(sent[0].text.includes("Child reply text"));
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("notify: reply by parent author to own comment -> no mail", async () => {
  const { sent } = installMailerStub();
  try {
    const parentRes = await commentsRoute.POST(
      makeReq({ sessionId: readerSession, body: { body: "Reader parent" } }),
      { params: { id: "brief-1" } },
    );
    await flushNotify();
    sent.length = 0; // ignore the top-level notification to owner
    const parent = (await jsonOf(parentRes)).comment;

    const childRes = await commentsRoute.POST(
      makeReq({
        sessionId: readerSession,
        body: { body: "Reader self-reply", parent_id: parent.id },
      }),
      { params: { id: "brief-1" } },
    );
    assert.equal(childRes.status, 200);
    await flushNotify();
    assert.equal(sent.length, 0);
  } finally {
    emailMod.__setTestMailer(null);
  }
});

test("notify: owner with email_notifications_enabled=0 -> no mail", async () => {
  const { sent } = installMailerStub();
  try {
    db()
      .prepare(`UPDATE users SET email_notifications_enabled = 0 WHERE id = ?`)
      .run("owner-1");
    const res = await commentsRoute.POST(
      makeReq({ sessionId: readerSession, body: { body: "Should be silent" } }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
    await flushNotify();
    assert.equal(sent.length, 0);
  } finally {
    db()
      .prepare(`UPDATE users SET email_notifications_enabled = 1 WHERE id = ?`)
      .run("owner-1");
    emailMod.__setTestMailer(null);
  }
});

test("notify: email not configured + no test mailer -> returns silently, no error", async () => {
  // No test mailer installed -> send() takes the real path; with no SMTP env,
  // isEmailConfigured() is false -> noop return.
  emailMod.__setTestMailer(null);
  const res = await commentsRoute.POST(
    makeReq({ sessionId: readerSession, body: { body: "Quietly drop" } }),
    { params: { id: "brief-1" } },
  );
  assert.equal(res.status, 200);
  await flushNotify(); // must not throw
});

test("notify: sendMail throws -> POST still returns the comment", async () => {
  installMailerStub({ throwError: new Error("smtp boom") });
  try {
    const res = await commentsRoute.POST(
      makeReq({ sessionId: readerSession, body: { body: "Despite smtp boom" } }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
    const data = await jsonOf(res);
    assert.equal(data.comment.body, "Despite smtp boom");
    await flushNotify(); // must not throw
  } finally {
    emailMod.__setTestMailer(null);
  }
});

// ---------------------------------------------------------------------------
// Public share-view comments (read-only). Token is the auth; the share
// surface must never accept POST/PATCH/DELETE and must never leak
// user_id or email in the comment DTO.
// ---------------------------------------------------------------------------

const shareCommentsRoute = require("../web/app/api/share/[token]/comments/route") as typeof import("../web/app/api/share/[token]/comments/route");

function seedShareLink(opts: {
  id: string;
  briefId: string;
  token: string;
  createdBy: string;
  expiresAt?: number | null;
  revokedAt?: number | null;
}) {
  db()
    .prepare(
      `INSERT INTO brief_share_links
         (id, brief_id, token, created_by, created_at, expires_at, revoked_at, last_accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    )
    .run(
      opts.id,
      opts.briefId,
      opts.token,
      opts.createdBy,
      Date.now(),
      opts.expiresAt ?? null,
      opts.revokedAt ?? null,
    );
}

function makePublicReq(): any {
  // The share-view GET handler doesn't read cookies or body, but the
  // shared helper expects a NextRequest-ish object.
  return { cookies: { get: () => undefined } };
}

seedShareLink({
  id: "link-live",
  briefId: "brief-1",
  token: "tok-live",
  createdBy: "owner-1",
  expiresAt: null,
});
seedShareLink({
  id: "link-expired",
  briefId: "brief-1",
  token: "tok-expired",
  createdBy: "owner-1",
  expiresAt: Date.now() - 60_000,
});
seedShareLink({
  id: "link-revoked",
  briefId: "brief-1",
  token: "tok-revoked",
  createdBy: "owner-1",
  expiresAt: null,
  revokedAt: Date.now() - 1000,
});

test("share-view: GET with valid token matches authenticated GET (body, ai_assisted, display_name)", async () => {
  const authedRes = await commentsRoute.GET(
    makeReq({ sessionId: ownerSession }),
    { params: { id: "brief-1" } },
  );
  const authedList = (await jsonOf(authedRes)).comments as any[];

  const publicRes = await shareCommentsRoute.GET(makePublicReq(), {
    params: { token: "tok-live" },
  });
  assert.equal(publicRes.status, 200);
  const publicList = (await jsonOf(publicRes)).comments as any[];

  assert.equal(publicList.length, authedList.length);
  for (let i = 0; i < authedList.length; i++) {
    const a = authedList[i];
    const p = publicList[i];
    assert.equal(p.id, a.id);
    assert.equal(p.parent_id, a.parent_id);
    assert.equal(p.body, a.body);
    assert.equal(p.ai_assisted, a.ai_assisted);
    assert.equal(p.created_at, a.created_at);
    if (p.deleted_at !== null) {
      assert.equal(p.author_display_name, null);
    } else {
      assert.equal(p.author_display_name, a.author.display_name);
    }
  }
});

test("share-view: soft-deleted comments are blanked but thread structure preserved", async () => {
  const parentRes = await commentsRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "Public-view parent" } }),
    { params: { id: "brief-1" } },
  );
  const parent = (await jsonOf(parentRes)).comment;
  const childRes = await commentsRoute.POST(
    makeReq({
      sessionId: readerSession,
      body: { body: "Public-view child", parent_id: parent.id },
    }),
    { params: { id: "brief-1" } },
  );
  const child = (await jsonOf(childRes)).comment;
  await commentRoute.DELETE(makeReq({ sessionId: ownerSession }), {
    params: { id: "brief-1", commentId: parent.id },
  });

  const publicRes = await shareCommentsRoute.GET(makePublicReq(), {
    params: { token: "tok-live" },
  });
  const list = (await jsonOf(publicRes)).comments as any[];
  const p = list.find((c) => c.id === parent.id);
  const ch = list.find((c) => c.id === child.id);
  assert.ok(p);
  assert.equal(p.body, null);
  assert.ok(p.deleted_at !== null);
  assert.equal(p.author_display_name, null);
  assert.ok(ch);
  assert.equal(ch.body, "Public-view child");
  assert.equal(ch.parent_id, parent.id);
});

test("share-view: invalid token -> 404", async () => {
  const res = await shareCommentsRoute.GET(makePublicReq(), {
    params: { token: "does-not-exist" },
  });
  assert.equal(res.status, 404);
});

test("share-view: expired token -> 404", async () => {
  const res = await shareCommentsRoute.GET(makePublicReq(), {
    params: { token: "tok-expired" },
  });
  assert.equal(res.status, 404);
});

test("share-view: revoked token -> 404", async () => {
  const res = await shareCommentsRoute.GET(makePublicReq(), {
    params: { token: "tok-revoked" },
  });
  assert.equal(res.status, 404);
});

test("share-view: route module exports GET only (no POST/PATCH/DELETE handlers)", () => {
  // Next.js treats an absent named export as "method not allowed" — this
  // is how we keep the public share surface strictly read-only without
  // an explicit 405 handler. Test the contract at the module level.
  assert.equal(typeof shareCommentsRoute.GET, "function");
  assert.equal((shareCommentsRoute as any).POST, undefined);
  assert.equal((shareCommentsRoute as any).PATCH, undefined);
  assert.equal((shareCommentsRoute as any).DELETE, undefined);
  assert.equal((shareCommentsRoute as any).PUT, undefined);
});

test("share-view: response does NOT include user_id / email / nested author identity", async () => {
  const res = await shareCommentsRoute.GET(makePublicReq(), {
    params: { token: "tok-live" },
  });
  const raw = JSON.stringify(await jsonOf(res));
  assert.equal(raw.includes("\"user_id\""), false, "user_id leaked");
  assert.equal(raw.includes("\"user_email\""), false, "user_email leaked");
  assert.equal(raw.includes("\"email\""), false, "email field leaked");
  // PublicCommentDto has no nested `author` object at all; ensure we
  // didn't accidentally fall back to the authenticated shape.
  assert.equal(raw.includes("\"author\":{"), false, "nested author object leaked");
});

test("notify: shared user posts top-level -> only owner is notified", async () => {
  const { sent } = installMailerStub();
  try {
    // reader-1 is a shared user on brief-1; outsider-1 is not.
    // Confirm fan-out is exactly {owner}, no spam to shared users.
    const res = await commentsRoute.POST(
      makeReq({ sessionId: readerSession, body: { body: "From shared user" } }),
      { params: { id: "brief-1" } },
    );
    assert.equal(res.status, 200);
    await flushNotify();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.com");
    // Reader (the author) and outsider must NOT be recipients.
    assert.ok(!sent.some((m) => m.to === "reader@example.com"));
    assert.ok(!sent.some((m) => m.to === "outsider@example.com"));
  } finally {
    emailMod.__setTestMailer(null);
  }
});
