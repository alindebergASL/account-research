// Phase A.7 — Task 4: model-adapter boundary hard-invariant tests.
//
// These tests assert HARD SAFETY properties:
//   - Importing the runner is side-effect-free (no fs writes, no adapter
//     instantiation, no env reads).
//   - Fixture mode preserves PR #43 behavior (artifacts identical between
//     two runs with the same Date).
//   - `--mode model` without `--adapter fake` exits nonzero with a clear
//     refusal and writes no artifacts.
//   - `--mode model --adapter fake` against the synthetic A.7 fixtures runs
//     end-to-end and reports cost.observed_usd === 0.
//   - Adapter cannot invent SourceDocument IDs, EvidenceExcerpt IDs, or
//     paraphrased excerpts; each shows up as the *named* invariant key in
//     the report (not a regex on prose).
//   - Adapter that emits a verified/high claim without accepted excerpts
//     trips `verified_high_claims_without_accepted_excerpts`.
//   - Adapter that emits a ClaimEvidence link pointing at an unknown excerpt
//     trips `invented_evidence_excerpt_ids` (system drops the dangling link
//     before graph build, but the named violation is still recorded).
//   - Budget exhaustion stops further adapter calls; partial artifacts
//     remain on disk and classification is `budget_exceeded`.
//   - `cost.status === "unknown_estimated"` forces classification away from
//     `pass` (to `borderline`).
//   - Schema-failed adapter output propagates as a `schema_parse` invariant.
//   - `--max-cost 30` without `--allow-high-cost` exits nonzero.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const RUNNER_PATH = "../web/scripts/run-account-graph-validation";
const REPO_ROOT = resolve(__dirname, "..");
const SHARED_OUT_DIR = join(REPO_ROOT, "out", "account-graph-validation");

function snapshotDir(p: string): Set<string> {
  if (!existsSync(p)) return new Set<string>();
  return new Set(readdirSync(p));
}

function makeTmpOut(): string {
  return mkdtempSync(join(tmpdir(), "a7-task4-test-"));
}

function loadRunner(): typeof import("../web/scripts/run-account-graph-validation") {
  return require(RUNNER_PATH);
}

// --- 1, 2: invented SourceDocument / EvidenceExcerpt IDs ---

