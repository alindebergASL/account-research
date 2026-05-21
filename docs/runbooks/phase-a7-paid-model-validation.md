# Phase A.7 — Paid model validation runbook (Task 8)

**Status:** Operator runbook for the *paid* model validation run. NOT a CI
procedure. A.7 graph-first writes remain **BLOCKED** per
[`docs/BLOCKERS.md`](../BLOCKERS.md) regardless of any run produced via this
runbook.

**Audience:** the operator (today: Andrew) executing the first paid model
validation against the locally-prepared production-backup corpus, after the
real adapter from
[`docs/plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md`](../plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md)
has been merged.

**Related docs:**

- Real adapter implementation plan:
  [`docs/plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md`](../plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md)
- Write-boundary doctrine: [`docs/decisions/2026-05-21-phase-a7-graph-first-write-boundary.md`](../decisions/2026-05-21-phase-a7-graph-first-write-boundary.md)
- Local production baseline (prerequisite): [`docs/runbooks/phase-a7-local-production-baseline.md`](phase-a7-local-production-baseline.md)
- Source plan: [`docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`](../plans/2026-05-21-phase-a7-model-mode-validation-plan.md)
- Blockers: [`docs/BLOCKERS.md`](../BLOCKERS.md)

This runbook describes Task 8 only. The implementation it depends on (Task 7,
the real `ModelAdapter`) is documented in Doc 1; refer to that for
flag semantics, refusal messages, hard invariants, and budget design.

---

## 1. Pre-run checklist

Do every item. Tick each before sending the paid-run approval message in §3.

- [ ] **Typecheck passes** locally:
      `( cd web && npm run typecheck )` exits 0.
- [ ] **Account graph tests pass** locally:
      `npx tsx --test tests/accountGraph.*.test.ts` exits 0.
- [ ] **Fixture mode is deterministic**. Sanity command:
      ```bash
      ( cd web && npx tsx scripts/run-account-graph-validation.ts \
          --mode fixture \
          --out /tmp/a7-sanity-$(date +%s) )
      ```
      Exit 0, `report.json.classification === "pass"`, `cost.observed_usd
      === 0`.
- [ ] **Local production baseline has been completed** via
      [`docs/runbooks/phase-a7-local-production-baseline.md`](phase-a7-local-production-baseline.md).
      The local-baseline artifacts (`paired-baseline.json`,
      `local-baseline-selection.json`, `report.json`) exist on the
      operator's machine in an ignored / outside-repo path and have been
      reviewed.
- [ ] **Selected gate-account rationale reviewed.** The
      `local-baseline-selection.json` file (operator-edited per the local-
      baseline runbook) records `account_label`, `selection_rationale`, and
      `criteria_covered` for each gate account against the §2 criteria from
      the source plan. Confirm every required criterion is covered or
      explicitly explained.
- [ ] **Safety grep is clean** on the branch that will run the paid
      execution. Use the grep from the source plan §9 plus an
      additional check for new env reads or production routes:
      ```bash
      git diff origin/main...HEAD | grep -Ein \
        "fetch\\(|anthropic|openai|resend|NEXT_PUBLIC|feature flag|app/s|api/share|UPDATE briefs|INSERT INTO briefs|write.*brief_json|brief_json.*UPDATE|password|secret|api_key|private_key|ANTHROPIC_API_KEY|OPENAI_API_KEY" \
        || true
      ```
      Every hit must be classified prose-only or as the new (reviewed) real
      adapter module.
- [ ] **Estimated max spend accepted**. The preflight in the real adapter
      computes an upper-bound USD estimate from the corpus size, max calls
      per account, worst-case tokens per call, and the provider price.
      Confirm this estimate is `≤ --max-cost` and within the operator's
      stated tolerance.
- [ ] **Explicit human approval captured** in the chat or PR thread per §3.
      No paid run proceeds without this artifact.

If any item fails, stop. Re-run the pre-run checklist after fixing.

---

## 2. Corpus policy

### Use the local production-backup corpus

