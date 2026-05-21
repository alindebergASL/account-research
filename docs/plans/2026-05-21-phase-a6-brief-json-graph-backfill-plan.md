# Phase A.6: brief_json → account graph backfill plan

**Date:** 2026-05-21
**Branch:** `docs/phase-a6-brief-json-backfill-plan`
**Status:** docs-only plan, awaiting review. No implementation, no deploy, no production migration, no feature flag change.

---

## 1. Goal and non-goals

### Goal

Define a deterministic, source-cited decomposition of saved `brief_json` rows into the Phase A.5 account graph (`AccountObject`, `Claim`, `ClaimEvidence`, `EvidenceExcerpt`, `SourceDocument`, `GraphEdge`, `ConflictRecord`). The decomposition runs as a *shadow* path: it produces graph artifacts for inspection, parity comparison, and validator coverage, but it does NOT replace canonical `brief_json` storage and it does NOT power production Brief rendering.

A.6 exists to:
- Prove that the A.5 graph schema accommodates real saved-brief content (not just curated fixtures).
- Expose mapping gaps, provenance ambiguities, and validator soft spots before any graph-first write path is considered.
- Produce auditable side-by-side reports so a human reviewer can judge whether the shadow graph is decision-equivalent to the legacy Brief.

### Non-goals

- A.6 does **not** flip canonical storage. `brief_json` remains the canonical persisted shape throughout A.6.
- A.6 does **not** replace production Brief rendering. The graph-rendered output is comparison-only.
- A.6 does **not** unblock A.7 graph-first writes. A.7 remains blocked per `docs/BLOCKERS.md`.
- A.6 does **not** add user-visible toggles, navigation entries, or admin routes by default.
- A.6 does **not** make a roadmap decision. It produces architectural decisions internal to A.6 and decision inputs only.
- A.6 does **not** solve user-visible provenance vocabulary ("from your brief", "from your edits", "inferred"). That is an A.7+ product question.

---

## 2. A.5 foundation summary

Verified present on current `origin/main` at or after commit `527f39846abf9746e2b57a7a418f0ee04d0470b9`:

- `web/lib/accountGraph/{schema,validation,excerpts,spikePipeline,report}.ts` — the typed graph primitives, deterministic excerpt verifier, full validator (referential integrity, invented-ID detection, false-verified-provenance detection, paraphrase rejection), cascade computation, and markdown report generator.
- `web/scripts/run-account-graph-spike.ts` — the fixture-mode runner harness.
- `docs/spikes/phase-a5-account-graph-results.md` — Spike A and Spike B both classified `pass` against the curated Nueva fixture (excerpt validity 100.0%, exact-span 90.0%, normalized-span 100.0%, contradiction + conflict + cascade examples captured).

### What A.5 proved

- The schema and validator accept hand-authored, fully-grounded inputs and reject all eight deliberate broken-fixture cases tested (duplicate IDs, invented source/excerpt/claim refs, verified-without-evidence, high-confidence-without-strong-evidence, disallowed-source-supports-verified-claim, excerpt offset corruption).
- Deterministic excerpt verification (exact + normalized span) works and correctly rejects paraphrase.
- Cascade computation (claim marked wrong, source marked unreliable) returns the expected dependent fanout.
- The graph schema cleanly expresses hierarchy, MEDDPICC mapping, contradiction (edge + ClaimEvidence role + ConflictRecord), and provenance tiering.

### What A.5 did NOT prove

- Real LLM extraction reliability against uncurated sources. Fixture mode used hand-authored excerpts that already satisfied the validator's requirements.
- That a real extractor can hit the hard invariants on production-grade noisy inputs.
- That the schema's granularity (AccountObject vs Claim split, embedded vs edge relationships) survives contact with the full diversity of saved-brief content.

A.6 is the first phase that touches real saved content. It is allowed because the decomposition is deterministic (no LLM in the loop). A.7 — which would use an LLM to populate the graph from new research — remains blocked until model-mode validation passes.

---

## 3. Relationship canonicalization

A.6 follows the ADR landed at `docs/decisions/2026-05-21-account-graph-relations.md`. The load-bearing decision quoted verbatim:

