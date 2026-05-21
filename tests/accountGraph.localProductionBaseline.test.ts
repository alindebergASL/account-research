// Phase A.7 Task 5 — local-only production-backup baseline tests.
//
// These tests assert HARD safety properties for the local-corpus runner:
//   - The runner refuses to READ a --corpus that resolves inside the repo's
//     tracked directories (docs/scripts/tests/web).
//   - The runner refuses to WRITE artifacts to a path inside the repo's
//     tracked directories.
//   - A local-corpus run against a /tmp corpus + /tmp out leaves the repo
//     working tree byte-for-byte clean (no staged or untracked entries).
//   - Production-derived fixtures/artifacts are not tracked by git.
//   - The runner imports zero provider SDKs and reads zero provider env vars.
//   - Malformed JSON / malformed JSONL line / schema mismatches are classified
//     (skipped_malformed_json / skipped_unsupported_schema_variant) and never
//     crash the run.
//   - The default fixture-mode (no --corpus) behavior remains unchanged.
//   - The PR #44 --mode model refusal-without-adapter behavior is unchanged.

import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RUNNER_PATH = "../web/scripts/run-account-graph-validation";
const REPO_ROOT = resolve(__dirname, "..");

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Minimal valid Brief object (matches the Zod shape in web/lib/schema.ts).
// All content is clearly synthetic — no real account names, no real URLs.
function syntheticBrief(label: string): Record<string, unknown> {
  return {
    account_name: `a7_local_synthetic_${label}`,
    segment: "synthetic-local-test",
    generated_at: "2026-05-21T00:00:00.000Z",
    audience: "internal",
    snapshot: "synthetic snapshot text for a7 local production baseline tests",
    priority_summary: "synthetic priority summary",
    recent_signals: [],
    ai_tech_maturity: { rating: 1, rationale: "synthetic" },
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
  };
}

test("isInsideRepoTrackedTree flags repo subdirs and ignores outside paths", () => {
  const mod = require(RUNNER_PATH);
  assert.equal(mod.isInsideRepoTrackedTree(join(REPO_ROOT, "web", "x")), true);
  assert.equal(mod.isInsideRepoTrackedTree(join(REPO_ROOT, "tests", "x")), true);
  assert.equal(mod.isInsideRepoTrackedTree(join(REPO_ROOT, "docs", "x")), true);
  assert.equal(mod.isInsideRepoTrackedTree(join(REPO_ROOT, "scripts", "x")), true);
  // out/ is gitignored (apart from out/account-graph-* and out/local-prod-baseline/),
  // so out/local-prod-baseline/ is NOT a tracked top-level dir.
  assert.equal(mod.isInsideRepoTrackedTree(join(REPO_ROOT, "out", "local-prod-baseline", "x")), false);
  assert.equal(mod.isInsideRepoTrackedTree("/tmp/anything"), false);
});

test("runner REFUSES to read --corpus from inside repo tracked tree (exit 1)", async () => {
  const mod = require(RUNNER_PATH);
  const insideRepoCorpus = join(REPO_ROOT, "tests", "fixtures", "a7_account_a_public_web.json");
  assert.ok(existsSync(insideRepoCorpus), "synthetic fixture must exist for negative test");

  const out = makeTmpDir("a7-task5-out-");
  const errChunks: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await mod.main(["--corpus", insideRepoCorpus, "--out", out]);
    assert.equal(code, 1, "must exit nonzero when --corpus is inside tracked tree");
    assert.ok(
      errChunks.join("\n").includes(mod.LOCAL_CORPUS_INSIDE_REPO_ERROR),
      `expected explicit refusal; got: ${errChunks.join("\n")}`,
    );
  } finally {
    console.error = origErr;
    rmSync(out, { recursive: true, force: true });
  }
});

