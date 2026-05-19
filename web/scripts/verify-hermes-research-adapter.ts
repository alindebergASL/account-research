// Local verification for the PR-2 Hermes research adapter.
//
// Proves end-to-end (no model spend, no network):
//   1. fake-mode + HERMES_RESEARCH_ENABLED=1: adapter runs, persists a
//      `hermes_jobs` row with kind=research/fake=1, emits ordered
//      `job.started` ... `job.completed` events, returns a PipelineResult-
//      shaped value, never persists token-shaped material.
//   2. disabled path: `selectResearchPath()` returns "direct" when
//      HERMES_RESEARCH_ENABLED is unset and "hermes" when set — no
//      provider call required to assert dispatcher routing.
//   3. failure path: with HERMES_RUNTIME_FAKE=0 and
//      HERMES_RUNTIME_ENABLED=0 the runtime client throws
//      HermesRuntimeDisabledError; the adapter records a `failed` job
//      row and a sanitized `job.failed` event, then re-throws a
//      HermesResearchAdapterError carrying only {jobId, kind, message}.
//
// Run via `npm run verify:hermes-research-adapter`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (!process.env.BRIEF_DB_PATH) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "abb-hermes-research-verify-"),
  );
  process.env.BRIEF_DB_PATH = path.join(tmpDir, "verify.sqlite");
}
if (!process.env.ADMIN_EMAIL)
  process.env.ADMIN_EMAIL = "verify-hermes-research@example.com";
if (!process.env.ADMIN_PASSWORD)
  process.env.ADMIN_PASSWORD = "VerifyTempPass123!";

// Start in fake mode with research routing enabled.
process.env.HERMES_RUNTIME_FAKE = "1";
process.env.HERMES_RESEARCH_ENABLED = "1";
delete process.env.HERMES_RUNTIME_ENABLED;
delete process.env.RESEARCH_WORKER_FAKE_PROVIDER;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db, initDb } = require("../lib/db") as typeof import("../lib/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  runResearchViaHermes,
  selectResearchPath,
  HermesResearchAdapterError,
} = require("../lib/hermes/researchAdapter") as typeof import("../lib/hermes/researchAdapter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listHermesEventsForJob } =
  require("../lib/hermes/events") as typeof import("../lib/hermes/events");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Brief: BriefSchema } = require("../lib/schema") as typeof import("../lib/schema");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    // eslint-disable-next-line no-console
    console.error(`assertion failed: ${msg}`);
    process.exit(2);
  }
}

const TOKEN_RE =
  /Bearer\s+[A-Za-z0-9._\-]+|sk-[A-Za-z0-9\-_]{20,}|Cookie:|Authorization:/i;

