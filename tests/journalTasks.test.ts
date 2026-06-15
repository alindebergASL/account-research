import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "journal-tasks-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);

const dbMod = require("../web/lib/db") as typeof import("../web/lib/db");
const { db, initDb } = dbMod;
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const tasksLib = require("../web/lib/journalTasks") as typeof import("../web/lib/journalTasks");
const tasksRoute = require("../web/app/api/briefs/[id]/journal/tasks/route") as typeof import("../web/app/api/briefs/[id]/journal/tasks/route");
const taskRoute = require("../web/app/api/briefs/[id]/journal/tasks/[taskId]/route") as typeof import("../web/app/api/briefs/[id]/journal/tasks/[taskId]/route");

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
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, 'Acme', 'Tech', 'internal', ?, ?, '{}')`,
    )
    .run(id, ownerId, new Date().toISOString(), Date.now());
}

function seedShare(briefId: string, userId: string, grantedBy: string, role: "reader" | "writer") {
  db()
    .prepare(
      `INSERT INTO brief_shares (brief_id, user_id, granted_by, created_at, role)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(briefId, userId, grantedBy, Date.now(), role);
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

// --- fixture ---
seedUser("owner-1", "owner@example.com");
seedUser("reader-1", "reader@example.com");
seedUser("outsider-1", "outsider@example.com");
seedBrief("brief-1", "owner-1");
seedShare("brief-1", "reader-1", "owner-1", "reader");
const ownerSession = authMod.createSession("owner-1").id;
const readerSession = authMod.createSession("reader-1").id;
const outsiderSession = authMod.createSession("outsider-1").id;

// ----------------------- lib: hierarchy -----------------------

test("insert builds an ordered nested tree", () => {
  const a = tasksLib.insertTask({ briefId: "brief-1", body: "Parent A", createdBy: "owner-1" });
  const b = tasksLib.insertTask({ briefId: "brief-1", body: "Parent B", createdBy: "owner-1" });
  const a1 = tasksLib.insertTask({ briefId: "brief-1", parentId: a.id, body: "Child A1", createdBy: "owner-1" });

  const tree = tasksLib.listTasksForBrief("brief-1");
  // Two top-level tasks in insertion order.
  assert.deepEqual(tree.map((t) => t.body), ["Parent A", "Parent B"]);
  const parentA = tree.find((t) => t.id === a.id)!;
  assert.equal(parentA.children.length, 1);
  assert.equal(parentA.children[0].id, a1.id);
  assert.equal(tree.find((t) => t.id === b.id)!.children.length, 0);
});

test("body validation rejects empty and over-long", () => {
  assert.throws(() => tasksLib.insertTask({ briefId: "brief-1", body: "   ", createdBy: "owner-1" }), /required/);
  assert.throws(
    () => tasksLib.insertTask({ briefId: "brief-1", body: "x".repeat(tasksLib.MAX_TASK_BODY_CHARS + 1), createdBy: "owner-1" }),
    /too long/,
  );
});

test("nesting is capped at MAX_TASK_DEPTH_LEVELS", () => {
  let parentId: string | null = null;
  // Create a chain exactly MAX_TASK_DEPTH_LEVELS deep (depths 0..N-1).
  for (let d = 0; d < tasksLib.MAX_TASK_DEPTH_LEVELS; d++) {
    const t: { id: string } = tasksLib.insertTask({ briefId: "brief-1", parentId, body: `depth ${d}`, createdBy: "owner-1" });
    parentId = t.id;
  }
  // One level deeper must be refused.
  assert.throws(
    () => tasksLib.insertTask({ briefId: "brief-1", parentId, body: "too deep", createdBy: "owner-1" }),
    /nesting depth/,
  );
});

test("toggling done records and clears completion stamp", () => {
  const t = tasksLib.insertTask({ briefId: "brief-1", body: "do the thing", createdBy: "owner-1" });
  const done = tasksLib.updateTask({ briefId: "brief-1", taskId: t.id, done: true, actorUserId: "reader-1" });
  assert.equal(done.done, true);
  assert.equal(done.done_by, "reader-1");
  assert.ok(typeof done.done_at === "number");
  const undone = tasksLib.updateTask({ briefId: "brief-1", taskId: t.id, done: false, actorUserId: "reader-1" });
  assert.equal(undone.done, false);
  assert.equal(undone.done_by, null);
  assert.equal(undone.done_at, null);
});

