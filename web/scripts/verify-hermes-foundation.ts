// Local verification for the PR-1 Hermes foundation.
//
// Proves end-to-end (no model spend, no network):
//   1. migration 013 applies cleanly against a fresh sqlite file
//   2. a Hermes "fake" job + three ordered events round-trip through
//      `createHermesJob` / `appendHermesEvent`
//   3. seq numbering is contiguous (1/2/3) per job
//   4. canvas_states upsert returns version=1 on first save
//   5. nothing token-shaped ever lands in the persisted payloads
//
// Run via `npm run verify:hermes-foundation`. Exit code is 0 on success
// and non-zero on any assertion failure.
// IMPORTANT: env mutation must happen before any `lib/db` import. ESM
// hoists imports above top-level statements regardless of textual
// position, so we use a tiny boot module loaded via `require` so the
// env is set before db.ts evaluates `process.env.BRIEF_DB_PATH`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (!process.env.BRIEF_DB_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abb-hermes-verify-"));
  process.env.BRIEF_DB_PATH = path.join(tmpDir, "verify.sqlite");
}
if (!process.env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = "verify-hermes@example.com";
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = "VerifyTempPass123!";
process.env.HERMES_RUNTIME_FAKE = "1";
delete process.env.HERMES_RUNTIME_ENABLED;

// Use require() so module evaluation happens AFTER the env block above.
// `tsx` compiles this to CJS-style require for `.ts` siblings.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db, initDb } = require("../lib/db") as typeof import("../lib/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  appendHermesEvent,
  createHermesJob,
  listHermesEventsForBrief,
  listHermesEventsForJob,
} = require("../lib/hermes/events") as typeof import("../lib/hermes/events");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saveCanvasState, getCanvasState } =
  require("../lib/canvas/state") as typeof import("../lib/canvas/state");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    // eslint-disable-next-line no-console
    console.error(`assertion failed: ${msg}`);
    process.exit(2);
  }
}

function main() {
  initDb();
  const conn = db();

  const userId = "verify-hermes-foundation-user";
  const briefId = "verify-hermes-foundation-brief";
  const now = Date.now();

  // Idempotent: rerunning the script against the same temp DB shouldn't
  // crash on a unique-violation.
  const existingUser = conn
    .prepare(`SELECT 1 AS x FROM users WHERE id = ?`)
    .get(userId) as { x: number } | undefined;
  if (!existingUser) {
    conn
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, display_name, created_at)
         VALUES (?, ?, 'scrypt$N=1$x$y', 'member', ?, ?)`,
      )
      .run(userId, `verify-${randomUUID()}@example.com`, "verify-hermes", now);
  }
  const existingBrief = conn
    .prepare(`SELECT 1 AS x FROM briefs WHERE id = ?`)
    .get(briefId) as { x: number } | undefined;
  if (!existingBrief) {
    conn
      .prepare(
        `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
         VALUES (?, ?, 'Verify Hermes Foundation', 'lab', 'internal', '1970-01-01', ?, '{}')`,
      )
      .run(briefId, userId, now);
  }

  const jobId = createHermesJob({
    kind: "research",
    user_id: userId,
    brief_id: briefId,
    fake: true,
    status: "running",
  });
  assert(typeof jobId === "string" && jobId.length > 0, "jobId returned");

  // Append three ordered events. Include a payload that contains
  // token-shaped strings + a forbidden key so we can assert sanitization
  // actually happened on the persisted row.
  appendHermesEvent({
    job_id: jobId,
    brief_id: briefId,
    kind: "job.started",
    title: "fake research started",
  });
  appendHermesEvent({
    job_id: jobId,
    brief_id: briefId,
    kind: "canvas.widget.created",
    title: "fake widget created",
    payload: {
      widget_kind: "metric",
      // These MUST be scrubbed before write:
      authorization: "Bearer abcdef0123456789",
      headers: { cookie: "session=should-not-persist" },
      raw: "Authorization: Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    },
  });
  appendHermesEvent({
    job_id: jobId,
    brief_id: briefId,
    kind: "job.completed",
    title: "fake research completed",
  });

  const jobEvents = listHermesEventsForJob(jobId);
  assert(jobEvents.length === 3, `expected 3 events, got ${jobEvents.length}`);
  assert(jobEvents[0].seq === 1, "first event seq is 1");
  assert(jobEvents[1].seq === 2, "second event seq is 2");
  assert(jobEvents[2].seq === 3, "third event seq is 3");

  const briefEvents = listHermesEventsForBrief(briefId, { limit: 50 });
  assert(briefEvents.length === 3, "listHermesEventsForBrief returns 3");

  // Sanitization: no event payload (as serialized JSON) should contain
  // anything token-shaped. Check the raw on-disk JSON too.
  const tokenRe = /Bearer\s+[A-Za-z0-9._\-]+|sk-[A-Za-z0-9\-_]{20,}|Cookie:|session=should-not-persist/i;
  for (const ev of briefEvents) {
    const blob = JSON.stringify(ev.payload ?? {});
    assert(!tokenRe.test(blob), `payload contains token-shaped data: ${blob}`);
  }
  const rawRows = conn
    .prepare(`SELECT payload_json FROM hermes_job_events WHERE job_id = ?`)
    .all(jobId) as Array<{ payload_json: string | null }>;
  for (const r of rawRows) {
    if (!r.payload_json) continue;
    assert(
      !tokenRe.test(r.payload_json),
      `raw DB row contains token-shaped data: ${r.payload_json}`,
    );
  }

  const saved = saveCanvasState({ briefId, canvas: { widgets: [] } });
  assert(saved.version === 1, `expected canvas version 1, got ${saved.version}`);
  const loaded = getCanvasState(briefId);
  assert(loaded !== null && loaded.version === 1, "canvas state round-trips");

  // eslint-disable-next-line no-console
  console.log(
    `hermes_foundation_ok job=${jobId} events=${briefEvents.length} canvas_version=${saved.version} db=${process.env.BRIEF_DB_PATH}`,
  );
}

try {
  main();
  process.exit(0);
} catch (e: any) {
  // eslint-disable-next-line no-console
  console.error("verify-hermes-foundation failed:", e?.message ?? e);
  process.exit(1);
}