> Use both patterns, but for different relationship classes:
>
> 1. Embedded references are canonical for containment/high-frequency provenance traversals.
>    - `AccountObject.claim_ids` is the canonical object → claim containment link.
>    - `ClaimEvidence.claim_id` + `ClaimEvidence.evidence_excerpt_id` is the canonical claim → evidence link.
>    - `EvidenceExcerpt.source_document_id` is the canonical excerpt → source link.
>
> 2. `GraphEdge` is canonical for semantic/lower-frequency relationships.
>    - claim contradicts claim
>    - claim supports claim
>    - claim depends on claim
>    - object relates to object
>    - signal/risk/opportunity relationships that are not containment
>    - future cascade/dependency links that need explanation/rationale
>
> 3. Do not use `GraphEdge` to duplicate every containment link by default.

A.6 implementation must:
- Populate `AccountObject.claim_ids`, `ClaimEvidence`, and `EvidenceExcerpt.source_document_id` as the primary provenance chain.
- Emit a `GraphEdge` only when there is a semantic relationship worth preserving with `kind` and `rationale`.
- Treat reverse indexes as in-memory implementation details, not as new canonical sources of truth.

---

## 4. Deterministic decomposition rules (load-bearing)

The current saved Brief Zod schema (`web/lib/schema.ts:122–145`) is the input. Each section maps to graph records as follows. Tags:

- **Direct** — every field has a deterministic, evidence-backed home in the graph.
- **Inferred** — mapping is deterministic but the resulting Claim carries an `inferred_from_brief_json` provenance tier, not `verified`.
- **Unsupported** — section persists as a `SourceDocument` of subtype `legacy_brief_json` but does NOT spawn high-confidence claims.
- **Ambiguous** — mapping is unclear at planning time; deferred to the future implementation PR for resolution.

| Brief section | Decomposition target(s) | Tag |
|---|---|---|
| `account_name`, `segment` | Root `AccountObject` of kind `account`; carried as identity fields. | Direct |
| `generated_at`, `audience` | Metadata on the synthetic `SourceDocument(subtype=legacy_brief_json)` representing this brief; not a Claim. | Direct |
| `snapshot` | `SourceDocument(subtype=legacy_brief_json)` carries the snapshot text. Claims are NOT extracted from prose. | Unsupported |
| `priority_summary` | Same: stored on the brief-level `SourceDocument`; no automatic Claim extraction. | **Ambiguous** — sentence-level decomposition deferred to future PR. |
| `recent_signals[]` (each Signal: text, source, confidence, previously_found) | One `Claim` per signal. `ClaimEvidence` links it to an `EvidenceExcerpt` derived from the `text` field. `EvidenceExcerpt.source_document_id` points to a `SourceDocument` materialized from the signal's `source` URL/title; if `source` is empty or null, the excerpt's source is the brief-level `legacy_brief_json` document and the claim's tier becomes `legacy_brief_json`. Signals attach to a `signal_or_change` AccountObject. | Direct when `source` populated; Inferred when not. |
| `ai_tech_maturity.rating` + `rationale` | One `Claim` (rating + rationale). Provenance is the brief-level `legacy_brief_json` document unless individual fields carry sources (they do not in current schema). | Inferred |
| `top_initiatives[]` (title, detail, confidence, source) | One `AccountObject(kind=initiative)` per row, with `claim_ids` pointing at one Claim per initiative carrying the `detail`. Source handling matches `recent_signals[]`. | Direct when `source` populated; Inferred when not. |
| `technical_footprint.ai_in_production[]` | Each entry → one `Claim` attached to a `tech_capability` AccountObject. No per-entry source in brief schema; provenance is `legacy_brief_json`. | Inferred |
| `technical_footprint.active_pilots[]` | Same as above. | Inferred |
| `technical_footprint.cloud_platforms[]` | Same. | Inferred |
| `technical_footprint.data_infrastructure` | One Claim; provenance `legacy_brief_json`. | Inferred |
| `technical_footprint.clinical_platforms` | Same. | Inferred |
| `technical_footprint.analytics_bi_stack` | Same. | Inferred |
| `technical_footprint.build_vs_buy_posture` | Same. | Inferred |
| `technical_footprint.competitive_incumbents[]` | One Claim per entry; provenance `legacy_brief_json`. | Inferred |
| `programs_procurement.modernization_grants[]` | One Claim per entry attached to a `program` AccountObject. | Inferred |
| `programs_procurement.consortium_purchasing[]` | Same. | Inferred |
| `programs_procurement.active_rfps_contracts[]` | One Claim per entry attached to an `opportunity` AccountObject when the entry implies a procurement window; otherwise a `program` AccountObject. | Inferred |
| `programs_procurement.ai_governance_policy` | One Claim attached to a `risk_or_open_question` or `program` AccountObject (decision deferred to implementation). | Inferred |
| `programs_procurement.public_ai_use_cases[]` | One Claim per entry. | Inferred |
| `personas[]` (name, title, priority, opener, confidence, source) | One `AccountObject(kind=stakeholder)` per persona; the `opener` becomes a Claim with provenance from the persona's `source` if populated, else `legacy_brief_json`. | Direct when `source` populated; Inferred when not. |
| `buying_path` | One Claim attached to the root account object; no per-sentence decomposition in A.6. | Inferred |
| `first_angle` | Free-text recommendation; stored on the brief-level SourceDocument with no automatic Claim. | **Ambiguous** — sentence-level decomposition deferred. |
| `risks[]` | One `AccountObject(kind=risk_or_open_question)` per entry; one Claim per risk. | Inferred |
| `competitive_signals[]` | One Claim per entry attached to a competitive-context AccountObject (kind TBD in implementation). | Inferred |
| `next_action` | One `AccountObject(kind=recommended_action)` plus one Claim. | Inferred |
| `extensions[]` (kind: card / table / list / narrative; source: "model" / "research" / "chat") | See provenance mapping in §5. `kind=narrative` is **Ambiguous** — narrative bodies don't decompose deterministically into Claims and are deferred. `kind=card/table/list` can produce one Claim per row/bullet with provenance from the `source` flag. | Direct (table/list/card with source="research"); Inferred (source="model"); chat_patch_object_level (source="chat"); narrative is Ambiguous. |
| `sources[]` (title, url, accessed) | Each entry materializes as one `SourceDocument`. URL collisions are deduped. Sources not referenced by any excerpt are still emitted but flagged in the parity report as "orphan sources". | Direct |