The corpus for the paid run is the same corpus produced for the local
production baseline (see the local-baseline runbook). It must:

- Live **outside the repo working tree** (e.g. `/tmp/...`, `~/private/...`).
  The runner's `classifyCorpusPath` refuses any in-repo path. Refusal
  message (verbatim from `formatCorpusRefusal`):
  > `--corpus <resolved> resolves inside the repo working tree (<repoRoot>);
  > local-only corpus inputs must live outside the repo. See
  > docs/runbooks/phase-a7-local-production-baseline.md.`
- Be derived from a local SQLite copy of a production backup. No production
  network access; the export step is operator-local.
- Cover the §2 criteria from the source plan (chat-patch / public-web /
  non-URL / legacy-high-confidence / one A.6 `pass` / one
  `partial_with_attribution_gaps` / procurement-governance if applicable).

### `--out` path policy

The `--out` directory must resolve to **either** a path outside the repo
working tree (e.g. `/tmp/a7-paid-out-$(date +%s)`) **or** a path under the
gitignored `out/local-prod-baseline/**` allowlist. Any other in-repo path is
refused. Refusal message (verbatim from `formatOutRefusal`):

> `--out <resolved> resolves inside the repo working tree (<repoRoot>) but
> is not under out/local-prod-baseline/. Allowed: any path outside the repo
> (e.g. /tmp/...) OR a path under out/local-prod-baseline/ (gitignored).
> See docs/runbooks/phase-a7-local-production-baseline.md.`

### Production-derived artifact policy

No production-derived artifact is committed. Ever. The local-baseline
runbook §"Operator checklist" applies here too:

- `git status --short` must be clean after the run.
- `git ls-files out/local-prod-baseline/` must print nothing.
- No fixture under `tests/fixtures/` may contain real account names.

### Empty / malformed corpus refusal

If the corpus yields zero valid Brief entries, the runner refuses with the
message containing `yielded zero valid Brief entries; refusing to write a
pass-looking baseline.` (constant `LOCAL_CORPUS_NO_VALID_ENTRIES_ERROR_PREFIX`).
Fix the corpus and re-run.

---

## 3. Approval mechanism

An agent must **not** initiate a paid run without explicit human approval
captured *before* the run. Approval must be a written message (chat or PR
comment) that records:

- `max_cost_usd` — the exact `--max-cost` value the operator approves.
- `allow_high_cost` — whether `--allow-high-cost` is approved (only if
  `--max-cost > 25`).
- `corpus_path_class` — qualitative description. The corpus **must be
  outside the repo working tree** per §2 (`classifyCorpusPath` refuses
  in-repo paths, including `out/local-prod-baseline/**`). Acceptable
  examples: `/tmp/...`, `~/private/...`. Do not use
  `out/local-prod-baseline/**` here — that path is for `--out` only,
  not `--corpus`.
- `out_path_class` — qualitative description. Acceptable examples:
  `/tmp/...` (outside repo) or `out/local-prod-baseline/<timestamp>/`
  (in-repo, gitignored, the only in-repo location `classifyOutPath`
  allows).
- `adapter` — `real` (the only paid choice).
- `provider` and `model` — the exact provider and model name (e.g.
  `anthropic`, `claude-opus-4.7`).
- `expected_artifact_destination` — exact `--out` value or its directory
  parent.
- `gate_corpus_account_count` — typically 3, per source plan §2.

### Template approval snippet

Paste this into the approval message, edited with the actual values:

```
APPROVAL: A.7 paid model validation run

- max_cost_usd: 10
- allow_high_cost: false
- corpus_path_class: /tmp/a7-paid-corpus-<timestamp>.jsonl (outside repo)
- out_path_class: /tmp/a7-paid-out-<timestamp> (outside repo)
- adapter: real
- provider: anthropic
- model: claude-opus-4.7
- expected_artifact_destination: /tmp/a7-paid-out-<timestamp>/
- gate_corpus_account_count: 3
- estimated_max_usd (preflight): <value from preflight>
- approver: Andrew
- approved_at: <ISO timestamp>
```

