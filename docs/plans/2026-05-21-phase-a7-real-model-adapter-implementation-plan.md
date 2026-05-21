# Phase A.7 — Real model adapter implementation plan (Task 7)

> **Audience:** the engineer implementing the real model adapter that conforms
> to the `ModelAdapter` boundary shipped in PR #44. Read this end-to-end
> before opening a PR. This plan is **docs-only**. It does not authorize any
> production deploy, schema change, route change, or graph-first write.
>
> **A.7 graph-first writes remain BLOCKED** per
> [`docs/BLOCKERS.md`](../BLOCKERS.md). Successful completion of Task 7 is a
> prerequisite for Task 8 (paid validation), not for graph-first writes.

**Related docs:**

- Paid validation runbook (Task 8 operator):
  [`docs/runbooks/phase-a7-paid-model-validation.md`](../runbooks/phase-a7-paid-model-validation.md)
- Write-boundary doctrine (architecture reviewer):
  [`docs/decisions/2026-05-21-phase-a7-graph-first-write-boundary.md`](../decisions/2026-05-21-phase-a7-graph-first-write-boundary.md)
- Source plan: [`docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`](2026-05-21-phase-a7-model-mode-validation-plan.md)
- Local production baseline runbook (prerequisite for Task 8):
  [`docs/runbooks/phase-a7-local-production-baseline.md`](../runbooks/phase-a7-local-production-baseline.md)

---

## 1. Goal and non-goals

### Goal

