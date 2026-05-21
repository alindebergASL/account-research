# Phase A.7 Model-Mode Validation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. This is a validation-gate plan, not approval to ship graph-first writes.

**Goal:** Build and run a small, budget-capped model-mode validation harness for the staged source → excerpt → claim/object pipeline, then decide whether A.7 graph-first writes remain blocked.

**Architecture:** A.7 validation compares model-produced evidence graphs against the A.6 deterministic backfill baseline on the same selected accounts. The harness must keep fixture mode deterministic and free, make model mode explicit and budget-capped, preserve artifacts, and report measured evidence quality without mutating production or changing canonical storage.

**Tech Stack:** TypeScript, Zod, existing `web/lib/accountGraph/*` schemas/validators, Node/tsx CLI runners, SQLite local backup copies, existing model/research provider adapters only if explicitly wired through a budgeted validation path.

---

## 0. Current gate status

A.7 remains **BLOCKED**.

This plan does not unblock A.7 by existing, being implemented, or being attempted. A.7 is unblocked only after a model-mode validation run passes the hard invariants and paired-corpus improvement criteria below, followed by human review.

Hard scope constraints:

- No production deploy.
- No production DB writes.
- No migration.
- No feature flag enabling graph-first writes.
- No `brief_json` retirement.
- No user-visible route changes.
- No public/share/admin route changes.
- No automatic model calls during tests, fixture mode, import, or CI-like verification.
- No arbitrary web crawling beyond explicitly selected validation sources/accounts.

---

## 1. A.6 baseline constraints

A.6 deterministic `brief_json` → graph backfill is landed on `main`.

Relevant commits:

- A.6 implementation squash merge: `c4beae644bd463474201697c31771617540f7123`
- A.6 local-db parity fix squash merge: `d92bdc50732380a4a3a43046e8ca9445acc845f7`

A.6 26-brief production-backup dry-run baseline:

| Metric | A.6 baseline |
|---|---:|
| Run classification | `borderline` |
| Briefs processed | 26 |
| Per-brief classifications | 20 `partial_with_attribution_gaps`, 6 `pass` |
| Hard failures | 0 |
| Total claims | 1,486 |
| Confidence downgrades | 460 / 1,486 = 31.0% high→medium |
| Orphan SourceDocuments | 538 total = 0.36 per claim |
| Parity coverage | 1,112 / 1,166 = 95.4% |
| Parity dropped items | 54 |
| Provenance gaps | 460 |
| Validator errors | 0 |

Interpretation:

- A.6 is safe as deterministic decomposition: no false-verified provenance, no invented evidence, no validator hard-invariant failures.
- A.6 is not enough for graph-first writes: 31.0% of claims are downgraded and 538 SourceDocuments are orphaned because A.6 cannot validate source excerpts from saved Brief prose.
- A.7 model-mode validation must show the staged pipeline can reduce those attribution gaps without creating false provenance.

Important denominator note:

- `538 orphan SourceDocuments` is not "36% orphan" unless explicitly normalized as `0.36 orphan SourceDocuments per claim`; do not present it as a percentage without a defined denominator.

---

## 2. Validation corpus design

A.7 validation must use paired comparison.

For each selected account:

1. Run A.6 deterministic backfill on the account's existing saved Brief JSON.
2. Run A.7 staged model-mode pipeline for the same account/scope.
3. Compare A.7 metrics to that account's A.6 baseline.

Do not compare a tiny A.7 sample directly to only the full 26-brief A.6 aggregate. The aggregate provides global context; the pass/fail decision must be paired account-by-account.

Recommended first corpus:

- Minimum: 1 account for smoke validation.
- Preferred: 3 accounts for gate validation.
- Selection should include diversity from the 26-brief corpus:
  - one `pass` A.6 account,
  - one `partial_with_attribution_gaps` account with many source-bearing claims,
  - one `partial_with_attribution_gaps` account with procurement/governance/risk complexity.

Privacy/data handling:

