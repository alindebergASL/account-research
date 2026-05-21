# ADR: Phase A.7 graph-first write boundary

Date: 2026-05-21
Status: **Accepted — A.7 graph-first writes remain BLOCKED**

**Audience:** the architecture / product reviewer evaluating, after A.7
validation runs are reported, whether graph-first writes of new research can
be unblocked. This ADR is the contract that governs that decision.

**Related docs:**

- Real adapter implementation plan (Task 7):
  [`docs/plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md`](../plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md)
- Paid validation runbook (Task 8):
  [`docs/runbooks/phase-a7-paid-model-validation.md`](../runbooks/phase-a7-paid-model-validation.md)
- Source plan: [`docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`](../plans/2026-05-21-phase-a7-model-mode-validation-plan.md)
- Local production baseline: [`docs/runbooks/phase-a7-local-production-baseline.md`](../runbooks/phase-a7-local-production-baseline.md)
- Blockers: [`docs/BLOCKERS.md`](../BLOCKERS.md)
- Prior ADR (containment vs edges): [`docs/decisions/2026-05-21-account-graph-relations.md`](2026-05-21-account-graph-relations.md)
- Merged: PR #43 (synthetic fixtures), PR #44 (adapter boundary), PR #45
  (local production baseline guardrails).

> **Location note.** This ADR lives in `docs/decisions/` because the prior
> account-graph relationship ADR established that directory as the project's
> ADR convention. New ADRs follow that convention.

---

## 1. Status

**Accepted. A.7 graph-first writes remain BLOCKED.**

This ADR does not unblock anything. It defines the criteria that future
work would need to meet before a separate, explicit decision could
unblock graph-first writes of new research.

The blocker statement in [`docs/BLOCKERS.md`](../BLOCKERS.md) is the
authoritative gate. This ADR explains *what evidence would be needed* to
revisit it, and *what failure modes keep it in place*.

---

## 2. Context

The account graph schema and validators (Phase A.5), the deterministic
`brief_json` → graph backfill (Phase A.6), and the staged validation
harness (Phase A.7 to date) have proved progressively more about the
pipeline. This section is explicit about what each has shown and what it
has NOT shown.

### What A.5 proved

The hand-authored fixture pass in Phase A.5 showed that:

- The account graph schemas (`AccountObject`, `Claim`, `EvidenceExcerpt`,
  `SourceDocument`, `ClaimEvidence`, `GraphEdge`, `ConflictRecord`) hold
  together as a typed model in
  [`web/lib/accountGraph/schema.ts`](../../web/lib/accountGraph/schema.ts).
- The deterministic excerpt verifier in
  [`web/lib/accountGraph/excerpts.ts`](../../web/lib/accountGraph/excerpts.ts)
  accepts exact and normalized-whitespace spans and rejects paraphrases.
- The validators in
  [`web/lib/accountGraph/validation.ts`](../../web/lib/accountGraph/validation.ts)
  catch referential integrity violations, dangling
  `ClaimEvidence`, invented IDs, and false `verified` provenance.
- The cascade computation and reporting harness produce reviewer-readable
  output.

A.5 did NOT prove anything about extraction reliability or model behavior,
because the inputs were curated and the expected outputs were known.

### What A.6 proved (and didn't)

A.6 deterministic `brief_json` → graph backfill landed against a 26-brief
production-backup dry-run. Per [`docs/BLOCKERS.md`](../BLOCKERS.md):

| Metric | A.6 baseline |
|---|---:|
| Run classification | `borderline` |
| Briefs processed | 26 |
| Per-brief classifications | 20 `partial_with_attribution_gaps`, 6 `pass` |
| Hard failures | 0 |
| Total claims | 1,486 |
| Confidence downgrades | 460 / 1,486 = 31.0% high→medium |
| Orphan SourceDocuments | 538 (= 0.36 per claim) |
| Parity coverage | 1,112 / 1,166 = 95.4% |
| Validator errors | 0 |

A.6 proved that deterministic decomposition of existing `brief_json` does
not invent evidence, does not produce false-verified provenance, and does
not trip the validator. It also showed the limits of deterministic-only:
31% of claims need downgrading and 538 SourceDocuments are orphaned because
A.6 cannot validate source excerpts from prose alone.

A.6 did NOT prove anything about a model-driven path, because A.6 itself
runs no model.

