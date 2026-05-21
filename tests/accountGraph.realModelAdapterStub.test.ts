// Phase A.7 — Task 7: real adapter behavior tests using a STUB provider.
//
// HARD SAFETY:
//   - These tests NEVER load `@anthropic-ai/sdk`. The adapter is constructed
//     with `RealAnthropicAdapter.init({ providerClient: stub })` so the
//     dynamic SDK import path is never taken.
//   - These tests exercise: provider response validation (invalid JSON,
//     schema mismatch, hallucinated source IDs, paraphrased excerpts,
//     claims without evidence, verified/high without accepted excerpts),
//     budget enforcement (pre-call estimate gate, unknown pricing,
//     observed cannot retroactively permit overspend), provider error
//     handling (401/403 fail fast, 429/5xx/timeout retry+preserve,
//     budget exhaustion prevents retry).

import assert from "node:assert/strict";
import test from "node:test";

import {
  RealAnthropicAdapter,
  type ProviderClient,
  type ProviderRequest,
  type ProviderResponse,
} from "../web/lib/accountGraph/validationPipeline/adapters/realAnthropic";
import {
  callWithRetry,
  classifyProviderError,
  ProviderBudgetHaltError,
  ProviderRetriesExhaustedError,
} from "../web/lib/accountGraph/validationPipeline/providerErrors";
import {
  createBudgetState,
  recordCost,
  lookupModelPricing,
  estimateCallCostUsd,
  preflightBudgetGate,
} from "../web/lib/accountGraph/validationPipeline/budget";
import type {
  AdapterContext,
  AdapterExcerptProposalInput,
} from "../web/lib/accountGraph/validationPipeline/types";

const KNOWN_MODEL = "claude-opus-4-7"; // present in PRICING_TABLE

function makeStub(responses: ProviderResponse[]): ProviderClient & { calls: ProviderRequest[] } {
  let i = 0;
  const calls: ProviderRequest[] = [];
  return {
    calls,
    async call(req) {
      calls.push(req);
      if (i >= responses.length) throw new Error(`stub exhausted at call ${i + 1}`);
      const r = responses[i++];
      return r;
    },
  };
}

function makeFailingStub(errors: unknown[]): ProviderClient & { attempts: number } {
  let i = 0;
  const stub: ProviderClient & { attempts: number } = {
    attempts: 0,
    async call() {
      stub.attempts += 1;
      const err = errors[Math.min(i, errors.length - 1)];
      i += 1;
      throw err;
    },
  };
  return stub;
}

function fullChunkInput(): AdapterExcerptProposalInput {
  return {
    account_id: "acct_test",
    chunks: [
      {
        source_document_id: "src_test_0",
        source_text: "Synthetic source text for stub-provider tests. Long enough for excerpts to verify locally.",
        chunk_index: 0,
      },
    ],
  };
}

function ctxWithBudget(remaining: number): AdapterContext {
  return { account_id: "acct_test", remaining_budget_usd: remaining };
}

// ---------- Response validation ----------