### Ambiguous sections deferred

The future implementation PR resolves these:
- `priority_summary` — free-text. Options: store on brief-level `legacy_brief_json` only (no Claims), or attempt deterministic sentence-segmentation. Recommend the former for A.6.
- `first_angle` — same pattern as `priority_summary`.
- `extensions[]` of kind `narrative` — narrative bodies. Recommend storing as `SourceDocument` content and not generating Claims in A.6.

Tagging these Ambiguous now (vs forcing a mapping) keeps A.6 honest about what deterministic decomposition can and cannot do.

### Deduplication

The future runner should mirror `tests/briefMerge.test.ts` semantics (Jaccard similarity ≥ 0.7) when deduping signals across versioned briefs of the same account. Object-level dedup for initiatives is by title similarity; for personas, by name match. Stable IDs across runs are required (deterministic hashing of `account_name` + section + ordinal).

---

## 5. Provenance-tier mapping (load-bearing)

A.6 introduces the following provenance tiers on every `Claim` emitted by the backfill:

| Tier | Meaning | Source basis |
|---|---|---|
| `verified` | Claim is backed by an `EvidenceExcerpt` whose `SourceDocument` is on the allowlist and whose span verification passed. | Reserved for claims with real external evidence. NOT auto-applied during A.6 backfill of brief_json — A.6 has no way to verify spans against legacy text. |
| `source_document_only` | Claim cites a `SourceDocument` but no specific verified excerpt. | Brief signal/initiative/persona with populated `source` URL but no captured excerpt text. |
| `legacy_brief_json` | Claim's only provenance is the brief-level `legacy_brief_json` SourceDocument (i.e. the saved Brief itself, treated as a single document). | Brief fields without per-field sources: technical_footprint, programs_procurement, ai_tech_maturity, buying_path, risks, competitive_signals, next_action. |
| `chat_patch_object_level` | Claim originates in user/assistant chat-patch content that modified the saved brief at object level. | Brief sections or extensions with `source="chat"` (and any future per-section chat-patch metadata). |
| `inferred_from_brief_json` | Deterministic decomposition produced this Claim from structured brief content where no direct external source exists. | Any field deterministically mapped from brief structure that lacks a real source URL. |
| `unsupported` | Decomposition could not safely attribute the claim. Reserved for cases that surface during backfill that the runner cannot tier. | Edge cases discovered at implementation time. |

### HARD INVARIANT

