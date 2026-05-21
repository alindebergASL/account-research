# Canvas Polish + Schema Alignment Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the behind-flag read-only canvas polished enough for production preview while preserving production safety: no provider-backed actions, no refresh mutation, no public-share canvas, and production flag remains OFF until explicitly enabled.

**Architecture:** Keep the existing production bridge (`buildReadOnlyCanvasFromBrief`) as the source of truth and improve it in place. Port only safe, deterministic UI/schema improvements from the Hermes lab prototype: richer widget data shapes, layout-aware rendering, clearer widget chrome, stronger drill details, and dedicated extension-derived widgets. Do not import lab localStorage stores, fakeHermes, action queues, reducers, or autonomous controls.

**Tech Stack:** Next.js 14 app router, React/TypeScript, Zod schemas, existing Brief schema, node:test, PM2/nginx deployment behind `NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE`.

---

## Scope

Implement one PR, suggested branch:

```bash
git checkout main
git pull --ff-only origin main
git checkout -b hermes/canvas-polish-schema
```

PR scope:

1. Improve canvas visual polish and layout on the existing authenticated `/brief/[id]` page when `NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1`.
2. Widen production canvas schema to safely match the richer lab prototype where useful.
3. Bridge saved `brief.extensions` into dedicated extension widgets instead of only a single generic Insights section reference.
4. Add disabled/placeholder refresh/action affordances only if they are explicitly non-clickable or show “coming later”; no real action execution.
5. Strengthen tests and fake-provider fixtures so the flag-on canvas can be reviewed without paid provider calls.

Hard out of scope:

- Do not enable `NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE` in production.
- Do not add live provider/model calls.
- Do not add schedule-based refresh, merge, version-history changes, or diff view.
- Do not add canvas persistence tables or DB migrations unless explicitly approved before implementation.
- Do not import lab `store.ts`, `reducer.ts`, `fakeHermes.ts`, `actions.ts`, `ActionQueue.tsx`, or `HermesComposer.tsx` into production.
- Do not expose canvas on public share routes (`/s/[token]`, `/api/share/[token]`).
- Do not run `npm audit fix --force`.

Reference files:

Production current bridge:
- `web/lib/canvas/schema.ts`
- `web/lib/canvas/fromBrief.ts`
- `web/lib/canvas/registry.tsx`
- `web/components/canvas/ReadOnlyCanvasView.tsx`
- `web/components/canvas/WidgetTile.tsx`
- `web/components/canvas/tiles.tsx`
- `web/components/canvas/details.tsx`
- `web/app/brief/[id]/page.tsx`
- `tests/canvasBridge.test.ts`

Safe lab reference only:
- `/home/ubuntu/account-research-hermes-lab/web/lib/canvas/schema.ts`
- `/home/ubuntu/account-research-hermes-lab/web/components/canvas/WidgetTile.tsx`
- `/home/ubuntu/account-research-hermes-lab/web/components/canvas/tiles.tsx`
- `/home/ubuntu/account-research-hermes-lab/web/components/canvas/details.tsx`
- `/home/ubuntu/account-research-hermes-lab/web/components/canvas/CanvasView.tsx` for visual layout only; do not port state/action behavior.

---

## Task 1: Create branch and baseline verification

**Objective:** Start from latest main and prove the current code is clean before edits.

**Files:** none.

**Steps:**

```bash
cd /home/ubuntu/account-research
git fetch origin main
git checkout main
git pull --ff-only origin main
git checkout -b hermes/canvas-polish-schema
cd web
npm run typecheck
npm run build
cd ..
npm test -- tests/canvasBridge.test.ts
```

Expected:
- typecheck passes.
- build passes.
- canvas bridge tests pass.

Commit: none.

---

## Task 2: Widen schema safely toward lab shape

**Objective:** Align production `CanvasWidget` data shapes with the richer lab prototype without enabling mutability.

**Files:**
- Modify: `web/lib/canvas/schema.ts`
- Test: `tests/canvasBridge.test.ts`

**Implementation details:**

Keep the same widget kinds:
- `section_ref`
- `evidence_board`
- `action_panel`
- `open_questions`
- `metric`

Schema changes:

1. `WidgetLayout`
   - constrain `x` and `y` to `.int().min(0)`
   - constrain `w` to `.int().min(1).max(12)`
   - constrain `h` to `.int().min(1).max(24)`

2. `WidgetSource`
   - add safe enum values used by lab/future systems:
     - `refresh`
     - `hermes`
   - Keep current production values:
     - `system`, `model`, `chat`, `user`

3. `Source`
   - keep `accessed` optional for compatibility with existing brief sources.
   - require `title` and `url` strings, but do not require non-empty if current brief data may contain blanks; avoid breaking legacy parsed briefs.