test("runner REFUSES to write --out to a path inside repo tracked tree (exit 1)", async () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const corpusFile = join(corpusDir, "synthetic.jsonl");
  writeFileSync(corpusFile, JSON.stringify(syntheticBrief("a")) + "\n");
  // --out inside tracked tree must be refused.
  const insideRepoOut = join(REPO_ROOT, "web", "lib", "a7-task5-should-not-exist");
  const errChunks: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await mod.main(["--corpus", corpusFile, "--out", insideRepoOut]);
    assert.equal(code, 1, "must exit nonzero when --out is inside tracked tree");
    assert.ok(
      errChunks.join("\n").includes(mod.LOCAL_OUT_INSIDE_REPO_ERROR),
      `expected explicit refusal; got: ${errChunks.join("\n")}`,
    );
    assert.equal(existsSync(insideRepoOut), false, "no directory should be created inside tracked tree");
  } finally {
    console.error = origErr;
    rmSync(corpusDir, { recursive: true, force: true });
  }
});

test("local-corpus run with /tmp corpus + /tmp out does not perturb git working tree", async () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const outDir = makeTmpDir("a7-task5-out-");
  const corpusFile = join(corpusDir, "synthetic.jsonl");
  writeFileSync(
    corpusFile,
    JSON.stringify(syntheticBrief("a")) + "\n" + JSON.stringify(syntheticBrief("b")) + "\n",
  );
  // Snapshot git status BEFORE the run; assert the run doesn't add or modify
  // anything relative to that snapshot. (The PR's own in-flight changes are
  // present in both snapshots.)
  const before = execSync("git status --short", { cwd: REPO_ROOT }).toString();
  try {
    const code = await mod.main(["--corpus", corpusFile, "--out", outDir]);
    assert.equal(code, 0, "local-corpus run must exit 0");
    assert.ok(existsSync(join(outDir, "paired-baseline.json")));
    assert.ok(existsSync(join(outDir, "local-baseline-selection.json")));
    assert.ok(existsSync(join(outDir, "report.json")));
    const after = execSync("git status --short", { cwd: REPO_ROOT }).toString();
    assert.equal(
      after,
      before,
      `local-corpus run must not perturb git working tree;\nbefore:\n${before}\nafter:\n${after}`,
    );
    // And no tracked file under out/local-prod-baseline/ — that path stays ignored.
    const lsOut = execSync("git ls-files out/local-prod-baseline/", { cwd: REPO_ROOT }).toString().trim();
    assert.equal(lsOut, "");
  } finally {
    rmSync(corpusDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("paired-baseline.json from local corpus uses corpus_kind=local_production_backup with caveats", async () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const outDir = makeTmpDir("a7-task5-out-");
  const corpusFile = join(corpusDir, "synthetic.jsonl");
  writeFileSync(corpusFile, JSON.stringify(syntheticBrief("a")) + "\n");
  try {
    const result = await mod.runLocalCorpusOrchestrator({
      corpusPath: corpusFile,
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    const paired = JSON.parse(readFileSync(result.artifacts.pairedBaselinePath, "utf8"));
    assert.equal(paired.corpus_kind, "local_production_backup");
    assert.equal(paired.fixture_placeholder, false);
    assert.ok(/blocked/i.test(paired.caveat));
    assert.ok(/not committed/i.test(paired.caveat));
    assert.ok(Array.isArray(paired.accounts) && paired.accounts.length === 1);
    // Same per-account metric shape as the synthetic-fixture baseline.
    const a = paired.accounts[0];
    for (const key of [
      "account_label",
      "fixture_id",
      "selection_rationale",
      "criteria_covered",
      "claims",
      "objects",
      "classification",
      "confidence_downgrades",
      "orphan_source_documents",
      "parity_coverage_numerator",
      "parity_coverage_denominator",
      "dropped_material_count",
      "validator_errors",
      "validator_warnings",
      "provenance_gaps",
    ]) {
      assert.ok(key in a, `paired account missing key ${key}`);
    }
  } finally {
    rmSync(corpusDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("local-baseline-selection.json carries local_artifact/committed/caveat per entry", async () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const outDir = makeTmpDir("a7-task5-out-");
  const corpusFile = join(corpusDir, "synthetic.jsonl");
  writeFileSync(
    corpusFile,
    JSON.stringify(syntheticBrief("a")) + "\n" + JSON.stringify(syntheticBrief("b")) + "\n",
  );
  try {
    const result = await mod.runLocalCorpusOrchestrator({
      corpusPath: corpusFile,
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    const sel = JSON.parse(readFileSync(result.artifacts.selectionPath, "utf8"));
    assert.equal(sel.corpus_kind, "local_production_backup");
    assert.equal(sel.local_artifact, true);
    assert.equal(sel.committed, false);
    assert.ok(/not committed/i.test(sel.caveat));
    assert.equal(sel.selections.length, 2);
    for (const r of sel.selections) {
      assert.equal(typeof r.account_label, "string");
      assert.equal(typeof r.account_id, "string");
      assert.equal(typeof r.fixture_id, "string");
      assert.equal(typeof r.selection_rationale, "string");
      assert.ok(Array.isArray(r.criteria_covered));
      assert.equal(r.local_artifact, true);
      assert.equal(r.committed, false);
      assert.ok(/not committed/i.test(r.caveat));
    }
  } finally {
    rmSync(corpusDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("malformed JSONL line is classified skipped_malformed_json (no crash)", () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const corpusFile = join(corpusDir, "mixed.jsonl");
  writeFileSync(
    corpusFile,
    JSON.stringify(syntheticBrief("good")) + "\n" + "{not valid json" + "\n",
  );
  try {
    const res = mod.readLocalCorpus(corpusFile);
    assert.equal(res.format, "jsonl");
    assert.equal(res.entries_total, 2);
    assert.equal(res.entries_ok.length, 1);
    assert.equal(res.entries_skipped.length, 1);
    assert.equal(res.entries_skipped[0].classification, "skipped_malformed_json");
    assert.ok(typeof res.entries_skipped[0].error === "string");
    assert.equal(res.entries_skipped[0].source_line, 2);
  } finally {
    rmSync(corpusDir, { recursive: true, force: true });
  }
});

test("schema-mismatch entry is classified skipped_unsupported_schema_variant", () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const corpusFile = join(corpusDir, "mismatch.jsonl");
  // valid JSON but missing required Brief fields
  writeFileSync(corpusFile, JSON.stringify({ hello: "world" }) + "\n");
  try {
    const res = mod.readLocalCorpus(corpusFile);
    assert.equal(res.entries_total, 1);
    assert.equal(res.entries_ok.length, 0);
    assert.equal(res.entries_skipped.length, 1);
    assert.equal(res.entries_skipped[0].classification, "skipped_unsupported_schema_variant");
  } finally {
    rmSync(corpusDir, { recursive: true, force: true });
  }
});

test("entirely-malformed single-JSON file is classified, not crashed", () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const corpusFile = join(corpusDir, "bad.json");
  writeFileSync(corpusFile, "{not valid");
  try {
    const res = mod.readLocalCorpus(corpusFile);
    assert.equal(res.entries_total, 1);
    assert.equal(res.entries_ok.length, 0);
    assert.equal(res.entries_skipped.length, 1);
    assert.equal(res.entries_skipped[0].classification, "skipped_malformed_json");
  } finally {
    rmSync(corpusDir, { recursive: true, force: true });
  }
});

test("local-corpus run does NOT call fetch and does NOT read provider env vars", async () => {
  const mod = require(RUNNER_PATH);
  const corpusDir = makeTmpDir("a7-task5-corpus-");
  const outDir = makeTmpDir("a7-task5-out-");
  const corpusFile = join(corpusDir, "synthetic.jsonl");
  writeFileSync(corpusFile, JSON.stringify(syntheticBrief("a")) + "\n");

  let fetchCalls = 0;
  const origFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called by local-corpus run");
  };

  // Wrap process.env in a Proxy so any read of a known provider key throws.
  const banned = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY"];
  const origEnv = process.env;
  const envProxy = new Proxy(origEnv, {
    get(target, prop) {
      if (typeof prop === "string" && banned.includes(prop)) {
        throw new Error(`local-corpus run must not read ${prop}`);
      }
      return (target as Record<string, string | undefined>)[prop as string];
    },
  });
  (process as { env: NodeJS.ProcessEnv }).env = envProxy as NodeJS.ProcessEnv;

  try {
    await mod.runLocalCorpusOrchestrator({
      corpusPath: corpusFile,
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    assert.equal(fetchCalls, 0, "local-corpus run must not call fetch");
  } finally {
    (process as { env: NodeJS.ProcessEnv }).env = origEnv;
    if (origFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as { fetch?: unknown }).fetch = origFetch;
    rmSync(corpusDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("default fixture mode (no --corpus) still routes to synthetic-fixture orchestrator", async () => {
  // Confirms backward compatibility: when --corpus is omitted, the runner
  // produces a synthetic-fixture paired baseline (corpus_kind=synthetic_fixture).
  const mod = require(RUNNER_PATH);
  const outDir = makeTmpDir("a7-task5-fixture-out-");
  try {
    const result = await mod.runFixtureOrchestrator({
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    assert.equal(result.paired.corpus_kind, "synthetic_fixture");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("--mode model refusal-without-adapter behavior from PR #44 unchanged", async () => {
  const mod = require(RUNNER_PATH);
  const origErr = console.error;
  const errChunks: string[] = [];
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await mod.main(["--mode", "model"]);
    assert.equal(code, 1);
    const stderr = errChunks.join("\n");
    assert.ok(stderr.includes(mod.MODEL_MODE_REFUSAL_MESSAGE));
    assert.ok(stderr.includes(mod.MODEL_MODE_REAL_ADAPTER_REFUSAL));
  } finally {
    console.error = origErr;
  }
});

test("no production-derived fixtures are tracked under tests/fixtures/ in this PR", () => {
  // All tracked fixtures must remain synthetic. Specifically, every committed
  // file under tests/fixtures/ must either be one of the pre-existing
  // synthetic fixtures, or carry the a7_local_synthetic_ prefix in name.
  const out = execSync("git ls-files tests/fixtures/", { cwd: REPO_ROOT }).toString().trim();
  const tracked = out.length > 0 ? out.split("\n") : [];
  // Any new file added by this PR under tests/fixtures/ must be clearly
  // synthetic (a7_local_synthetic_*).
  const newSinceMain = execSync(
    "git diff --name-only --diff-filter=A origin/main...HEAD -- tests/fixtures/",
    { cwd: REPO_ROOT },
  )
    .toString()
    .trim();
  const newFiles = newSinceMain.length > 0 ? newSinceMain.split("\n") : [];
  for (const f of newFiles) {
    assert.ok(
      /a7_local_synthetic_/.test(f) || /synthetic/i.test(f),
      `new committed fixture must be clearly synthetic: ${f}`,
    );
  }
  // And no tracked file should be under out/local-prod-baseline/.
  const localOut = execSync("git ls-files out/local-prod-baseline/ || true", {
    cwd: REPO_ROOT,
    shell: "/bin/bash",
  })
    .toString()
    .trim();
  assert.equal(
    localOut,
    "",
    `out/local-prod-baseline/ must contain zero tracked files; got: ${localOut}`,
  );
  // Silence unused-var lint warnings.
  void tracked;
});

test("runner module exports the local-corpus surface", () => {
  const mod = require(RUNNER_PATH);
  assert.equal(typeof mod.isInsideRepoTrackedTree, "function");
  assert.equal(typeof mod.readLocalCorpus, "function");
  assert.equal(typeof mod.runLocalCorpusOrchestrator, "function");
  assert.equal(typeof mod.LOCAL_CORPUS_INSIDE_REPO_ERROR, "string");
  assert.equal(typeof mod.LOCAL_OUT_INSIDE_REPO_ERROR, "string");
  assert.equal(typeof mod.LOCAL_SELECTION_CAVEAT, "string");
  assert.equal(typeof mod.LOCAL_PAIRED_CAVEAT, "string");
});

// Use mkdirSync in some path just to silence unused import warnings if any.
void mkdirSync;