> **HARD INVARIANT.** No high-confidence graph claim derived from unsupported or unsourced legacy brief text may be marked `verified` or evidence-backed. Such claims MUST carry a tier of `legacy_brief_json`, `chat_patch_object_level`, `inferred_from_brief_json`, or `unsupported`, and MUST NOT participate in any "verified" downstream rollup, badge, count, or surface.

This rule is the floor of A.6's safety story. Violating it would let unsourced legacy assertions wear the same provenance badge as externally-verified evidence — turning the graph into laundering for unverified content. Validators added in the implementation PR must enforce this as a hard failure, not a warning.

### Extension `source` flag mapping

| Brief extension `source` | A.6 tier |
|---|---|
| `"research"` | `source_document_only` (or `verified` only if extension carries excerpt-level provenance — does not in current schema) |
| `"model"` | `inferred_from_brief_json` |
| `"chat"` | `chat_patch_object_level` |

---

## 6. User-edited / chat-patch content (load-bearing)

A.6 must handle briefs where user or assistant edits modified saved Brief content. The principle:

> **Object-level traceability is not claim-level evidence.**

Knowing that a user edited an initiative tells you the object exists in the user's mental model; it does NOT tell you which sentence the user added, where they sourced it, or whether it was a paraphrase of cited evidence. A.6 must not promote object-level edit metadata to claim-level evidence.

### Mechanics

- If patch/event metadata exists (e.g. brief_events captured the diff), the A.6 runner materializes a `SourceDocument` of subtype `chat_patch_event` recording the patch text and timestamp. Affected child claims inherit `tier = chat_patch_object_level` unless they also have a stronger source.
- If only the final `brief_json` exists with no patch history, the runner cannot distinguish user-added text from research-sourced text. All untagged content in such briefs defaults to `legacy_brief_json`. Claims do NOT receive `verified` or `source_document_only` tiers.
- If a patch affects a section/object but not individual sentences, child claims inherit `chat_patch_object_level` and the runner emits a parity report note flagging the inheritance.
- If patched content contradicts sourced content, the runner emits a `ConflictRecord` and a `GraphEdge(kind="contradicts")` between the patched Claim and the sourced Claim. The conflict is unresolved at A.6; a human reviewer or future product surface decides.

### Architectural choice: option A (special SourceDocument subtype)

A.6 represents user edits as **special `SourceDocument` records** with subtypes `user_edit_event` and `chat_patch_event`. The alternative — a distinct first-class `UserEditEvent` table — is **rejected for A.6**.

Rationale for A:
- Minimal schema surface area. A.6 reuses the existing `SourceDocument` primitive that A.5 already validates.
- Provenance traversal works through the same chain: claim → ClaimEvidence → EvidenceExcerpt → SourceDocument.
- Subtype tagging on `SourceDocument` is enough to make the parity reporter and any future UI distinguish "edit" from "external source" without a new join.

Rationale against B (distinct UserEditEvent table):
- New table = new validator surface, new migration, new query joins.
- The product hasn't yet decided what user-visible provenance vocabulary looks like ("from your edits" vs "user-added" vs "draft note"). Hardening that vocabulary into a table before the product question is answered would risk a schema-then-rename churn.
- A.7/A.8 may still need a distinct UserEditEvent model when user-visible provenance vocabulary hardens. A.6 should not preempt that decision.

### Important deferral

User-visible provenance labels are an A.7+ product question. The A.6 plan does NOT propose user-visible strings. Internal tier names (`legacy_brief_json`, etc.) are for validator and report consumption only.

---

## 7. Dual-render parity criteria (load-bearing)

### Headline: decision-equivalent, not byte-equivalent

A.6's parity goal is **decision-equivalent**, not byte-equivalent. The graph-rendered output and the legacy Brief should lead a reader to the same go/no-go conclusions, action recommendations, and stakeholder priorities. Whitespace, field ordering, and minor phrasing differences are acceptable. Material contradictions, dropped sections, or false-confidence shifts are not.

Parity is evaluated against three categories:

### A. Structural and render parity

- Every populated core Brief section is represented in the shadow graph.
- No whole populated section is silently dropped.
- The graph-rendered output is reviewable and comparable to the legacy Brief output by a human in the parity report.
- Whitespace, ordering, and minor phrasing differences are acceptable.
- Material contradictions in claim text are not acceptable.