The agent must echo this approval message back into the run log (`tee` to
stdout) so the artifact directory contains an unambiguous record of the
authorization.

Approval that arrives **after** a paid call has been issued is invalid for
that call. Re-approve and re-run.

---

## 4. Execution procedure

### Dry-run / preflight using the fake adapter

Before spending money, verify the pipeline shape against the same corpus
using the fake deterministic adapter. This catches corpus shape problems,
guard refusals, and orchestrator wiring issues without any provider call.

```bash
( cd web && npx tsx scripts/run-account-graph-validation.ts \
    --mode model \
    --adapter fake \
    --max-cost 10 \
    --corpus /tmp/a7-paid-corpus-<timestamp>.jsonl \
    --out /tmp/a7-paid-dryrun-<timestamp> )
```

Confirm:

- Exit 0.
- `report.json.classification` is `pass` or `borderline` (deterministic
  fake adapter typically passes against synthetic structure; against a
  local corpus, expect `borderline` because soft metrics are not
  comparable to the synthetic baseline).
- `report.json.cost.observed_usd === 0`.
- `paired-baseline.json` produced.
- No filesystem writes outside `$OUT`.

If the dry-run refuses, fix the refusal *before* attempting the paid run.

### Paid run command shape

```bash
STAMP=$(date +%Y%m%dT%H%M%SZ)
OUT=/tmp/a7-paid-out-$STAMP
CORPUS=/tmp/a7-paid-corpus-<timestamp>.jsonl
mkdir -p "$OUT"

( cd web && npx tsx scripts/run-account-graph-validation.ts \
    --mode model \
    --adapter real \
    --allow-real-model \
    --max-cost 10 \
    --corpus "$CORPUS" \
    --out "$OUT" ) 2>&1 | tee "$OUT/console.log"
```

Notes:

- `--allow-real-model` is mandatory for the real adapter; see Doc 1 §2.
- `--max-cost` is mandatory for the real adapter (the runner default of
  `10` does not satisfy the explicit-flag requirement for `--adapter
  real`); see Doc 1 §4.
- `tee` to `$OUT/console.log` captures stdout/stderr in the artifact
  directory so post-run review has the full transcript.
- If `--max-cost > 25` is required, append `--allow-high-cost` and update
  the §3 approval accordingly. The runner already refuses
  `--max-cost > 25` without `--allow-high-cost` with the verbatim message:
  `--max-cost <N> exceeds the per-run hard cap of 25 USD; pass
  --allow-high-cost to override`.

### Confirming artifacts exist

```bash
ls -la "$OUT"
test -f "$OUT/report.json" && echo "report.json: ok"
test -f "$OUT/report.md" && echo "report.md: ok"
test -f "$OUT/paired-baseline.json" && echo "paired-baseline.json: ok"
test -f "$OUT/console.log" && echo "console.log: ok"
```

A run that exits non-zero may still write partial artifacts. Treat the
presence of `report.json` as authoritative: if absent, the run failed
before classification could be written; review `console.log` for the
refusal or error message.

---

## 5. Required artifacts

Every paid run, regardless of outcome, must produce:

- **`$OUT/report.json`** — structured run metadata. Fields include:
  `branch`, `commit`, `run_at`, `mode: "model"`, `adapter_selected: "real"`,
  `classification`, `cost` (a `BudgetReportBlock` from
  `validationPipeline/budget.ts`), `hard_invariants[]`, `per_account[]`,
  `artifact_paths[]`, `a7_blocker_status`, `non_production_notice`.
- **`$OUT/report.md`** — human-readable summary rendered by
  `renderModelModeReportMarkdown`.
- **`$OUT/paired-baseline.json`** — A.6 paired baseline metrics for the
  same accounts. Shape per `PairedBaselineJson` in
  `web/scripts/run-account-graph-validation.ts`.
- **`$OUT/local-baseline-selection.json`** — produced by the pre-run
  local-baseline procedure and copied (or referenced) into the paid run's
  artifact directory. Operator-edited fields (`selection_rationale`,
  `criteria_covered`) must be present.
