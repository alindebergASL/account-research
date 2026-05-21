# Phase A.6 — brief_json → account graph backfill results

- Branch: `feat/phase-a6-brief-json-graph-backfill`
- Base commit (origin/main at branch-out): `837daf2a3cfe77b4601c9b3fb71b40af5aecb5a2`
- Plan: `docs/plans/2026-05-21-phase-a6-brief-json-graph-backfill-plan.md`
- Mode: deterministic only. No model calls. No web fetches. No production DB access.

## Aggregate A.6 classification

**`pass`** — for the fixture corpus this implementation runs against.

- 0 false-verified-provenance failures
- 0 invented-evidence failures
- 0 validator hard-invariant failures
- 0 systematic whole-section losses
- Per-brief mix: 3 `pass`, 1 `partial_with_attribution_gaps`, 1 `skipped_malformed_json`, 1 `skipped_unsupported_schema_variant`

The aggregate is honest about the fixture-only nature of this run: see "local-db dry-run" below.

## Commands run

```
git fetch origin main --prune
git checkout main && git pull --ff-only origin main
git checkout -b feat/phase-a6-brief-json-graph-backfill

( cd web && npm run typecheck )           # clean
npx tsx --test tests/accountGraph.*.test.ts                                   # 55/55 pass
npx tsx --test tests/accountGraph.fromBriefJson.test.ts tests/accountGraph.briefParity.test.ts  # 25/25 pass
( cd web && npx tsx scripts/run-account-graph-backfill.ts --mode fixture )    # aggregate=pass
( cd web && npx tsx scripts/run-account-graph-backfill.ts --mode local-db --limit 26 --dry-run )  # local DB not present; ran fixture-mode fallback safely
git diff --check                          # clean
```

## Fixture results

Source: `tests/sample_brief.json`, `tests/fixtures/momentum_brief.json`, `tests/fixtures/procurement_brief.json`, `tests/fixtures/stakeholder_brief.json`, plus deliberate malformed/unsupported-variant inputs.

| Brief | Classification | Claims | Objects | Tier mix |
|---|---|---|---|---|
| `fixture:sample_brief.json` (Acme Health System) | `partial_with_attribution_gaps` | 43 | 22 | legacy=30, inferred=3, srcdoc=10, chat=0, verified=0 |
| `fixture:momentum_brief.json` | `pass` | 16 | 10 | legacy=8, inferred=3, srcdoc=5, chat=0, verified=0 |
| `fixture:procurement_brief.json` | `pass` | 12 | 8 | legacy=8, inferred=3, srcdoc=1, chat=0, verified=0 |
| `fixture:stakeholder_brief.json` | `pass` | 13 | 9 | legacy=5, inferred=3, srcdoc=5, chat=0, verified=0 |
| `fixture:malformed.json` | `skipped_malformed_json` | — | — | — |
| `fixture:unsupported_variant.json` | `skipped_unsupported_schema_variant` | — | — | — |

Artifacts (one per brief):
- `<brief>.graph.json` — full shadow `AccountGraphDocument`.
- `<brief>.parity.json` — `ParityReport` (per-section diff, dropped items, provenance gaps).
- `<brief>.shadow.md` — graph-rendered Brief-like markdown for side-by-side review.
- `report.md` + `report.json` at the run root.

Run output path (excluded from git via `.gitignore`):
`out/account-graph-backfill/<timestamp>/`

## Local-db dry-run results

**Not run, reason:** no local development SQLite database exists in this workspace. The runner checked `web/data/app.db`, `web/data/dev.db`, `data/app.db`, and `dev.db`; none were present. Per the A.6 hard constraints, production DB access is explicitly forbidden. The runner reported the missing-DB reason in `report.json.local_db_skip_reason` and fell back to fixture-mode (the same artifacts as above).

A future session with a populated local dev DB can run:

```
( cd web && npx tsx scripts/run-account-graph-backfill.ts --mode local-db --limit 26 --dry-run )
```

…and append the per-account results table to this document.

## Provenance gap summary

Across the fixture corpus, every Brief field that was marked High confidence is downgraded to `medium` in the shadow graph and listed as a provenance gap in the per-brief parity report. Reason: A.6 deliberately does not fabricate `EvidenceExcerpt` records against external `SourceDocument`s from saved Brief prose — the Brief carries source URLs/titles but not captured source text with verified offsets, so no excerpt verification is possible. This is the §5 HARD INVARIANT, expected behavior, and is enforced by `verified_from_legacy_brief_only` in `web/lib/accountGraph/validation.ts`.

Per-tier claim distribution (fixture corpus):

- `legacy_brief_json` — dominant tier; covers `technical_footprint.*`, `programs_procurement.*` (no per-row sources), `risks`, `competitive_signals`, and signals/personas/initiatives without a `source` value.
- `source_document_only` — used when a Brief field carries a `source` URL/title but no captured excerpt text (signals, top initiatives, personas, research-source extensions).
- `inferred_from_brief_json` — `ai_tech_maturity`, `buying_path`, `next_action`, model-source extensions.
- `chat_patch_object_level` — chat-source extensions; tested with a synthetic fixture in the test suite.
- `verified` — **zero**. By design.