### B. Material claim coverage

- Every material factual assertion in the legacy Brief is either:
  - represented as a graph `Claim`, or
  - explicitly listed in the parity report's "unsupported / unmapped" section.
- The runner does NOT invent new account-specific facts.
- The runner does NOT hide dropped facts. Drops surface in the report.

**Denominator clarification.** Any "claim coverage %" metric in the parity report MUST state its denominator. A.6 uses:
- **Automated structural/provenance checks across all target briefs** — heuristic, reported per-brief and in aggregate. This catches systematic decomposition gaps.
- **Human review of a representative sample** — e.g. 5 of N briefs where N is the current corpus size at implementation time (currently 26; should the count differ at implementation time, the runner uses `--limit` and `--brief-id` arguments to drive sample selection). The human reviewer judges material claim coverage and decision-equivalence.
- **Automated claim coverage is a heuristic / reporting metric, not the sole pass criterion.** Decision-equivalence depends on human judgment.

A pure machine score (e.g. "95% claim coverage") that does not specify its denominator is forbidden in the parity report.

### C. Provenance honesty

- `verified` tier only when evidence/source backing exists (per §5).
- No invented `SourceDocument` IDs.
- No invented `EvidenceExcerpt` IDs.
- No false `verified` provenance.
- Unsupported legacy content remains tagged `legacy_brief_json`, `inferred_from_brief_json`, or `unsupported`.

Provenance honesty is enforced by the validator. Any breach is a hard failure (see §9).

---

## 8. User-visible behavior during dual-render

**Default: CLI-only.**

A.6 produces side-by-side parity reports via the backfill runner. The reports are local artifacts (markdown + JSON) consumed by the implementer and reviewer. There is:

- No user-facing toggle.
- No production navigation entry.
- No admin route by default.

If a future implementation discussion proposes an internal preview route to render the shadow graph in a browser, that route MUST be:
- Explicitly deferred to A.7+ or separately approved.
- Behind a non-default feature flag labeled exactly **"Graph shadow render — not canonical"**.
- Hidden from public share surfaces.

Default A.6 is invisible to users.

---

## 9. Backfill failure modes (load-bearing)

### Per-brief classification

Every brief processed by the runner receives one of:

- `pass` — graph builds, validators pass all hard invariants, structural parity holds.
- `skipped_malformed_json` — input `brief_json` doesn't parse; skipped with a report entry.
- `skipped_unsupported_schema_variant` — brief is an older/newer schema variant the mapper doesn't handle; skipped with a report entry.
- `partial_with_attribution_gaps` — graph builds, hard invariants pass, but the parity report lists meaningful attribution gaps (e.g. many `legacy_brief_json` Claims where the source URL was present but unparseable).
- `failed_validation` — graph builds but validators fail at least one soft check (not a hard invariant).
- `failed_false_verified_provenance` — at least one Claim was emitted with `verified` tier from unsourced content. **Hard failure.**
- `failed_invented_evidence` — at least one `SourceDocument` or `EvidenceExcerpt` ID exists that has no real basis. **Hard failure.**
- `failed_render_parity` — material claim coverage or decision-equivalence sample review failed.

### Aggregate A.6 classification

`pass`, `borderline`, or `fail`:

- **`fail`** if any systematic dangerous failure occurs:
  - Any `failed_false_verified_provenance` outcome anywhere in the corpus.
  - Any `failed_invented_evidence` outcome.
  - Validation hard invariant failure caused by the mapping design (i.e. the design itself emits structurally invalid graphs).
  - Systematic whole-section loss across multiple briefs (i.e. the mapper is dropping populated content).
- **`borderline`** if:
  - Mostly valid graphs but too many `partial_with_attribution_gaps` outcomes to be confident.
  - Human review of the sampled subset finds material parity issues.
  - Aggregate pass depends on manual-cleanup assumptions about input data.
- **`pass`** if:
  - All or nearly all target briefs produce valid shadow graphs.
  - No dangerous provenance errors anywhere.
  - The human-reviewed sample is decision-equivalent.
  - Failures and skips are idiosyncratic (one malformed JSON, one unsupported variant) and explicitly reported.

Idiosyncratic bad data (one corrupt `brief_json`, one off-schema variant, one persona row with garbled fields) does NOT automatically fail A.6. Systematic dangerous failure (any false-verified-provenance, any invented IDs) DOES fail A.6.