- **`$OUT/console.log`** — full stdout/stderr transcript via `tee`.
- **Per-call cost ledger** — embedded in `report.json.cost.by_adapter[]`,
  shape per `AdapterCostRollup` in `validationPipeline/budget.ts`:
  `{adapter_name, provider, model, calls, input_tokens, output_tokens,
  observed_usd}`. This is the canonical model-call ledger; no separate
  file is required.

### Partial artifacts on failure / budget exhaustion

The model-mode orchestrator already preserves partial artifacts:

- **Budget exhausted mid-run:** classification `budget_exceeded`; the
  cutoff account's per-account record reflects partial work; remaining
  accounts are listed with classification `skipped_budget_exceeded`.
- **Provider error:** per-account `notes` mentions the error; classification
  is `fail` if a hard invariant tripped or `borderline` otherwise.
- **Malformed model output:** `hard_invariants[]` records `schema_parse`
  with `count >= 1` and `status: "fail"`; classification is `fail`.

In every case, `report.json` and `report.md` must exist after the runner
exits. If they do not, treat that as a runner bug, file an issue, and do
not retry until fixed.

---

## 6. Post-run checks

Immediately after the run finishes:

1. **Summarize classification** from `report.json.classification`. Possible
   values: `pass`, `borderline`, `fail`, `budget_exceeded`.
2. **Summarize observed cost** from `report.json.cost`:
   - `status` must be `"observed"` for a `pass` outcome (see Doc 1 §6;
     `unknown_estimated` cannot pass).
   - `observed_usd` must be `≤ max_cost_usd`. If not, `budget_exceeded`.
   - `by_adapter[]` lists per-adapter call counts and token usage.
3. **Summarize hard-invariant failures** from
   `report.json.hard_invariants[]`. Any entry with `status: "fail"` and
   `count > 0` triggers a `fail` classification regardless of other
   metrics.
4. **Confirm `git status` is clean.** No production-derived content
   accidentally tracked:
   ```bash
   git status --short
   git ls-files out/local-prod-baseline/   # must print nothing
   ```
5. **Archive the artifact directory path** in the post-run review note. Do
   not copy artifact contents into the repo. Reference by absolute path
   (e.g. `/tmp/a7-paid-out-<timestamp>/`) so a reviewer can request
   specific contents under the same approval discipline.
