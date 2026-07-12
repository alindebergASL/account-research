import test from "node:test";
process.env.PROVIDER_CALLS_ENABLED = "1"; // Explicitly enable only deterministic fake clients in this suite.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "strategic-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);

const dbMod = require("../web/lib/db") as typeof import("../web/lib/db");
const { db, initDb } = dbMod;
const authMod = require("../web/lib/auth") as typeof import("../web/lib/auth");
const models = require("../web/lib/models") as typeof import("../web/lib/models");
const strat = require("../web/lib/strategicAnalysis") as typeof import("../web/lib/strategicAnalysis");
const stratRoute = require("../web/app/api/admin/strategic/route") as typeof import("../web/app/api/admin/strategic/route");

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
  const briefJson = JSON.stringify({ account_name: "Acme", snapshot: "snap" });
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, 'Acme', 'Healthcare', 'internal', ?, ?, ?)`,
    )
    .run(id, ownerId, new Date().toISOString(), Date.now(), briefJson);
}

function makeReq(opts: { sessionId?: string; body?: any }): any {
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

// A stub Anthropic-compatible client that records every call.
function makeStub() {
  const stub = {
    calls: [] as Array<any>,
    messages: {
      async create(args: any) {
        stub.calls.push(args);
        return { content: [{ type: "text", text: "Strategic analysis output." }] };
      },
    },
  };
  return stub;
}

// --- fixture ---
seedUser("member-1", "member@example.com");
seedUser("admin-1", "admin2@example.com", "admin");
seedBrief("brief-1", "admin-1");
const memberSession = authMod.createSession("member-1").id;
const adminSession = authMod.createSession("admin-1").id;

// ----------------------- lib-level: gate is load-bearing -----------------------

test("runStrategicAnalysis routes to Fable only for an acknowledged admin", async () => {
  const stub = makeStub();
  const res = await strat.runStrategicAnalysis(
    { brief_json: { account_name: "Acme" }, prompt: "Where is the opportunity?" },
    { isAdmin: true, acknowledgedDataPosture: true },
    stub,
  );
  assert.equal(res.model, "claude-fable-5");
  assert.equal(res.text, "Strategic analysis output.");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].model, "claude-fable-5");
});

test("runStrategicAnalysis FAILS CLOSED for a non-admin: throws before any client call", async () => {
  const stub = makeStub();
  await assert.rejects(
    () =>
      strat.runStrategicAnalysis(
        { brief_json: { account_name: "Acme" }, prompt: "x" },
        { isAdmin: false, acknowledgedDataPosture: true },
        stub,
      ),
    (err: unknown) => {
      assert.ok(err instanceof models.AdminModelGateError);
      return true;
    },
  );
  // Critical: the model was never called — no brief data left the process.
  assert.equal(stub.calls.length, 0);
});

test("runStrategicAnalysis FAILS CLOSED when admin has not acknowledged data posture", async () => {
  const stub = makeStub();
  await assert.rejects(
    () =>
      strat.runStrategicAnalysis(
        { brief_json: { account_name: "Acme" }, prompt: "x" },
        { isAdmin: true, acknowledgedDataPosture: false },
        stub,
      ),
    (err: unknown) => {
      assert.ok(err instanceof models.AdminModelGateError);
      assert.match((err as Error).message, /acknowledgement of its data posture/);
      return true;
    },
  );
  assert.equal(stub.calls.length, 0);
});

test("strategic prompt enforces the brief input char cap", () => {
  const big = "X".repeat(50_000);
  // The embedded brief slice is bounded by the cap (+ the short truncation marker).
  const truncated = strat.truncateBriefForPrompt({ snapshot: big });
  assert.ok(truncated.endsWith("…[truncated]"));
  assert.ok(truncated.length <= strat.BRIEF_INPUT_CHAR_CAP + "\n…[truncated]".length);
  // And it flows through into the assembled system prompt.
  const { system } = strat.buildStrategicMessages({
    brief_json: { snapshot: big },
    prompt: "analyze",
  });
  assert.ok(system.includes("…[truncated]"));
});

// ----------------------- route-level: auth + ack enforcement -----------------------

test("POST /api/admin/strategic rejects non-admin sessions (403) without calling the model", async () => {
  const stub = makeStub();
  strat.__setTestStrategicClient(stub);
  try {
    const res = await stratRoute.POST(
      makeReq({
        sessionId: memberSession,
        body: { briefId: "brief-1", prompt: "x", acknowledgeDataPosture: true },
      }),
    );
    assert.equal(res.status, 403);
    assert.equal(stub.calls.length, 0);
  } finally {
    strat.__setTestStrategicClient(null);
  }
});

test("POST /api/admin/strategic: admin WITHOUT acknowledgement is refused by the gate (403)", async () => {
  const stub = makeStub();
  strat.__setTestStrategicClient(stub);
  try {
    const res = await stratRoute.POST(
      makeReq({
        sessionId: adminSession,
        body: { briefId: "brief-1", prompt: "x" }, // no acknowledgeDataPosture
      }),
    );
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.ok(Array.isArray(data.reasons) && data.reasons.length >= 1);
    // The gate, not route auth, blocked this — and Fable was never called.
    assert.equal(stub.calls.length, 0);
  } finally {
    strat.__setTestStrategicClient(null);
  }
});

test("POST /api/admin/strategic: acknowledged admin gets analysis from Fable (200)", async () => {
  const stub = makeStub();
  strat.__setTestStrategicClient(stub);
  try {
    const res = await stratRoute.POST(
      makeReq({
        sessionId: adminSession,
        body: { briefId: "brief-1", prompt: "Where is the opportunity?", acknowledgeDataPosture: true },
      }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.model, "claude-fable-5");
    assert.equal(data.text, "Strategic analysis output.");
    assert.equal(stub.calls.length, 1);
  } finally {
    strat.__setTestStrategicClient(null);
  }
});

test("POST /api/admin/strategic: missing briefId is 400, unknown briefId is 404", async () => {
  const stub = makeStub();
  strat.__setTestStrategicClient(stub);
  try {
    const noId = await stratRoute.POST(
      makeReq({ sessionId: adminSession, body: { acknowledgeDataPosture: true } }),
    );
    assert.equal(noId.status, 400);

    const badId = await stratRoute.POST(
      makeReq({
        sessionId: adminSession,
        body: { briefId: "nope", acknowledgeDataPosture: true },
      }),
    );
    assert.equal(badId.status, 404);
    assert.equal(stub.calls.length, 0);
  } finally {
    strat.__setTestStrategicClient(null);
  }
});