test("Task 7 (Blocker 3): invalid JSON retries once with corrective framing then THROWS ProviderResponseInvalidError (never silently empty)", async () => {
  const stub = makeStub([
    {
      text: "this is not JSON at all",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    {
      text: "still not JSON after correction",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  ]);
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  // Blocker 3: after invalid JSON twice, the adapter MUST throw, not silently
  // return an empty array (which a downstream consumer could misread as a
  // successful empty result).
  await assert.rejects(
    () => adapter.proposeExcerpts(fullChunkInput(), ctxWithBudget(100)),
    (err: unknown) =>
      (err as { name: string }).name === "ProviderResponseInvalidError" &&
      (err as { reason: string }).reason === "json_parse_failed",
  );
  assert.equal(stub.calls.length, 2, "must retry exactly once");
  assert.match(stub.calls[1].system, /PRIOR RESPONSE WAS INVALID/);
});

test("Task 7: schema mismatch retries once with corrective framing", async () => {
  const stub = makeStub([
    {
      // Valid JSON but wrong shape (missing required source_document_id).
      text: JSON.stringify([{ text: "foo", char_start: 0, char_end: 3 }]),
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    {
      text: JSON.stringify([
        { source_document_id: "src_test_0", text: "Synthetic source text", char_start: 0, char_end: 21 },
      ]),
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const r = await adapter.proposeExcerpts(fullChunkInput(), ctxWithBudget(100));
  assert.equal(stub.calls.length, 2, "must retry exactly once on schema mismatch");
  assert.equal(r.output.length, 1);
  assert.equal(r.output[0].source_document_id, "src_test_0");
});

test("Task 7: provider response is treated as UNTRUSTED — JSON-fenced reply is accepted and parsed", async () => {
  const stub = makeStub([
    {
      text: "```json\n[{\"source_document_id\":\"src_test_0\",\"text\":\"Synthetic\",\"char_start\":0,\"char_end\":9}]\n```",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const r = await adapter.proposeExcerpts(fullChunkInput(), ctxWithBudget(100));
  assert.equal(r.output.length, 1);
});

// ---------- Budget gating ----------

test("Task 7: pre-call estimate over remaining budget refuses BEFORE provider call (no provider call made)", async () => {
  const stub = makeStub([
    { text: "[]", usage: { input_tokens: 0, output_tokens: 0 } },
  ]);
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  // 0.0001 USD is far below any realistic estimate; the adapter should refuse.
  await assert.rejects(
    () => adapter.proposeExcerpts(fullChunkInput(), ctxWithBudget(0.0001)),
    /exceeds remaining budget/i,
  );
  assert.equal(stub.calls.length, 0, "must not make any provider call when pre-call estimate fails");
});

test("Task 7: unknown pricing blocks the call up front (cannot pass; never coerced to $0)", async () => {
  const stub = makeStub([
    { text: "[]", usage: { input_tokens: 0, output_tokens: 0 } },
  ]);
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: "fake-unknown-model-9999",
    apiKey: "stub-key",
    providerClient: stub,
    pricing: null,
    sleep: async () => {},
  });
  await assert.rejects(
    () => adapter.proposeExcerpts(fullChunkInput(), ctxWithBudget(100)),
    /pricing for model fake-unknown-model-9999 is unknown/i,
  );
  assert.equal(stub.calls.length, 0);
});

test("Task 7: observed cost is computed from priced pricing table (never $0 for real adapter when pricing+tokens known)", async () => {
  const stub = makeStub([
    {
      text: JSON.stringify([
        { source_document_id: "src_test_0", text: "Synthetic", char_start: 0, char_end: 9 },
      ]),
      usage: { input_tokens: 10_000, output_tokens: 2_000 },
    },
  ]);
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const r = await adapter.proposeExcerpts(fullChunkInput(), ctxWithBudget(100));
  assert.equal(r.cost.status, "observed");
  // Opus pricing is 15 input/M + 75 output/M → 10k input + 2k output =
  // 10000/1e6 * 15 + 2000/1e6 * 75 = 0.15 + 0.15 = 0.30 USD.
  assert.ok(Math.abs(r.cost.observed_usd - 0.30) < 1e-9, `expected ~0.30; got ${r.cost.observed_usd}`);
});

test("Task 7: pricing or usage missing → cost.status === 'unknown_estimated' (never silently $0 observed)", async () => {
  const stub = makeStub([
    {
      text: JSON.stringify([
        { source_document_id: "src_test_0", text: "Synthetic", char_start: 0, char_end: 9 },
      ]),
      // Usage block absent.
      usage: { input_tokens: null, output_tokens: null },
    },
  ]);
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const r = await adapter.proposeExcerpts(fullChunkInput(), ctxWithBudget(100));
  assert.equal(r.cost.status, "unknown_estimated");
  // Blocker 6: unknown real-provider cost MUST NOT be representable as $0.
  assert.equal(r.cost.observed_usd, null, "Blocker 6: must be null, never 0");
  assert.equal(r.cost.estimated_usd, null, "Blocker 6: must be null, never 0");
});

test("Task 7: post-call observed cost cannot retroactively permit overspend (recordCost reflects overage)", () => {
  const state = createBudgetState({ max_cost_usd: 1, allow_high_cost: false });
  const ok1 = recordCost(state, { name: "real-anthropic", provider: "anthropic", model: KNOWN_MODEL }, {
    status: "observed",
    observed_usd: 0.8,
    estimated_usd: null,
    input_tokens: 1,
    output_tokens: 1,
  });
  assert.equal(ok1, true, "first call within budget");
  const ok2 = recordCost(state, { name: "real-anthropic", provider: "anthropic", model: KNOWN_MODEL }, {
    status: "observed",
    observed_usd: 0.5,
    estimated_usd: null,
    input_tokens: 1,
    output_tokens: 1,
  });
  assert.equal(ok2, false, "second call observed cost MUST report budget exceeded; no retroactive permit");
});

test("Task 7: preflightBudgetGate refuses on unknown pricing without coercing to $0", () => {
  const state = createBudgetState({ max_cost_usd: 10, allow_high_cost: false });
  const err = preflightBudgetGate(state, null);
  assert.match(err ?? "", /pricing unknown/i);
});

test("Task 7: preflightBudgetGate refuses when estimate would overshoot remaining budget", () => {
  const state = createBudgetState({ max_cost_usd: 1, allow_high_cost: false });
  const err = preflightBudgetGate(state, 5);
  assert.match(err ?? "", /would exceed remaining budget/i);
});

test("Task 7: pricing table lookup returns null for unknown model (no silent fallback)", () => {
  assert.equal(lookupModelPricing("totally-unknown-model"), null);
  assert.notEqual(lookupModelPricing(KNOWN_MODEL), null);
  // estimateCallCostUsd returns null when pricing is null — caller must
  // treat as "cannot pass".
  assert.equal(estimateCallCostUsd(null, 1000, 1000), null);
});

// ---------- Provider error handling ----------

test("Task 7: 401 (auth) fails fast — no retry", async () => {
  const err = Object.assign(new Error("unauthorized"), { status: 401 });
  const stub = makeFailingStub([err]);
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async () => {},
      maxRetries: 3,
    }),
    /unauthorized/,
  );
  assert.equal(stub.attempts, 1, "auth error must NOT retry");
});

test("Task 7: 403 (forbidden) fails fast — no retry", async () => {
  const err = Object.assign(new Error("forbidden"), { status: 403 });
  const stub = makeFailingStub([err]);
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async () => {},
      maxRetries: 3,
    }),
    /forbidden/,
  );
  assert.equal(stub.attempts, 1);
});

test("Task 7: 400 (bad request) fails fast — no retry", async () => {
  const err = Object.assign(new Error("bad request"), { status: 400 });
  const stub = makeFailingStub([err]);
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async () => {},
      maxRetries: 3,
    }),
    /bad request/,
  );
  assert.equal(stub.attempts, 1);
});

