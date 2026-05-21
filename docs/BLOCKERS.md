# Account Research evidence graph blockers

This file captures phase gates that should survive chat history and planning churn.

## BLOCKED: A.7 graph-first writes of new research

Status: blocked until paired model-mode validation passes.

Plan: `docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`

A.5 fixture mode proved that the graph schemas, deterministic excerpt verifier, validators, cascade computation, and reporting harness work against curated inputs. That is necessary but not sufficient for graph-first writes from new research.

A.6 deterministic `brief_json` → account graph backfill has landed. Its 26-brief production-backup dry-run is the baseline for A.7 validation:

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

A.7 must not begin as graph-first writes until a model-mode validation run of the staged source → excerpt → claim/object pipeline has passed under explicit budget controls. Attempting a model-mode run is not enough; the run must pass.

Minimum unblock criteria:

- Run the A.7 validation harness in explicit model mode against a 1-3 account paired validation corpus.
- For each selected account, compare A.7 model-mode output to A.6 deterministic baseline on the same account.
- Model mode must be opt-in, not default.
- Model mode must honor a configured cost ceiling: target <= $10, hard cap $25 unless explicitly approved.
- The run must preserve partial artifacts if budget is exceeded.
- The run must report cost status, provider/model, token/call counts when available, and `unknown_estimated` if exact provider cost is unavailable.
- Unknown/estimated-only cost cannot count as a validation pass.
- Hard invariants must pass:
  - 100% schema parse success
  - 100% referential integrity
  - 0 invented source IDs
  - 0 invented excerpt IDs
  - 0 dangling ClaimEvidence links
  - 0 false verified provenance
  - 0 verified/high-confidence claims without accepted supporting EvidenceExcerpt links
  - 100% accepted excerpt offset/normalized-span correctness
  - 0 accepted paraphrases
  - 0 validator hard errors
  - 0 production writes
  - 0 production migrations
  - 0 production feature flags enabling graph-first writes
  - 0 public/share/admin route exposure changes
  - 0 committed secrets, source text, prompts with proprietary data, or production-derived per-account artifacts
  - 0 unbudgeted model calls
  - 0 automatic model calls from tests, module imports, fixture mode, or CI-like verification
- Source/fetch scope must be bounded and logged:
  - max 8 candidate sources per account
  - max 5 fetched/loaded sources per account
  - max 50,000 captured characters per source
  - max 6 model chunks per source
  - max 4,000 characters per chunk
  - any higher limit requires explicit approval before running
- Paired A.7 output must improve the metrics A.7 is meant to improve:
  - lower confidence-downgrade rate than paired A.6 baseline
  - lower orphan SourceDocuments per claim than paired A.6 baseline
  - more excerpt-backed material claims than paired A.6 baseline
  - fewer attribution-gap briefs/provenance gaps than paired A.6 baseline
- Paired A.7 output must not regress the metrics A.6 already keeps safe:
  - false verified provenance remains 0
  - invented evidence remains 0
  - validator hard errors remain 0
  - coverage remains at or above paired A.6 baseline, unless an explicit human-reviewed scope difference is accepted
- The output must include decision inputs, not an automated roadmap decision.

Rationale:

- A.5's fixture-mode pass uses curated hand-authored sources and known expected claims.
- Passing both Spike A and Spike B in fixture mode proves validator/buildability, not real LLM extraction reliability.
- A.7 is the first phase where untested LLM reliability would affect production graph-first writes.

## A.6 landed notes / future cleanup

A.6 has landed as deterministic backfill from existing saved briefs. The remaining notes below are no longer A.6 pre-implementation blockers; they are background for future A.7/A.8 planning:

- Relationship canonicalization ADR: embedded references for containment/provenance; `GraphEdge` for semantic relationships.
- Report provenance/SHA convention.
- Metric glossary separating validation metrics from extraction-quality metrics.
- `AccountObject.status` default/type ergonomics.
