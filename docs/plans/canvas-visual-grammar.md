# Canvas Visual Grammar + Deterministic Layout Planner Plan

> **For Hermes:** This is a planning-only deliverable. Do not implement from this branch without a separate implementation PR and review gate.

**Goal:** Make Canvas feel like Hermes selected the right representation for each account story while keeping every choice deterministic, source-cited, read-only, and runtime-pure.

**Architecture:** Add a pure Canvas layout planner that computes brief signals, classifies the account story, selects from an approved visual grammar, and emits deterministic layout metadata consumed by the existing read-only Canvas adapter. Hermes' fingerprint comes from ranking, emphasis, and form selection; not runtime LLM calls, generated UI, or new branding labels.

**Tech Stack:** Next.js 14 app router, React, TypeScript, Zod, node:test/tsx. First implementation PR remains UI/schema-adapter only, with no DB migration, no worker change, no public share expansion, and no provider calls.

---

## Context

PR #25, squash merge `ee9cfb0` on `main`, shipped the Hermes generative workspace framing: recommended-action spine, dossier modals, Hermes-voiced eyebrows, narrow-viewport overflow fixes, and copy sweep. Production QA passed.

The next blocker is that Canvas still has too little visual variety:

- Five different `section_ref` widgets reuse `InitiativeLandscape`.
- The strategic row stacks bar-style modules.
- The only non-bar primitives in `visuals.tsx` today are `MiniGauge`, `ToneIcon`, `SeverityChip`, and `SourceTypeBadge`.
- None of those primitives carry a whole account story.

Canvas still reads as a deterministic dashboard rather than Hermes choosing the right representation per account.

We are not ready for arbitrary generated UI or model-at-render calls. The right next step is a controlled visual grammar plus a deterministic layout planner that picks among approved forms based on saved-brief signals.

The fingerprint of Hermes is the planner's classification and selection. It is not new badges, labels, or runtime code generation.

---

## Planning PR Deliverable

This PR is planning only.

Required deliverable:

- Branch: `plan/canvas-visual-grammar`, created from latest `main`.
- File: `docs/plans/canvas-visual-grammar.md`.
- Commit: `docs(canvas): plan visual grammar + deterministic layout planner`.
- No implementation code.
- No deploy.

This file is the only intended tracked change for the planning PR.

---

## Architecture Diagram

```text
saved Brief (Zod-validated)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ CanvasLayoutPlanner   (web/lib/canvas/layoutPlanner.ts NEW) │
│   Inputs: Brief                                              │
│   Pure / deterministic / no provider calls                   │
│                                                              │
│   1. computeBriefSignals(brief) → BriefSignals               │
│        - signalRecency (count + freshness heuristic)         │
│        - personaDepth (count + confidence quality)           │
│        - initiativeStrength                                  │
│        - riskWeight                                          │
│        - buyingPathRichness                                  │
│        - technicalFootprintRichness                          │
│        - procurementSignal                                   │
│        - hasRecommendedAction                                │
│                                                              │
│   2. classifyStory(signals) → CanvasStoryType                │
│        union: "momentum" | "stakeholder-led" |               │
│               "risk-balanced" | "tech-modernization" |       │
│               "procurement-window" | "single-action" |       │
│               "balanced" (default)                           │
│                                                              │
│   3. selectVisualForms(story, signals) → PlannedModule[]     │
│        respects VISUAL_GRAMMAR_RULES                         │
│        - max 1 bar/list module per top cluster (first 5)     │
│        - prefer variety: timeline, map, matrix, narrative,   │
│          action in first cluster                             │
│        - never two bar-style adjacent                        │
│                                                              │
│   4. layout(modules) → CanvasLayoutPlan                      │
│        12-col bin pack; emits x/y/w/h per module             │
│                                                              │
│   Output: CanvasLayoutPlan = {                               │
│     story: CanvasStoryType,                                  │
│     modules: PlannedModule[]                                 │
│   }                                                          │
│   PlannedModule = {                                          │
│     id, kind, form: VisualForm, source brief paths,          │
│     prominence, reason (audit-only, never visible debug),    │
│     layout: {x,y,w,h}                                        │
│   }                                                          │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
buildReadOnlyCanvasFromBrief(brief)
   reads CanvasLayoutPlan and emits typed widgets;
   chooses Tile/Detail variant per `form` (not just kind)
        │
        ▼
Canvas widgets (existing schema, unchanged shape) +
  new VisualForm tag on data payload for tile/detail dispatch
        │
        ▼
ReadOnlyCanvasView grid → existing Tile/Detail components,
  with new presentational components for the 2–3 new forms
```

