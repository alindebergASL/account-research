# Phase A.5 — Account Graph Spike Results

- Branch: `feature/phase-a5-account-graph-spike`
- Commit: `4dfcb949e287ad02af517cbaf117f80430a795c3`
- Run at: 2026-05-21T00:02:10.084Z
- Mode: `fixture` (fixture mode is deterministic, no model/web calls)
- Runtime: 7 ms
- Cost: n/a (fixture mode, no model calls)

## Outcome classification

- **Spike A (graph assembly):** `pass`
  - Excerpt validity 100.0% ≥ 95%
- **Spike B (excerpt extraction):** `pass`
  - Exact span 90.0%; Normalized 100.0%

## Metrics

| Metric | Value |
|---|---|
| Source documents | 6 |
| Evidence excerpts | 10 |
| Claims | 9 |
| Account objects | 8 |
| ClaimEvidence links | 12 |
| Valid excerpt ratio | 100.0% |
| Exact-span ratio | 100.0% |
| Normalized-span ratio | 100.0% |
| Claims with evidence | 88.9% |
| High-confidence claims without strong evidence | 0 |
| Invented references | 0 |
| Contradiction count | 2 |
| Conflict count | 1 |
| Cascade fanout (claim_marked_wrong) | claims=1, objects=1, evidence=0 |

### Spike B extraction metrics

- expected_total: 11
- expected_matchable: 10
- expected_paraphrase: 1
- accepted: 10
- rejected_correctly (paraphrases): 1
- accepted_paraphrases (must be 0): 0
- exact_span_ok: 9
- normalized_span_ok: 1
- exact_span_ratio: 90.0%
- normalized_span_ratio: 100.0%

## Validation issues

- Errors: none
- Warnings: none

## Sample trace: source → excerpt → claim → object

- **Source** `srcdoc_procurement_rfp` (public_procurement): Nueva School — Request for Proposals: Network Refresh 2026
- **Excerpt** `ex_rfp_due_date` [282-312]: "Proposals are due May 30, 2026"
- **Claim** `claim_initiative_network_refresh` (fact, high, provenance=verified): Nueva is running an RFP for a campus-wide Wi-Fi 6E network refresh with proposals due May 30, 2026.
- **AccountObject** `obj_initiative_network_refresh` (initiative): Campus network refresh RFP

## Conflict representation example

- Conflict `conflict_pilot_status` (unresolved): Pilot announcement vs trade-press report of board pause; status unresolved pending Nueva confirmation.
- Involved claims: claim_signal_ai_pilot, claim_signal_contradiction

## Cascade impact example

- Event: `claim_marked_wrong`
- Affected claims: claim_initiative_network_refresh
- Affected objects: obj_initiative_network_refresh
- Affected excerpts: (none)
- Affected claim_evidence: (none)
- Notes:
  - Claim claim_initiative_network_refresh marked_wrong; status should become marked_wrong.
  - Object obj_initiative_network_refresh depends solely on claim claim_initiative_network_refresh; downgrade to marked_wrong.

## Decision inputs (for Andrew/Hermes review — not a roadmap decision)

### Evidence supporting proceed to A.6

- Both Spike A and Spike B classified `pass` in fixture mode.
- Schema can express hierarchy scope, conflict, MEDDPICC mapping, provenance tiering, and cascade impact without hacks.
- Validator catches deliberately broken cases in tests (see `tests/accountGraph.*.test.ts`).
- Deterministic excerpt verification reliably rejects paraphrase candidates.

### Evidence supporting repeat A.5

- Outcome classifications: A=pass, B=pass.
- If either is `borderline` or `fail`, repeat with adjusted fixtures or extractor logic.
- Only one fixture-mode run was executed in this artifact; future runs with --mode model are optional and budget-gated.

### Evidence supporting revise schema

- Watch for repeated validation warnings of type `object_without_claims`, `claim_no_evidence`, or schema gaps surfaced when authoring the Nueva fixture.
- Consider whether the current AccountObject/Claim split is the right granularity once A.6 begins backfilling.

## Caveats

- Fixture mode only. No model or web calls were made.
- Nueva sources are synthetic, lab-only fixtures. Findings do not represent the real school.
- A single deterministic pipeline run produces both Spike A and Spike B classifications; this is intentional for A.5 since the fixture extractor feeds the assembler.
- No production migration, no flag enablement, no UI work, no CRM writeback.