---

## 10. Storage options (load-bearing)

Four candidates were considered:

- **A. Report-only generated JSON/markdown artifacts.** Runner writes shadow graphs and parity reports under `out/` or `tmp/`. Not persisted in any DB. Easy to inspect, version, attach to PRs.
- **B. Local shadow JSON / dev-only artifact store.** Same as A but writes to a known dev-mode location (e.g. a local file tree or a dev-only SQLite table) for the implementer to query repeatedly across runs.
- **C. Production shadow table.** A new table in the production DB (e.g. `account_graphs_shadow`) populated alongside saved briefs.
- **D. Future canonical graph tables.** Full graph storage replacing `brief_json` as the canonical source.

### Recommendation for A.6

**A + B.** The runner produces report-only artifacts (A) by default, with an optional dev-mode local shadow store (B) for iterative inspection. C and D are explicitly NOT recommended for A.6.

Rationale:
- A.6's purpose is design validation, not production data plumbing.
- A production shadow table (C) introduces migration, write-path coupling, and on-call surface area that A.6 doesn't need to prove its design.
- Canonical graph storage (D) is post-A.7; it depends on graph-first writes being unblocked, which they aren't.
- Keeping the artifact local means rollback is `rm -rf out/`; there is no production state to clean up.

If a production shadow table is later proposed (e.g. to support a graph-rendered preview route), that is a separate implementation decision with its own migration plan and rollback story. A.6 does not assume it.

**`brief_json` remains canonical throughout A.6.**

---

## 11. Backfill runner design

Future implementation file: `web/scripts/run-account-graph-backfill.ts`. Mirrors the existing `web/scripts/run-account-graph-spike.ts` pattern.

### Modes and flags

- `--mode fixture` — runs against curated fixtures (e.g. the Nueva fixture from A.5). Deterministic. No DB access. Useful as a smoke test.
- `--mode local-db` — runs against the implementer's local development SQLite. Read-only on `briefs`/`brief_json`. Writes artifacts to `--out`.
- `--limit <N>` — limit number of briefs processed.
- `--brief-id <id>` — process a single brief.
- `--out <path>` — output directory for artifacts (default `out/account-graph-backfill/<timestamp>/`).
- `--dry-run` — default **true**. When true, no DB writes happen (the runner is read-only on `brief_json`; the flag exists for symmetry with future modes that might write).
- `--fail-fast` — optional, default **false**. When true, runner exits on the first hard-invariant failure. When false (default), runner completes the corpus and reports all failures together.

### Example commands

```
npx tsx scripts/run-account-graph-backfill.ts --mode fixture
npx tsx scripts/run-account-graph-backfill.ts --mode local-db --limit 26 --dry-run
npx tsx scripts/run-account-graph-backfill.ts --mode local-db --brief-id <id> --dry-run
```

The default behavior must be dry-run and report-only. The runner must not call any model API, fetch any web resource, or write to production data.

---

## 12. Graph-rendered Brief parity approach

A.6 needs a graph→Brief renderer for comparison purposes ONLY. It does not replace production Brief rendering. The renderer produces:

- A normalized structured output (markdown + JSON) that reads like a Brief but is generated from graph traversal.
- A side-by-side parity report comparing the legacy Brief to the graph-rendered Brief.
- A "dropped / unsupported claims" section listing every legacy assertion not represented in the graph.
- A "provenance gaps" section listing every Claim whose tier is weaker than its position in the Brief implies (e.g. a `legacy_brief_json` Claim where the legacy Brief presented the assertion as confident).
- A "material differences" section listing semantic deltas the reviewer should focus on.

The renderer is implementation-only — not exposed via any route, not bundled into any production code path.

---

## 13. Tests required

The future implementation PR must add tests for:

- Section mapping — every populated Brief section produces the expected graph records.
- Provenance-tier assignment — every Claim's tier matches the rules in §5.
- No false verified claims — corpus-wide assertion that no Claim is `verified` without backing evidence.
- Unsourced legacy content downgrade — verifies that fields without sources get `legacy_brief_json`, not `verified`.
- Chat-patch / object-level provenance — verifies `chat_patch_event` SourceDocument materialization and `chat_patch_object_level` tier propagation.
- Malformed `brief_json` handling — runner classifies as `skipped_malformed_json`, doesn't crash, doesn't pollute output.
- Unsupported schema variant handling — same posture.
- Graph validation failure handling — when validators detect an invariant breach, runner classifies the brief appropriately and continues (unless `--fail-fast`).
- Parity report output — structural, claim-coverage, and provenance sections all present and correctly populated.
- Rollback / canonical source remains legacy — assertion that nothing in the A.6 runner writes to `brief_json` or alters canonical storage.
- No public/share route exposure — if any route is proposed (deferred), no test should pass with the route exposed via `web/app/s/**` or `web/app/api/share/**`.

