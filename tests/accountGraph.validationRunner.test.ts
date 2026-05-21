// Phase A.7 validation runner skeleton — tests.
//
// These tests assert HARD safety properties:
//   - Importing the runner does not execute `main`, does not write artifacts.
//   - Fixture mode performs zero model/provider calls, zero web fetches.
//   - Fixture mode invokes the adapter through the `ModelAdapter` interface.
//   - `--mode model` exits nonzero with a clear refusal and DOES NOT call the
//     fake adapter, instantiate a provider, perform a web fetch, or write
//     artifacts.
//   - report.json carries exactly the named hard-invariant / soft-metrics
//     fields the plan requires.
//   - `cost.status === "unknown_estimated"` cannot classify as `pass`.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const RUNNER_PATH = "../web/scripts/run-account-graph-validation";
const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = join(REPO_ROOT, "out", "account-graph-validation");

function snapshotDir(p: string): Set<string> {
  if (!existsSync(p)) return new Set<string>();
  return new Set(readdirSync(p));
}

function makeTmpOut(): string {
  return mkdtempSync(join(tmpdir(), "a7-validation-test-"));
}

test("importing the runner does NOT execute main and does NOT write artifacts", () => {
  const before = snapshotDir(OUT_DIR);
  // Importing must be a pure module load.
  const mod = require(RUNNER_PATH);
  assert.equal(typeof mod.main, "function", "runner must export `main`");
  assert.equal(typeof mod.runFixtureOrchestrator, "function");
  assert.equal(typeof mod.classify, "function");
  assert.equal(typeof mod.buildFixtureHardInvariants, "function");
  assert.equal(typeof mod.buildPairedBaselinePlaceholder, "function");
  assert.equal(typeof mod.FakeModelAdapter, "function");

  const after = snapshotDir(OUT_DIR);
  const newEntries: string[] = [];
  for (const e of after) if (!before.has(e)) newEntries.push(e);
  for (const e of newEntries) {
    try {
      rmSync(join(OUT_DIR, e), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  assert.equal(
    newEntries.length,
    0,
    `runner import created artifacts under ${OUT_DIR}: ${newEntries.join(", ")}`,
  );
});

test("fixture mode makes zero web fetches and zero model/provider calls", async () => {
  const mod = require(RUNNER_PATH);
  const outDir = makeTmpOut();

  // Stub global fetch to prove the runner does not call it.
  let fetchCalls = 0;
  const origFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = (..._args: unknown[]) => {
    fetchCalls += 1;
    throw new Error("fetch must not be called in fixture mode");
  };
  try {
    // Spy adapter — proves the runner invokes the adapter through the
    // ModelAdapter interface, not through any concrete provider.
    let proposeCalls = 0;
    let synthesizeCalls = 0;
    const spy: import("../web/scripts/run-account-graph-validation").ModelAdapter = {
      name: "spy-adapter",
      async proposeExcerpts(input) {
        proposeCalls += 1;
        return [
          {
            source_id: input.source_id,
            text: input.source_text.slice(0, 20),
            char_start: 0,
            char_end: Math.min(20, input.source_text.length),
          },
        ];
      },
      async synthesizeClaims(_input) {
        synthesizeCalls += 1;
        return [];
      },
    };
    await mod.runFixtureOrchestrator({ outDir, adapter: spy });
    assert.equal(fetchCalls, 0, "fixture mode must not call fetch");
    assert.ok(proposeCalls >= 1, "runner must invoke adapter.proposeExcerpts");
    assert.ok(synthesizeCalls >= 1, "runner must invoke adapter.synthesizeClaims");
  } finally {
    if (origFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as { fetch?: unknown }).fetch = origFetch;
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("fixture mode invokes FakeModelAdapter through the ModelAdapter interface", async () => {
  const mod = require(RUNNER_PATH);
  const outDir = makeTmpOut();
  try {
    const fake = new mod.FakeModelAdapter();
    assert.equal(fake.proposeExcerptsCalls, 0);
    assert.equal(fake.synthesizeClaimsCalls, 0);
    const result = await mod.runFixtureOrchestrator({ outDir, adapter: fake });
    assert.ok(fake.proposeExcerptsCalls >= 1);
    assert.ok(fake.synthesizeClaimsCalls >= 1);
    assert.equal(result.report.adapter.name, "fake-deterministic");
    assert.ok(result.report.adapter.propose_excerpts_calls >= 1);
    assert.ok(result.report.adapter.synthesize_claims_calls >= 1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("fixture mode emits report.md, report.json, paired-baseline.json", async () => {
  const mod = require(RUNNER_PATH);
  const outDir = makeTmpOut();
  try {
    const result = await mod.runFixtureOrchestrator({
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    assert.ok(existsSync(result.artifacts.reportMdPath));
    assert.ok(existsSync(result.artifacts.reportJsonPath));
    assert.ok(existsSync(result.artifacts.pairedBaselinePath));
    assert.ok(statSync(result.artifacts.reportMdPath).size > 0);
    assert.ok(statSync(result.artifacts.reportJsonPath).size > 0);
    assert.ok(statSync(result.artifacts.pairedBaselinePath).size > 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("paired-baseline.json is the placeholder structure (no synthetic measured baseline)", async () => {
  const mod = require(RUNNER_PATH);
  const outDir = makeTmpOut();
  try {
    const result = await mod.runFixtureOrchestrator({
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    const paired = JSON.parse(readFileSync(result.artifacts.pairedBaselinePath, "utf8"));
    assert.equal(paired.fixture_placeholder, true);
    assert.equal(paired.mode, "fixture");
    assert.deepEqual(paired.accounts, []);
    assert.deepEqual(paired.metrics.per_account, []);
    assert.equal(paired.metrics.aggregate.count, 0);
    assert.ok(typeof paired.notes === "string" && paired.notes.length > 0);
    assert.ok(typeof paired.generated_at === "string");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("report.json.cost.observed_usd === 0 in fixture mode", async () => {
  const mod = require(RUNNER_PATH);
  const outDir = makeTmpOut();
  try {
    const result = await mod.runFixtureOrchestrator({
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    const j = JSON.parse(readFileSync(result.artifacts.reportJsonPath, "utf8"));
    assert.equal(j.cost.status, "observed");
    assert.equal(j.cost.observed_usd, 0);
    assert.equal(j.mode, "fixture");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("--mode model exits nonzero with a clear refusal and does NOT touch FS or adapters", async () => {
  const mod = require(RUNNER_PATH);

  // Stub fetch to prove it's not called.
  let fetchCalls = 0;
  const origFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called in model-mode refusal");
  };

  const beforeOut = snapshotDir(OUT_DIR);
  // Capture stderr to confirm refusal message.
  const origErr = console.error;
  const errChunks: string[] = [];
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await mod.main(["--mode", "model"]);
    assert.equal(code, 1, "--mode model must exit nonzero");
    const stderr = errChunks.join("\n");
    assert.ok(
      stderr.includes(mod.MODEL_MODE_REFUSAL_MESSAGE),
      `expected refusal message; got: ${stderr}`,
    );
    assert.ok(
      /model mode/i.test(stderr) && /not implemented|not enabled/i.test(stderr),
      "refusal must be clear about model mode not being implemented/enabled",
    );
    assert.equal(fetchCalls, 0, "model-mode refusal must not call fetch");
    // No artifacts created under shared out dir.
    const afterOut = snapshotDir(OUT_DIR);
    const newEntries: string[] = [];
    for (const e of afterOut) if (!beforeOut.has(e)) newEntries.push(e);
    for (const e of newEntries) {
      try {
        rmSync(join(OUT_DIR, e), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    assert.equal(
      newEntries.length,
      0,
      `model-mode refusal created artifacts: ${newEntries.join(", ")}`,
    );
  } finally {
    console.error = origErr;
    if (origFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as { fetch?: unknown }).fetch = origFetch;
  }
});

test("generated artifacts land under out/account-graph-validation/ when default --out is used", () => {
  const mod = require(RUNNER_PATH);
  // parseArgs default out should resolve under out/account-graph-validation.
  const args = mod.parseArgs([]);
  assert.ok(
    args.out.includes(`${"out"}${require("node:path").sep}account-graph-validation`),
    `default out must be under out/account-graph-validation/; got ${args.out}`,
  );
});

test("no validation artifacts are tracked by git", () => {
  // `git ls-files` on the ignored output dir should be empty (or only a
  // .gitkeep). We assert no real artifacts are tracked.
  let out = "";
  try {
    out = execSync(`git ls-files ${JSON.stringify("out/account-graph-validation/")}`, {
      cwd: REPO_ROOT,
    })
      .toString()
      .trim();
  } catch {
    out = "";
  }
  if (out.length === 0) {
    // OK — nothing tracked.
    return;
  }
  const lines = out.split("\n").filter((l) => l.length > 0);
  for (const l of lines) {
    assert.ok(
      l.endsWith(".gitkeep"),
      `unexpected tracked validation artifact: ${l}`,
    );
  }
});

test("report.json contains all named hard-invariant fields and a soft_metrics field", async () => {
  const mod = require(RUNNER_PATH);
  const outDir = makeTmpOut();
  try {
    const result = await mod.runFixtureOrchestrator({
      outDir,
      adapter: new mod.FakeModelAdapter(),
    });
    const j = JSON.parse(readFileSync(result.artifacts.reportJsonPath, "utf8"));
    const expected = [
      "schema parse success",
      "referential integrity",
      "invented SourceDocument IDs",
      "invented EvidenceExcerpt IDs",
      "dangling ClaimEvidence",
      "false verified",
      "verified/high claims without accepted excerpts",
      "accepted paraphrases",
      "production writes",
      "unbudgeted model calls",
      "automatic model calls from tests/imports/fixture mode",
    ];
    assert.ok(Array.isArray(j.hard_invariants));
    const names = j.hard_invariants.map((h: { name: string }) => h.name);
    for (const name of expected) {
      assert.ok(names.includes(name), `missing hard invariant: ${name}`);
    }
    // Each entry has the expected structured shape.
    for (const h of j.hard_invariants) {
      assert.ok(typeof h.name === "string");
      assert.ok(["pass", "fail", "not_applicable"].includes(h.status));
      assert.equal(typeof h.count, "number");
      assert.equal(typeof h.notes, "string");
    }
    assert.ok(Array.isArray(j.soft_metrics));
    assert.ok(j.soft_metrics.length > 0);
    assert.ok(typeof j.a7_blocker_status === "string");
    assert.ok(/blocked/i.test(j.a7_blocker_status));
    assert.ok(Array.isArray(j.artifact_paths) && j.artifact_paths.length >= 3);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("classifier: cost.status === 'unknown_estimated' cannot classify as pass", () => {
  const mod = require(RUNNER_PATH);
  // Build an all-pass hard-invariant table; only cost is unknown_estimated.
  const hi = mod.buildFixtureHardInvariants();
  // Force any not_applicable entries to count as pass for this scenario by
  // leaving them; classify only fails on `fail`, never on `not_applicable`.
  const result = mod.classify({
    cost: { status: "unknown_estimated", observed_usd: 0, estimated_usd: 5 },
    hard_invariants: hi,
  });
  assert.notEqual(result, "pass", "unknown_estimated must not classify as pass");
  assert.ok(
    result === "borderline" || result === "fail",
    `unknown_estimated must be borderline or fail; got ${result}`,
  );
});

test("classifier: any hard-invariant fail forces fail even when cost is observed/$0", () => {
  const mod = require(RUNNER_PATH);
  const hi = mod.buildFixtureHardInvariants();
  // Flip one to fail.
  const broken = hi.map((h: { name: string; status: string; count: number; notes: string }, i: number) =>
    i === 0 ? { ...h, status: "fail", count: 1 } : h,
  );
  const result = mod.classify({
    cost: { status: "observed", observed_usd: 0 },
    hard_invariants: broken,
  });
  assert.equal(result, "fail");
});

test("classifier: fixture-mode happy path (observed $0, no fails) classifies as pass", () => {
  const mod = require(RUNNER_PATH);
  const hi = mod.buildFixtureHardInvariants();
  const result = mod.classify({
    cost: { status: "observed", observed_usd: 0 },
    hard_invariants: hi,
  });
  assert.equal(result, "pass");
});