4. `MetricData`
   - support both current and richer shape:
     - `label: string`
     - `value: string`
     - `helper?: string`
     - `unit?: string`
     - `as_of?: string`
     - `delta?: string`

5. `OpenQuestionsData`
   - support structured questions while accepting current string questions:
     ```ts
     export const OpenQuestion = z.union([
       z.string(),
       z.object({
         text: z.string(),
         blocking: z.boolean().default(false),
         hypothesis: z.string().optional(),
       }),
     ]);
     ```

6. `ActionPanelData`
   - support current `{ label, detail }` and lab `{ text, why, owner?, severity? }` forms:
     ```ts
     export const ActionItem = z.object({
       label: z.string().optional(),
       detail: z.string().optional(),
       text: z.string().optional(),
       why: z.string().optional(),
       owner: z.string().optional(),
       severity: z.enum(["low", "medium", "high"]).optional(),
     }).refine((a) => a.label || a.text, "action needs label or text");
     ```

7. `EvidenceBoardData`
   - preserve current `items` and add lab-compatible `snippets`:
     ```ts
     items: z.array(EvidenceItem).default([]),
     snippets: z.array(EvidenceSnippet).default([]),
     ```
   - renderers should combine/normalize both.

8. `WidgetControls`
   - defaults must remain false in production, unlike lab.
   - Add tests asserting every widget built from a brief has all controls false.

Tests to add/update:
- Schema accepts lab-shaped metric fields (`unit`, `delta`, `as_of`).
- Schema accepts structured open questions.
- Schema accepts action items with `text`/`why`.
- Schema accepts evidence board `snippets`.
- `buildReadOnlyCanvasFromBrief` still produces controls=false.

Run:

```bash
cd /home/ubuntu/account-research
npm test -- tests/canvasBridge.test.ts
cd web && npm run typecheck
```

Commit:

```bash
git add web/lib/canvas/schema.ts tests/canvasBridge.test.ts
git commit -m "feat(canvas): widen read-only widget schema"
```

---

## Task 3: Add layout-aware polished widget chrome

**Objective:** Replace the simple two-column card grid with layout-aware, lab-inspired widget tiles that are visually clearer and production-safe.

**Files:**
- Modify: `web/components/canvas/ReadOnlyCanvasView.tsx`
- Modify: `web/components/canvas/WidgetTile.tsx`
- Modify: `web/components/canvas/tiles.tsx`
- Modify: `web/components/canvas/details.tsx`
- Test: `tests/canvasBridge.test.ts` if new test IDs are needed.

**Implementation details:**

1. `ReadOnlyCanvasView.tsx`
   - Use a 12-column grid on medium+ screens:
     ```tsx
     className="grid grid-cols-1 md:grid-cols-12 gap-4"
     ```
   - Add a compact preview header:
     - account name
     - widget count
     - “Read-only preview” badge
     - “Derived from saved brief” copy
   - Keep existing toggle behavior in `web/app/brief/[id]/page.tsx`; do not make Canvas default.

2. `WidgetTile.tsx`
   - Use `widget.layout.w` for `md:gridColumn` style, clamped 1..12.
   - Show:
     - descriptor label
     - widget title
     - confidence chip when present
     - status chip
     - source count
     - read-only lock/label
     - “Drill →” affordance
   - Entire tile can open drill, but buttons must not nest incorrectly.
   - Use accessible button semantics or `role="button"` + keyboard handlers.

3. Use production styling tokens/classes where possible:
   - `card`
   - `text-muted`
   - `text-ink`
   - `border-[var(--line)]`
   - avoid lab-only color assumptions if not present.

4. Add test IDs:
   - `data-testid="read-only-canvas"`
   - `data-testid="canvas-widget-grid"`
   - `data-testid="canvas-widget"`
   - `data-widget-kind`
   - `data-widget-id`

Verification:

```bash
cd /home/ubuntu/account-research/web
npm run typecheck
npm run build
```

Manual lab verification after deploy:
- Canvas grid shows varied tile widths.
- Header/chrome looks intentional.
- Drill still opens.
- No edit/refresh/remove controls are active.

Commit:

```bash
git add web/components/canvas/ReadOnlyCanvasView.tsx web/components/canvas/WidgetTile.tsx web/components/canvas/tiles.tsx web/components/canvas/details.tsx tests/canvasBridge.test.ts
git commit -m "feat(canvas): polish read-only widget layout"
```

---

## Task 4: Bridge extensions into dedicated canvas widgets

**Objective:** Make Insights/extensions feel native in Canvas view instead of only a generic section card.

**Files:**
- Modify: `web/lib/canvas/schema.ts`
- Modify: `web/lib/canvas/fromBrief.ts`
- Modify: `web/lib/canvas/registry.tsx`
- Modify: `web/components/canvas/tiles.tsx`
- Modify: `web/components/canvas/details.tsx`
- Test: `tests/canvasBridge.test.ts`