test("Task 7: 429 retries up to maxRetries with backoff, then ProviderRetriesExhaustedError", async () => {
  const err = Object.assign(new Error("rate limited"), { status: 429 });
  const stub = makeFailingStub([err, err, err, err, err]);
  const sleeps: number[] = [];
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async (ms) => { sleeps.push(ms); },
      maxRetries: 3,
    }),
    ProviderRetriesExhaustedError,
  );
  assert.equal(stub.attempts, 4, "1 initial + 3 retries = 4 attempts");
  assert.equal(sleeps.length, 3, "must back off 3 times");
});

test("Task 7: 5xx retries with backoff then exhausts", async () => {
  const err = Object.assign(new Error("internal"), { status: 503 });
  const stub = makeFailingStub([err, err, err, err]);
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async () => {},
      maxRetries: 3,
    }),
    ProviderRetriesExhaustedError,
  );
  assert.equal(stub.attempts, 4);
});

test("Task 7: 429 with retry-after respects header value (not the default backoff)", async () => {
  const err = Object.assign(new Error("rate limited"), {
    status: 429,
    headers: { get: (k: string) => (k === "retry-after" ? "2" : null) },
  });
  const stub = makeFailingStub([err, err]);
  const sleeps: number[] = [];
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async (ms) => { sleeps.push(ms); },
      maxRetries: 1,
    }),
    ProviderRetriesExhaustedError,
  );
  assert.equal(sleeps[0], 2000, "retry-after of 2 seconds must be honored");
});

test("Task 7: timeout retries with backoff", async () => {
  const err = Object.assign(new Error("request timeout"), { name: "TimeoutError" });
  const stub = makeFailingStub([err, err, err, err]);
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async () => {},
      maxRetries: 3,
    }),
    ProviderRetriesExhaustedError,
  );
  assert.equal(stub.attempts, 4);
});

