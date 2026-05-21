// Phase A.7 — Task 7: adversarial activation refusal tests for the real
// model adapter.
//
// HARD SAFETY:
//   - Each refusal MUST happen before any provider SDK is imported, before
//     any provider env var is read, before any filesystem write, before
//     any adapter is instantiated, before any `fetch` is called.
//   - Refusals MUST AGGREGATE: a single message lists every missing/invalid
//     flag and ends with the A.7 BLOCKED reminder.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const RUNNER_PATH = "../web/scripts/run-account-graph-validation";
const REPO_ROOT = resolve(__dirname, "..");
const SHARED_OUT_DIR = join(REPO_ROOT, "out", "account-graph-validation");
const ANTHROPIC_SDK_SPEC = "@anthropic-ai/sdk";

function loadRunner(): typeof import("../web/scripts/run-account-graph-validation") {
  return require(RUNNER_PATH);
}

function snapshotDir(p: string): Set<string> {
  if (!existsSync(p)) return new Set<string>();
  return new Set(readdirSync(p));
}

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function isSdkLoaded(): boolean {
  for (const key of Object.keys(require.cache)) {
    if (key.includes("@anthropic-ai/sdk")) return true;
  }
  return false;
}

function syntheticBriefJson(name: string): string {
  return JSON.stringify({
    account_name: name,
    segment: "x",
    generated_at: "2026-05-21T00:00:00Z",
    audience: "internal",
    snapshot: "s",
    priority_summary: "p",
    recent_signals: [],
    ai_tech_maturity: { rating: 1, rationale: "x" },
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
}

type SideEffectProbeResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
  fetchCalls: number;
  envReads: string[];
  newOutEntries: string[];
  sdkLoadedAfter: boolean;
  realAdapterModuleLoadedAfter: boolean;
};

async function runMainProbe(args: string[]): Promise<SideEffectProbeResult> {
  const mod = loadRunner();
  const beforeOut = snapshotDir(SHARED_OUT_DIR);
  // Track env reads, but DO NOT throw on them — the runner is allowed to
  // read non-provider env vars (e.g. PATH for git). We only assert no
  // PROVIDER env vars were read.
  const envReads: string[] = [];
  const origEnv = process.env;
  const envProxy = new Proxy(origEnv, {
    get(target, prop) {
      if (typeof prop === "string") envReads.push(prop);
      return (target as Record<string, string | undefined>)[prop as string];
    },
  });
  (process as { env: NodeJS.ProcessEnv }).env = envProxy as NodeJS.ProcessEnv;

  let fetchCalls = 0;
  const origFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called by a refusal path");
  };

  const origErr = console.error;
  const origLog = console.log;
  const errChunks: string[] = [];
  const outChunks: string[] = [];
  console.error = (...a: unknown[]) => { errChunks.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { outChunks.push(a.map(String).join(" ")); };

  let exitCode = -1;
  try {
    exitCode = await mod.main(args);
  } finally {
    console.error = origErr;
    console.log = origLog;
    (process as { env: NodeJS.ProcessEnv }).env = origEnv;
    if (origFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as { fetch?: unknown }).fetch = origFetch;
  }

  const afterOut = snapshotDir(SHARED_OUT_DIR);
  const newOutEntries: string[] = [];
  for (const e of afterOut) if (!beforeOut.has(e)) newOutEntries.push(e);
  for (const e of newOutEntries) {
    try { rmSync(join(SHARED_OUT_DIR, e), { recursive: true, force: true }); } catch { /* */ }
  }

  const realAdapterModuleLoadedAfter = Object.keys(require.cache).some((k) =>
    k.endsWith("validationPipeline/adapters/realAnthropic.ts") ||
    k.endsWith("validationPipeline/adapters/realAnthropic.js"),
  );

  return {
    exitCode,
    stderr: errChunks.join("\n"),
    stdout: outChunks.join("\n"),
    fetchCalls,
    envReads,
    newOutEntries,
    sdkLoadedAfter: isSdkLoaded(),
    realAdapterModuleLoadedAfter,
  };
}

const PROVIDER_ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY"];

function assertNoProviderEnvReads(envReads: string[]): void {
  for (const k of PROVIDER_ENV_VARS) {
    assert.ok(!envReads.includes(k), `refusal path must not read provider env ${k}`);
  }
}

// ---------- Refusal aggregation ----------

test("Task 7: --adapter real with NO other flags aggregates every missing flag and ends with BLOCKED reminder", async () => {
  const r = await runMainProbe(["--mode", "model", "--adapter", "real"]);
  assert.equal(r.exitCode, 1);
  // Every required flag is named in the SAME message.
  assert.match(r.stderr, /--allow-real-model/);
  assert.match(r.stderr, /--provider/);
  assert.match(r.stderr, /--model/);
  assert.match(r.stderr, /--max-cost/);
  assert.match(r.stderr, /--corpus/);
  assert.match(r.stderr, /--out/);
  assert.match(r.stderr, /A\.7 graph-first writes remain BLOCKED/);
  // No side effects: no fetch, no provider env reads, no artifacts, no SDK,
  // no real-adapter module loaded.
  assert.equal(r.fetchCalls, 0);
  assertNoProviderEnvReads(r.envReads);
  assert.deepEqual(r.newOutEntries, []);
  assert.equal(r.sdkLoadedAfter, false, "Anthropic SDK must NOT load on refusal");
  assert.equal(r.realAdapterModuleLoadedAfter, false, "real adapter module must NOT load on refusal");
});

test("Task 7: --adapter real with --provider only still names every OTHER missing flag", async () => {
  const r = await runMainProbe(["--mode", "model", "--adapter", "real", "--provider", "anthropic"]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /--allow-real-model/);
  assert.match(r.stderr, /--model/);
  assert.match(r.stderr, /--max-cost/);
  assert.match(r.stderr, /--corpus/);
  assert.match(r.stderr, /--out/);
  // --provider IS supplied so it must NOT appear as a missing-flag reason.
  assert.doesNotMatch(r.stderr, /--provider is required/);
  assert.equal(r.sdkLoadedAfter, false);
  assert.equal(r.realAdapterModuleLoadedAfter, false);
});

test("Task 7: unknown --provider is refused with supported-providers list", async () => {
  const r = await runMainProbe([
    "--mode", "model", "--adapter", "real",
    "--allow-real-model",
    "--provider", "definitely-not-a-real-provider",
    "--model", "x",
    "--max-cost", "5",
    "--corpus", "/tmp/x.jsonl",
    "--out", "/tmp/x-out",
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /definitely-not-a-real-provider/);
  assert.match(r.stderr, /supported: anthropic/);
  assert.equal(r.sdkLoadedAfter, false);
});

test("Task 7: invalid --max-cost (0) is refused with aggregated message", async () => {
  const r = await runMainProbe([
    "--mode", "model", "--adapter", "real",
    "--allow-real-model",
    "--provider", "anthropic",
    "--model", "x",
    "--max-cost", "0",
    "--corpus", "/tmp/x.jsonl",
    "--out", "/tmp/x-out",
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /--max-cost must be a positive number/);
});

test("Task 7: defaulted --max-cost (no flag) is REFUSED even though runner default exists", async () => {
  const r = await runMainProbe([
    "--mode", "model", "--adapter", "real",
    "--allow-real-model",
    "--provider", "anthropic",
    "--model", "x",
    "--corpus", "/tmp/x.jsonl",
    "--out", "/tmp/x-out",
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /--max-cost is required for --adapter real/);
});

test("Task 7: --max-cost over hard cap without --allow-high-cost is refused", async () => {
  const r = await runMainProbe([
    "--mode", "model", "--adapter", "real",
    "--allow-real-model",
    "--provider", "anthropic",
    "--model", "x",
    "--max-cost", "50",
    "--corpus", "/tmp/x.jsonl",
    "--out", "/tmp/x-out",
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /exceeds the per-run hard cap of 25 USD/);
});

test("Task 7: --corpus inside the repo is refused via existing PR #45 guard", async () => {
  const r = await runMainProbe([
    "--mode", "model", "--adapter", "real",
    "--allow-real-model",
    "--provider", "anthropic",
    "--model", "x",
    "--max-cost", "5",
    "--corpus", join(REPO_ROOT, "tests", "fixtures", "a7_account_a_public_web.json"),
    "--out", "/tmp/x-out",
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /resolves inside the repo working tree/);
});

test("Task 7: --out inside the repo (and not under out/local-prod-baseline) is refused", async () => {
  const r = await runMainProbe([
    "--mode", "model", "--adapter", "real",
    "--allow-real-model",
    "--provider", "anthropic",
    "--model", "x",
    "--max-cost", "5",
    "--corpus", "/tmp/x.jsonl",
    "--out", join(REPO_ROOT, "tests"),
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /resolves inside the repo working tree/);
});

// ---------- Credential refusal ----------

test("Task 7: fully-activated real mode without ANTHROPIC_API_KEY refuses cleanly without provider call", async () => {
  const corpusDir = makeTmpDir("a7-task7-corpus-");
  const outDir = makeTmpDir("a7-task7-out-");
  const corpusFile = join(corpusDir, "synthetic.jsonl");
  writeFileSync(corpusFile, syntheticBriefJson("local_test_acct") + "\n");

  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await runMainProbe([
      "--mode", "model", "--adapter", "real",
      "--allow-real-model",
      "--provider", "anthropic",
      "--model", "claude-opus-4-7",
      "--max-cost", "5",
      "--corpus", corpusFile,
      "--out", outDir,
    ]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /ANTHROPIC_API_KEY is not present/);
    // Must NOT have leaked any value (we never set one, but assert structure).
    assert.doesNotMatch(r.stderr, /sk-/, "must not log API key shape");
    // No filesystem artifacts produced.
    assert.equal(readdirSync(outDir).length, 0, "no artifacts written on credential refusal");
    // We DO expect the real adapter module to have loaded (to read the env
    // var name constant), but the SDK MUST NOT have been imported.
    assert.equal(r.sdkLoadedAfter, false, "SDK must not load on credential refusal");
    // BLOCKED reminder present.
    assert.match(r.stderr, /BLOCKED/);
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(corpusDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------- Default/safe paths remain SDK-free / env-read-free / fetch-free ----------

test("Task 7: default fixture mode does NOT load the Anthropic SDK and does NOT read provider env", async () => {
  // Force-clear SDK from require cache so the test is deterministic.
  for (const k of Object.keys(require.cache)) {
    if (k.includes("@anthropic-ai/sdk") || k.endsWith("realAnthropic.ts") || k.endsWith("realAnthropic.js")) {
      delete require.cache[k];
    }
  }
  const outDir = makeTmpDir("a7-task7-fixture-");
  try {
    const r = await runMainProbe(["--mode", "fixture", "--out", outDir]);
    assert.equal(r.exitCode, 0);
    assertNoProviderEnvReads(r.envReads);
    assert.equal(r.fetchCalls, 0);
    assert.equal(r.sdkLoadedAfter, false, "fixture mode must not load Anthropic SDK");
    assert.equal(r.realAdapterModuleLoadedAfter, false, "fixture mode must not load real adapter module");
    // Cost is $0 / observed.
    const j = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(j.cost.observed_usd, 0);
    assert.equal(j.cost.status, "observed");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Task 7: --mode model --adapter fake does NOT load the Anthropic SDK and does NOT read provider env", async () => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes("@anthropic-ai/sdk") || k.endsWith("realAnthropic.ts") || k.endsWith("realAnthropic.js")) {
      delete require.cache[k];
    }
  }
  const outDir = makeTmpDir("a7-task7-fake-");
  try {
    const r = await runMainProbe(["--mode", "model", "--adapter", "fake", "--out", outDir]);
    assert.equal(r.exitCode, 0);
    assertNoProviderEnvReads(r.envReads);
    assert.equal(r.fetchCalls, 0);
    assert.equal(r.sdkLoadedAfter, false, "fake-adapter mode must not load Anthropic SDK");
    assert.equal(r.realAdapterModuleLoadedAfter, false, "fake-adapter mode must not load real adapter module");
    const j = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(j.cost.observed_usd, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Task 7: --mode fixture --corpus <local> does NOT load Anthropic SDK and does NOT read provider env", async () => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes("@anthropic-ai/sdk") || k.endsWith("realAnthropic.ts") || k.endsWith("realAnthropic.js")) {
      delete require.cache[k];
    }
  }
  const corpusDir = makeTmpDir("a7-task7-localcorp-");
  const outDir = makeTmpDir("a7-task7-localcorp-out-");
  const corpusFile = join(corpusDir, "synthetic.jsonl");
  writeFileSync(corpusFile, syntheticBriefJson("local_account") + "\n");
  try {
    const r = await runMainProbe(["--mode", "fixture", "--corpus", corpusFile, "--out", outDir]);
    assert.equal(r.exitCode, 0);
    assertNoProviderEnvReads(r.envReads);
    assert.equal(r.fetchCalls, 0);
    assert.equal(r.sdkLoadedAfter, false, "local-corpus mode must not load Anthropic SDK");
    assert.equal(r.realAdapterModuleLoadedAfter, false, "local-corpus mode must not load real adapter module");
  } finally {
    rmSync(corpusDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------- Import-time safety ----------

test("Task 7: importing the runner does NOT load Anthropic SDK and does NOT load real adapter module", () => {
  // Clear caches that may have been populated by other tests in the same file.
  for (const k of Object.keys(require.cache)) {
    if (k.includes("@anthropic-ai/sdk") || k.endsWith("realAnthropic.ts")) {
      delete require.cache[k];
    }
  }
  // Also drop the runner so we get a fresh import.
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith("run-account-graph-validation.ts") || k.endsWith("run-account-graph-validation.js")) {
      delete require.cache[k];
    }
  }
  const envReads: string[] = [];
  const origEnv = process.env;
  (process as { env: NodeJS.ProcessEnv }).env = new Proxy(origEnv, {
    get(t, p) { if (typeof p === "string") envReads.push(p); return (t as Record<string, string | undefined>)[p as string]; },
  }) as NodeJS.ProcessEnv;
  try {
    loadRunner();
  } finally {
    (process as { env: NodeJS.ProcessEnv }).env = origEnv;
  }
  for (const k of PROVIDER_ENV_VARS) assert.ok(!envReads.includes(k), `import read forbidden env var ${k}`);
  assert.equal(isSdkLoaded(), false, "importing the runner must not load the Anthropic SDK");
  const realAdapterLoaded = Object.keys(require.cache).some((k) => k.endsWith("realAnthropic.ts"));
  assert.equal(realAdapterLoaded, false, "importing the runner must not load the real adapter module");
});

// ---------- Static-import check: runner source must NOT statically import the SDK ----------

test("Task 7: runner source does NOT statically import @anthropic-ai/sdk", () => {
  const runnerPath = resolve(__dirname, "..", "web", "scripts", "run-account-graph-validation.ts");
  const src = readFileSync(runnerPath, "utf8");
  // No static `import ... from "@anthropic-ai/sdk"` and no CJS require().
  assert.doesNotMatch(src, /from\s+["']@anthropic-ai\/sdk["']/);
  assert.doesNotMatch(src, /require\(\s*["']@anthropic-ai\/sdk["']\s*\)/);
  // The dynamic import IS allowed, but it must appear ONLY indirectly via
  // the real adapter module (the runner imports realAnthropic dynamically;
  // realAnthropic in turn imports the SDK dynamically inside init()).
});

test("Task 7: ONLY realAnthropic.ts statically references @anthropic-ai/sdk in the validation pipeline + script", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const roots = [
    resolve(__dirname, "..", "web", "scripts"),
    resolve(__dirname, "..", "web", "lib", "accountGraph"),
  ];
  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) yield p;
    }
  }
  const offenders: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) {
      const src = fs.readFileSync(file, "utf8");
      if (
        /from\s+["']@anthropic-ai\/sdk["']/.test(src) ||
        /require\(\s*["']@anthropic-ai\/sdk["']\s*\)/.test(src)
      ) {
        offenders.push(file);
      }
    }
  }
  // The only allowed file is the real Anthropic adapter — and it uses
  // DYNAMIC import (await import("@anthropic-ai/sdk")), not a static one.
  // Static-import probe should match ZERO files anywhere in the validation
  // pipeline + runner script trees.
  assert.deepEqual(
    offenders,
    [],
    `expected no static @anthropic-ai/sdk imports in validation pipeline; offenders: ${offenders.join(", ")}`,
  );
  void ANTHROPIC_SDK_SPEC; // referenced for readability
});

test("Task 7: realAnthropic adapter module does NOT load Anthropic SDK at import time", () => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes("@anthropic-ai/sdk") || k.endsWith("realAnthropic.ts")) {
      delete require.cache[k];
    }
  }
  // Import the adapter module directly.
  require("../web/lib/accountGraph/validationPipeline/adapters/realAnthropic");
  assert.equal(isSdkLoaded(), false, "importing realAnthropic.ts must not load the SDK");
});
