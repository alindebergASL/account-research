// Standalone PM2 worker entry. Run via `npm run worker` (tsx).
//
// Ordering matters:
//   1. loadEnvConfig — Next does NOT auto-load .env.local for non-Next
//      processes, so do it explicitly before anything reads process.env.
//   2. Hard-fail on RESEARCH_WORKER_FAKE_PROVIDER in production.
//   3. Dynamic imports for lib/* — modules that read process.env at module
//      load (e.g. better-sqlite3 path resolution) must run AFTER step 1.
//   4. Wrap startup in try/catch so fatal boot errors get logged before
//      PM2 restarts the process. Without this, an ESM import error gets
//      swallowed into a bare unhandledRejection.
//
// Top-level await is unavailable here because tsx transforms to CJS by
// default, so the body lives inside an async IIFE.

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

if (
  process.env.NODE_ENV === "production" &&
  process.env.RESEARCH_WORKER_FAKE_PROVIDER
) {
  // eslint-disable-next-line no-console
  console.error(
    "FATAL: RESEARCH_WORKER_FAKE_PROVIDER must not be set in production",
  );
  process.exit(1);
}

(async () => {
  try {
    const { initDb } = await import("../lib/db");
    const { recoverStuckJobs, startWorker } = await import(
      "../lib/researchWorker"
    );

    initDb();
    recoverStuckJobs();
    await startWorker(); // never resolves except on fatal error
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[worker] fatal startup error", err);
    process.exit(1);
  }
})();