Implement a **real** provider-backed `ModelAdapter` that conforms to the seam
already shipped in
[`web/lib/accountGraph/validationPipeline/types.ts`](../../web/lib/accountGraph/validationPipeline/types.ts)
(PR #44) and is consumed by the model-mode orchestrator
`runModelModeOrchestrator` in
[`web/scripts/run-account-graph-validation.ts`](../../web/scripts/run-account-graph-validation.ts).

Concretely, Task 7 must:

1. Add a new adapter module under
   `web/lib/accountGraph/validationPipeline/adapters/` (recommended name:
   `realAnthropic.ts` for the first cut — single-provider on purpose, see
   §8) that implements the existing `ModelAdapter` interface:
   `proposeExcerpts(input, ctx)` and `synthesizeClaims(input, ctx)`, returning
   `AdapterCallResult<ExcerptProposal[]>` and
   `AdapterCallResult<AdapterClaimSynthesisOutput>` respectively, with a real
   `CostObservation` per call.
2. Extend the CLI in `web/scripts/run-account-graph-validation.ts` so that
   `--mode model --adapter real` is reachable, but **only** when all of the
   following are passed together: `--allow-real-model`, `--max-cost <N>`, a
   `--corpus` path that resolves outside the repo (the existing
   `classifyCorpusPath` allowlist applies), and an `--out` path that the
   existing `classifyOutPath` allowlist accepts.
3. Keep every default path **safe**: fixture mode, `--mode model --adapter
   fake`, and the local-corpus path from PR #45 must remain free / network-free
   / SDK-free / env-read-free. The existing import-side-effect test, the
   `process.env` Proxy env-ban test, and the `fetch`-ban tests must all
   continue to pass without modification.
4. Define the prompt / input / output schemas for the two adapter calls
   against the existing Zod schemas (`ExcerptProposalSchema`,
   `ClaimProposalSchema`, `ObjectProposalSchema`) and document the prompt
   shape inline. The system continues to own SourceDocument IDs and excerpt
   verification — the model only proposes against system-provided IDs.
5. Enforce hard invariants for any real-adapter run (see §6) and preserve
   partial artifacts on every non-pass exit path.

### Non-goals (do not do these in Task 7)

- **No graph-first writes.** No `app/`, `pages/api`, share/admin route, or
  production DB / migration changes. A.7 writes remain blocked.
- **No CI execution of the real adapter.** CI runs fixture mode and the fake
  adapter only. No CI job, no GitHub Actions step, no `package.json` script
  may invoke `--mode model --adapter real`.
- **No default-on activation.** The real adapter must be unreachable from any
  default flag combination. `--mode model` without `--adapter fake` (today)
  or without the full real-adapter approval set (after Task 7) refuses.
- **No schema changes** to `web/lib/accountGraph/schema.ts`,
  `web/lib/schema.ts`, or the validation pipeline types. If a schema change
  looks necessary, stop and open a separate ADR.
- **No multi-provider abstraction.** First cut is single provider; see §8.
- **No new public surfaces, no telemetry endpoints, no model output
  post-processing** beyond schema validation and the existing system-side
  excerpt verifier.

---

## 2. Adapter activation policy

The runner today (post-PR #44 + PR #45) supports:

- `--mode fixture` (default) — deterministic, `$0`, uses
  `FakeModelAdapter` through the `ModelAdapter` seam, no network, no env.
- `--mode fixture --corpus <local>` — local-corpus path from PR #45.
  Routed through `runLocalCorpusOrchestrator`. Same safety properties.
- `--mode model --adapter fake` — exercises the model-mode orchestrator
  (`runModelModeOrchestrator`) with `FakeDeterministicAdapter`. Cost is
  observed `$0`.
- `--mode model` *without* `--adapter fake` — **REFUSED**. The runner prints
  both `MODEL_MODE_REFUSAL_MESSAGE` ("model mode is not implemented/enabled
  in this PR; run fixture mode only") and `MODEL_MODE_REAL_ADAPTER_REFUSAL`
  ("model mode requires --adapter fake in this PR; real model adapter is not
  enabled and A.7 remains BLOCKED per docs/BLOCKERS.md") and exits 1 without
  touching the filesystem or instantiating any adapter.

Task 7 changes this only by adding a *new* approved path:

```
--mode model
--adapter real
--allow-real-model
--provider <provider-id>
--model <exact-provider-model-id>
--max-cost <N>
--corpus <local-path-outside-repo>
--out <local-out-path>
```

If **any** of `--adapter real`, `--allow-real-model`, `--provider`,
`--model`, `--max-cost`, `--corpus`, or `--out` is missing, the runner
must refuse before any adapter is instantiated, before any provider SDK
is dynamically imported, before any env var is read, and before any
filesystem write. The refusal must explicitly name the missing flag(s)
and re-state that A.7 remains BLOCKED.

### No hardcoded provider/model IDs

The real adapter **must not** hardcode a provider model ID such as
`claude-opus-4.7` (or any specific Opus/Sonnet/Haiku version, or any
specific OpenAI/other-provider model name). Models change frequently;
hardcoding a model ID turns every model bump into a code change and
hides which model an operator actually paid for.

Requirements for Task 7:

- `--provider` and `--model` are mandatory for `--adapter real` and are
  parsed in `parseArgs` **before** any adapter is constructed or any
  provider SDK is dynamically imported.
- The adapter receives `provider` and `model` as constructor / `init()`
  arguments. It must not consult a hardcoded constant for either value.
- Unknown `--provider` values (i.e. providers without a wired adapter
  implementation in this PR — only one is required) must refuse at the
  CLI layer with a clear message that names the supported provider(s).
- Unknown `--model` values for a known provider are allowed to flow
  through to the provider call, but the runner must capture pricing
  resolution status (see "Unknown model pricing" below).
- `report.json.cost.by_adapter[]` entries must record `provider` and
  `model` exactly as the operator passed them — never a hardcoded
  fallback — so post-run review can verify the paid run matched the
  approved values from the operator's approval snippet (Doc 2 §3).
- The approval snippet, the CLI invocation, and the
  `report.json.cost.by_adapter[]` entry must all agree on
  `(provider, model)`. Task 7's post-run check should fail the run if
  the recorded values diverge from the operator's approved values.

### Unknown model pricing

If the runner cannot resolve pricing for the requested `--model` (no
known per-token rate, provider API does not return a cost field, or the
pricing table for that model is stale), the run must:

- Set `report.json.cost.status = "unknown_estimated"`.
- Classify the run as non-pass (see §6); `unknown_estimated` blocks a
  `pass` outcome unconditionally per Doc 1 §6.
- **Never** coerce unknown pricing to `observed_usd = 0`. Observed `$0`
  is reserved for fixture mode and the fake adapter; coercing real-call
  cost to `$0` would silently launder paid spend as free, defeating
  the budget guard.
- Populate `cost.estimated_usd` if a best-effort estimate is available;
  otherwise leave it `null`.

Operators bumping to a newer model (e.g. Opus 4.8 → 5.0) update the
approved `--model` value in their approval snippet; no code change in
the real adapter is required as long as pricing for the new model is
known to the runner's pricing table. If pricing is not known, the run
classifies non-pass — by design.

### Why `--allow-real-model` is a separate flag from `--adapter real`

`--adapter real` selects the adapter implementation. `--allow-real-model` is
an *explicit operator acknowledgement* that this run will spend money
and exercise a real provider. They are decoupled so that:

- A typo (`--adapter rael`) doesn't silently fall back to a fake adapter and
  hide a configuration mistake. Unknown adapter values must refuse.
- A misconfigured automation script that passes `--adapter real` without the
  acknowledgement flag is rejected at parse time, not after the first paid
  call. Each gate is independent and explicit.
- Reviewers can grep PRs and operator transcripts for `--allow-real-model`
  to find every place a paid run was authorized. Coupling the acknowledgement
  to the adapter name would lose that affordance.

### "No real-adapter path runs from CI by accident" — how this is enforced

A real-adapter call must be impossible unless an operator deliberately
provides every flag in §2. The defense-in-depth layers Task 7 must preserve
or extend:

1. **CLI parsing.** `parseArgs` must reject `--mode model --adapter real`
   without `--allow-real-model`, without `--max-cost`, without
   `--provider`, without `--model`, without `--corpus`, or without
   `--out`. Each rejection happens in the CLI layer **before** the
   orchestrator is called, and before any provider SDK is dynamically
   imported.
2. **Test harness defaults.** Existing tests in
   `tests/accountGraph.validationRunner.test.ts`,
   `tests/accountGraph.modelAdapterBoundary.test.ts`, and
   `tests/accountGraph.localProductionBaseline.test.ts` never pass
   `--adapter real`. Task 7 must not change those defaults. New Task 7 tests
   that exercise the real adapter's *refusal paths* must not pass
   `--allow-real-model`.
3. **Fixture mode.** `--mode fixture` (the test/CI default) takes a code
   path that uses `FakeModelAdapter` and never references the real adapter
   module. The real adapter module must not be statically imported by
   `run-account-graph-validation.ts`; use a dynamic import inside the
   `--adapter real` branch *after* refusal checks.
4. **Local-corpus mode.** PR #45's `runLocalCorpusOrchestrator` uses
   `--mode fixture` semantics with a local corpus. It must continue to use
   `FakeModelAdapter` and must never reach the real adapter path.
5. **Import-side-effect test.** The test
   `"importing the runner does NOT execute main and does NOT write
   artifacts"` (`tests/accountGraph.validationRunner.test.ts:34`) must
   continue to pass: importing the runner module must not import the real
   adapter, must not read env vars, must not call `fetch`.
6. **CI policy doc.** Task 7's PR description must state explicitly: "no CI
   job invokes `--adapter real`; the real adapter is operator-only."

If any of these layers is weakened, the PR fails review.

---

## 3. Provider / env / import safety

### Static-import ban for the real adapter module

The real adapter module **must not** be statically imported by
`web/scripts/run-account-graph-validation.ts`,
`web/lib/accountGraph/validationPipeline/index.ts`, or any module loaded by
fixture / local-corpus / fake-adapter code paths.

In the runner, the `--adapter real` branch should look approximately like:

```ts
// Pseudocode — illustrative; the real implementation must keep the dynamic
// import behind all refusal checks.
if (args.adapter === "real") {
  // ...refusal checks for --allow-real-model, --max-cost, --corpus, --out,
  //    --max-cost > 25 without --allow-high-cost...
  const { RealAnthropicAdapter } = await import(
    "../lib/accountGraph/validationPipeline/adapters/realAnthropic"
  );
  const adapter = await RealAnthropicAdapter.init({ /* config */ });
  // ...
}
```

The dynamic import keeps the provider SDK module out of the dependency graph
for every path that does not opt into the real adapter. Fixture mode, the
fake adapter, the local-corpus orchestrator, and CI tests will not load the
SDK at all.

### Provider env-var reads gated behind preflight

Provider env vars (e.g. `ANTHROPIC_API_KEY`) must be read **inside** the real
adapter's `init()` method, only after:

1. CLI refusal checks pass (§2).
2. `validateBudgetConfig` from
   [`web/lib/accountGraph/validationPipeline/budget.ts`](../../web/lib/accountGraph/validationPipeline/budget.ts)
   passes for the supplied `--max-cost` and `--allow-high-cost`.
3. The corpus and out paths pass `classifyCorpusPath` / `classifyOutPath`
   (the existing PR #45 guards).
4. An estimated max cost has been computed and is within `--max-cost` (§4).

A missing env var at this point is a hard error: refuse, preserve any
already-written artifacts (none yet), exit 1 with a clear message. Do not
fall back to a stub adapter.

### Existing env-ban test must keep passing

`tests/accountGraph.modelAdapterBoundary.test.ts` wraps `process.env` in a
`Proxy` that throws on read of provider keys. The Proxy is asserted across
fixture mode and fake-adapter mode. Task 7 must keep that test green for the
non-`real` paths and add new tests (§7) for the real path that verify the
env read happens **only** after preflight passes.

### Network-call ban for non-real paths

Tests in `tests/accountGraph.validationRunner.test.ts` shim `global.fetch` to
throw and assert it is never invoked in fixture mode. The new Task 7 real
adapter must keep this guarantee for fixture and fake-adapter modes. The
real-adapter path is allowed to call `fetch` (or use the provider SDK's
internal HTTP) only after preflight passes; that path is not exercised in CI.

---

## 4. Cost and budget design

The existing budget primitives in
[`web/lib/accountGraph/validationPipeline/budget.ts`](../../web/lib/accountGraph/validationPipeline/budget.ts)
are the only sanctioned cost-tracking surface. Task 7 must wire the real
adapter's `CostObservation` returns through `recordCost`, `canAffordNextCall`,
`remainingBudget`, and `budgetExceeded` exactly as the fake adapter does. Do
not add a parallel cost tracker.

### Default and hard ceilings

- **Default `--max-cost`:** `10` USD per run (already the runner default;
  do not change).
- **Hard ceiling without override:** `25` USD per run. `validateBudgetConfig`
  rejects `--max-cost > 25` unless `--allow-high-cost` is passed (already
  enforced; do not weaken). Cite that exact rejection message in the new
  test (§7).
- **`--max-cost` is required for `--adapter real`.** Even though the runner
  defaults to `10`, the real-adapter refusal must require the operator to
  pass `--max-cost` explicitly. Rationale: forces the operator to choose a
  number and prevents accidental reliance on the default.
- **Cumulative cap is future work.** The source plan §6 mentions a `$100`
  cumulative A.7 validation cap. Task 7 does not need to implement persistent
  cumulative tracking; document the per-run cap, log observed cost into
  artifacts, and leave cumulative aggregation to the operator (the paid
  runbook §6 covers this). See §8 (out-of-scope).

### Preflight estimated max cost

Before the first paid call, compute an upper-bound estimate from the corpus:

- count of selected accounts × max model calls per account × worst-case
  tokens-per-call × provider price.

Refuse the run if `estimated_max_usd > --max-cost`. Print the estimate, the
breakdown, and exit 1. This is the only place where an *estimated* number
gates a real run; once the run starts, only *observed* cost counts.

### `cost.status === "observed"` is required for `pass`

The classifier in `runModelModeOrchestrator` already enforces:

```ts
else if (cost.status === "unknown_estimated") classification = "borderline";
```

For the real adapter, every `proposeExcerpts` / `synthesizeClaims` call must
return `CostObservation.status === "observed"` whenever the provider returns
a usage block with priced tokens. If the provider returns a usage block but
the price is not available (e.g. unknown SKU), the adapter must set
`status: "unknown_estimated"`, populate `estimated_usd`, and let the
classifier downgrade to `borderline`. Never coerce an unknown cost to
`observed: 0`.

### Partial artifact preservation on budget exhaustion

The model-mode orchestrator already marks remaining accounts as
`skipped_budget_exceeded` and writes `report.json`, `report.md`, and
`paired-baseline.json` even when the run halts early. Task 7 must verify
that the **real** adapter produces the same partial artifacts when:

- The first account exhausts the budget mid-call.
- A mid-corpus account exhausts the budget; subsequent accounts are skipped.
- The cost block populates `by_adapter[]` with the real adapter's `provider`,
  `model`, `calls`, `input_tokens`, `output_tokens`, and `observed_usd` up to
  the cutoff.
- Per-account classification is `budget_exceeded` for the cutoff account and
  `skipped_budget_exceeded` for any later accounts.

Add an explicit test (§7) that an account whose first synthesizeClaims call
trips the budget still emits its partial per-account record.

### Retry and provider-error behavior

- **Transient errors** (HTTP 5xx, `fetch` network error, JSON parse failure
  on a single response): single retry with exponential backoff (e.g. 500ms,
  then 2s). One retry, no more. Plan §6 already caps retries at "1 per
  stage/account".
- **Persistent errors** (auth failure, rate limit after retry, malformed
  output that fails Zod after retry): record a hard-invariant violation
  under `schema_parse` (for malformed output) or note a `provider_error` in
  the per-account `notes` array, mark the account `fail`, preserve all
  artifacts written so far, and continue to the next account *only if the
  failure was not auth/credential* — an auth failure should halt the run
  with all artifacts preserved.
- **Unknown / partial output:** any response that does not validate against
  `ExcerptProposalSchema`, `ClaimProposalSchema`, or `ObjectProposalSchema`
  after the single retry is a `schema_parse` hard-invariant failure. The
  account is marked `fail`. Do not attempt to repair the model's output.

### Optional cumulative cap (future work, not Task 7)

A future PR can read a sidecar `cumulative-spend.json` file from a local
operator path and refuse runs that would exceed `$100` cumulative. Out of
scope here. Document this as a follow-up in the Task 7 PR description.

---

## 5. Prompt / input / output schema

The system already encodes the seam in
[`web/lib/accountGraph/validationPipeline/types.ts`](../../web/lib/accountGraph/validationPipeline/types.ts).
Task 7 must use it verbatim.

### Excerpt-proposal input → output

**Input:** `AdapterExcerptProposalInput`:

```ts
type AdapterExcerptProposalInput = {
  account_id: string;
  chunks: SystemProvidedSourceChunk[]; // each has source_document_id, source_text, optional chunk_index
};
```

**Prompt shape (illustrative — must be implemented as static strings in the
adapter, not loaded from env or remote):**

- A system message explaining the contract: "Propose excerpts from the
  provided source chunks. Each excerpt must be a verbatim span of one of the
  given chunks. Cite the exact `source_document_id` provided. Do not invent
  source IDs."
- A user message containing the JSON-serialized account ID and chunks.
- A response format request for a JSON array of
  `{source_document_id, text, char_start, char_end}` objects matching
  `ExcerptProposalSchema`.

**Output:** `ExcerptProposal[]`, parsed with `ExcerptProposalSchema.array()`.
The system-side step (see `systemSteps.ts:runAccountThroughAdapter`) then
verifies each proposed excerpt against the captured source text using the
existing exact-span / normalized-span verifier in
[`web/lib/accountGraph/excerpts.ts`](../../web/lib/accountGraph/excerpts.ts).
Paraphrases are rejected by that verifier and counted under the
`accepted_paraphrases` hard invariant (which must remain `0`).

### Claim-synthesis input → output

**Input:** `AdapterClaimSynthesisInput`:

```ts
type AdapterClaimSynthesisInput = {
  account_id: string;
  accepted_excerpts: SystemProvidedExcerpt[]; // each has evidence_excerpt_id, source_document_id, text
};
```

**Prompt shape:**

- System message explaining: "Synthesize Claim and AccountObject proposals
  grounded in the supplied accepted excerpts. Each ClaimEvidenceProposal must
  reference an `evidence_excerpt_id` from the input. Do not invent excerpt
  IDs or source IDs. If a claim cannot be grounded in an accepted excerpt,
  emit it with `confidence: medium` or lower and `provenance_status:
  source_document_only` or `legacy_brief_json`. Verified / high-confidence
  claims require at least one supporting accepted excerpt."
- User message containing JSON-serialized account ID and accepted excerpts.
- Response format: `{claims: ClaimProposal[], objects: ObjectProposal[]}`
  matching `AdapterClaimSynthesisOutput`.

**Output:** `AdapterClaimSynthesisOutput`, parsed with a Zod object
combining `ClaimProposalSchema.array()` and `ObjectProposalSchema.array()`.

### Invented-ID rejection

The system-side pipeline already constructs `accepted_excerpts` with
`evidence_excerpt_id` values *it* assigned. If the adapter returns an
`evidence_excerpt_id` not in the input, `runAccountThroughAdapter` flags
`invented_evidence_excerpt_ids`. Same for `source_document_id`. Task 7 does
not need to re-implement that — but the new tests (§7) must include a
synthetic real-adapter fake that returns an invented ID and assert the
hard-invariant violation is recorded and classification is `fail`.

### Excerpt verification (paraphrases banned)

The verifier in `web/lib/accountGraph/excerpts.ts` exposes the same
exact-span / normalized-span semantics used by the fake adapter. The real
adapter does **not** need to call the verifier itself; the system step
applies it to every excerpt proposal before the IDs are minted. A paraphrase
that is not a verbatim span and not a whitespace-normalized span is rejected
and counted under `accepted_paraphrases` (must remain `0`).

### Verified / high-confidence evidence requirement

Existing validators in
[`web/lib/accountGraph/validation.ts`](../../web/lib/accountGraph/validation.ts)
enforce `verified_high_claims_without_accepted_excerpts == 0` as a hard
invariant. The real adapter's prompts must make this explicit so that the
model does not emit `verified` / `high` claims without backing them with an
accepted excerpt. The runtime validator catches any violation regardless of
prompt wording.

### Span normalization and `EvidenceExcerpt` ID minting

The system mints `evidence_excerpt_id` values after verification (see
`SystemProvidedExcerpt` in `types.ts`). The adapter never picks excerpt IDs.
This is non-negotiable: if Task 7 finds a path that lets the adapter mint
its own excerpt ID, that is a bug — refuse and re-route through the system.

---

## 6. Classification gate

Task 7's real-adapter run uses the same outcome bands as fixture / fake
modes. The orchestrator already wires this; the new code must not weaken it.

### Hard-fail invariants (any one ⇒ `fail`)

The `HardInvariantKey` enum is the canonical list (see
`validationPipeline/types.ts`):

- `schema_parse` — any provider output that fails its Zod schema after the
  single allowed retry.
- `referential_integrity` — any graph that fails
  `validateAccountGraph(graph)`.
- `invented_source_document_ids` — adapter referenced a `source_document_id`
  not provided by the system.
- `invented_evidence_excerpt_ids` — adapter referenced an
  `evidence_excerpt_id` not provided by the system.
- `dangling_claim_evidence` — `ClaimEvidence` referencing an excerpt that
  does not exist in the graph.
- `false_verified` — `provenance_status: "verified"` without a system-
  accepted supporting excerpt.
- `verified_high_claims_without_accepted_excerpts` — `confidence: "high"`
  with `provenance_status: "verified"` but no accepted `ClaimEvidence`.
- `accepted_paraphrases` — adapter excerpt accepted as an
  `EvidenceExcerpt` despite failing the exact / normalized verifier (must be
  `0`; the verifier prevents this directly).
- `production_writes` — any code path that writes to the production DB
  during validation (must be impossible by construction; see §3 and Doc 3).
- `unbudgeted_model_calls` — any model call after `budgetExceeded` returns
  true.
- `automatic_model_calls_from_tests_imports_fixture_mode` — verified by the
  import-side-effect, env-Proxy, and fixture-mode tests.

### Budget-exceeded is non-pass but preserves artifacts

If `budgetExceeded(budget)` becomes true mid-run, classification is
`budget_exceeded` (see the existing orchestrator). Artifacts are still
written. A `budget_exceeded` run **cannot be a `pass`** but is not a `fail`
unless a hard invariant also tripped before the budget cutoff.

### Unknown / estimated cost is non-pass

`cost.status === "unknown_estimated"` forces classification to `borderline`
(see `runModelModeOrchestrator`). Real-adapter implementations must return
`observed` whenever the provider exposes a priced usage block. Returning
`unknown_estimated` blocks a `pass` outcome even if every invariant holds.

### Aggregate classification is worst-account / conservative

`runModelModeOrchestrator` already computes per-account classifications and
then promotes any hard-invariant violation to a `fail` for the whole run.
Task 7 must not weaken this conservative aggregation. Source plan §5: "the
aggregate is the worst per-account classification, not the median."

### Explicit `pass` / `borderline` / `fail` criteria for the real run

The source plan §5 enumerates these for the gate corpus. Repeating only the
real-run-specific bits here so the Task 7 implementer can hold the bar:

- **`pass`** requires every hard invariant `0`, `cost.status === "observed"`,
  total observed cost `≤ --max-cost`, every per-account classification
  `pass`, and the paired-corpus quality thresholds in source plan §5.
- **`borderline`** is the default when invariants hold but a quality
  threshold misses or `cost.status === "unknown_estimated"`.
- **`fail`** is forced by any hard-invariant violation, by total cost
  exceeding the per-run cap, or by any account whose per-account
  classification is `fail`.

The Task 8 runbook (Doc 2) uses this same vocabulary; do not introduce new
classifications in Task 7.

---

## 7. Tests required for the Task 7 PR

Each test below must be added (or asserted unchanged) in the Task 7 PR.
Names are suggested; the existing test file conventions in
`tests/accountGraph.*.test.ts` apply.

### Tests that must be **added**

1. **`import-side-effect: importing the real adapter module does NOT read
   env vars, does NOT import provider SDK, does NOT call fetch`** — file:
   `tests/accountGraph.realAdapter.test.ts`. Use the existing `process.env`
   Proxy pattern from
   `tests/accountGraph.modelAdapterBoundary.test.ts:285–321`. The module
   under test is the new `realAnthropic.ts` (or equivalent). Acceptance:
   import the module and assert zero Proxy hits, zero `fetch` calls, and
   that the provider SDK module is not in `require.cache` immediately after
   import.
2. **`fixture mode does NOT import provider SDK and does NOT read provider
   env`** — assert that running `--mode fixture` (existing test path)
   leaves the provider SDK module absent from `require.cache` and the env
   Proxy untriggered. Acceptance: extend
   `tests/accountGraph.modelAdapterBoundary.test.ts` with one new assertion.
3. **`local-corpus mode does NOT import provider SDK and does NOT read
   provider env`** — same pattern, exercising the `--corpus` path through
   `runLocalCorpusOrchestrator`. Acceptance: extend
   `tests/accountGraph.localProductionBaseline.test.ts:371`
   (`local-corpus run does NOT call fetch and does NOT read provider env
   vars`) with the SDK-cache assertion.
4. **`--mode model --adapter real` REFUSES without `--allow-real-model`** —
   acceptance: exit code 1, refusal message mentions the missing flag,
   adapter module is not imported, no filesystem writes occur, the existing
   refusal messages (`MODEL_MODE_REFUSAL_MESSAGE` and
   `MODEL_MODE_REAL_ADAPTER_REFUSAL`) are extended or supplemented but the
   *current* "must use --adapter fake" behavior remains for combinations
   that don't include `--adapter real`.
5. **`--mode model --adapter real --allow-real-model` REFUSES without
   `--max-cost`** — same shape; the refusal must explicitly name
   `--max-cost` as required.
6. **`--mode model --adapter real --allow-real-model --max-cost 50` REFUSES
   without `--allow-high-cost`** — the existing `validateBudgetConfig`
   rejection message ("--max-cost 50 exceeds the per-run hard cap of 25 USD;
   pass --allow-high-cost to override") must be surfaced; assert the exact
   string.
7. **`--mode model --adapter real ...` REFUSES when `--corpus` resolves
   inside the repo** — re-uses `formatCorpusRefusal`; acceptance: exit 1,
   no adapter import, no env read.
8. **`--mode model --adapter real ...` REFUSES when `--out` resolves inside
   the repo and is not under `out/local-prod-baseline/**`** — re-uses
   `formatOutRefusal`. Note: real-adapter runs should generally write to
   paths outside the repo; the `out/local-prod-baseline/**` allowance is
   left intact for symmetry with PR #45.
9. **`real adapter: provider error → preserves artifacts, classifies
   non-pass`** — use an injectable fake-real adapter (test-only) that
   throws on `synthesizeClaims`. Acceptance: `report.json`, `report.md`,
   and `paired-baseline.json` exist; per-account `notes` mentions
   `provider_error`; classification is `fail` (or `borderline` if the
   error happened after some accounts already passed). Importantly, the
   real adapter module itself is not imported in this test; we inject a
   fake-real adapter through the same `--adapter real` code path's
   `await import` site using a stubbed module loader, or we exercise the
   orchestrator directly via `runModelModeOrchestrator({adapter: stubReal})`.
10. **`real adapter: budget exhaustion → preserves partial artifacts,
    classifies budget_exceeded`** — fake-real adapter returns
    `observed_usd: 999` on first call. Acceptance: classification is
    `budget_exceeded`, partial `report.json` present with `cost.observed_usd
    >= max_cost`, subsequent accounts marked `skipped_budget_exceeded`.
11. **`real adapter: malformed provider output → schema_parse hard
    failure`** — fake-real adapter returns shape that fails
    `ExcerptProposalSchema`. Acceptance: hard-invariant violation under
    `schema_parse`, classification `fail`, artifacts preserved.
12. **`real adapter: invented evidence_excerpt_id → invented_evidence_
    excerpt_ids hard failure`** — fake-real adapter cites a non-existent
    excerpt ID in `synthesizeClaims`. Acceptance: violation logged,
    classification `fail`.
13. **`real adapter: paraphrased excerpt → accepted_paraphrases stays 0
    because verifier rejects`** — fake-real adapter returns a clearly
    paraphrased text that is not a span of the source. Acceptance: excerpt
    is rejected at system-side verification; no `EvidenceExcerpt` is
    minted; downstream claims that depended on it are downgraded or
    dropped per existing logic.

### Tests that must remain **unchanged and green** (point-to references)

- `tests/accountGraph.validationRunner.test.ts:34` — `"importing the runner
  does NOT execute main and does NOT write artifacts"`.
- `tests/accountGraph.validationRunner.test.ts:62` — `"fixture mode makes
  zero web fetches and zero model/provider calls"`.
- `tests/accountGraph.validationRunner.test.ts:107` — `"fixture mode
  invokes FakeModelAdapter through the ModelAdapter interface"`.
- `tests/accountGraph.validationRunner.test.ts:189` — `"--mode model exits
  nonzero with a clear refusal and does NOT touch FS or adapters"`. Task 7
  may extend this test to also cover the new
  `--mode model --adapter real` refusal without `--allow-real-model`, but
  the existing assertions for the no-adapter case must remain.
- `tests/accountGraph.validationRunner.test.ts:323` — `"classifier:
  cost.status === 'unknown_estimated' cannot classify as pass"`.
- `tests/accountGraph.validationRunner.test.ts:340` — `"classifier: any
  hard-invariant fail forces fail even when cost is observed/$0"`.
- `tests/accountGraph.modelAdapterBoundary.test.ts:285–321` — env-Proxy
  ban on `process.env` reads in fixture and fake-adapter modes.
- `tests/accountGraph.modelAdapterBoundary.test.ts:323` — `"fixture mode
  creates zero model calls and zero adapter cost; report.json unchanged
  shape"`.
- `tests/accountGraph.localProductionBaseline.test.ts:200` — `"local-
  corpus run with /tmp corpus + /tmp out does not perturb git working
  tree"`.
- `tests/accountGraph.localProductionBaseline.test.ts:371` — `"local-corpus
  run does NOT call fetch and does NOT read provider env vars"`.
- `tests/accountGraph.localProductionBaseline.test.ts:430` — `"--mode
  model refusal-without-adapter behavior from PR #44 unchanged"`. Task 7
  may extend this to assert the new refusal-without-`--allow-real-model`
  behavior; the original `--mode model` (no adapter) refusal must keep
  working.
- All `tests/accountGraph.briefParity.test.ts` tests — PR #43 behavior.
- All `tests/accountGraph.fromBriefJson.test.ts` tests — A.6 behavior.

If any of these tests need to change to land Task 7, that is a red flag.
The Task 7 PR should *add* new tests, not *modify* existing ones.

---

## 8. Out-of-scope

Explicitly out of scope for Task 7. Surface any of these in a separate
ADR / plan / PR.

- **Graph-first writes.** Still blocked (Doc 3). Task 7 produces
  artifacts; it does not promote them to canonical storage.
- **Public route changes.** No new `app/`, `pages/api`, share, or admin
  routes. No telemetry endpoints.
- **Model-output post-processing.** Beyond Zod schema validation and the
  existing exact/normalized-span verifier, do not transform model outputs.
- **Multi-provider abstraction.** Implement one provider for the first cut
  (Anthropic recommended given existing repo patterns). A `ProviderRegistry`
  / `getAdapter(provider)` indirection is *not* required and adds surface
  area without value at this stage.
- **Persistent prompt caching.** Provider-side prompt caching is allowed
  (use the SDK's native cache controls if available), but no on-disk or
  in-process cache that survives across runs. Each run starts fresh.
- **Fine-tuning, evals, RLHF.** Not in scope.
- **Cumulative cost ledger across runs.** Per-run cost is reported; the
  paid runbook (Doc 2) §5 documents how the operator aggregates across
  runs locally.
- **A new schema tier or provenance status.** Source plan §3 forbids this.
- **CI execution of the real adapter.** The real adapter is operator-only.

---

## 9. Cross-references

- Source plan: [`docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`](2026-05-21-phase-a7-model-mode-validation-plan.md)
- Paid validation runbook (Task 8): [`docs/runbooks/phase-a7-paid-model-validation.md`](../runbooks/phase-a7-paid-model-validation.md)
- Local production baseline runbook (Task 8 prerequisite):
  [`docs/runbooks/phase-a7-local-production-baseline.md`](../runbooks/phase-a7-local-production-baseline.md)
- Write-boundary doctrine (Doc 3): [`docs/decisions/2026-05-21-phase-a7-graph-first-write-boundary.md`](../decisions/2026-05-21-phase-a7-graph-first-write-boundary.md)
- Blockers: [`docs/BLOCKERS.md`](../BLOCKERS.md)
- Existing seam: [`web/lib/accountGraph/validationPipeline/types.ts`](../../web/lib/accountGraph/validationPipeline/types.ts)
- Existing budget primitives: [`web/lib/accountGraph/validationPipeline/budget.ts`](../../web/lib/accountGraph/validationPipeline/budget.ts)
- Existing system steps: [`web/lib/accountGraph/validationPipeline/systemSteps.ts`](../../web/lib/accountGraph/validationPipeline/systemSteps.ts)
- Existing fake adapter: [`web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic.ts`](../../web/lib/accountGraph/validationPipeline/adapters/fakeDeterministic.ts)
- Existing CLI: [`web/scripts/run-account-graph-validation.ts`](../../web/scripts/run-account-graph-validation.ts)
- Excerpt verifier: [`web/lib/accountGraph/excerpts.ts`](../../web/lib/accountGraph/excerpts.ts)
- Graph validator: [`web/lib/accountGraph/validation.ts`](../../web/lib/accountGraph/validation.ts)
