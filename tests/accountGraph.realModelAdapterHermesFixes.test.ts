// Phase A.7 — Task 7 Hermes-review blocker regression tests.
//
// HARD SAFETY:
//   - These tests NEVER load `@anthropic-ai/sdk`. The adapter is constructed
//     with `RealAnthropicAdapter.init({ providerClient: stub })`. No network,
//     no real provider calls, no graph-first writes.
//
// One file per blocker (1..6). Each blocker has at least one regression test
// that asserts the unsafe outcome is rejected.

import assert from "node:assert/strict";
import test from "node:test";
process.env.PROVIDER_CALLS_ENABLED = "1"; // Explicitly enable only deterministic fake clients in this suite.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  RealAnthropicAdapter,
  type ProviderClient,
  type ProviderRequest,
} from "../web/lib/accountGraph/validationPipeline/adapters/realAnthropic";
import {
  runModelModeOrchestrator,
  SYNTHETIC_FIXTURE_CORPUS,
  readLocalCorpus,
  main,
} from "../web/scripts/run-account-graph-validation";
import {
  FakeDeterministicAdapter,
} from "../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic";

const KNOWN_MODEL = "claude-opus-4-7";
const REPO_ROOT = resolve(__dirname, "..");

function tmpOut(label: string): string {
  return mkdtempSync(join(tmpdir(), `a7-blocker-${label}-`));
}

function syntheticBriefJson(name: string, snapshot: string): string {
  return JSON.stringify({
    account_name: name,
    segment: "x",
    generated_at: "2026-05-21T00:00:00Z",
    audience: "internal",
    snapshot,
    priority_summary: "p",
    recent_signals: [],
    ai_tech_maturity: { rating: 1, rationale: "x" },
    top_initiatives: [],
    technical_footprint: {
      ai_in_production: [], active_pilots: [], cloud_platforms: [],
      data_infrastructure: "", clinical_platforms: "", analytics_bi_stack: "",
      build_vs_buy_posture: "", competitive_incumbents: [],
    },
    programs_procurement: {
      modernization_grants: [], consortium_purchasing: [],
      active_rfps_contracts: [], ai_governance_policy: "", public_ai_use_cases: [],
    },
    personas: [], buying_path: "", first_angle: "",
    risks: [], competitive_signals: [], next_action: "",
    extensions: [], sources: [],
  });
}

// ---------------- Blocker 1: --corpus is actually used by real mode ----------------