async function main() {
  initDb();
  const conn = db();

  const userId = "verify-hermes-research-user";
  const briefId = "verify-hermes-research-brief";
  const now = Date.now();

  const existingUser = conn
    .prepare(`SELECT 1 AS x FROM users WHERE id = ?`)
    .get(userId) as { x: number } | undefined;
  if (!existingUser) {
    conn
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, display_name, created_at)
         VALUES (?, ?, 'scrypt$N=1$x$y', 'member', ?, ?)`,
      )
      .run(
        userId,
        `verify-research-${randomUUID()}@example.com`,
        "verify-hermes-research",
        now,
      );
  }
  const existingBrief = conn
    .prepare(`SELECT 1 AS x FROM briefs WHERE id = ?`)
    .get(briefId) as { x: number } | undefined;
  if (!existingBrief) {
    conn
      .prepare(
        `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
         VALUES (?, ?, 'Verify Hermes Research', 'lab', 'internal', '1970-01-01', ?, '{}')`,
      )
      .run(briefId, userId, now);
  }

  // --- 1) fake_path -----------------------------------------------------
  const jobsBefore = (
    conn
      .prepare(
        `SELECT COUNT(*) AS c FROM hermes_jobs WHERE kind = 'research'`,
      )
      .get() as { c: number }
  ).c;

  const result = await runResearchViaHermes(
    {
      account: "Verify Hermes Research Account",
      segment: "lab",
      mode: "standard",
      audience: "internal",
      // Token-shaped material in notes MUST be excluded from any
      // persisted payload (the adapter never copies notes into events,
      // and the sanitizer scrubs anything that slips through).
      notes:
        "secret notes Authorization: Bearer abcdef0123456789 sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    },
    { user_id: userId, brief_id: briefId },
  );

  assert(result && typeof result === "object", "fake_path: returns an object");
  assert(result.brief && typeof result.brief === "object", "fake_path: brief present");
  const parsedFakeBrief = BriefSchema.safeParse(result.brief);
  assert(
    parsedFakeBrief.success,
    `fake_path: brief passes worker BriefSchema.parse boundary${
      parsedFakeBrief.success ? "" : `: ${parsedFakeBrief.error.message}`
    }`,
  );
  assert(Array.isArray(result.stages), "fake_path: stages is array");
  assert(
    result.quality && typeof result.quality === "object",
    "fake_path: quality block present",
  );
  assert(
    typeof result.quality.mode === "string",
    "fake_path: quality.mode is a string",
  );

  const jobsAfterFake = (
    conn
      .prepare(
        `SELECT COUNT(*) AS c FROM hermes_jobs WHERE kind = 'research'`,
      )
      .get() as { c: number }
  ).c;
  assert(
    jobsAfterFake === jobsBefore + 1,
    `fake_path: exactly one new research job (before=${jobsBefore}, after=${jobsAfterFake})`,
  );

  const fakeJob = conn
    .prepare(
      `SELECT id, kind, fake, status FROM hermes_jobs
       WHERE kind = 'research' ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { id: string; kind: string; fake: number; status: string };
  assert(fakeJob.kind === "research", "fake_path: job kind=research");
  assert(fakeJob.fake === 1, "fake_path: job fake=1");
  assert(fakeJob.status === "done", "fake_path: job status=done");

  const fakeEvents = listHermesEventsForJob(fakeJob.id);
  const kinds = fakeEvents.map((e) => e.kind);
  assert(
    kinds[0] === "job.started",
    `fake_path: first event is job.started, got ${kinds[0]}`,
  );
  assert(
    kinds.includes("job.completed"),
    `fake_path: events include job.completed, got [${kinds.join(",")}]`,
  );
  // job.completed must come after job.started.
  const startedIdx = kinds.indexOf("job.started");
  const completedIdx = kinds.indexOf("job.completed");
  assert(
    completedIdx > startedIdx,
    "fake_path: job.completed appears after job.started",
  );

  // Sanitization check on every persisted payload + error column.
  const rawRows = conn
    .prepare(
      `SELECT payload_json FROM hermes_job_events WHERE job_id = ?`,
    )
    .all(fakeJob.id) as Array<{ payload_json: string | null }>;
  for (const r of rawRows) {
    if (!r.payload_json) continue;
    assert(
      !TOKEN_RE.test(r.payload_json),
      `fake_path: raw event payload contains token-shaped data: ${r.payload_json}`,
    );
  }
  const errCol = conn
    .prepare(`SELECT error FROM hermes_jobs WHERE id = ?`)
    .get(fakeJob.id) as { error: string | null };
  if (errCol.error) {
    assert(
      !TOKEN_RE.test(errCol.error),
      `fake_path: job error column contains token-shaped data`,
    );
  }

  // --- 2) disabled_path: dispatcher routing only, no provider call -----
  delete process.env.HERMES_RESEARCH_ENABLED;
  const pathOff = selectResearchPath();
  assert(
    pathOff === "direct",
    `disabled_path: selectResearchPath()='${pathOff}' (expected 'direct')`,
  );
  process.env.HERMES_RESEARCH_ENABLED = "1";
  const pathOn = selectResearchPath();
  assert(
    pathOn === "hermes",
    `disabled_path: selectResearchPath()='${pathOn}' (expected 'hermes')`,
  );

  // No new research job should have been created during this branch.
  const jobsAfterDisabled = (
    conn
      .prepare(
        `SELECT COUNT(*) AS c FROM hermes_jobs WHERE kind = 'research'`,
      )
      .get() as { c: number }
  ).c;
  assert(
    jobsAfterDisabled === jobsAfterFake,
    `disabled_path: no new jobs created (before=${jobsAfterFake}, after=${jobsAfterDisabled})`,
  );

  // --- 3) failure_path: runtime disabled in non-fake mode --------------
  delete process.env.HERMES_RUNTIME_FAKE;
  delete process.env.HERMES_RUNTIME_ENABLED;
  // HERMES_RESEARCH_ENABLED is still 1; but the client is in "direct"
  // mode (neither fake nor hermes), so runHermesResearch will throw
  // HermesRuntimeDisabledError.

  let threw = false;
  let caughtKind: string | null = null;
  let caughtJobId: string | null = null;
  try {
    await runResearchViaHermes(
      {
        account: "Verify Hermes Failure",
        mode: "quick",
        audience: "internal",
      },
      { user_id: userId, brief_id: briefId },
    );
  } catch (err) {
    threw = true;
    if (err instanceof HermesResearchAdapterError) {
      caughtKind = err.kind;
      caughtJobId = err.jobId;
      // Sanitized message must never expose token-shaped material.
      assert(
        !TOKEN_RE.test(err.message),
        `failure_path: adapter error message contains token-shaped data`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.error("failure_path: unexpected error type", err);
    }
  }
  assert(threw, "failure_path: adapter threw");
  assert(
    caughtKind === "runtime_disabled",
    `failure_path: error.kind='${caughtKind}' (expected 'runtime_disabled')`,
  );
  assert(
    typeof caughtJobId === "string" && caughtJobId.length > 0,
    "failure_path: error carries jobId",
  );

  const failedJob = conn
    .prepare(`SELECT status, error FROM hermes_jobs WHERE id = ?`)
    .get(caughtJobId) as { status: string; error: string | null };
  assert(
    failedJob.status === "failed",
    `failure_path: job row status='${failedJob.status}' (expected 'failed')`,
  );
  assert(
    failedJob.error !== null && failedJob.error.length > 0,
    "failure_path: job error column populated",
  );
  assert(
    !TOKEN_RE.test(failedJob.error ?? ""),
    "failure_path: job error column sanitized",
  );

  const failedEvents = listHermesEventsForJob(caughtJobId!);
  const failedKinds = failedEvents.map((e) => e.kind);
  assert(
    failedKinds[0] === "job.started",
    `failure_path: first event is job.started, got ${failedKinds[0]}`,
  );
  assert(
    failedKinds.includes("job.failed"),
    `failure_path: events include job.failed, got [${failedKinds.join(",")}]`,
  );
  for (const ev of failedEvents) {
    const blob = JSON.stringify(ev.payload ?? {});
    assert(
      !TOKEN_RE.test(blob),
      `failure_path: event payload contains token-shaped data: ${blob}`,
    );
  }

  const totalJobs = (
    conn
      .prepare(
        `SELECT COUNT(*) AS c FROM hermes_jobs WHERE kind = 'research'`,
      )
      .get() as { c: number }
  ).c;
  const totalEvents = (
    conn
      .prepare(
        `SELECT COUNT(*) AS c FROM hermes_job_events
         WHERE job_id IN (SELECT id FROM hermes_jobs WHERE kind = 'research')`,
      )
      .get() as { c: number }
  ).c;

  // eslint-disable-next-line no-console
  console.log(
    `hermes_research_adapter_ok jobs=${totalJobs} events=${totalEvents} fake_path=ok disabled_path=ok failure_path=ok db=${process.env.BRIEF_DB_PATH}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    // eslint-disable-next-line no-console
    console.error("verify-hermes-research-adapter failed:", e?.message ?? e);
    process.exit(1);
  },
);