**Implementation options:**

Preferred safe option: add one new widget kind:

```ts
"extension"
```

with data:

```ts
export const ExtensionWidgetData = z.object({
  extension_kind: z.enum(["card", "table", "list", "narrative"]),
  extension_id: z.string(),
  body: z.string().optional(),
  columns: z.array(z.string()).default([]),
  rows: z.array(z.record(z.string())).default([]),
  items: z.array(z.string()).default([]),
});
```

Alternative if avoiding a new kind: map extension kinds into existing widgets:
- `table` → `evidence_board` or `section_ref` loses structure, not preferred.
- `list` → `open_questions` is semantically wrong.
- `card`/`narrative` → `section_ref` is too generic.

Therefore, add `extension` as a sixth production read-only widget kind.

Builder behavior in `fromBrief.ts`:

1. Keep the existing `section-extensions` overview only if useful, but consider replacing it with individual widgets.
2. For each `brief.extensions` item, create one widget:
   - id: `extension-${stable extension id}`
   - title: extension title
   - source: extension.source
   - created_at/updated_at: extension.created_at or generatedAt
   - confidence: extension.confidence
   - why_included: extension.why_included
   - sources: extension.sources
   - layout:
     - table: width 12, h 3 or 4
     - narrative: width 12, h 3
     - card: width 6, h 2
     - list: width 6, h 2
   - controls: all false
   - status: fresh

Renderer behavior:

- `card`: callout style with body text.
- `table`: show column headers and first 2-3 rows in tile; full table in drill.
- `list`: show first 4 bullets in tile; full list in drill.
- `narrative`: prose preview in tile; full prose in drill.
- Show “Added in chat” chip if `source === "chat"`.

Tests:

- Brief with one extension of each kind yields four `extension` widgets.
- Empty/defaulted extensions yields zero `extension` widgets and no generic empty Insights widget.
- Chat-sourced extension carries `source: "chat"` to widget.
- Table extension preserves columns/rows.
- Widget IDs are stable and unique.

Run:

```bash
cd /home/ubuntu/account-research
npm test -- tests/canvasBridge.test.ts
cd web && npm run typecheck && npm run build
```

Commit:

```bash
git add web/lib/canvas/schema.ts web/lib/canvas/fromBrief.ts web/lib/canvas/registry.tsx web/components/canvas/tiles.tsx web/components/canvas/details.tsx tests/canvasBridge.test.ts
git commit -m "feat(canvas): render brief extensions as widgets"
```

---

## Task 5: Add disabled future-action affordances, not actions

**Objective:** Make the canvas direction visible without enabling unsafe behavior.

**Files:**
- Modify: `web/components/canvas/WidgetTile.tsx`
- Modify: `web/components/canvas/ReadOnlyCanvasView.tsx`
- Optionally modify: `web/components/canvas/details.tsx`

**Implementation details:**

Add non-functional, visibly disabled affordances:

- Header text: “Read-only preview — refresh/actions are coming later.”
- Optional disabled buttons/chips:
  - Refresh later
  - Edit later
  - Remove later

Rules:

- Buttons must have `disabled` attribute.
- No `onClick` handlers that mutate anything.
- No API routes called.
- No imports from lab action/store files.
- Do not add `can_refresh: true` anywhere.

Tests:

- Unit/static test can assert builder controls remain all false.
- Manual browser check confirms disabled buttons cannot be clicked.

Run:

```bash
cd /home/ubuntu/account-research/web
npm run typecheck
npm run build
```

Commit:

```bash
git add web/components/canvas/WidgetTile.tsx web/components/canvas/ReadOnlyCanvasView.tsx web/components/canvas/details.tsx tests/canvasBridge.test.ts
git commit -m "feat(canvas): add read-only future action affordances"
```

---

## Task 6: Add fixture/browser QA coverage without paid calls

**Objective:** Make the flag-on canvas easy to verify in lab/staging and CI without provider spend.

**Files:**
- Modify: `tests/canvasBridge.test.ts`
- Optionally create: `tests/canvas_fixture_brief_with_extensions.json`
- Optionally create script: `scripts/seed-canvas-bridge-fixture.js` or `.ts`

**Implementation details:**

1. Extend test fixture to include:
   - one card extension
   - one table extension
   - one list extension
   - one narrative extension

2. Add tests:
   - `Canvas.parse(buildReadOnlyCanvasFromBrief(...))` succeeds.
   - All widget kinds in registry have Tile and Detail renderers.
   - Extension widgets are omitted for legacy brief with no `extensions` field.
   - Extension table/list/narrative/card data are preserved.

3. Optional seed script for lab:
   - Reads `tests/sample_brief.json`.
   - Adds four extensions.
   - Inserts or updates `lab-canvas-bridge-fixture` in a local SQLite DB.
   - Must accept `DATABASE_PATH` or use `web/data/briefs.sqlite`.
   - Must never call provider APIs.