---

## Product Goal

Make Canvas feel like Hermes selected the right representation for this account's story, while keeping every choice:

- deterministic;
- source-cited;
- read-only;
- runtime-pure;
- bounded to approved typed visual forms.

The Hermes fingerprint is the planner's classification plus selection. It is not new labels or live LLM calls.

---

## First Implementation PR Scope: Exactly Three New Visual Forms

Build exactly three new visual forms in the first implementation PR. Each is a non-bar form that materially diversifies the top of Canvas.

### 1. Timeline / momentum lane

`form: "timeline"`

Renders:

- `recent_signals`;
- `top_initiatives`;
- `programs_procurement.active_rfps_contracts`.

Presentation:

- Left-to-right time band.
- Relative order only, not absolute dates, because the brief does not have reliable absolute dates today.
- Three swimlanes: signals, initiatives, procurement.

Selection:

- `story = "momentum"`; or
- `signalRecency >= 3` and `procurementSignal >= 1`.

### 2. Stakeholder / persona map

`form: "persona-map"`

Renders:

- `personas[]` as cards around a central `decision` node;
- influence edges derived from `buying_path` text using regex-tokenised stakeholder mentions.

Selection:

- `story = "stakeholder-led"`; or
- `personas.length >= 3` and `buyingPathRichness >= medium`.

Important constraint:

- Edges must only come from explicit `buying_path` token mentions. Do not infer relationships beyond the text.

### 3. Opportunity / tension matrix

`form: "tension-matrix"`

Renders:

- 2x2 grid.
- Axis A: ease vs. ambition, derived from initiative count vs. confidence.
- Axis B: opportunity vs. caveat, derived from initiative count vs. risk count.
- Initiatives plotted as dots.
- Risks rendered as small markers on the caveat side.

Selection:

- `story = "risk-balanced"`; or
- `initiativeStrength` and `riskWeight` both at least medium.

### Existing widgets as fallbacks

The existing `opportunity_risk_split`, `momentum_strip`, and `strategic_signal_radar` widgets stay, but become fallback forms when the new variants do not fit, or render alongside them as lower-prominence secondary modules.

### Explicitly out of scope

Do not add in this first implementation PR:

- Org graphs, until edges are authoritative.
- Competitive feature grids, deferred to a later extension-kind PR.
- Risk waterfalls, deferred.

---

## Layout Planner Signal Extraction

`computeBriefSignals(brief): BriefSignals` is pure and tested.

Initial thresholds may be constants. They can become env-overridable later, but not in the first implementation PR.

| Signal | Derivation | Bucket thresholds |
| --- | --- | --- |
| `signalRecency` | `recent_signals.length` plus high-confidence weight | `0/1/2/3+` → none/low/medium/high |
| `personaDepth` | `personas.length` weighted by confidence buckets | `0/1/2/3+` |
| `initiativeStrength` | `top_initiatives.length` weighted by confidence | `0/1/2/3+` |
| `riskWeight` | `risks.length + competitive_signals.length` | `0/1/2/3+` |
| `buyingPathRichness` | `buying_path` token count plus stakeholder mentions | none/low/medium/high |
| `technicalFootprintRichness` | count of populated `TechnicalFootprint` fields | `0/2/4/6+` |
| `procurementSignal` | `programs_procurement.active_rfps_contracts.length + modernization_grants` | `0/1/2+` |
| `hasRecommendedAction` | non-empty `brief.next_action` | boolean |

---

## Story Classification Cascade

`classifyStory(signals): CanvasStoryType` follows this rule cascade:

1. `signalRecency = high` and `procurementSignal >= 1` → `"momentum"`.
2. `personaDepth >= high` and `buyingPathRichness >= medium` → `"stakeholder-led"`.
3. `initiativeStrength >= medium` and `riskWeight >= medium` → `"risk-balanced"`.
4. `technicalFootprintRichness >= high` and `initiativeStrength >= medium` → `"tech-modernization"`.
5. `procurementSignal >= 2` and `riskWeight < medium` → `"procurement-window"`.
6. `hasRecommendedAction` and signals are otherwise thin → `"single-action"`.
7. Otherwise → `"balanced"`.

The `balanced` fallback should preserve today's layout where the heuristics cannot confidently classify the account.

---

## Visual Grammar Rules

`VISUAL_GRAMMAR_RULES` are enforced inside `selectVisualForms`.

Rules:

1. The first 5 modules after the Executive Cockpit must contain at most one bar-style module.
2. Bar-style modules include `InitiativeLandscape`, ConfidenceBar rows, `momentum_strip`, and strategic-signal radar bars.
3. No two bar-style modules may be adjacent in `y`.
4. If the evidence board, which uses bar-style ConfidenceBar rendering, is in the top cluster, the adjacent strategic row must use a non-bar form: `timeline`, `tension-matrix`, or `persona-map`.
5. `section_ref` widgets that currently reuse `InitiativeLandscape` for personas, recent signals, and competitive signals may only continue doing that when their data is sparse, defined as 3 or fewer items.
6. When there are at least 4 items and personas or buying-path data is rich, the planner promotes a `persona-map` module instead and the `section_ref` drops to a simple-text variant.
7. The cockpit's `Priority move` cell stays a pointer. The `action-next` widget remains the primary action object.
8. Hard layout cap: the first 5 modules collectively occupy `y < 18` rows.

---

## Copy and Mobile-Density Polish

Carry forward these polish items from PR #25 QA in the implementation PR.

### Copy replacements

Replace remaining product-mechanical phrases:

- `saved brief` → `account brief`, or omit.
- `Review-only recommendation` stays in the Recommended Move dossier, but is removed from secondary places such as footer duplication on every modal. One per surface, not per card.
- `generated`, `synthesized`, and `citations stitched together` → omit. The framing eyebrow already conveys the concept.

### Provenance consolidation

- Consolidate provenance to a single line at the modal footer.
- Remove the in-body `Synthesized from saved account evidence` line from the Recommended Move detail.
- One provenance line is enough.

### Mobile detail sheets

At `< sm`, modal sections become collapsed by default after the first three:

1. Recommended move.
2. Why this matters.
3. Expected outcome.

Remaining sections expand on tap.

Implementation requirement:

- Use native `<details>` with a small chevron.
- Preserve native semantics.
- No new dependency.

### Card scannability

- Tighten `tiles.tsx` to use `line-clamp-3` on secondary cards.
- Primary cards, especially the `action-next` row, stay unclamped. This was already handled in PR #25 and must not regress.

---

## Hard Safety Guardrails

Preserve these verbatim:

- No Run / Execute / Approve / Dismiss controls. Existing test remains.
- No live provider/model calls in canvas render. Existing `tests/canvasBridge.test.ts` grep test for provider symbols stays.
- No arbitrary generated React, HTML, or code from model output. The planner emits typed `VisualForm` enum values. Tile components are static React.
- No public share surface expansion. `web/app/s/[token]/...` and `web/app/api/share/[token]/...` are untouched.
- No schema / DB migration. Planner output is computed in memory. Nothing is persisted. Brief JSON schema unchanged.
- All `widget.controls` remain false. Existing test stays.
- Canvas preview stays admin-gated via `canPreviewCanvas` plus `CANVAS_PREVIEW_ENABLED=1`. Untouched.
- Existing public share routes remain sanitized and negative-tested.
- Worker process is not touched.

---

## File-by-File Changes for the Implementation PR

This section describes the later implementation PR. It is not part of this planning PR.

### New files

- `web/lib/canvas/layoutPlanner.ts`
  - `computeBriefSignals`
  - `classifyStory`
  - `selectVisualForms`
  - `planLayout`
  - `buildCanvasLayoutPlan(brief)` entry point
  - Pure and React-free.