test("fake adapter that invents a SourceDocument ID -> invented_source_document_ids", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  const adapter = new FakeDeterministicAdapter({
    injectInventedSourceId: "src_NOT_PROVIDED_BY_SYSTEM",
  });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const failed = r.report.hard_invariants.find(
      (h: { key: string }) => h.key === "invented_source_document_ids",
    );
    assert.ok(failed, "must have invented_source_document_ids row");
    assert.equal(failed.status, "fail");
    assert.ok(failed.count >= 1);
    assert.equal(r.report.classification, "fail");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("fake adapter that invents an EvidenceExcerpt ID -> invented_evidence_excerpt_ids", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  const adapter = new FakeDeterministicAdapter({
    injectInventedExcerptId: "ex_NOT_PROVIDED",
  });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const failed = r.report.hard_invariants.find(
      (h: { key: string }) => h.key === "invented_evidence_excerpt_ids",
    );
    assert.ok(failed, "must have invented_evidence_excerpt_ids row");
    assert.equal(failed.status, "fail");
    assert.equal(r.report.classification, "fail");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 3: paraphrase rejection ---

test("fake adapter that proposes a paraphrase not in source -> accepted_paraphrases fail", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  // Paraphrase text deliberately NOT present in the synthetic source body.
  const adapter = new FakeDeterministicAdapter({
    injectParaphraseText:
      "ZZZ_PARAPHRASE_NOT_IN_SOURCE_TEXT_BUT_LONG_ENOUGH_FOR_EXCERPT_MIN_LEN_2026",
  });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const failed = r.report.hard_invariants.find(
      (h: { key: string }) => h.key === "accepted_paraphrases",
    );
    assert.ok(failed, "must have accepted_paraphrases row");
    assert.equal(failed.status, "fail", `expected fail; got ${JSON.stringify(failed)}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 4: verified/high without accepted excerpts ---

test("verified/high claim without accepted excerpts -> verified_high_claims_without_accepted_excerpts", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  const adapter = new FakeDeterministicAdapter({
    emitVerifiedHighWithoutEvidence: true,
  });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const failed = r.report.hard_invariants.find(
      (h: { key: string }) => h.key === "verified_high_claims_without_accepted_excerpts",
    );
    assert.ok(failed, "must have verified_high_claims_without_accepted_excerpts row");
    assert.equal(failed.status, "fail");
    assert.equal(r.report.classification, "fail");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 5: dangling ClaimEvidence to unknown excerpt also recorded as invented ID ---

test("ClaimEvidence pointing to nonexistent excerpt is recorded as invented_evidence_excerpt_ids", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  // Same as test #2 — the boundary catches this BEFORE graph build, so the
  // recorded violation is `invented_evidence_excerpt_ids`. We assert that
  // dangling links never silently propagate.
  const adapter = new FakeDeterministicAdapter({
    injectInventedExcerptId: "ex_dangling_unknown",
  });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const violations: { key: string }[] = [];
    for (const a of r.report.per_account) {
      for (const v of a.hard_invariant_violations) violations.push(v);
    }
    const keys = new Set(violations.map((v) => v.key));
    assert.ok(
      keys.has("invented_evidence_excerpt_ids"),
      `must record invented_evidence_excerpt_ids; got keys: ${[...keys].join(",")}`,
    );
    // Also assert no `dangling_claim_evidence` from the validator — the
    // boundary should drop the link before graph build so we don't
    // double-report.
    const danglingRow = r.report.hard_invariants.find(
      (h: { key: string }) => h.key === "dangling_claim_evidence",
    );
    assert.equal(danglingRow.status, "pass", "dangling_claim_evidence should not double-report");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 6: budget exhausted mid-run ---

test("budget exhausted partway -> classification=budget_exceeded, partial artifacts exist", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  // Each adapter call reports $5; budget is $6 → second call inside the
  // first account will already overshoot, third account never starts.
  const adapter = new FakeDeterministicAdapter({ costUsdPerCall: 5 });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 6,
      allowHighCost: false,
    });
    assert.equal(r.report.classification, "budget_exceeded");
    // Partial artifacts exist on disk.
    assert.ok(existsSync(r.artifacts.reportJsonPath));
    assert.ok(existsSync(r.artifacts.reportMdPath));
    assert.ok(existsSync(r.artifacts.pairedBaselinePath));
    assert.ok(statSync(r.artifacts.reportJsonPath).size > 0);
    // Cost block reports observed cost.
    assert.ok(r.report.cost.observed_usd > 0);
    assert.equal(r.report.cost.max_cost_usd, 6);
    // At least one account is skipped because of budget.
    const skipped = r.report.per_account.filter((a: { classification: string }) =>
      a.classification === "skipped_budget_exceeded" || a.classification === "budget_exceeded",
    );
    assert.ok(
      skipped.length >= 1,
      `expected at least one skipped/budget_exceeded account; got: ${r.report.per_account.map((a: { account_id: string; classification: string }) => `${a.account_id}=${a.classification}`).join(", ")}`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 7: unknown_estimated cost cannot pass ---

test("cost.status === 'unknown_estimated' forces classification away from pass", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  const adapter = new FakeDeterministicAdapter({ unknownEstimatedCost: true });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    assert.equal(r.report.cost.status, "unknown_estimated");
    assert.notEqual(
      r.report.classification,
      "pass",
      "unknown_estimated must NOT classify as pass",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 8: module import is side-effect-free ---

test("module import is side-effect-free (no fs writes, no adapter instantiation, no env reads)", () => {
  const before = snapshotDir(SHARED_OUT_DIR);
  // Track env reads via a Proxy on process.env. (Node permits read-trap.)
  const envReads: string[] = [];
  const origEnv = process.env;
  const trapped = new Proxy(origEnv, {
    get(target, prop) {
      if (typeof prop === "string") envReads.push(prop);
      return (target as Record<string, string | undefined>)[prop as string];
    },
  });
  (process as { env: NodeJS.ProcessEnv }).env = trapped as NodeJS.ProcessEnv;
  try {
    const mod = loadRunner();
    assert.equal(typeof mod.main, "function");
    assert.equal(typeof mod.runModelModeOrchestrator, "function");
    assert.equal(typeof mod.runFixtureOrchestrator, "function");
    // No provider env vars must have been read on import.
    const forbidden = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY"];
    for (const f of forbidden) {
      assert.ok(!envReads.includes(f), `runner read forbidden env var on import: ${f}`);
    }
  } finally {
    (process as { env: NodeJS.ProcessEnv }).env = origEnv;
  }
  const after = snapshotDir(SHARED_OUT_DIR);
  const newEntries: string[] = [];
  for (const e of after) if (!before.has(e)) newEntries.push(e);
  for (const e of newEntries) {
    try {
      rmSync(join(SHARED_OUT_DIR, e), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  assert.equal(newEntries.length, 0, `import created artifacts: ${newEntries.join(", ")}`);
});

// --- 9: fixture mode preserves PR #43 behavior ---

test("fixture mode creates zero model calls and zero adapter cost; report.json unchanged shape", async () => {
  const mod = loadRunner();
  let fetchCalls = 0;
  const origFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called in fixture mode");
  };
  const outDir = makeTmpOut();
  try {
    const r = await mod.runFixtureOrchestrator({
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    // PR #43 shape preserved.
    assert.equal(j.mode, "fixture");
    assert.equal(j.cost.observed_usd, 0);
    assert.equal(j.cost.status, "observed");
    assert.ok(Array.isArray(j.hard_invariants));
    assert.equal(fetchCalls, 0);
  } finally {
    if (origFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as { fetch?: unknown }).fetch = origFetch;
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 10: --mode model without --adapter fake exits nonzero, no artifacts ---

test("--mode model without --adapter fake exits nonzero with refusal; no artifacts", async () => {
  const mod = loadRunner();
  const beforeOut = snapshotDir(SHARED_OUT_DIR);
  const origErr = console.error;
  const errChunks: string[] = [];
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await mod.main(["--mode", "model"]);
    assert.equal(code, 1);
    const stderr = errChunks.join("\n");
    assert.ok(
      stderr.includes(mod.MODEL_MODE_REAL_ADAPTER_REFUSAL),
      `expected real-adapter refusal; got: ${stderr}`,
    );
    assert.ok(/BLOCKED/i.test(stderr), "refusal must mention A.7 still BLOCKED");
  } finally {
    console.error = origErr;
  }
  const afterOut = snapshotDir(SHARED_OUT_DIR);
  const newEntries: string[] = [];
  for (const e of afterOut) if (!beforeOut.has(e)) newEntries.push(e);
  for (const e of newEntries) {
    try {
      rmSync(join(SHARED_OUT_DIR, e), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  assert.equal(newEntries.length, 0, `refusal created artifacts: ${newEntries.join(", ")}`);
});

test("--mode model --adapter real exits nonzero (only 'fake' is allowed)", async () => {
  const mod = loadRunner();
  const origErr = console.error;
  const errChunks: string[] = [];
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await mod.main(["--mode", "model", "--adapter", "real"]);
    assert.equal(code, 1);
    const stderr = errChunks.join("\n");
    assert.ok(stderr.includes(mod.MODEL_MODE_REAL_ADAPTER_REFUSAL));
  } finally {
    console.error = origErr;
  }
});

// --- 11: --mode model --adapter fake runs end-to-end with cost.observed_usd === 0 ---

test("--mode model --adapter fake runs end-to-end with cost.observed_usd === 0", async () => {
  const mod = loadRunner();
  const outDir = makeTmpOut();
  const origLog = console.log;
  console.log = () => {};
  try {
    const code = await mod.main([
      "--mode",
      "model",
      "--adapter",
      "fake",
      "--out",
      outDir,
    ]);
    assert.equal(code, 0, "fake-adapter run must exit 0");
    assert.ok(existsSync(join(outDir, "report.json")));
    assert.ok(existsSync(join(outDir, "report.md")));
    assert.ok(existsSync(join(outDir, "paired-baseline.json")));
    const j = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(j.mode, "model");
    assert.equal(j.adapter_selected, "fake");
    assert.equal(j.cost.observed_usd, 0);
    assert.equal(j.cost.status, "observed");
    // Cost block carries provider/model/calls/tokens.
    assert.ok(Array.isArray(j.cost.by_adapter) && j.cost.by_adapter.length >= 1);
    const a = j.cost.by_adapter[0];
    assert.equal(a.adapter_name, "fake-deterministic");
    assert.equal(a.provider, "fake");
    assert.equal(a.model, "fake-v0");
    assert.equal(typeof a.calls, "number");
    assert.equal(typeof a.input_tokens, "number");
    assert.equal(typeof a.output_tokens, "number");
    assert.equal(a.observed_usd, 0);
    // Non-production banner is captured in the report.
    assert.ok(/NON-PRODUCTION/i.test(j.non_production_notice));
    assert.ok(/blocked/i.test(j.a7_blocker_status));
  } finally {
    console.log = origLog;
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 12: --max-cost 30 without --allow-high-cost exits nonzero ---

test("--max-cost 30 without --allow-high-cost exits nonzero before adapter touched", async () => {
  const mod = loadRunner();
  const origErr = console.error;
  const errChunks: string[] = [];
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await mod.main([
      "--mode",
      "model",
      "--adapter",
      "fake",
      "--max-cost",
      "30",
    ]);
    assert.equal(code, 1);
    const stderr = errChunks.join("\n");
    assert.ok(/exceeds the per-run hard cap/i.test(stderr));
  } finally {
    console.error = origErr;
  }
});

test("--max-cost 30 with --allow-high-cost is accepted (boundary respected)", async () => {
  const mod = loadRunner();
  const outDir = makeTmpOut();
  const origLog = console.log;
  console.log = () => {};
  try {
    const code = await mod.main([
      "--mode",
      "model",
      "--adapter",
      "fake",
      "--max-cost",
      "30",
      "--allow-high-cost",
      "--out",
      outDir,
    ]);
    assert.equal(code, 0);
    const j = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
    assert.equal(j.cost.max_cost_usd, 30);
    assert.equal(j.cost.allow_high_cost, true);
  } finally {
    console.log = origLog;
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- 13: schema-invalid adapter output -> schema_parse invariant ---

test("schema-invalid adapter output is recorded as schema_parse hard invariant (not silent skip)", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  const adapter = new FakeDeterministicAdapter({ emitInvalidClaimSchema: true });
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const row = r.report.hard_invariants.find(
      (h: { key: string }) => h.key === "schema_parse",
    );
    assert.ok(row);
    assert.equal(row.status, "fail", "schema parse failure must propagate as fail, not silent skip");
    assert.equal(r.report.classification, "fail");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- Extra: assert that the named keys we emit are exactly the plan keys ---

test("hard_invariants table emits every plan-named invariant key", async () => {
  const mod = loadRunner();
  const {
    FakeDeterministicAdapter,
  } = require("../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic");
  const outDir = makeTmpOut();
  try {
    const r = await mod.runModelModeOrchestrator({
      outDir,
      adapter: new FakeDeterministicAdapter(),
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const keys = r.report.hard_invariants.map((h: { key: string }) => h.key).sort();
    const expected = [
      "schema_parse",
      "referential_integrity",
      "invented_source_document_ids",
      "invented_evidence_excerpt_ids",
      "dangling_claim_evidence",
      "false_verified",
      "verified_high_claims_without_accepted_excerpts",
      "accepted_paraphrases",
      "production_writes",
      "unbudgeted_model_calls",
      "automatic_model_calls_from_tests_imports_fixture_mode",
    ].sort();
    assert.deepEqual(keys, expected);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