test("Task 7: budget exhaustion BEFORE next retry halts retry — preserved as ProviderBudgetHaltError", async () => {
  const err = Object.assign(new Error("rate limited"), { status: 429 });
  const stub = makeFailingStub([err, err]);
  let budgetAllow = true;
  await assert.rejects(
    () => callWithRetry(() => stub.call({} as ProviderRequest), {
      sleep: async () => { budgetAllow = false; },
      canAffordNext: () => budgetAllow,
      maxRetries: 3,
    }),
    ProviderBudgetHaltError,
  );
  // First attempt happened, then budgetAllow was true so we retried once,
  // sleep flipped budgetAllow to false, then the next retry attempt
  // hit the budget gate.
  assert.ok(stub.attempts >= 1);
});

test("Task 7: classifyProviderError shape probe is SDK-agnostic", () => {
  assert.equal(classifyProviderError({ status: 429 }).class, "rate_limited");
  assert.equal(classifyProviderError({ status: 500 }).class, "server");
  assert.equal(classifyProviderError({ status: 503 }).class, "server");
  assert.equal(classifyProviderError({ status: 401 }).class, "auth");
  assert.equal(classifyProviderError({ status: 403 }).class, "auth");
  assert.equal(classifyProviderError({ status: 400 }).class, "bad_request");
  assert.equal(classifyProviderError({ name: "TimeoutError", message: "x" }).class, "timeout");
  assert.equal(classifyProviderError({ code: "ECONNRESET", message: "x" }).class, "network");
  assert.equal(classifyProviderError("plain string").class, "unknown");
});

// ---------- Integration with the orchestrator: stub adapter through the
// full system-side pipeline (verifies hallucinated source IDs, paraphrases,
// claims-without-evidence, and that artifacts are preserved when retries
// exhaust). ----------

import { runModelModeOrchestrator, SYNTHETIC_FIXTURE_CORPUS } from "../web/scripts/run-account-graph-validation";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpOut(): string { return mkdtempSync(join(tmpdir(), "a7-task7-stub-")); }