- `web/lib/canvas/visualGrammar.ts`
  - `VisualForm` enum
  - `VISUAL_GRAMMAR_RULES`
  - `isBarStyleForm`
  - `formForStoryAndSection`
  - Pure and React-free.

- `web/components/canvas/visualForms/TimelineLane.tsx`
  - Tile + Detail pair.
  - Swimlanes rendered with plain CSS grid and semantic divs.
  - No chart library.

- `web/components/canvas/visualForms/PersonaMap.tsx`
  - Tile + Detail pair.
  - CSS-positioned cards around a central decision node.
  - Edges as `<svg>` lines.

- `web/components/canvas/visualForms/TensionMatrix.tsx`
  - Tile + Detail pair.
  - 2x2 CSS-grid quadrants.

- `docs/plans/canvas-visual-grammar.md`
  - This plan.

### Modified files

- `web/lib/canvas/schema.ts`
  - Add optional `form?: VisualForm` field to base widget data payloads.
  - Backward-compatible default is `undefined`, which keeps the existing rendering path.

- `web/lib/canvas/fromBrief.ts`
  - Call `buildCanvasLayoutPlan(brief)` first.
  - Pass the resulting plan to widget emitters.
  - Keep widget IDs stable.

- `web/lib/canvas/registry.tsx`
  - Add descriptors only if new kinds are introduced.
  - Recommendation is to avoid new kinds and prefer a `form` discriminator.

- `web/components/canvas/tiles.tsx`
  - Dispatch to `TimelineLane`, `PersonaMap`, or `TensionMatrix` when the widget carries the corresponding `form`.
  - Keep existing dispatch as fallback.

- `web/components/canvas/details.tsx`
  - Same form-first dispatch.

- `web/components/canvas/ReadOnlyCanvasView.tsx`
  - Minor mobile behavior: at `< sm`, render the first three modal sections expanded and the rest collapsible.

- `tests/canvasBridge.test.ts`
  - Add planner and visual grammar test cases listed below.

### Untouched hard-guardrail files and areas

Do not modify:

- `web/lib/canvas/capability.ts`
- `web/app/api/briefs/[id]/route.ts`
- `web/app/brief/[id]/page.tsx`, except toggle wiring must remain unchanged
- `web/app/s/[token]/...`
- `web/app/api/share/[token]/...`
- `web/components/BriefCanvas.tsx`
- Worker
- DB
- Auth

---

## Bite-Sized Implementation Tasks for Later PR

### T1: Write visual grammar types

Objective: Add grammar constants and helpers.

Files:

- Create: `web/lib/canvas/visualGrammar.ts`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Enum exhaustiveness.
- Helper purity.
- `isBarStyleForm` returns expected values.

### T2: Write `computeBriefSignals`

Objective: Extract deterministic signal buckets from a brief.

Files:

- Create: `web/lib/canvas/layoutPlanner.ts`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Fixture snapshot on existing sample brief.
- Synthetic sparse brief.
- Synthetic rich brief.

### T3: Write `classifyStory`

Objective: Implement the rule cascade for every story type.

Files:

- Modify: `web/lib/canvas/layoutPlanner.ts`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Misty-like profile → momentum.
- Tufts-like profile → stakeholder-led.
- Bass-like profile → procurement-window or balanced, depending on engineered signals.
- Sparse profile → single-action or balanced.
- Every story type covered by at least one engineered fixture.

### T4: Write `selectVisualForms`

Objective: Pick visual forms while enforcing `VISUAL_GRAMMAR_RULES`.

Files:

- Modify: `web/lib/canvas/layoutPlanner.ts`
- Test: `tests/canvasBridge.test.ts`

Tests:

- First 5 modules contain at most 1 bar-style module.
- No two bar-style modules are adjacent.
- Rich persona/buying-path briefs promote `persona-map`.
- Sparse data falls back to existing simple variants.

### T5: Write `planLayout`

Objective: Emit deterministic 12-column layout bounds for planned modules.

Files:

- Modify: `web/lib/canvas/layoutPlanner.ts`
- Test: `tests/canvasBridge.test.ts`

Implementation note:

- Reuse the GridPacker logic currently embedded in `fromBrief.ts` where possible.

Tests:

- Bounds stay within 12 columns.
- No overlap.
- Deterministic ordering across repeated calls.
- First 5 modules stay under the `y < 18` cap.

### T6: Integrate planner into `fromBrief.ts`

Objective: Route Canvas adapter through `buildCanvasLayoutPlan` while preserving stable widget IDs and fallback behavior.

Files:

- Modify: `web/lib/canvas/fromBrief.ts`
- Modify if needed: `web/lib/canvas/schema.ts`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Widget IDs remain unique.
- Widget IDs remain stable for unchanged input.
- Planner output is deterministic.
- When planner output equals today's deterministic emission, ordering remains regression-safe.

### T7: Ship TimelineLane tile and detail

Objective: Add the timeline/momentum lane presentational form.

Files:

- Create: `web/components/canvas/visualForms/TimelineLane.tsx`
- Modify: `web/components/canvas/tiles.tsx`
- Modify: `web/components/canvas/details.tsx`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Swimlane row count is stable.
- Empty lanes do not render fabricated items.
- `data-testid="timeline-lane"` exists.

### T8: Ship PersonaMap tile and detail

Objective: Add the stakeholder/persona map form.

Files:

- Create: `web/components/canvas/visualForms/PersonaMap.tsx`
- Modify: `web/components/canvas/tiles.tsx`
- Modify: `web/components/canvas/details.tsx`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Node count matches `personas.length`.
- Edges are derived only from `buying_path` text.
- No fabricated edges.

### T9: Ship TensionMatrix tile and detail

Objective: Add the opportunity/tension matrix form.

Files:

- Create: `web/components/canvas/visualForms/TensionMatrix.tsx`
- Modify: `web/components/canvas/tiles.tsx`
- Modify: `web/components/canvas/details.tsx`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Quadrant labels are stable.
- Items are placed in the correct quadrant per confidence and risk count.
- Risks appear on the caveat side.

### T10: Copy-density polish and mobile collapsible details

Objective: Apply PR #25 QA follow-through without expanding scope.

Files:

- Modify: `web/components/canvas/tiles.tsx`
- Modify: `web/components/canvas/details.tsx`
- Possibly modify: `web/components/canvas/ReadOnlyCanvasView.tsx`
- Test: `tests/canvasBridge.test.ts`

Tests:

- Collapsible affordance source-grep sees `<details>` in `details.tsx`.
- Banned internal copy is absent.
- Recommended Move primary content remains unclamped.

---

## Tests for the Implementation PR

Add these to `tests/canvasBridge.test.ts`:

- `computeBriefSignals` produces deterministic output on fixture, with snapshot-style expectations.
- `classifyStory` returns each story type for engineered fixtures.
- `selectVisualForms` first 5 modules contain at most 1 bar-style module.
- `selectVisualForms` never emits two adjacent bar-style modules.
- `buildCanvasLayoutPlan` is deterministic across calls.
- Planner output widget IDs remain unique and stable for unchanged input.
- New widget kinds, if introduced, are in `ALL_WIDGET_KINDS` and have registry descriptors.
- New tiles render no `Run`, `Execute`, `Approve`, or `Dismiss` labels. Extend the existing source-level grep test.
- Generated canvas walk has no banned internal copy:
  - `next_action`
  - `brief.next_action`
  - `READ-ONLY MODE`
  - `Provenance: hermes`
  - `INSIGHT · TABLE`
  - `Hermes-ranked`
- Layout stays within 12-column bounds. Extend existing test to new forms.
- Mobile-collapsible source-grep confirms a `<details>` element exists in `details.tsx`.

---

## Verification Commands for the Implementation PR

Paste verbatim outputs in the implementation PR body:

```bash
./web/node_modules/.bin/tsx --test tests/canvasBridge.test.ts
./web/node_modules/.bin/tsx --test tests/canvasCapability.test.ts
./web/node_modules/.bin/tsx --test tests/schema.test.ts
./web/node_modules/.bin/tsx --test tests/briefMerge.test.ts
./web/node_modules/.bin/tsx --test tests/briefEvents.test.ts
cd web && npm run typecheck
cd web && npm run build
cd .. && git diff --check
```

