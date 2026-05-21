# Phase A.7 — Local production-backup baseline runbook

**Status:** Local-only operator procedure. NOT a CI procedure. A.7 graph-first
writes remain **BLOCKED** per [`docs/BLOCKERS.md`](../BLOCKERS.md) regardless
of any run produced via this runbook.

## What this is

A safe local-only path to run the **A.6 deterministic paired baseline** against
the real 3 A.7 gate accounts, sourced from a production-backup-derived corpus
on the operator's local machine.

This procedure:

- Makes **zero** model/API/network calls.
- Imports **no** provider SDKs (`@anthropic-ai/sdk`, `openai`, `resend`, etc.).
- Reads **no** provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).
- Makes **zero** production DB writes/reads.
- Runs **no** migrations.
- Touches **no** public/share/admin/route surfaces.
- Performs **no** A.7 graph-first writes.

The CI-safe baseline remains the **synthetic fixture corpus** committed in
PR #43 under `tests/fixtures/a7_account_*.json`. The procedure here is an
operator-driven supplement, not a replacement.

## When to use

Use this runbook when you need to measure the deterministic A.6 paired
baseline against actual production brief content (for the A.7 gate
selection rationale documented in
[`docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`](../plans/2026-05-21-phase-a7-model-mode-validation-plan.md)
§2) without committing any production-derived content to git.

## Prerequisites

- A local production-backup copy of the relevant briefs.
- The corpus file must live **outside** the repo working tree's tracked
  directories (`docs/`, `scripts/`, `tests/`, `web/`). Recommended:
  - Corpus file: under `/tmp/...` or another operator-controlled location
    outside the repo.
  - Output directory: `out/local-prod-baseline/<timestamp>/` (gitignored —
    see [`.gitignore`](../../.gitignore)) **or** a path under `/tmp/...`.

The runner **refuses** to read a `--corpus` from inside the repo's tracked
tree and **refuses** to write `--out` to such a path. This is a guardrail
against accidental `git add` of production-derived content.

## Corpus format

The runner accepts either:

- **JSON** — a single Brief object, or a JSON array of Brief objects.
- **JSONL** — one Brief object per line.

Each entry is parsed against the Brief Zod schema (`web/lib/schema.ts`).
Entries that fail JSON parsing are classified `skipped_malformed_json`.
Entries that fail schema validation are classified
`skipped_unsupported_schema_variant`. Skips do **not** crash the run.

Operator responsibility: derive the corpus from a local production backup
using whatever script you prefer (e.g. read from a local SQLite copy and
emit JSONL). That export step is intentionally not committed here — the
contents are production-derived.

## Procedure

```bash
# Step 1 — prepare a local-only corpus path OUTSIDE the repo.
CORPUS=/tmp/a7-local-corpus-$(date +%s).jsonl
# ... operator's export step produces $CORPUS ...

# Step 2 — pick an ignored out directory. Either of these is acceptable:
OUT=out/local-prod-baseline/$(date +%Y%m%dT%H%M%SZ)        # ignored via .gitignore
# OR
OUT=/tmp/a7-local-out-$(date +%s)                          # outside repo entirely

# Step 3 — run the deterministic paired baseline (fixture mode, $0).
cd web
npx tsx scripts/run-account-graph-validation.ts \
  --corpus "$CORPUS" \
  --out "../$OUT"      # use a path that resolves outside tracked dirs
cd ..

# Step 4 — confirm nothing got staged.
git status --short
git ls-files out/local-prod-baseline/      # must print nothing
```

The run is in `--mode fixture` (the default). No model adapter is invoked
against real data; the model-adapter seam is exercised only with the fake
deterministic adapter for `$0` observed cost.

## Artifacts

Each run writes under `$OUT`:

| File | Purpose |
|---|---|
| `paired-baseline.json` | Same shape as PR #43's synthetic `paired-baseline.json`, but with `corpus_kind: "local_production_backup"`. |
| `local-baseline-selection.json` | Per-account selection record. Each entry carries `local_artifact: true`, `committed: false`, `caveat: "local production-derived artifact, ignored, not committed"`. |
| `report.json` | Run-level metadata: branch, commit, classification, cost, A.7 blocker statement, paired-baseline pointer. |

`local-baseline-selection.json` is the place to record operator-controlled
fields such as `account_label`, `selection_rationale`, and
`criteria_covered` for each gate account against the §2 criteria:

- `chat_patch_object_level_content`
- `public_web_sources`
- `non_url_sources`
- `legacy_high_confidence_claims`
- `at_least_one_a6_pass_account`
- `at_least_one_a6_partial_with_attribution_gaps_account`
- `procurement_governance_complexity`

The runner does not invent rationales or criteria coverage for real
accounts — operator must edit the produced `local-baseline-selection.json`
in place (the artifact lives in an ignored path) before the file is used
as input to any A.7 review.

## Operator checklist (must pass before stepping away)

- [ ] `git status --short` shows **no** changes inside any tracked directory.
- [ ] `git ls-files out/local-prod-baseline/` prints **nothing**.
- [ ] The corpus file path is outside the repo, or under `out/local-prod-baseline/`.
- [ ] No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` was set in this shell while
      running the procedure (the runner does not read these, but belt-and-braces).
- [ ] No edits to public/share/admin/route code as part of this work.
- [ ] No edits to migrations or production DB.
- [ ] Synthetic fixtures under `tests/fixtures/a7_account_*.json` are **unchanged**.

## What this run does NOT do

- It does **not** unblock A.7. A.7 unblock requires the model-mode paired
  validation pass described in `docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`
  §2–§5.
- It does **not** run the model-mode pipeline. Use `--mode model --adapter fake`
  (still local, still $0) only for boundary testing; use `--mode model` without
  `--adapter fake` is **refused** in this PR.
- It does **not** capture or write any production data into the repo.

## Related

- Plan: `docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`
- Blockers: `docs/BLOCKERS.md`
- Synthetic CI-safe fixtures: `tests/fixtures/a7_account_*.json`
- Runner: `web/scripts/run-account-graph-validation.ts`