- Use a local copy of a production backup only when needed.
- Do not commit account names, brief contents, source text, model prompts containing proprietary data, or full per-account artifacts.
- Commit only sanitized aggregate summaries and code/docs.
- Store generated validation artifacts under ignored `out/account-graph-validation/`.

---

## 3. A.7 staged pipeline under validation

The validation pipeline should test the future graph-first write path without making it canonical.

Stages:

1. Source discovery / selection
   - Input: account name, segment, optional existing Brief context.
   - Output: candidate sources with URL/title/publisher/relevance.
   - Validation: source IDs are assigned by system, not invented by model.

2. Source fetch / capture
   - System fetches or loads bounded source text.
   - Stores content hash and source metadata in artifacts.
   - For validation, source text can live only in ignored artifacts.

3. Excerpt proposal
   - Model proposes excerpts from bounded source chunks or source IDs.
   - System verifies excerpt text appears in captured source text.
   - Accepted excerpts require exact or normalized-span match.

4. Claim/object synthesis
   - Model emits Claims, AccountObjects, and ClaimEvidence links using known SourceDocument/EvidenceExcerpt IDs.
   - System validates all IDs, provenance statuses, confidence rules, and graph shape.

5. Report and paired comparison
   - Render A.7 graph output and compare to paired A.6 baseline.
   - Report hard invariant failures, soft metric changes, cost, and caveats.

Source/fetch bounds for the first validation run:

- Max candidate sources per account: 8.
- Max fetched/loaded sources per account: 5.
- Max captured text per source: 50,000 characters after extraction.
- Max chunks sent to model per source: 6.
- Max chunk size: 4,000 characters.
- Fetch mechanisms must be allowlisted and logged; local fixture/source-text replay is preferred for the first implementation pass.
- Every selected source/account scope must be written to the source ledger before model synthesis.
- Any request to exceed these limits turns the run into `borderline` or `budget_exceeded` unless explicitly approved before running.

Do not rely on a single prompt to both browse the web and freehand a fully auditable evidence graph. System owns source capture, IDs, hashes, excerpt verification, and referential integrity. Model owns bounded extraction/synthesis against known IDs.

---

## 4. Hard invariants

Any violation is `fail`; do not treat as close enough.

Validation hard invariants:

- 100% schema parse success for produced graph artifacts.
- 100% referential integrity.
- 0 invented SourceDocument IDs.
- 0 invented EvidenceExcerpt IDs.
- 0 dangling ClaimEvidence links.
- 0 false-verified claims.
- 0 verified/high-confidence claims without accepted supporting EvidenceExcerpt links.
- 0 accepted paraphrases as excerpts.
- 100% accepted excerpt offsets/normalized spans correct.
- 0 validator hard errors.
- 0 silent partial failures.
- 0 production writes.
- 0 unbudgeted model calls.
- 0 automatic model calls from tests/imports/fixture mode.

Security/product hard invariants:

- No generated code execution.
- No route exposure to public/share/admin surfaces.
- No production feature flag enabling graph-first writes.
- No production migration.
- No secret/log leakage in committed artifacts.

---

## 5. Soft metrics and paired success criteria

A.7 should improve these metrics on the paired validation corpus:

| Metric | Desired direction |
|---|---|
| Confidence downgrade rate | Lower than paired A.6 baseline |
| Orphan SourceDocuments per claim | Lower than paired A.6 baseline |
| Excerpt-backed claims | Higher than paired A.6 baseline |
| Verified claims | Higher than A.6 only when backed by accepted excerpts |
| Attribution-gap briefs | Fewer than paired A.6 baseline |
| Provenance gaps | Fewer than paired A.6 baseline |

A.7 must not regress these metrics:

| Metric | Requirement |
|---|---|
| False-verified claims | remain 0 |
| Invented evidence/source IDs | remain 0 |
| Validator hard errors | remain 0 |
| Parity/coverage | automatic pass requires >= paired A.6 baseline; any below-baseline coverage is at most `borderline` pending human review |
| Dropped material | no increase greater than 5 percentage points of paired A.6 dropped-material rate; any increase above 0 is reported |
| Human-readable rendering | graph output remains reviewer-readable |
| Cost | under approved budget |

Metric denominators:

- Downgrade rate = downgraded claims / total claims for the same run.
- Orphan rate = orphan SourceDocuments / total claims for the same run. Report both raw count and rate for A.6 and A.7.
- Excerpt-backed material claim rate = claims with at least one accepted supporting EvidenceExcerpt / total material claims.
- Coverage = parity coverage numerator / parity coverage denominator using the same paired-account section collector.
- Dropped-material rate = dropped parity items / coverage denominator.

Outcome bands:

### Pass

- All hard invariants pass.
- A.7 paired coverage is >= paired A.6 coverage.
- Downgrade rate is lower than paired A.6 by at least 5 percentage points relative to total claims, or by at least 20% relative reduction when the paired A.6 downgrade rate is below 25%.
- Orphan SourceDocuments per claim is strictly lower than paired A.6.
- Excerpt-backed material claim rate is at least 15%, and every verified/high-confidence claim is backed by accepted EvidenceExcerpts.
- Dropped-material rate does not increase by more than 5 percentage points vs paired A.6.
- Total observed cost is under budget and not `unknown_estimated`.
- Artifacts and report are complete enough for human review.

### Borderline

- All hard invariants pass.
- Coverage is below paired A.6 by <= 5 percentage points, or a scoped-down run is intentionally accepted for review.
- Downgrade/orphan metrics improve but miss the pass threshold, or improve inconsistently across accounts.
- Excerpt-backed material claim rate is > 0 but < 15%.
- Dropped-material rate increases by <= 5 percentage points.
- Cost is under budget.
- Requires human decision before any A.7 unblock.

### Fail

- Any hard invariant fails.
- Coverage drops by > 5 percentage points vs paired A.6.
- Downgrade and orphan rates do not improve.
- Dropped-material rate increases by > 5 percentage points.
- Model cost exceeds hard cap.
- Cost is unknown/estimated and cannot be bounded.
- Pipeline cannot preserve audit artifacts.

Budget-exceeded is its own operational outcome, not a quality pass. Any below-baseline coverage, even with an accepted reason, is at most `borderline`; automatic `pass` requires coverage >= paired A.6.

---

## 6. Cost ceiling and run controls

Default budget:

- Fixture mode: $0. No model calls, no web fetches.
- Model validation target: <= $10 total.
- Hard cap: $25 total unless Andrew explicitly approves more.
- Max accounts for first gate run: 3.
- Max model retries per stage/account: 1.

Required controls:

- `--mode fixture` must be default and deterministic.
- `--mode model` must be explicit.
- `--max-cost-usd` must default to 10 and reject values above 25 unless an explicit override flag or approval marker is present.
- Stop additional model calls when estimated or observed spend reaches the cap.
- Preserve partial artifacts and write a `budget_exceeded` report.
- Track provider, model, stage, input tokens, output tokens, call count, observed cost when available, and estimated cost when exact cost is unavailable.
- `unknown_estimated` cost status cannot count as a validation pass.

---

## 7. Required report artifacts

Create a new ignored artifact root:

```text
out/account-graph-validation/<run-id>/
```

Required files:

- `report.md` — human-readable run summary.
- `report.json` — structured metrics and outcome classification.
- `paired-baseline.json` — A.6 per-account baseline metrics for selected accounts.
- `<account-slug>.a6.graph.json` — A.6 graph artifact, ignored.
- `<account-slug>.a7.graph.json` — A.7 graph artifact, ignored.
- `<account-slug>.source-ledger.json` — SourceDocument/source-capture metadata, ignored.
- `<account-slug>.trace.md` — sanitized source → excerpt → claim → object trace, ignored unless scrubbed and explicitly approved.

`report.md` must include:

1. Branch and commit SHA.
2. Run timestamp.
3. Mode: fixture/model.
4. Corpus selection rationale.
5. Cost status and token/call table.
6. A.6 global baseline table.
7. Paired A.6 vs A.7 per-account table.
8. Aggregate A.7 classification: `pass` / `borderline` / `fail` / `budget_exceeded`.
9. Hard invariant table.
10. Soft metric table.
11. Sample source → excerpt → claim → object trace.
12. Validation failures/borderline issues.
13. Caveats and non-goals.
14. Decision inputs for human review.
15. Explicit statement: "This report does not automatically unblock A.7."