6. **Read `report.md`**. Confirm:
   - The `A.7 blocker status` line is intact.
   - The `non_production_notice` line is intact (carried forward from PR
     #44 / current orchestrator output).
   - Per-account paired-comparison metrics are populated.
   - Sample source → excerpt → claim → object trace (if rendered) is
     scrubbed of PII / proprietary text per source plan §7 (lines 296–322).

If any check fails, treat the run as not-pass even if `classification ===
"pass"` in the JSON. The artifacts feed human review; the JSON is not
self-certifying.

---

## 7. Cleanup

After the post-run review note has been written and any follow-up actions
recorded:

- **Do NOT delete the local artifact directory** until the reviewer
  (Andrew) signs off on the run. The artifact directory is the only
  evidence of what the paid call produced.
- **Do NOT copy artifact contents into the repo** as part of cleanup.
  If a reviewer asks for a specific metric, paste the metric value
  inline; do not commit the raw artifact.
- **OK to delete:** `console.log` if you've already extracted what you
  need (rarely worth doing; keep it). Temporary corpus extraction
  scripts and shell variables.
- **OK to delete after sign-off:** the entire `$OUT` directory and the
  `$CORPUS` file.

If `$OUT` is under `out/local-prod-baseline/<timestamp>` (gitignored):
the directory remains until manually removed; ensure it stays gitignored
and `git ls-files` reports nothing under it.

---

## 8. Failure behavior

For each failure mode below: what the runner does, then what the operator
does next.

### Provider error (transient: HTTP 5xx, network drop, single bad response)

- **Runner:** retries once with exponential backoff (Doc 1 §4). If retry
  succeeds, continues. If retry fails, records the error in the per-account
  `notes`, classifies the account `fail` (or `borderline` if no hard
  invariant tripped), preserves artifacts, continues to the next account.
- **Operator:** review `report.md` and `console.log`. If the error pattern
  suggests a provider outage, retry the run later. If it suggests a
  misconfiguration (wrong model name, missing env var), fix and rerun.

### Provider error (persistent: auth failure, repeated rate limit)

- **Runner:** halts the run after the retry. Preserves any artifacts
  written so far. Exit 1.
- **Operator:** verify the env var (`ANTHROPIC_API_KEY` or equivalent) is
  set in the local shell. If rate-limited, wait and rerun. Do *not* rotate
  to a new provider mid-run; that requires a new approval (§3).

### Budget exhaustion

- **Runner:** stops further model calls, marks the cutoff account
  `budget_exceeded`, marks subsequent accounts `skipped_budget_exceeded`,
  writes `report.json` / `report.md` / `paired-baseline.json` with
  `classification: "budget_exceeded"`, exit non-zero per orchestrator
  policy.
- **Operator:** review the budget breakdown in `report.json.cost.by_adapter[]`.
  Either accept the partial result for review purposes, or request a
  higher `--max-cost` via a new approval (§3) and rerun.

### Malformed model output

- **Runner:** retries once. If still malformed, records `schema_parse`
  hard-invariant violation with `count >= 1`, classifies the account
  `fail`, preserves artifacts, continues to next account.
- **Operator:** review the malformed output (captured in `console.log` if
  the adapter logs it). If a model-version issue is suspected, file an
  issue against Task 7. Do not patch model output by hand.

### Zero valid corpus entries

- **Runner:** refuses before any model call with the message
  `yielded zero valid Brief entries; refusing to write a pass-looking
  baseline.`
- **Operator:** fix the corpus extraction script (likely a schema-mismatch
  or JSONL parse problem) and rerun. The `paired-baseline.json` does NOT
  get written, so there is nothing to clean up.

### Unknown / estimated cost

- **Runner:** sets `cost.status === "unknown_estimated"`, classification
  falls to `borderline` (cannot pass; see Doc 1 §6). Artifacts written.
- **Operator:** investigate why the provider's response did not include a
  priced usage block. Possibly a new SKU not yet priced in the adapter.
  Do *not* treat the run as a pass.

### Invented evidence / source IDs

- **Runner:** records `invented_evidence_excerpt_ids` or
  `invented_source_document_ids` under `hard_invariants[]` with `status:
  "fail"`. Per-account classification `fail`, run classification `fail`.
- **Operator:** treat this as a prompt / adapter regression. Do not retry
  the same run; file an issue against Task 7.

### False verified provenance

- **Runner:** records `false_verified` or
  `verified_high_claims_without_accepted_excerpts` hard invariant.
  Classification `fail`. Artifacts preserved.
- **Operator:** this is the highest-priority finding. It means the model
  produced `verified` / `high` claims without accepted excerpts. Treat as
  a stop-the-line bug; do not consider unblocking A.7.

---

## 9. Cross-references

- Implementation plan (Task 7): [`docs/plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md`](../plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md)
- Write-boundary doctrine: [`docs/decisions/2026-05-21-phase-a7-graph-first-write-boundary.md`](../decisions/2026-05-21-phase-a7-graph-first-write-boundary.md)
- Local production baseline runbook (PR #45 prerequisite):
  [`docs/runbooks/phase-a7-local-production-baseline.md`](phase-a7-local-production-baseline.md)
- Source plan: [`docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`](../plans/2026-05-21-phase-a7-model-mode-validation-plan.md)
- Blockers: [`docs/BLOCKERS.md`](../BLOCKERS.md)
- Runner CLI: [`web/scripts/run-account-graph-validation.ts`](../../web/scripts/run-account-graph-validation.ts)
- Budget primitives: [`web/lib/accountGraph/validationPipeline/budget.ts`](../../web/lib/accountGraph/validationPipeline/budget.ts)
