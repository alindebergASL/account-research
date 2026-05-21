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
- The corpus file MUST live **outside the repo working tree entirely**
  (regardless of git-tracked status). The runner refuses any `--corpus`
  path that resolves under `git rev-parse --show-toplevel`, including the
  repo root, `web/`, `tests/`, `docs/`, `scripts/`, AND gitignored
  subdirectories such as `out/local-prod-baseline/`. Recommended:
  - Corpus file: under `/tmp/...`, `~/private/...`, or another
    operator-controlled location outside the repo.
- The `--out` directory MUST resolve to one of:
  - A path **outside** the repo working tree (e.g. `/tmp/a7-out-...`,
    `/var/tmp/...`, or any operator-controlled absolute path off the repo).
  - A path **under `out/local-prod-baseline/**`** (gitignored — see
    [`.gitignore`](../../.gitignore)). Any other in-repo path —
    including the repo root, `web/`, `docs/`, `tests/`,
    `out/account-graph-validation/`, `out/account-graph-backfill/` — is
    refused, and the runner does **not** create the directory.

Correct examples:

```bash
# Corpus outside the repo (good).
CORPUS=/tmp/a7-local-corpus-$(date +%s).jsonl
CORPUS=~/private/a7-corpus.jsonl

# Out outside the repo (good).
OUT=/tmp/a7-local-out-$(date +%s)

# Out under the gitignored allow-list (good).
OUT=out/local-prod-baseline/$(date +%Y%m%dT%H%M%SZ)
```

Incorrect examples (the runner will REFUSE and exit nonzero, without
creating anything):

```bash
# Corpus at the repo root or any in-repo dir → REFUSED.
CORPUS=./a7-corpus.jsonl
CORPUS=tests/fixtures/a7-corpus.jsonl
CORPUS=out/local-prod-baseline/inputs/a7-corpus.jsonl   # also refused for --corpus

# Out at the repo root or any non-allow-listed in-repo path → REFUSED.
OUT=./local-out
OUT=web/local-out
OUT=out/account-graph-validation/local-out
```

This is a guardrail against accidental `git add` of production-derived
content.

## Corpus format

The runner accepts either:

- **JSON** — a single Brief object, or a JSON array of Brief objects.
- **JSONL** — one Brief object per line.

Each entry is parsed against the Brief Zod schema (`web/lib/schema.ts`).
Entries that fail JSON parsing are classified `skipped_malformed_json`.
Entries that fail schema validation are classified
`skipped_unsupported_schema_variant`. Per-entry skips do **not** crash the
run as long as at least one valid Brief entry is present.

If **all** entries in the corpus are malformed or schema-mismatched (zero
valid Brief entries), the runner **refuses** to write any artifacts and
exits nonzero with a `zero valid Brief entries; refusing to write a
pass-looking baseline` error. This prevents an empty corpus from being
mistaken for a successful baseline. Fix the corpus and re-run.

Operator responsibility: derive the corpus from a local production backup
using whatever script you prefer (e.g. read from a local SQLite copy and
emit JSONL). That export step is intentionally not committed here — the
contents are production-derived.

## Procedure

```bash
# Step 1 — prepare a local-only corpus path OUTSIDE the repo.
CORPUS=/tmp/a7-local-corpus-$(date +%s).jsonl
# ... operator's export step produces $CORPUS ...

# Step 2 — pick an OUT path. Choose ONE of the two options below.
# Pass $OUT to --out directly from inside web/; do NOT prepend "../".
# Option A — in-repo ignored (relative from inside web/):
OUT=../out/local-prod-baseline/$(date +%Y%m%dT%H%M%SZ)
# Option B — outside repo entirely (absolute):
# OUT=/tmp/a7-local-out-$(date +%s)

# Step 3 — run the deterministic paired baseline (fixture mode, $0).
cd web
npx tsx scripts/run-account-graph-validation.ts \
  --corpus "$CORPUS" \
  --out "$OUT"
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
- [ ] The corpus file path is outside the repo working tree entirely (a
      corpus under `out/local-prod-baseline/` is also refused — that
      location is for `--out`, not `--corpus`).
- [ ] The `--out` path is either outside the repo or under
      `out/local-prod-baseline/**`.
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

## Next step

After this local deterministic baseline is complete and reviewed, the
*next* gated step is the paid model validation described in
[`docs/runbooks/phase-a7-paid-model-validation.md`](phase-a7-paid-model-validation.md).
That runbook depends on the artifacts produced here (especially
`local-baseline-selection.json` with operator-edited rationales) and
requires explicit human approval before any paid call.

The implementation plan for the real adapter consumed by Task 8 lives at
[`docs/plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md`](../plans/2026-05-21-phase-a7-real-model-adapter-implementation-plan.md).
The write-boundary doctrine that governs whether any of this ever
unblocks graph-first writes lives at
[`docs/decisions/2026-05-21-phase-a7-graph-first-write-boundary.md`](../decisions/2026-05-21-phase-a7-graph-first-write-boundary.md).

## Related

- Plan: `docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md`
- Blockers: `docs/BLOCKERS.md`
- Synthetic CI-safe fixtures: `tests/fixtures/a7_account_*.json`
- Runner: `web/scripts/run-account-graph-validation.ts`