## Unsupported / unmapped section summary

Per plan §4 these sections are deferred to a future PR and recorded as `ambiguous` in the per-brief mapping report rather than auto-decomposed into Claims:

- `priority_summary` — free-text prose.
- `first_angle` — free-text recommendation.
- `extensions[]` of `kind=narrative` — narrative bodies.
- `programs_procurement.ai_governance_policy` — plan §4 left attachment ambiguous between `risk_or_open_question` and `program`; mapper defaults to `procurement_program` and records the choice as ambiguous.
- `snapshot` — carried on the synthetic `legacy_brief_json` SourceDocument and on the root `account_snapshot` AccountObject body; no Claim extraction.

## §4 mapping ambiguity surfaced in practice

These places were genuinely harder than the plan suggested:

- **`AccountObjectType` enum vs. plan-level type names.** The A.5 schema enum has values like `signal`, `initiative`, `stakeholder`, `risk`, `opportunity`, `technical_footprint`, `procurement_program`, `competitor`, `recommended_action`, `open_question`. The plan uses slightly different category names (`signal_or_change`, `risk_or_open_question`, `tech_capability`, `program`). The mapper picks the closest existing enum value rather than expanding the enum — extending the enum was out of scope for this PR per the "don't gold-plate" guidance. Documented for any follow-up reviewer.
- **`technical_footprint.*` (eight sub-fields, mostly string/array of string) → one AccountObject with many Claims** is workable but loses per-sub-field hierarchy; a future iteration could split into per-capability AccountObjects.
- **`programs_procurement.active_rfps_contracts`** is mapped to `opportunity` AccountObjects by default (the plan said "opportunity when implies procurement window; otherwise program"). The mapper applies the procurement-window heuristic unconditionally for this field — string-level intent detection is out of scope for A.6.
- **High-confidence claim downgrade.** The A.5 validator forbids `confidence=high` without strong/medium supporting evidence. Since A.6 does not fabricate evidence, the mapper now downgrades brief-level `high` → graph-level `medium` and records the original confidence in `metadata.original_confidence` so the parity report can list the gap honestly. This is in `web/lib/accountGraph/fromBriefJson.ts` and `briefParity.ts`.
- **External-source kinds for unparseable `source` strings** (e.g. "Acme press release, Mar 2026"). The mapper materializes a `SourceDocument(kind="unknown", allowed=false)` with a placeholder `content_text` explaining no external content was fetched. This is correct under `source_document_only` (no excerpt is created against it) but produces "orphan SourceDocuments" in the parity report — expected and documented.

## Files changed in this PR

- Schema: `web/lib/accountGraph/schema.ts` — extends `ProvenanceStatus` with `source_document_only`, `legacy_brief_json`, `inferred_from_brief_json` (§5 option A).
- Validator: `web/lib/accountGraph/validation.ts` — adds the §5 HARD INVARIANT (`verified_from_legacy_brief_only`) and treats synthetic `legacy_brief_json`/`chat_patch_event`/`user_edit_event` SourceDocuments as ineligible to back a `verified` claim.
- Report classifier: `web/lib/accountGraph/report.ts` — adds `verified_from_legacy_brief_only` to the hard-error list.
- Mapper (new): `web/lib/accountGraph/fromBriefJson.ts` — deterministic §4 decomposition.
- Parity (new): `web/lib/accountGraph/briefParity.ts` — graph → Brief-like renderer + diff.
- Backfill report (new): `web/lib/accountGraph/backfillReport.ts` — per-brief and aggregate §9 classifications + markdown writer.
- CLI runner (new): `web/scripts/run-account-graph-backfill.ts` — §11 runner. Dry-run default. No production writes.
- Tests (new): `tests/accountGraph.fromBriefJson.test.ts`, `tests/accountGraph.briefParity.test.ts`.
- This results doc.
- `.gitignore` — excludes `out/account-graph-backfill/` artifacts from commits.

## Safety statement

- **`brief_json` remains canonical.** This runner does not write to saved briefs, does not migrate production data, and does not add user-visible routes.
- **No deploy. No production migration. No feature flag.** Schema enum extension is in-repo code; no DB migration accompanies it.
- **No model API calls. No web fetches.** All decomposition is deterministic.
- **A.7 remains BLOCKED** per `docs/BLOCKERS.md`. A.6 outcomes do not unblock A.7. A.7 unblock still requires the documented model-mode validation run.

## Caveats / blockers

- Fixture corpus is small (4 real fixtures + 2 synthetic edge cases). The aggregate `pass` classification is honest for this corpus; the larger production-corpus picture cannot be assessed without a local dev DB.
- `web/app/s/**` and `web/app/api/share/**` were neither created nor touched in this branch (per plan §13).
- The Jaccard ≥ 0.7 dedup mirror is implemented in `fromBriefJson.ts` (`jaccard()`); production `briefMerge.ts` semantics remain authoritative for canonical merges. A.6 reuses the same threshold but does not invoke `mergeBriefs`.
