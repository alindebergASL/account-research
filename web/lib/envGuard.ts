// Hard-fail at boot if RESEARCH_WORKER_FAKE_PROVIDER is set in production.
// A misconfigured env is obvious within seconds of restart instead of being
// discovered per-job. Imported by both lib/db.ts (web boot) and the worker
// entry script (after loadEnvConfig).

let _checked = false;

export function assertNoFakeProviderInProd() {
  if (_checked) return;
  _checked = true;
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
}
