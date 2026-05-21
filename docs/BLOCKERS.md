# Account Research evidence graph blockers

This file captures phase gates that should survive chat history and planning churn.

## BLOCKED: A.7 graph-first writes of new research

Status: blocked until model-mode validation passes.

A.5 fixture mode proved that the graph schemas, deterministic excerpt verifier, validators, cascade computation, and reporting harness work against curated inputs. That is necessary but not sufficient for graph-first writes from new research.

A.6 may proceed because it is deterministic backfill/decomposition from existing structured `brief_json`; it does not depend on unproven LLM reliability.

A.7 must not begin until a model-mode validation run of the staged source → excerpt → claim/object pipeline has passed under explicit budget controls.

Minimum unblock criteria:

- Run `web/scripts/run-account-graph-spike.ts` or its A.6 successor in explicit model mode.
- Model mode must be opt-in, not default.
- Model mode must honor a configured cost ceiling.
- The run must preserve partial artifacts if budget is exceeded.
- The run must report cost status, token/call counts when available, and `unknown_estimated` if exact provider cost is unavailable.
- Hard invariants must pass:
  - 100% schema parse success
  - 100% referential integrity
  - 0 invented source IDs
  - 0 invented excerpt IDs
  - 0 false verified provenance
  - 100% accepted excerpt offset correctness
  - 0 accepted paraphrases
- Soft excerpt metrics must be at least pass-level or explicitly reviewed if borderline.
- The output must include decision inputs, not an automated roadmap decision.

Rationale:

- A.5's fixture-mode pass uses curated hand-authored sources and known expected claims.
- Passing both Spike A and Spike B in fixture mode proves validator/buildability, not real LLM extraction reliability.
- A.7 is the first phase where untested LLM reliability would affect production graph-first writes.

## A.6 allowed path

A.6 is not blocked by model mode if it remains deterministic and backfills from existing saved briefs.

A.6 should still resolve these before implementation:

- Relationship canonicalization ADR: embedded references for containment/provenance; `GraphEdge` for semantic relationships.
- Report provenance/SHA convention.
- Metric glossary separating validation metrics from extraction-quality metrics.
- `AccountObject.status` default/type ergonomics.