### What A.7 has proved so far

- **PR #43** added synthetic paired-baseline fixtures and the validation
  runner skeleton. CI runs deterministic, `$0`, zero-network.
- **PR #44** added the `ModelAdapter` seam and a fake deterministic
  adapter. `--mode model --adapter fake` exercises the orchestrator
  end-to-end with `$0` observed cost. The `process.env` Proxy ban test,
  the import-side-effect test, and the network-call ban test together
  prove that no provider SDK, no env read, no `fetch` call occurs in any
  default or test path.
- **PR #45** added the local-production-backup-derived corpus path, with
  refusal guardrails (`classifyCorpusPath`, `classifyOutPath`,
  `formatCorpusRefusal`, `formatOutRefusal`) that prevent any
  production-derived artifact from being committed.

### What A.7 has NOT proved (yet)

- That a *real* model adapter, when run against a production-backup-derived
  corpus, produces hard-invariant-clean output.
- That observed cost lands within budget on the real provider.
- That the paired soft metrics improve vs. the A.6 baseline on the same
  accounts.
- That the operator approval / refusal discipline holds under real
  spending pressure (rate limits, mid-run errors, etc.).

These are what Task 7 (implementation) and Task 8 (paid run) together aim
to produce evidence about.

---

## 3. Current decision

**A.7 graph-first writes remain BLOCKED.**

Real model validation per Tasks 7 and 8 is **necessary** evidence for any
future unblock decision. It is **not automatically sufficient.**

Even if the paid run classifies as `pass` and meets every hard invariant,
the decision to enable graph-first writes is a separate decision that
requires:

- explicit human review of the artifacts (not just the JSON `pass`
  classification);
- a separate write-path implementation PR (lab/staging first; see §8);
- a documented rollback procedure;
- a feature flag or kill switch;
- audit / event records for every graph-first write;
- a production DB backup before any production write run.

This ADR exists so that a future reader does not conflate "validation
passed" with "writes shipped."

---

## 4. Non-write boundary

These properties hold *during* A.7 validation, and Task 7 / Task 8 work
must not violate them.