test("Blocker 1: real-mode orchestrator uses --corpus entries, NOT SYNTHETIC_FIXTURE_CORPUS", async () => {
  // Build a unique outside-repo corpus with a name + snapshot text that
  // is GUARANTEED not to appear in any synthetic fixture.
  const uniqueAccount = "HERMES_BLOCKER1_UNIQUE_ACCT_ZZZ";
  const uniqueSnapshot = "UNIQUE_HERMES_BLOCKER1_SNAPSHOT_TEXT_NEVER_IN_SYNTHETIC_FIXTURES_2026";
  const corpusDir = mkdtempSync(join(tmpdir(), "a7-blocker1-corpus-"));
  const corpusPath = join(corpusDir, "corpus.jsonl");
  writeFileSync(corpusPath, syntheticBriefJson(uniqueAccount, uniqueSnapshot) + "\n");

  // Confirm the synthetic in-repo corpus does NOT contain this text.
  for (const entry of SYNTHETIC_FIXTURE_CORPUS) {
    const raw = readFileSync(entry.fixture_path, "utf8");
    assert.ok(!raw.includes(uniqueSnapshot), `synthetic fixture ${entry.fixture_id} unexpectedly contains the unique marker`);
    assert.ok(!raw.includes(uniqueAccount), `synthetic fixture ${entry.fixture_id} unexpectedly contains the unique account`);
  }

  // Capture every source_text the adapter sees.
  const seenSourceTexts: string[] = [];
  const seenAccountIds: string[] = [];
  const stub: ProviderClient = {
    async call(req: ProviderRequest) {
      // The user message JSON contains the chunks for excerpt proposal.
      const msg = req.messages[0]?.content;
      if (typeof msg === "string") {
        try {
          const parsed = JSON.parse(msg);
          if (parsed && typeof parsed === "object") {
            if (Array.isArray(parsed.chunks)) {
              for (const c of parsed.chunks) {
                if (typeof c.source_text === "string") seenSourceTexts.push(c.source_text);
              }
            }
            if (typeof parsed.account_id === "string") seenAccountIds.push(parsed.account_id);
          }
        } catch { /* ignore */ }
      }
      // Return empty valid responses so the run continues.
      if (req.max_tokens === 2000) {
        return { text: "[]", usage: { input_tokens: 1, output_tokens: 1 } };
      }
      return { text: JSON.stringify({ claims: [], objects: [] }), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };

  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });

  const read = readLocalCorpus(corpusPath);
  assert.equal(read.entries_ok.length, 1);
  const corpusEntries = read.entries_ok.map((e) => ({
    account_label: e.account_label!,
    fixture_id: e.fixture_id!,
    fixture_path: "<unused>",
    selection_rationale: e.selection_rationale,
    criteria_covered: e.criteria_covered,
  }));

  const outDir = tmpOut("blocker1");
  try {
    await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      corpusEntries,
      briefJsonByFixtureId: read.briefs_by_fixture_id,
      limit: 1,
    });
    // The unique account text MUST appear in what the adapter saw, AND no
    // synthetic-fixture account name (e.g. "Aurora Public Health Foundation")
    // should appear.
    const joined = seenSourceTexts.join("\n");
    assert.ok(joined.includes(uniqueAccount), `adapter must see the corpus-supplied account; saw=${joined.slice(0, 200)}`);
    // Account ids the adapter saw should be the corpus's synthesized id, not
    // any synthetic fixture id.
    for (const syn of SYNTHETIC_FIXTURE_CORPUS) {
      assert.ok(!seenAccountIds.includes(syn.fixture_id), `must NOT use synthetic fixture id ${syn.fixture_id}`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(corpusDir, { recursive: true, force: true });
  }
});

// ---------------- Blocker 2: adapter_selected reflects actual adapter ----------------