---

## 8. Implementation tasks

### Task 1: Add A.7 blocker details to `docs/BLOCKERS.md`

**Objective:** Make the A.7 gate survive chat history and planning churn.

**Files:**

- Modify: `docs/BLOCKERS.md`

**Steps:**

1. Add the A.6 26-brief baseline table.
2. Replace generic "model-mode validation passes" language with paired-corpus criteria.
3. Preserve the existing hard-invariant language.
4. Add cost ceiling and report artifact requirements.

**Verification:**

```bash
git diff -- docs/BLOCKERS.md
```

Expected:

- A.7 still marked blocked.
- A.6 baseline explicitly listed.
- Unblock requires pass, not mere attempt.

---

### Task 2: Add validation runner skeleton

**Objective:** Create a fixture-default CLI that can run paired A.6 baseline comparison without model calls.

**Files:**

- Create: `web/scripts/run-account-graph-validation.ts`
- Modify: `.gitignore` (`out/account-graph-validation/` must be ignored)
- Test: `tests/accountGraph.validationRunner.test.ts`

Required CLI shape:

```bash
cd web
npx tsx scripts/run-account-graph-validation.ts \
  --mode fixture \
  --corpus ../tests/fixtures/account-graph-validation-corpus.json \
  --out ../out/account-graph-validation/dev-fixture
```

Required flags:

- `--mode fixture|model`
- `--max-cost-usd <number>` default `10`
- `--corpus <path>`
- `--out <path>`
- `--limit <n>` optional
- `--allow-cost-over-25` optional but must require an explicit approval string if implemented

Required hygiene:

- Export `main` for testability.
- Guard entrypoint so import does not run the CLI.
- Add import-side-effect test proving no artifacts are created on import.
- Generated artifacts must be under ignored `out/account-graph-validation/`.

Fixture mode behavior:

- No model calls.
- No web fetches.
- Use saved fixture Brief JSON/source snippets.
- Compute A.6 paired baseline using existing deterministic backfill functions.
- Emit a placeholder A.7 fixture graph only if it is deterministic and fixture-backed; otherwise mark `not_run_fixture_only` without pretending model validation passed.

Model mode behavior in this task:

- Refuse with a clear error unless explicit model adapter work is implemented in a later task.
- This prevents accidental spend during skeleton PR.

**Verification:**

```bash
( cd web && npm run typecheck )
npx tsx --test tests/accountGraph.validationRunner.test.ts
npx tsx --test tests/accountGraph.*.test.ts
( cd web && npx tsx scripts/run-account-graph-validation.ts --mode fixture --corpus ../tests/fixtures/account-graph-validation-corpus.json --out ../out/account-graph-validation/dev-fixture )
git ls-files 'out/account-graph-validation/**'
git status --ignored --short out/account-graph-validation
```

Expected:

- Tests pass.
- Fixture run emits report artifacts.
- No tracked generated artifacts.
- Importing runner does not create artifacts.

---

### Task 3: Add corpus selector and paired baseline measurement

**Objective:** Select 1-3 accounts and compute paired A.6 baseline metrics for exactly those accounts.

**Files:**

- Modify: `web/scripts/run-account-graph-validation.ts`
- Test: `tests/accountGraph.validationRunner.test.ts`

Requirements:

- Corpus file contains account IDs/brief IDs or sanitized fixture identifiers, not full production content if committed.
- Local production-backup-derived corpus files must remain ignored.
- For each selected account, run existing `fromBriefJson`, `validateAccountGraph`, `buildParityReport`, and `classifyBrief`.
- Store paired baseline metrics in `paired-baseline.json` and `report.json`.

Metric fields:

- claims
- objects
- classification
- confidence downgrades
- orphan SourceDocuments
- parity coverage numerator/denominator
- dropped material count
- validator errors/warnings
- provenance gaps

**Verification:**