- **No production DB writes.** Validation runs are read-only against any
  production database. The local-corpus path (PR #45) reads from a local
  SQLite copy of a production backup; nothing else.
- **No production migrations.** Schema changes are out of scope per
  source plan §10 and Doc 1 §1.
- **No graph-first production persistence.** Even if the validation
  produces a clean graph, that graph is *not* written to canonical
  storage. Brief rendering continues to use `brief_json`.
- **No public, share, or admin route changes.** The validation runner is
  a CLI script. It does not register routes, does not modify
  `app/`, does not touch `api/share` or admin surfaces.
- **No feature flag** that, when toggled, enables graph-first writes.
- **No committed secrets, source text, prompts, or per-account
  artifacts.** Enforced by `.gitignore`, `formatCorpusRefusal`,
  `formatOutRefusal`, the `paths-allowlist` test, and the per-entry
  `local_artifact / committed: false / caveat` markers in
  `local-baseline-selection.json`.

These properties are exercised by tests already on `main`:

- `tests/accountGraph.briefParity.test.ts:257` — `"no public/share route
  exposure in this branch"`.
- `tests/accountGraph.briefParity.test.ts:281` — `"rollback: canonical
  source remains legacy — runner does not export a brief_json writer"`.
- `tests/accountGraph.fromBriefJson.test.ts:334` — `"rollback: no A.6
  code touches public share or admin routes"`.
- `tests/accountGraph.modelAdapterBoundary.test.ts:285–321` — env-Proxy
  ban on provider env-var reads.
- `tests/accountGraph.modelAdapterBoundary.test.ts:323` — fixture mode
  creates zero model calls.
- `tests/accountGraph.localProductionBaseline.test.ts:200` — `"local-
  corpus run with /tmp corpus + /tmp out does not perturb git working
  tree"`.
- `tests/accountGraph.localProductionBaseline.test.ts:371` — `"local-
  corpus run does NOT call fetch and does NOT read provider env vars"`.
- `tests/accountGraph.localProductionBaseline.test.ts:448` — `"no
  production-derived fixtures are tracked under tests/fixtures/"`.

Any future PR that would change these properties must be flagged in
review and is out of scope for both Task 7 and Task 8.

---

## 5. Evidence required to consider unblocking

The following items, all present and reviewed, would constitute the
evidence package that lets the unblock decision be revisited. Any *one*
missing item disqualifies the package; this is a conjunction, not a
weighted score.

1. **Local production baseline completed and reviewed.** Per
   [`docs/runbooks/phase-a7-local-production-baseline.md`](../runbooks/phase-a7-local-production-baseline.md).
   `paired-baseline.json` and `local-baseline-selection.json` exist on
   the operator's machine with operator-edited `selection_rationale`
   and `criteria_covered` covering the source-plan §2 criteria.
2. **Paid model validation completed under approved budget.** Per
   [`docs/runbooks/phase-a7-paid-model-validation.md`](../runbooks/phase-a7-paid-model-validation.md).
   `report.json` exists with `mode: "model"`, `adapter_selected:
   "real"`, and `classification: "pass"`.
3. **Observed cost, not estimated.** `report.json.cost.status ===
   "observed"`. `unknown_estimated` is disqualifying per Doc 1 §6 and the
   classifier in `runModelModeOrchestrator`.
4. **No hard-invariant failures.** Every entry in
   `report.json.hard_invariants[]` has `status: "pass"` and `count: 0`.
5. **No false verified provenance.** Specifically `false_verified` count
   is `0` *and* `verified_high_claims_without_accepted_excerpts` count
   is `0`.
6. **No invented IDs.** Both `invented_source_document_ids` and
   `invented_evidence_excerpt_ids` counts are `0`.
7. **Accepted excerpts are exact / normalized source spans.**
   `accepted_paraphrases` count is `0` (the verifier rejects paraphrases
   before they can be accepted).
8. **Verified / high-confidence claims have accepted evidence.** Already
   implied by item 5; spelled out separately because the validator
   distinguishes these.
9. **Aggregate and per-account classifications reviewed.** A reviewer
   has read `report.md`, examined `per_account[]`, and confirmed every
   account is `pass`. Aggregate is the *worst* per-account classification
   per source plan §5; conservative aggregation is non-negotiable.
10. **Failure / borderline cases triaged.** If any earlier run was
    `borderline` or `fail`, the reviewer has either documented why it is
    superseded by a later passing run or has decided that the borderline
    issue does not affect graph-first writes (with reasoning).
11. **Rollback strategy documented for any future write path.** Before
    any write-path PR is filed, a rollback procedure exists (separate
    document; see §8).

---

## 6. What would re-block or keep blocked

A.7 stays blocked if *any* of the following is observed in the validation
artifacts or process. This list is intentionally broad: the conservative
stance is the safe stance.

- **Any hard-invariant failure** on any account in any paid run. Even one
  invented ID, one paraphrase accepted, one false-verified claim.
- **Unknown / estimated cost status.** `cost.status ===
  "unknown_estimated"` cannot pass.
- **Budget exhaustion before sufficient coverage.** A paid run that hit
  `budget_exceeded` before completing the gate corpus (3 accounts per
  source plan §2) is not coverage. Either rerun under higher approved
  budget or revise the pipeline.
- **Production-derived artifact leakage.** `git ls-files
  out/local-prod-baseline/` shows tracked files; any production data
  appears under `tests/fixtures/`; any commit accidentally includes a
  real account name, real source URL, real prompt text, or
  production-derived per-account artifact.
- **Unclear account selection rationale.** If
  `local-baseline-selection.json` carries default/placeholder rationales
  rather than operator-edited rationales tying each account to source
  plan §2 criteria, the corpus is not gate-worthy.
- **Model output requiring manual correction to look valid.** If a
  reviewer (or implementer) had to edit model output to make it pass
  validation, the run does not count.
- **Disagreement between deterministic baseline and model-mode evidence
  quality.** If A.7 evidence quality is materially lower than A.6 for
  the same accounts on metrics A.7 should improve (downgrade rate,
  orphan SourceDocument rate, excerpt-backed claim rate; see source
  plan §5), the model path is not improving the system and shouldn't
  drive writes.
- **Refusal-bypass.** If any operator workaround circumvented a refusal
  (e.g. coerced a corpus path to look outside the repo via symlink
  tricks; bypassed `--allow-real-model`), the validation is invalid.
- **Test regressions.** Any of the tests cited in §4 failing means a
  safety property has eroded; that must be fixed first.

---

## 7. Decision ownership

- **Andrew** approves any paid run (per the paid runbook §3).
- **Andrew** decides whether the evidence package in §5 is sufficient to
  *propose* unblocking A.7. The proposal is a separate document and a
  separate decision.
- **Andrew** decides whether the *write-path implementation* (a future
  PR, separate from validation) is approved for lab/staging.
- **Andrew** decides whether any production deploy of graph-first writes
  is approved, after lab/staging soaks.

An agent **may** summarize evidence, identify gaps, and recommend.
An agent **must not** declare A.7 unblocked or initiate write-path code.
Recommendation is fine; declaration is not.

---

## 8. Later write-path requirements

When (and only when) §5's evidence package exists and §6's disqualifiers
are absent, a future unblock-then-implement effort must follow these
rules. These are stated here so that a future reader does not have to
re-derive them.

- **Lab / staging first.** No production deploy until the write path runs
  cleanly in a lab/staging environment with backups and rollback proved.
- **Explicit rollback procedure.** Documented before any write. Must
  cover: how to revert a partial write, how to detect a bad write, how
  to restore from the pre-write backup.
- **DB backup before any production write.** Hot backup or verified
  snapshot. The backup must be testable (i.e. can be restored to a
  scratch DB and queried).
- **Feature flag or kill switch.** A single switch that disables
  graph-first writes without code redeploy. Logged toggles.
- **Audit / event records for every graph-first write.** Each write
  records: invoking operator (if applicable), source corpus / model run
  / commit SHA, classification at write time, the exact `AccountObject`
  / `Claim` / `EvidenceExcerpt` IDs created.
- **Read-only dry-run before any write run.** The write path supports a
  `--dry-run` mode that produces the same artifacts but performs no DB
  writes; review dry-run output before enabling writes.
- **Production deploy is a separate PR from validation.** No single PR
  may both validate the path and ship the write. They are reviewed
  independently and merged independently.

This list is non-exhaustive. The write-path PR's review must enumerate
its own constraints; this list is the floor.

---

## 9. Consequences

### Short-term

- Task 7 (real adapter implementation) and Task 8 (paid validation) are
  the immediate next pieces of work. They produce *evidence*, not
  *writes*.
- Brief rendering continues to use `brief_json` as the canonical source.
  A.6 deterministic backfill remains the production graph view (used for
  reporting and review, not writes).
- The fake adapter, fixture mode, and local-corpus path remain the
  CI-safe / no-spend code paths.

### Long-term

There is a real gap between "validation passing" and "production writes
shipping." This gap is intentional. A validation run shows that the model
can produce a clean graph against a chosen corpus on a chosen day; it
does not show that:

- The cost stays bounded across many runs over time.
- Provider behavior remains stable across model versions.
- Operator approval discipline holds under operational pressure.
- The graph schema accommodates account variation the gate corpus
  didn't cover.
- Rollback procedures actually work.
- Audit records actually capture what you'd want them to capture during
  an incident.

The write-path implementation will surface its own surprises. The ADR
treats validation as a gate, not a launch.

### Counterpart for the prior ADR

This ADR is the *write-boundary* counterpart to the *relationship
canonicalization* ADR at
[`docs/decisions/2026-05-21-account-graph-relations.md`](2026-05-21-account-graph-relations.md).
That ADR governs how graph data is *modeled*; this ADR governs whether
graph data is *written*. They are independent: a future schema-change
ADR is possible without touching write-path policy, and vice versa.

---

## 10. Cross-references

- Real adapter implementation plan (Task 7):
  [`docs/plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md`](../plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md)
- Paid validation runbook (Task 8):
  [`docs/runbooks/phase-a7-paid-model-validation.md`](../runbooks/phase-a7-paid-model-validation.md)
- Source plan: [`docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`](../plans/2026-05-21-phase-a7-model-mode-validation-plan.md)
- Local production baseline runbook: [`docs/runbooks/phase-a7-local-production-baseline.md`](../runbooks/phase-a7-local-production-baseline.md)
- Blockers (authoritative gate): [`docs/BLOCKERS.md`](../BLOCKERS.md)
- Prior ADR (containment vs edges): [`docs/decisions/2026-05-21-account-graph-relations.md`](2026-05-21-account-graph-relations.md)
- PR #43 (synthetic fixtures), PR #44 (adapter boundary), PR #45 (local
  baseline guardrails).