test("move reparents, and cannot create a cycle", () => {
  const p = tasksLib.insertTask({ briefId: "brief-1", body: "movable parent", createdBy: "owner-1" });
  const c = tasksLib.insertTask({ briefId: "brief-1", parentId: p.id, body: "movable child", createdBy: "owner-1" });
  // Moving the parent under its own child is a cycle → rejected.
  assert.throws(
    () => tasksLib.moveTask({ briefId: "brief-1", taskId: p.id, parentId: c.id }),
    /descendant|own parent/,
  );
  // Promote the child to top-level.
  const moved = tasksLib.moveTask({ briefId: "brief-1", taskId: c.id, parentId: null });
  assert.equal(moved.parent_id, null);
  const top = tasksLib.listTasksForBrief("brief-1").map((t) => t.id);
  assert.ok(top.includes(c.id));
});

test("soft-delete removes the whole subtree", () => {
  const root = tasksLib.insertTask({ briefId: "brief-1", body: "subtree root", createdBy: "owner-1" });
  const child = tasksLib.insertTask({ briefId: "brief-1", parentId: root.id, body: "subtree child", createdBy: "owner-1" });
  tasksLib.insertTask({ briefId: "brief-1", parentId: child.id, body: "subtree grandchild", createdBy: "owner-1" });

  const removed = tasksLib.softDeleteTask("brief-1", root.id);
  assert.equal(removed, 3);
  const ids = new Set<string>();
  const walk = (ts: any[]) => ts.forEach((t) => { ids.add(t.id); walk(t.children); });
  walk(tasksLib.listTasksForBrief("brief-1"));
  assert.equal(ids.has(root.id), false);
  assert.equal(ids.has(child.id), false);
});

// ----------------------- routes: auth + CRUD -----------------------

test("tasks require brief access; outsiders are blocked, shared readers can participate", async () => {
  // outsider has no access at all
  const outGet = await tasksRoute.GET(makeReq({ sessionId: outsiderSession }), { params: { id: "brief-1" } });
  assert.equal(outGet.status, 404);
  const outPost = await tasksRoute.POST(
    makeReq({ sessionId: outsiderSession, body: { body: "nope" } }),
    { params: { id: "brief-1" } },
  );
  assert.equal(outPost.status, 404);

  // a shared reader participates in the journal (like entries/review-candidates)
  const readGet = await tasksRoute.GET(makeReq({ sessionId: readerSession }), { params: { id: "brief-1" } });
  assert.equal(readGet.status, 200);
  const readPost = await tasksRoute.POST(
    makeReq({ sessionId: readerSession, body: { body: "reader task" } }),
    { params: { id: "brief-1" } },
  );
  assert.equal(readPost.status, 200);
});

test("owner can create, toggle, and delete a task via routes", async () => {
  const created = await tasksRoute.POST(
    makeReq({ sessionId: ownerSession, body: { body: "route task" } }),
    { params: { id: "brief-1" } },
  );
  assert.equal(created.status, 200);
  const { task } = await created.json();
  assert.equal(task.body, "route task");
  assert.equal(task.done, false);

  const toggled = await taskRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { done: true } }),
    { params: { id: "brief-1", taskId: task.id } },
  );
  assert.equal(toggled.status, 200);
  assert.equal((await toggled.json()).task.done, true);

  const del = await taskRoute.DELETE(
    makeReq({ sessionId: ownerSession }),
    { params: { id: "brief-1", taskId: task.id } },
  );
  assert.equal(del.status, 200);
  assert.equal((await del.json()).removed, 1);
});

test("PATCH on an unknown task is 404", async () => {
  const res = await taskRoute.PATCH(
    makeReq({ sessionId: ownerSession, body: { done: true } }),
    { params: { id: "brief-1", taskId: "does-not-exist" } },
  );
  assert.equal(res.status, 404);
});