- Add tests with a tiny fixture corpus proving paired metrics are computed and aggregated.
- Assert denominator labels are explicit; no unlabeled "orphan percentage".

---

### Task 4: Add model-mode adapter boundary without enabling graph-first writes

**Objective:** Define the model-mode integration seam while preserving safety and cost controls.

**Files:**

- Create or modify under `web/lib/accountGraph/validationPipeline/*` as appropriate.
- Modify: `web/scripts/run-account-graph-validation.ts`
- Test: relevant account graph validation tests.

Requirements:

- Split system-owned and model-owned steps:
  - system: source IDs, fetch/capture, hashes, excerpt validation, referential integrity
  - model: excerpt proposal, claim/object synthesis against known IDs
- Model calls must be stage-scoped and budget-metered.
- No production DB writes.
- No route changes.
- No generated code execution.
- Preserve partial artifacts if budget is exceeded.
- If provider cost is unavailable, mark `unknown_estimated` and do not allow pass.

Testing:

- Use fake deterministic model adapter in tests.
- Test budget exhaustion before all accounts complete.
- Test unknown cost cannot pass.
- Test real provider adapters are never invoked unless `--mode model`, valid budget configuration, credentials, and explicit approval are all present.
- Test invented ID from fake adapter causes fail.
- Test paraphrased excerpt causes fail.

---

### Task 5: Run first model-mode validation only after fixture/default path is reviewed

**Objective:** Execute the first real model-mode validation under budget after code review approval.

Preconditions:

- Tasks 1-4 merged or approved.
- Fixture mode passes.
- Import-side-effect tests pass.
- Budget ceiling confirmed.
- Selected accounts confirmed.
- Required model credentials available in local/lab environment, not committed.

Command template:

```bash
cd web
npx tsx scripts/run-account-graph-validation.ts \
  --mode model \
  --max-cost-usd 10 \
  --corpus ../out/account-graph-validation/selected-corpus.json \
  --out ../out/account-graph-validation/model-YYYYMMDDTHHMMSSZ
```

Required post-run review:

- Inspect hard invariant table.
- Inspect paired A.6 vs A.7 metrics.
- Inspect sample source → excerpt → claim → object trace.
- Confirm no committed sensitive artifacts.
- Human decision: continue blocked / rerun / revise schema or prompts / unblock A.7.

---

## 9. Review gates for any implementation PR

Every implementation PR for this plan must include:

- Exact branch/head commit.
- Scope statement: plan-only, skeleton, fixture, model adapter, or real model run.
- Verification commands and outputs.
- Safety grep for production writes/routes/model-call defaults.
- Import-side-effect test result for any CLI runner.
- Artifact tracking check.
- Cost-control tests if model adapter code changed.
- Explicit statement whether real model calls were made.

Run at minimum:

```bash
( cd web && npm run typecheck )
npx tsx --test tests/accountGraph.*.test.ts
git diff --check
git ls-files 'out/account-graph-validation/**' 'out/account-graph-backfill/**'
git diff origin/main...HEAD | grep -Ein "fetch\\(|anthropic|openai|resend|NEXT_PUBLIC|feature flag|app/s|api/share|UPDATE briefs|INSERT INTO briefs|write.*brief_json|brief_json.*UPDATE|password|secret|api_key|private_key" || true
```

Interpret grep hits rather than blindly passing/failing; expected model-adapter code may mention provider names, but defaults must remain safe.

---

## 10. Non-goals

- Do not implement canonical graph storage.
- Do not add graph tables/migrations.
- Do not switch Brief rendering to graph output.
- Do not retire `brief_json`.
- Do not build Workshop/Canvas UI.
- Do not add promotion ritual.
- Do not add long-running watcher/self-healing behavior.
- Do not install a resident helper agent on production.

---

## 11. Definition of done for this plan document

This plan is done when:

- It is committed as a plan-only PR or merged docs update.
- `docs/BLOCKERS.md` is updated to reference the A.6 baseline and paired A.7 criteria.
- No implementation/model-call code is included in the plan-only PR.
- The next implementation prompt can be copied directly from this plan.

This plan does not itself unblock A.7.