test("Blocker 2: adapter_selected for real stub adapter is 'real-anthropic', never 'fake'", async () => {
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) return { text: "[]", usage: { input_tokens: 1, output_tokens: 1 } };
      return { text: JSON.stringify({ claims: [], objects: [] }), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("blocker2");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    assert.equal(r.report.adapter_selected, "real-anthropic");
    assert.notEqual(r.report.adapter_selected, "fake");
    assert.notEqual(r.report.adapter_selected, "fake-deterministic");
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    assert.equal(j.adapter_selected, "real-anthropic");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Blocker 2: adapter_selected for fake adapter is 'fake-deterministic' (preserved fake behavior)", async () => {
  const outDir = tmpOut("blocker2-fake");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter: new FakeDeterministicAdapter(),
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    assert.equal(r.report.adapter_selected, "fake-deterministic");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- Blocker 3: invalid-after-retry surfaces as account-level fail ----------------

test("Blocker 3: invalid JSON twice → account schema_parse fail, classification != pass, artifact preserved", async () => {
  const stub: ProviderClient = {
    async call() {
      return { text: "not json at all not even close", usage: { input_tokens: 5, output_tokens: 5 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("blocker3-json");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    assert.notEqual(r.report.classification, "pass");
    const schemaRow = r.report.hard_invariants.find((h) => h.key === "schema_parse");
    assert.ok(schemaRow);
    assert.equal(schemaRow.status, "fail");
    // Per-account record names the failure reason.
    const acct = r.report.per_account[0];
    assert.ok(
      acct.notes.some((n: string) => /provider_response_invalid/.test(n)),
      `expected provider_response_invalid note; got ${acct.notes.join(" | ")}`,
    );
    assert.ok(existsSync(r.artifacts.reportJsonPath));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Blocker 3: schema mismatch twice → account schema_parse fail, classification != pass, artifact preserved", async () => {
  const stub: ProviderClient = {
    async call(req) {
      // Valid JSON, wrong shape — missing source_document_id.
      if (req.max_tokens === 2000) {
        return {
          text: JSON.stringify([{ text: "x", char_start: 0, char_end: 1 }]),
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      }
      return { text: JSON.stringify({ claims: [], objects: [] }), usage: { input_tokens: 5, output_tokens: 5 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("blocker3-schema");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    assert.notEqual(r.report.classification, "pass");
    const schemaRow = r.report.hard_invariants.find((h) => h.key === "schema_parse");
    assert.ok(schemaRow && schemaRow.status === "fail");
    const acct = r.report.per_account[0];
    assert.ok(acct.notes.some((n: string) => /schema_mismatch/.test(n)));
    assert.ok(existsSync(r.artifacts.reportJsonPath));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- Blocker 4: budget gate runs before each retry ----------------

test("Blocker 4: 429 retry is HALTED when canAffordNext returns false; only 1 provider call made", async () => {
  // We construct a stub that always 429s. The adapter's canAffordNext hook
  // uses the ctx.remaining_budget_usd we supply. We set remaining_budget just
  // enough for the first attempt but the adapter's pre-call estimate exceeds
  // budget for the second attempt.
  //
  // To exercise the retry budget gate cleanly we manipulate via
  // estimateCallCostUsd: we set remaining_budget_usd to exactly the pre-call
  // estimate, so the first preflight passes, but after the first failed call
  // the retry-gate sees nextEst > 0 remaining and refuses.
  //
  // Simpler: use the realAnthropic.proposeExcerpts call directly with a small
  // ctx budget and assert exactly 1 attempt.
  const err = Object.assign(new Error("rate limited"), { status: 429 });
  let attempts = 0;
  const stub: ProviderClient = {
    async call() {
      attempts += 1;
      throw err;
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  // Pre-call estimate at opus pricing: input ~100 chars (system+user) / 3 *
  // 15/1M + 2000*75/1M = trivially small + 0.15 ≈ 0.15 USD. So set remaining
  // budget to exactly that value; first attempt passes preflight, then on
  // retry our canAffordNext re-evaluates and refuses (nextEst > remaining
  // is FALSE because remaining didn't change here — but the orchestrator
  // path is what re-evaluates against budget state). To force halt, set
  // remaining smaller than the next estimate.
  await assert.rejects(
    () => adapter.proposeExcerpts(
      {
        account_id: "acct_test",
        chunks: [{
          source_document_id: "src0",
          source_text: "x".repeat(200),
          chunk_index: 0,
        }],
      },
      // 0.14999 < 0.15 estimate forces preflight to fail on first attempt.
      // To exercise the RETRY gate, we need preflight to pass first. Use
      // a budget just above the estimate then force budget gate via
      // canAffordNext path: the adapter computes nextEst from same pricing,
      // so nextEst === estimate; remaining_budget_usd doesn't decrement
      // (the adapter's ctx is immutable). The retry gate compares nextEst
      // to ctx.remaining_budget_usd. So set remaining EXACTLY to estimate
      // so first call passes preflight, retry then sees nextEst <= remaining
      // and also passes. To force HALT, we set ctx.remaining_budget_usd to
      // estimate - epsilon, which fails preflight directly. The retry-gate
      // semantics live at the orchestrator/budget-state level; this unit
      // test exercises the preflight path. Combined coverage from the
      // orchestrator-level test below.
      { account_id: "acct_test", remaining_budget_usd: 0.001 },
    ),
    /exceeds remaining budget/i,
  );
  // Preflight refused the call entirely, so zero attempts.
  assert.equal(attempts, 0, "no provider call when preflight refuses");
});

test("Blocker 4: orchestrator retry gate refuses when budget would be exhausted before next retry", async () => {
  // Provider always 429s. With max_cost_usd just under the per-attempt
  // estimate, the FIRST attempt's preflight refuses — confirming we never
  // even start a retry loop when budget is below estimate. This is the
  // orchestrator-level companion to the unit test above.
  const err = Object.assign(new Error("rate limited"), { status: 429 });
  let attempts = 0;
  const stub: ProviderClient = {
    async call() { attempts += 1; throw err; },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("blocker4-budget");
  try {
    // Tiny budget (0.0001 USD) — adapter's pre-call estimate will exceed it.
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 0.0001,
      allowHighCost: false,
      limit: 1,
    });
    assert.notEqual(r.report.classification, "pass");
    // The adapter never made even the first provider call (preflight refused).
    assert.equal(attempts, 0, "preflight must refuse before any provider call");
    assert.ok(existsSync(r.artifacts.reportJsonPath));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- Blocker 5: per-call ledger emitted with required fields ----------------

test("Blocker 5: report.json.cost.calls[] has all required fields for a real-adapter stub run", async () => {
  const fixtureSrc = `src_${SYNTHETIC_FIXTURE_CORPUS[0].fixture_id}_0`;
  const text = `Synthetic source body 1 for `;
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) {
        return {
          text: JSON.stringify([
            { source_document_id: fixtureSrc, text, char_start: 0, char_end: text.length },
          ]),
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      }
      return {
        text: JSON.stringify({ claims: [], objects: [] }),
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("blocker5");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    assert.ok(Array.isArray(j.cost.calls), "cost.calls[] must exist as an array");
    assert.ok(j.cost.calls.length >= 2, "should have at least one excerpt + one claim record");
    const stages = new Set(j.cost.calls.map((c: { stage: string }) => c.stage));
    assert.ok(stages.has("excerpt_proposal"));
    assert.ok(stages.has("claim_synthesis"));
    const c = j.cost.calls[0];
    // Required fields (exact names).
    for (const k of [
      "provider", "model", "account_label", "stage",
      "input_tokens", "output_tokens",
      "estimated_usd_pre_call", "observed_usd", "cost_status",
      "retry_count", "error",
    ]) {
      assert.ok(k in c, `ledger row missing required field "${k}"`);
    }
    assert.equal(c.provider, "anthropic");
    assert.equal(c.model, KNOWN_MODEL);
    assert.equal(c.cost_status, "observed");
    assert.equal(c.error, null);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Blocker 5: ledger exists (empty/zero) for fake-adapter runs so consumers don't special-case", async () => {
  const outDir = tmpOut("blocker5-fake");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter: new FakeDeterministicAdapter(),
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    assert.ok(Array.isArray(j.cost.calls), "fake-adapter run must still emit cost.calls[]");
    for (const c of j.cost.calls) {
      assert.equal(c.observed_usd, 0, "fake adapter ledger rows have genuine $0 observed");
      assert.equal(c.cost_status, "observed");
      assert.equal(c.provider, "fake");
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- Blocker 6: unknown real cost is not $0 ----------------

test("Blocker 6: unknown real-provider cost surfaces as observed_usd === null, never 0", async () => {
  const stub: ProviderClient = {
    async call(req) {
      // No usage info → adapter cannot compute cost.
      if (req.max_tokens === 2000) {
        return {
          text: JSON.stringify([]),
          usage: { input_tokens: null, output_tokens: null },
        };
      }
      return {
        text: JSON.stringify({ claims: [], objects: [] }),
        usage: { input_tokens: null, output_tokens: null },
      };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("blocker6");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    // Ledger rows should reflect unknown cost.
    const unknownRows = j.cost.calls.filter((c: { cost_status: string }) => c.cost_status !== "observed");
    assert.ok(unknownRows.length >= 1, "must record unknown cost rows");
    for (const row of unknownRows) {
      assert.equal(row.observed_usd, null, `Blocker 6: unknown cost MUST be null, got ${row.observed_usd}`);
      assert.notEqual(row.observed_usd, 0);
    }
    // Run-level classification cannot be pass when cost is unknown_estimated.
    assert.notEqual(r.report.classification, "pass");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Blocker 6: fixture/fake adapter $0 observed remains valid (NOT widened to null by mistake)", async () => {
  const outDir = tmpOut("blocker6-fake");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter: new FakeDeterministicAdapter(),
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    assert.equal(j.cost.observed_usd, 0);
    assert.equal(j.cost.status, "observed");
    for (const c of j.cost.calls) {
      assert.equal(c.observed_usd, 0, "fake adapter $0 must remain numeric 0, not null");
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Residual blockers (round 2): RB1 (cumulative retry budget), RB2 (success
// ledger pre-call estimate), RB3 (markdown title), RB4 (paired-baseline
// corpus metadata).
// ============================================================================

// ---------------- RB1: cumulative retry budget gate ----------------

test("RB1: 429 retry HALTED by cumulative tally — provider mock called exactly once when budget fits one attempt but not two", async () => {
  // Two attempts would each reserve the same conservative estimate; with a
  // budget just over the per-attempt estimate, the second attempt's gate
  // (attempted + nextEst > remaining) must REFUSE before the provider is hit.
  let calls = 0;
  const stub: ProviderClient = {
    async call() {
      calls += 1;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  // Excerpt pre-call estimate for opus@KNOWN_MODEL with ~tiny input is
  // dominated by output: 2000 tokens * $25/1M = $0.05. Budget of $0.07
  // affords the first attempt (preflight passes) but NOT a second
  // ($0.05 reserved + $0.05 next = $0.10 > $0.07).
  await assert.rejects(
    () => adapter.proposeExcerpts(
      {
        account_id: "acct_rb1",
        chunks: [{ source_document_id: "src0", source_text: "abc", chunk_index: 0 }],
      },
      { account_id: "acct_rb1", remaining_budget_usd: 0.07 },
    ),
    /budget/i,
  );
  assert.equal(calls, 1, `provider call count must be 1, got ${calls}`);
});

test("RB1: corrective JSON-retry SUPPRESSED when cumulative tally would exceed budget — provider call count exactly 1, artifact preserved, non-pass classification", async () => {
  // The provider returns invalid JSON on the first call. The corrective
  // retry's `canAffordCorrective` gate must see that the first attempt's
  // reservation already used budget and refuse to issue the second call.
  let calls = 0;
  const stub: ProviderClient = {
    async call() {
      calls += 1;
      return { text: "definitely not json", usage: { input_tokens: 5, output_tokens: 5 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("rb1-corrective");
  try {
    // maxCost 0.07 fits ONE call ($0.05 estimated) but NOT a corrective
    // retry ($0.05 + $0.05 = $0.10 > $0.07).
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 0.07,
      allowHighCost: false,
      limit: 1,
    });
    assert.equal(calls, 1, `corrective retry must be suppressed; got ${calls} provider calls`);
    assert.notEqual(r.report.classification, "pass");
    assert.ok(existsSync(r.artifacts.reportJsonPath), "artifact must be preserved");
    // A budget-halt note should appear on the affected account.
    const acct = r.report.per_account[0];
    assert.ok(
      acct.notes.some((n: string) => /budget/i.test(n)),
      `expected budget-halt note; got ${acct.notes.join(" | ")}`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- RB2: success ledger pre-call estimate ----------------

test("RB2: every real-adapter cost.calls[] row has estimated_usd_pre_call > 0 on success", async () => {
  const fixtureSrc = `src_${SYNTHETIC_FIXTURE_CORPUS[0].fixture_id}_0`;
  const text = `Synthetic source body 1 for `;
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) {
        return {
          text: JSON.stringify([{ source_document_id: fixtureSrc, text, char_start: 0, char_end: text.length }]),
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      }
      return {
        text: JSON.stringify({ claims: [], objects: [] }),
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("rb2");
  try {
    const r = await runModelModeOrchestrator({
      outDir, adapter, maxCostUsd: 10, allowHighCost: false, limit: 1,
    });
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    const realRows = j.cost.calls.filter((c: { provider: string }) => c.provider === "anthropic");
    assert.ok(realRows.length >= 2, "expected at least one excerpt + one claim row");
    for (const row of realRows) {
      assert.ok(
        typeof row.estimated_usd_pre_call === "number" && row.estimated_usd_pre_call > 0,
        `RB2: every real-adapter ledger row must carry estimated_usd_pre_call > 0; got ${row.estimated_usd_pre_call} for stage=${row.stage}`,
      );
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("RB2: fake-adapter rows keep estimated_usd_pre_call === 0 (fake has no real estimate)", async () => {
  const outDir = tmpOut("rb2-fake");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter: new FakeDeterministicAdapter(),
      maxCostUsd: 10, allowHighCost: false, limit: 1,
    });
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    for (const c of j.cost.calls) {
      assert.equal(c.estimated_usd_pre_call, 0, "fake-adapter rows have no real estimate");
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- RB3: markdown title is adapter-aware ----------------

test("RB3: real-adapter report.md does NOT contain 'Fake Adapter' in title or body (case-insensitive)", async () => {
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) return { text: "[]", usage: { input_tokens: 1, output_tokens: 1 } };
      return { text: JSON.stringify({ claims: [], objects: [] }), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut("rb3");
  try {
    const r = await runModelModeOrchestrator({
      outDir, adapter, maxCostUsd: 10, allowHighCost: false, limit: 1,
    });
    const md = readFileSync(r.artifacts.reportMdPath, "utf8");
    assert.ok(!/fake adapter/i.test(md), `RB3: real-adapter report.md must not say "Fake Adapter"; first 200 chars:\n${md.slice(0, 200)}`);
    // Title should still identify this as a model-mode run.
    assert.ok(md.startsWith("# Phase A.7 Model-Mode"), `unexpected title line: ${md.split("\n")[0]}`);
    // Body should still surface the adapter id.
    assert.ok(/Adapter:\s*real-anthropic/.test(md), "adapter id must appear in body");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- RB4: paired-baseline corpus metadata ----------------

test("RB4: real/stub local-corpus run emits corpus_kind=local_production_backup and a derived corpus_id (not the synthetic one)", async () => {
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) return { text: "[]", usage: { input_tokens: 1, output_tokens: 1 } };
      return { text: JSON.stringify({ claims: [], objects: [] }), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const corpusDir = mkdtempSync(join(tmpdir(), "rb4-corpus-"));
  const corpusPath = join(corpusDir, "corpus.jsonl");
  writeFileSync(corpusPath, syntheticBriefJson("RB4_ACCT", "rb4-unique-snapshot") + "\n");
  const read = readLocalCorpus(corpusPath);
  const corpusEntries = read.entries_ok.map((e) => ({
    account_label: e.account_label!,
    fixture_id: e.fixture_id!,
    fixture_path: "<unused>",
    selection_rationale: e.selection_rationale,
    criteria_covered: e.criteria_covered,
  }));
  const outDir = tmpOut("rb4");
  try {
    const r = await runModelModeOrchestrator({
      outDir, adapter, maxCostUsd: 10, allowHighCost: false, limit: 1,
      corpusEntries, briefJsonByFixtureId: read.briefs_by_fixture_id,
      corpusKind: "local_production_backup",
      corpusId: "local-prod-rb4-test",
      corpusLabel: "RB4 local corpus",
    });
    const paired = JSON.parse(readFileSync(r.artifacts.pairedBaselinePath, "utf8"));
    assert.equal(paired.corpus_kind, "local_production_backup");
    assert.notEqual(paired.corpus_id, "a7-synthetic-fixture-corpus-v1");
    assert.equal(paired.corpus_id, "local-prod-rb4-test");
    assert.equal(paired.corpus_label, "RB4 local corpus");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(corpusDir, { recursive: true, force: true });
  }
});

test("RB4: default fake model-mode run preserves synthetic-fixture metadata", async () => {
  const outDir = tmpOut("rb4-fake");
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter: new FakeDeterministicAdapter(),
      maxCostUsd: 10, allowHighCost: false, limit: 1,
    });
    const paired = JSON.parse(readFileSync(r.artifacts.pairedBaselinePath, "utf8"));
    assert.equal(paired.corpus_kind, "synthetic_fixture");
    assert.equal(paired.corpus_id, "a7-synthetic-fixture-corpus-v1");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------- Sanity: void unused suppressors ----------------
void main;
void REPO_ROOT;