---

## Browser QA Acceptance Criteria for the Implementation PR

Run QA on production-like data for:

- Misty Robotics;
- Tufts Medicine;
- Bass Pro Shops.

Acceptance criteria:

- Visually distinct module mix per account.
  - Misty should lean momentum/timeline.
  - Tufts should lean stakeholder-led/persona-map.
  - Bass should lean procurement-window or balanced.
  - Actual classification must be verified against planner output.
- No horizontal overflow at 360 px viewport.
- Recommended Move card visible near top, full-width, content unclamped.
- Executive Cockpit Priority-move cell remains a pointer, with no duplicated action text.
- At least 2 non-bar visual forms, from timeline / persona-map / tension-matrix, visible above the lower long-list region where data supports it.
- Modal details open by mouse click and Enter/Space key.
- No JS console errors.
- No Run / Execute / Approve / Dismiss controls.
- No banned internal copy.

---

## Rollback Strategy for the Implementation PR

- Planner output is gated behind a const `LAYOUT_PLANNER_ENABLED` in `fromBrief.ts`, default true.
- Setting `LAYOUT_PLANNER_ENABLED` to false restores the pre-PR deterministic emission path.
- This provides a one-line revert if the new forms misrender at scale.
- New visual forms are net-additive. Rolling back the `TimelineLane`, `PersonaMap`, and `TensionMatrix` imports plus dispatcher branches removes them without affecting existing kinds.
- No DB migration means no DB rollback.
- PR should be single-commit-revertable.

---

## Deploy Notes

### Planning PR

- This planning PR is docs only.
- It adds `docs/plans/canvas-visual-grammar.md` on branch `plan/canvas-visual-grammar`.
- No code.
- No deploy.

### Later implementation PR

- Follow the v12 SQLite playbook only because all Canvas PRs do. The worker and webapp need a clean reload.
- Re-verify `prod-health-check.sh` after deploy.
- No environment-variable changes required.

---

## Open Questions and Tradeoffs

### New widget kinds vs. form discriminator on existing kinds

Recommendation: keep widget kind count stable and add an optional `form` field inside `widget.data` for `section_ref` / extension variants.

Tiles and details dispatch on `form` first, falling back to the kind's default renderer.

Tradeoff:

- Richer dispatch logic in `tiles.tsx` and `details.tsx`.
- Less schema churn.
- No migration.
- No new `ALL_WIDGET_KINDS` entries if no new kinds are introduced.

This is the safer path.

### PersonaMap edges

Edges are derived only from explicit `buying_path` token mentions.

Tradeoff:

- Thin briefs may show isolated nodes with no edges.
- That is honest.

Do not infer relationships beyond the text.

### Timeline relativity

Without absolute dates, the timeline lane orders items by `recent_signals` order, which already reflects brief priority, and groups by lane rather than absolute time.

Tradeoff:

- No real recency axis.
- Honest representation of current data.

A future PR can parse date heuristics from `Signal.source`, such as `Feb 2026`.

### Mobile collapsible details

Use native `<details>` for accessibility.

Tradeoff:

- Less designer control over chevron style.
- Zero JavaScript.
- Immediate keyboard support.

### Balanced fallback

If thresholds do not trigger a story, default to today's layout.

This keeps the planner net-additive on accounts the heuristics cannot classify.

### Synthetic fixtures

The implementation PR should add three tiny JSON fixtures under `tests/fixtures/` for Misty-, Tufts-, and Bass-like profiles.

Do not commit production data.

---

## Verification for This Planning PR

Required checks:

```bash
git diff --check
branch=$(git branch --show-current)
test "$branch" = "plan/canvas-visual-grammar"
test -f docs/plans/canvas-visual-grammar.md
tracked=$(git diff --cached --name-only)
```

Acceptance:

- `git diff --check` clean.
- File exists at `docs/plans/canvas-visual-grammar.md`.
- Branch is off `origin/main` at or after `ee9cfb0`.
- No edits to `.ts`, `.tsx`, `package.json`, schema, DB, worker, auth, or public share route files.