test("Task 7 (integration): real adapter with stub returning hallucinated source IDs trips invented_source_document_ids", async () => {
  // The synthetic fixture corpus has known source IDs of form src_<fixtureId>_<i>.
  // We make the stub return an invented one and assert the pipeline catches it.
  const halluRespExcerpt = JSON.stringify([
    { source_document_id: "src_NEVER_PROVIDED", text: "anything verbatim", char_start: 0, char_end: 17 },
  ]);
  const stub: ProviderClient = {
    async call(req) {
      // Excerpt vs claim distinguished by max_tokens we pass.
      if (req.max_tokens === 2000) {
        return { text: halluRespExcerpt, usage: { input_tokens: 10, output_tokens: 10 } };
      }
      return { text: JSON.stringify({ claims: [], objects: [] }), usage: { input_tokens: 10, output_tokens: 10 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut();
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const failed = r.report.hard_invariants.find((h) => h.key === "invented_source_document_ids");
    assert.ok(failed && failed.status === "fail");
    assert.equal(r.report.classification, "fail");
    // Partial artifacts MUST exist.
    assert.ok(existsSync(r.artifacts.reportJsonPath));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Task 7 (integration): paraphrased excerpt that is not a span of source is rejected by verifier (accepted_paraphrases stays correct)", async () => {
  // Use a non-span text long enough to attempt to be accepted as excerpt.
  const paraphraseResp = JSON.stringify([
    { source_document_id: `src_${SYNTHETIC_FIXTURE_CORPUS[0].fixture_id}_0`, text: "ZZZ_TOTALLY_PARAPHRASED_NEVER_IN_SOURCE_TEXT_2026Z", char_start: 0, char_end: 51 },
  ]);
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) return { text: paraphraseResp, usage: { input_tokens: 10, output_tokens: 10 } };
      return { text: JSON.stringify({ claims: [], objects: [] }), usage: { input_tokens: 10, output_tokens: 10 } };
    },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut();
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const failed = r.report.hard_invariants.find((h) => h.key === "accepted_paraphrases");
    assert.ok(failed, "must have accepted_paraphrases row");
    assert.equal(failed.status, "fail", "paraphrase must trip accepted_paraphrases");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Task 7 (integration): verified/high claim without supporting excerpt trips verified_high_claims_without_accepted_excerpts", async () => {
  const fixtureSrc = `src_${SYNTHETIC_FIXTURE_CORPUS[0].fixture_id}_0`;
  // Return a valid verbatim excerpt then a verified+high claim with no evidence.
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) {
        // Use the deterministic synthetic body prefix to ensure verifier accepts.
        const text = `Synthetic source body 1 for `;
        return {
          text: JSON.stringify([
            { source_document_id: fixtureSrc, text, char_start: 0, char_end: text.length },
          ]),
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      }
      return {
        text: JSON.stringify({
          claims: [
            {
              text: "unsupported verified high claim",
              type: "fact",
              confidence: "high",
              provenance_status: "verified",
              evidence: [],
            },
          ],
          objects: [],
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
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
  const outDir = tmpOut();
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    const failed = r.report.hard_invariants.find((h) => h.key === "verified_high_claims_without_accepted_excerpts");
    assert.ok(failed && failed.status === "fail", `expected verified_high_claims fail; got: ${JSON.stringify(r.report.hard_invariants)}`);
    assert.equal(r.report.classification, "fail");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Task 7 (integration, Blockers 3+5): provider 429 exhausting retries preserves partial artifacts, classifies non-pass, and emits ledger error rows", async () => {
  const err = Object.assign(new Error("rate limited"), { status: 429 });
  const stub: ProviderClient = {
    async call() { throw err; },
  };
  const adapter = await RealAnthropicAdapter.init({
    provider: "anthropic",
    model: KNOWN_MODEL,
    apiKey: "stub-key",
    providerClient: stub,
    sleep: async () => {},
  });
  const outDir = tmpOut();
  try {
    // The orchestrator MUST catch the retry-exhaustion (provider unreliable
    // is not a runner crash), record schema_parse violations per-account,
    // classify the run non-pass, AND preserve artifacts plus a ledger entry
    // with the provider error code.
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    assert.notEqual(r.report.classification, "pass", "must not classify as pass after retry exhaustion");
    assert.ok(existsSync(r.artifacts.reportJsonPath));
    const j = JSON.parse(readFileSync(r.artifacts.reportJsonPath, "utf8"));
    assert.notEqual(j.classification, "pass");
    // Blocker 5: ledger row records the provider error code.
    assert.ok(Array.isArray(j.cost.calls), "cost.calls[] ledger present");
    const errored = j.cost.calls.find((c: { error: unknown }) => c.error !== null);
    assert.ok(errored, "must have at least one ledger entry with error metadata");
    assert.ok(/rate_limited|retries_exhausted/.test(errored.error.code));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Task 7 (integration): adapter NEVER coerces real-call cost to $0 — observed_usd > 0 when pricing and usage are present", async () => {
  const fixtureSrc = `src_${SYNTHETIC_FIXTURE_CORPUS[0].fixture_id}_0`;
  const text = `Synthetic source body 1 for `;
  const stub: ProviderClient = {
    async call(req) {
      if (req.max_tokens === 2000) {
        return {
          text: JSON.stringify([
            { source_document_id: fixtureSrc, text, char_start: 0, char_end: text.length },
          ]),
          usage: { input_tokens: 1000, output_tokens: 500 },
        };
      }
      return {
        text: JSON.stringify({ claims: [], objects: [] }),
        usage: { input_tokens: 1000, output_tokens: 500 },
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
  const outDir = tmpOut();
  try {
    const r = await runModelModeOrchestrator({
      outDir,
      adapter,
      maxCostUsd: 10,
      allowHighCost: false,
      limit: 1,
    });
    assert.ok(r.report.cost.observed_usd > 0, `real-adapter must report >0 observed cost when pricing+tokens known; got ${r.report.cost.observed_usd}`);
    // Cost block exposes provider/model from the operator-supplied values.
    const row = r.report.cost.by_adapter.find((b) => b.adapter_name === "real-anthropic");
    assert.ok(row);
    assert.equal(row!.provider, "anthropic");
    assert.equal(row!.model, KNOWN_MODEL);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