Run:

```bash
cd /home/ubuntu/account-research
npm test -- tests/canvasBridge.test.ts
cd web && npm run typecheck && npm run build
```

Commit:

```bash
git add tests/canvasBridge.test.ts tests/canvas_fixture_brief_with_extensions.json scripts/seed-canvas-bridge-fixture.*
git commit -m "test(canvas): cover rich read-only canvas fixtures"
```

---

## Task 7: Final local verification and PR

**Objective:** Prove the PR is safe and ready for review, with production flag still OFF.

**Commands:**

```bash
cd /home/ubuntu/account-research
npm test -- tests/canvasBridge.test.ts
cd web
npm run typecheck
npm run build
```

Also verify no banned imports were added:

```bash
cd /home/ubuntu/account-research
! grep -R "@/lib/canvas/store\|@/lib/canvas/reducer\|@/lib/canvas/fakeHermes\|@/lib/canvas/actions" web/components web/app web/lib/canvas --include='*.ts' --include='*.tsx'
```

Expected:
- tests pass.
- typecheck passes.
- build passes.
- grep returns no matches.

Open PR:

```bash
git push -u origin hermes/canvas-polish-schema
```

PR title:

```text
feat: polish read-only canvas bridge
```

PR body checklist:

```markdown
## Summary
- Polishes the behind-flag read-only Canvas view
- Widens the safe production canvas schema toward the lab prototype shape
- Renders Brief extensions as first-class read-only canvas widgets
- Keeps all widget controls disabled; no provider-backed actions or refresh behavior

## Safety / out of scope
- Production flag remains OFF by default
- No DB migration
- No provider/model calls
- No public-share canvas changes
- No lab store/reducer/fakeHermes/action queue imports

## Verification
- [ ] npm test -- tests/canvasBridge.test.ts
- [ ] cd web && npm run typecheck
- [ ] cd web && npm run build
- [ ] Flag-off production behavior unchanged
- [ ] Flag-on lab browser QA: default Brief view, Canvas toggle, polished grid, extension widgets, drill modals, disabled controls
```

---

## Lab deploy / QA checklist after PR build

Only after the PR branch is ready locally, deploy it to lab; do not deploy to production.

Lab target currently used for bridge QA:
- host: `researchlab.ai-lab1.com` / `54.245.17.76`
- repo checkout: `/home/ubuntu/account-research-bridge-lab`
- PM2 app: `account-research-lab`
- URL: `https://researchlab.ai-lab1.com`

Lab deploy commands:

```bash
ssh -i /home/ubuntu/.ssh/claw.pem ubuntu@54.245.17.76
cd ~/account-research-bridge-lab
git fetch origin hermes/canvas-polish-schema
git checkout hermes/canvas-polish-schema
git pull --ff-only origin hermes/canvas-polish-schema
cd web
NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 APP_BASE_URL=https://researchlab.ai-lab1.com npm ci
NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 APP_BASE_URL=https://researchlab.ai-lab1.com npm run build
NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 APP_BASE_URL=https://researchlab.ai-lab1.com pm2 reload account-research-lab --update-env
pm2 save
```

Lab checks:

- `/login` returns 200.
- Authenticated `/brief/lab-canvas-bridge-fixture` returns 200.
- Brief view remains default.
- Toggle appears only because lab build uses the flag.
- Canvas view looks production-polished.
- Extension card/table/list/narrative widgets render correctly.
- Drill modal renders each widget kind.
- Disabled future controls are visibly disabled.
- PM2 error log has no fresh errors after reload.

---

## Production deploy policy

After merge, production deploy should still build with the flag OFF unless the user explicitly approves enabling it.

Production deploy invariant:

```bash
grep -E '^NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=' ~/account-research/web/.env.local || echo "flag not set (good)"
cd ~/account-research/web
npm ci
npm run build
pm2 reload account-brief-worker --update-env
pm2 reload account-brief --update-env
pm2 save
```

Post-deploy production checks:

- deployed commit equals merge SHA.
- migration ledger unchanged, unless the approved PR explicitly added a migration.
- PM2 web + worker online.
- `scripts/prod-health-check.sh` returns RESULT: OK.
- Existing briefs load.
- Public shares load.
- Canvas toggle remains hidden when flag is OFF.

---

## Recommended implementation order

1. Schema widening tests + implementation.
2. Layout-aware widget tile polish.
3. Dedicated extension widgets.
4. Disabled future-action affordances.
5. Fixture/seed test support.
6. Lab QA with flag ON.
7. PR review/merge.
8. Production deploy with flag OFF.

This keeps the next PR narrowly focused on making the existing dark-launched canvas credible without crossing into autonomous refresh/actions or production exposure.