---

## 14. Safety and rollback posture (load-bearing)

A.6 has **no production rollback** because it does not change canonical production behavior. The backfill runner is read-only on `brief_json`; the artifacts it produces live outside the production DB. Rolling back means deleting the artifact directory or branch.

### Future canonical pointer model

When (and only when) graph canonicalization is eventually considered (A.7 / A.8 territory at the earliest), the migration story will require a per-brief reversible pointer:

```
canonical_source: "brief_json" | "account_graph"
```

This pointer is **future A.7/A.8 design, not A.6 implementation**. A.6 mentions it here to anchor the eventual rollback story but does NOT add the pointer column or any related code.

### `brief_json` retirement

Retirement of `brief_json` as the canonical store is a **separately named future phase** — e.g. **Phase C.1** — that requires explicit go/no-go review. Retirement must NOT happen through gradual drift, undocumented flag flips, or silent default changes. The C.1 decision is made on its own merits, separately from A.6, A.7, and A.8.

---

## 15. A.7 blocker reminder

Quoted verbatim from `docs/BLOCKERS.md`:

> ## BLOCKED: A.7 graph-first writes of new research
>
> Status: blocked until model-mode validation passes.
>
> A.5 fixture mode proved that the graph schemas, deterministic excerpt verifier, validators, cascade computation, and reporting harness work against curated inputs. That is necessary but not sufficient for graph-first writes from new research.
>
> A.6 may proceed because it is deterministic backfill/decomposition from existing structured `brief_json`; it does not depend on unproven LLM reliability.
>
> A.7 must not begin until a model-mode validation run of the staged source → excerpt → claim/object pipeline has passed under explicit budget controls.

A.6 outcomes — regardless of classification — do NOT unblock A.7. A.7 unblock requires the model-mode run described in `docs/BLOCKERS.md` (opt-in, cost-ceilinged, with the hard-invariant pass criteria listed there). This is a process commitment.

---

## 16. Ordered future implementation tasks

The implementation PR for A.6 (separate, not in this docs PR) will likely add:

| Path | Purpose |
|---|---|
| `web/lib/accountGraph/fromBriefJson.ts` | Deterministic decomposition: brief_json → graph records. |
| `web/lib/accountGraph/briefParity.ts` | Graph → Brief renderer and parity comparator. |
| `web/lib/accountGraph/backfillReport.ts` | Markdown + JSON report writer. |
| `web/scripts/run-account-graph-backfill.ts` | CLI runner (per §11). |
| `tests/accountGraph.fromBriefJson.test.ts` | Mapping and provenance-tier tests (per §13). |
| `tests/accountGraph.briefParity.test.ts` | Parity renderer + report tests. |
| `docs/spikes/phase-a6-brief-json-backfill-results.md` | The A.6 results report (generated by the runner, committed to the implementation PR). |

These are future files. None are added in this docs PR.

---

## 17. Future verification commands

When the implementation PR lands, verification will be:

```
cd web && npm run typecheck
npx tsx --test tests/accountGraph.*.test.ts
npx tsx --test tests/accountGraph.fromBriefJson.test.ts tests/accountGraph.briefParity.test.ts
cd web && npx tsx scripts/run-account-graph-backfill.ts --mode fixture
cd web && npx tsx scripts/run-account-graph-backfill.ts --mode local-db --limit 26 --dry-run
```

The local-db dry-run requires an implementer-local development DB and never runs against production.

---

## 18. PR checklist

- [ ] Docs only
- [ ] No implementation
- [ ] No deploy
- [ ] No production migration
- [ ] No feature flag change
- [ ] brief_json remains canonical
- [ ] A.7 blocker restated
- [ ] A.6 architectural decisions explicit
- [ ] Storage recommendation included
- [ ] Failure/aggregate classification defined
- [ ] Rollback/canonical pointer story included
