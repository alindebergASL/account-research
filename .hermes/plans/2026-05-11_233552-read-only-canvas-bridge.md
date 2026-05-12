# Read-only Canvas Bridge Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a conservative, read-only dynamic canvas view for production briefs behind an internal feature flag, derived from existing brief JSON without new persistence, model calls, or write actions.

**Architecture:** Port only the safe schema/renderer subset from the lab prototype into production. Build a pure adapter that maps an existing `Brief` into a `Canvas` made of read-only `section_ref`, `evidence_board`, `action_panel`, `open_questions`, and optional `metric` widgets. Add a gated UI toggle on private brief pages so the existing `BriefCanvas` remains default and public-share routes remain unchanged.

**Tech Stack:** Next.js 14 app router, React client components, TypeScript, Zod, existing `Brief` schema, existing `<DrillModal>` shell, existing Tailwind/CSS classes, node:test + tsx.

---

## Current context verified before writing this plan

Production repo:
- Path: `/home/ubuntu/account-research`
- Default remote: `origin https://github.com/alindebergASL/account-research.git`
- `origin/main` at inspection time: `3ddef6e`
- Local checked branch at inspection time: `claude/build-account-brief-builder-MXJKA`, same tree as current post-Track-1 baseline.

Relevant production files:
- Existing primary renderer: `web/components/BriefCanvas.tsx`
- Existing drill shell: `web/components/DrillModal.tsx`
- Existing extensions renderers: `web/components/extensions/ExtensionRenderers.tsx`
- Existing brief page: `web/app/brief/[id]/page.tsx`
- Existing schema: `web/lib/schema.ts`
- Existing tests: `tests/schema.test.ts`, `tests/briefMerge.test.ts`, `tests/briefEvents.test.ts`

Relevant lab prototype files to selectively port from:
- `/home/ubuntu/account-research-hermes-lab/web/lib/canvas/schema.ts`
- `/home/ubuntu/account-research-hermes-lab/web/lib/canvas/registry.tsx`
- `/home/ubuntu/account-research-hermes-lab/web/components/canvas/tiles.tsx`
- `/home/ubuntu/account-research-hermes-lab/web/components/canvas/details.tsx`
- `/home/ubuntu/account-research-hermes-lab/web/components/canvas/WidgetTile.tsx`

Hard constraints for this PR:
- No DB migration.
- No new persisted `canvas_json` field.
- No Hermes action queue, fakeHermes, reducer, store, localStorage, undo, or autonomous mutation in production.
- No refresh/merge/version-history work.
- No public-share behavior change unless explicitly approved later.
- No real model/API calls.
- Existing `BriefCanvas` remains the default production view.
- New canvas is read-only and private-page-only behind a feature flag.

Suggested branch:
- `hermes/read-only-canvas-bridge-<short>` off latest `origin/main`.

---

## Acceptance criteria

1. With the feature flag off or absent, private brief pages render exactly the existing `BriefCanvas` path.
2. With the feature flag on, private brief pages expose a toggle between:
   - `Brief view` = existing `BriefCanvas`
   - `Canvas view` = new read-only dynamic canvas bridge
3. Canvas view is derived from existing parsed `Brief` data only.
4. Canvas view has no write controls, no action queue, no composer, no localStorage persistence, no approve/reject/undo.
5. Canvas widgets open drill/detail modals and show grounded source/confidence metadata where available.
6. Legacy briefs without `extensions` still parse and render because `Brief.extensions` already defaults to `[]`.
7. Public share routes keep using existing `BriefCanvas` and do not expose the new toggle in this PR.
8. Typecheck, build, and targeted tests pass.
9. Production deploy, if approved later, follows normal backup/build/PM2/nginx health-check procedure.

---

## Proposed widget mapping

Use lab widget kinds, but only for read-only display:

### `section_ref`

Purpose: bridge standard brief sections into canvas widgets.

Map these sections:
- `snapshot` -> title `Account snapshot`
- `priority_summary` -> title `Why this account · why now`
- `recent_signals` -> title `Recent strategic signals`
- `ai_tech_maturity` -> title `AI / tech maturity`
- `top_initiatives` -> title `Top initiatives`
- `technical_footprint` -> title `Technical footprint`
- `programs_procurement` -> title `Programs & procurement`
- `personas` -> title `Key personas`
- `buying_path` -> title `Buying / decision path`
- `first_angle` -> title `First conversation angle`
- `risks` -> title `Risks & watch-outs`
- `competitive_signals` -> title `Competitive / vendor signals`
- `extensions` -> title `Insights`, only if `brief.extensions.length > 0`
- `sources` -> title `Key sources`

Data shape:
```ts
{
  section_key: string;
  preview: string;
}
```

### `evidence_board`

Purpose: summarize cited evidence snippets from signals, initiatives, personas, extensions, and sources.

Initial implementation should derive at most 8 snippets:
- recent signals: `text`, `source`, `confidence`
- top initiatives: `title + detail`, `source`, `confidence`
- personas: `name/title + opener`, `source`, `confidence`
- extension sources: source title/url, extension confidence

### `action_panel`

Purpose: display recommended actions/read-only strategy from existing fields.

Initial actions:
- `brief.next_action`, hidden in public mode and shown only in private canvas view.
- Optional derived action for `first_angle` only if needed, but prefer YAGNI: start with one action.

### `open_questions`

Purpose: surface gaps/questions without model calls.

Initial questions can be deterministic heuristics from missing or thin fields:
- No personas -> `Which buyer or executive sponsor should be prioritized?`
- No competitive signals -> `Which incumbent vendors or competitors are most relevant?`
- Low completeness from `briefCompleteness(brief)` -> `Which public sources would strengthen this account brief?`

Do not invent account-specific facts.

### `metric`

Purpose: simple read-only metadata cards.

Initial metrics:
- `AI maturity` = `brief.ai_tech_maturity.rating / 5`
- `Sources` = `brief.sources.length`
- `Initiatives` = `brief.top_initiatives.length`

Keep to 2-3 metrics only.

---

## Task 1: Create production canvas schema subset

**Objective:** Add typed read-only canvas primitives to production without importing lab action/store concepts.

**Files:**
- Create: `web/lib/canvas/schema.ts`
- Test: `tests/canvasBridge.test.ts`

**Step 1: Write failing schema test**

Create `tests/canvasBridge.test.ts` with a minimal schema parse test:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Canvas } from "../web/lib/canvas/schema";

test("Canvas schema accepts a read-only section_ref widget", () => {
  const parsed = Canvas.parse({
    account_id: "brief-1",
    account_name: "Example Health",
    version: 1,
    generated_at: "2026-05-11T00:00:00.000Z",
    widgets: [
      {
        id: "section-snapshot",
        kind: "section_ref",
        title: "Account snapshot",
        description: "",
        source: "system",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z",
        confidence: "Medium",
        why_included: "Derived from standard brief section.",
        sources: [],
        layout: { x: 0, y: 0, w: 6, h: 2, pinned: true, collapsed: false },
        controls: { can_refresh: false, can_remove: false, can_edit: false, can_export: false },
        status: "fresh",
        evidence: [],
        data: { section_key: "snapshot", preview: "Snapshot preview" },
      },
    ],
    meta: { layout_mode: "grid", pinned_order: ["section-snapshot"] },
  });

  assert.equal(parsed.widgets[0].kind, "section_ref");
  assert.equal(parsed.widgets[0].controls.can_edit, false);
});
```

**Step 2: Run test to verify failure**

Run:
```bash
cd /home/ubuntu/account-research
npx tsx --test tests/canvasBridge.test.ts
```

Expected: FAIL because `web/lib/canvas/schema.ts` does not exist.

**Step 3: Add minimal schema implementation**

Create `web/lib/canvas/schema.ts` by porting from lab `web/lib/canvas/schema.ts`, but make the production intent explicit:
- Keep: `Confidence`, `Source`, `WidgetKind`, `WidgetSource`, `WidgetStatus`, `WidgetLayout`, `WidgetControls`, `Evidence`, data schemas, widget discriminated union, `Canvas`.
- Do not add: action schemas, reducer, store, fakeHermes, localStorage.
- Keep `controls` available but every bridge-generated widget will set all controls false unless a future PR enables something.

**Step 4: Run test to verify pass**

Run:
```bash
npx tsx --test tests/canvasBridge.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add web/lib/canvas/schema.ts tests/canvasBridge.test.ts
git commit -m "feat: add read-only canvas schema"
```

---

## Task 2: Add pure Brief -> Canvas adapter

**Objective:** Convert existing parsed `Brief` objects into deterministic read-only `Canvas` objects.

**Files:**
- Create: `web/lib/canvas/fromBrief.ts`
- Modify: `tests/canvasBridge.test.ts`

**Step 1: Add failing adapter tests**

Append tests to `tests/canvasBridge.test.ts`:

```ts
import { Brief } from "../web/lib/schema";
import { buildReadOnlyCanvasFromBrief } from "../web/lib/canvas/fromBrief";
import sampleBriefJson from "./sample_brief.json" assert { type: "json" };

test("buildReadOnlyCanvasFromBrief derives deterministic read-only widgets", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });

  assert.equal(canvas.account_id, "sample");
  assert.equal(canvas.account_name, brief.account_name);
  assert.ok(canvas.widgets.length >= 8);
  assert.ok(canvas.widgets.some((w) => w.kind === "section_ref" && w.id === "section-snapshot"));
  assert.ok(canvas.widgets.some((w) => w.kind === "evidence_board"));
  assert.ok(canvas.widgets.some((w) => w.kind === "action_panel"));
  assert.ok(canvas.widgets.some((w) => w.kind === "metric"));
  assert.deepEqual(
    canvas.widgets.map((w) => w.id),
    Array.from(new Set(canvas.widgets.map((w) => w.id))),
  );
  assert.ok(canvas.widgets.every((w) => !w.controls.can_edit && !w.controls.can_remove && !w.controls.can_refresh));
});

test("buildReadOnlyCanvasFromBrief omits Insights section when extensions are empty/defaulted", () => {
  const brief = Brief.parse({ ...sampleBriefJson, extensions: undefined });
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "legacy", brief });

  assert.equal(brief.extensions.length, 0);
  assert.equal(canvas.widgets.some((w) => w.id === "section-extensions"), false);
});
```

If TypeScript JSON import assertions are awkward under current tsx config, replace the import with `readFileSync` + `JSON.parse` in the test.

**Step 2: Run test to verify failure**

Run:
```bash
npx tsx --test tests/canvasBridge.test.ts
```

Expected: FAIL because `fromBrief.ts` does not exist.

**Step 3: Implement adapter**

Create `web/lib/canvas/fromBrief.ts`.

Implementation guidance:

```ts
import type { Brief, Source as BriefSource } from "@/lib/schema";
import { briefCompleteness } from "@/lib/schema";
import type { Canvas, CanvasWidget, Confidence, Source } from "./schema";

export function buildReadOnlyCanvasFromBrief({
  briefId,
  brief,
}: {
  briefId: string;
  brief: Brief;
}): Canvas {
  const created = brief.generated_at || new Date(0).toISOString();
  const widgets: CanvasWidget[] = [];

  // helper functions:
  // - sourceFromBriefSource
  // - baseWidget
  // - addSectionRef
  // - previewText
  // - nextLayout

  return {
    account_id: briefId,
    account_name: brief.account_name,
    version: 1,
    generated_at: brief.generated_at,
    widgets,
    meta: {
      layout_mode: "grid",
      pinned_order: widgets.map((w) => w.id),
    },
  };
}
```

Rules:
- IDs must be stable slugs, e.g. `section-snapshot`, `metric-ai-maturity`, `evidence-board`, `action-next`.
- `source` should be `system` because the canvas is system-derived from the saved brief.
- `controls` must be all false for this PR.
- `layout` can use deterministic two-column-ish grid coordinates; no drag/drop in this PR.
- `evidence` should be derived only from explicit brief fields, never invented.
- Extension section should only be added when `brief.extensions.length > 0`.
- Do not mutate the `brief` object.

**Step 4: Run test to verify pass**

Run:
```bash
npx tsx --test tests/canvasBridge.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add web/lib/canvas/fromBrief.ts tests/canvasBridge.test.ts
git commit -m "feat: derive read-only canvas from briefs"
```

---

## Task 3: Add read-only widget renderers

**Objective:** Add production-safe widget tiles/details that render the derived canvas without action controls.

**Files:**
- Create: `web/components/canvas/tiles.tsx`
- Create: `web/components/canvas/details.tsx`
- Create: `web/components/canvas/WidgetTile.tsx`
- Create: `web/lib/canvas/registry.tsx`

**Step 1: Add render coverage test target if practical**

Prefer a lightweight registry unit test in `tests/canvasBridge.test.ts`:

```ts
import { ALL_WIDGET_KINDS, getDescriptor } from "../web/lib/canvas/registry";

test("production canvas registry covers every widget kind", () => {
  assert.deepEqual([...ALL_WIDGET_KINDS].sort(), [
    "action_panel",
    "evidence_board",
    "metric",
    "open_questions",
    "section_ref",
  ]);
  for (const kind of ALL_WIDGET_KINDS) {
    const descriptor = getDescriptor(kind);
    assert.equal(descriptor.kind, kind);
    assert.equal(typeof descriptor.Tile, "function");
    assert.equal(typeof descriptor.Detail, "function");
  }
});
```

**Step 2: Run test to verify failure**

Run:
```bash
npx tsx --test tests/canvasBridge.test.ts
```

Expected: FAIL because registry does not exist.

**Step 3: Port and simplify renderers**

Port from the lab repo with these production changes:
- Remove all references to actions, action queue, fake Hermes, approve/reject/undo.
- `WidgetTile` accepts:
  ```ts
  export default function WidgetTile({ widget, onOpen }: { widget: CanvasWidget; onOpen: () => void })
  ```
- Tiles use existing app styling (`card`, `text-muted`, `border-[var(--line)]`) and no new design system dependency.
- Details should render enough metadata:
  - title
  - confidence chip if available
  - why_included
  - sources using existing `SourceLink` from `DrillModal`
  - evidence list if present
- `section_ref` detail should display `data.preview` and a clear note: `Derived from standard brief section.`

**Step 4: Implement registry**

Create `web/lib/canvas/registry.tsx` with a production read-only descriptor shape:

```ts
export interface WidgetDescriptor {
  kind: WidgetKind;
  label: string;
  Tile: React.FC<{ widget: CanvasWidget }>;
  Detail: React.FC<{ widget: CanvasWidget }>;
}
```

Do not include `allowedActions`, `autoApplyActions`, or fixtures in production registry for this PR.

**Step 5: Run tests**

Run:
```bash
npx tsx --test tests/canvasBridge.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add web/components/canvas web/lib/canvas/registry.tsx tests/canvasBridge.test.ts
git commit -m "feat: add read-only canvas widget renderers"
```

---

## Task 4: Add `ReadOnlyCanvasView` component

**Objective:** Compose derived widgets into a read-only grid with drill modals.

**Files:**
- Create: `web/components/canvas/ReadOnlyCanvasView.tsx`

**Step 1: Create component**

Component props:

```ts
import type { CanvasWidget, Canvas } from "@/lib/canvas/schema";

export default function ReadOnlyCanvasView({ canvas }: { canvas: Canvas }) {
  // useState<string | null> for drill widget id
  // grid render of WidgetTile
  // DrillModal with descriptor.Detail
}
```

Required DOM markers for QA/testing:
- `data-testid="read-only-canvas"`
- `data-testid="canvas-widget-grid"`
- Each widget wrapper: `data-testid="canvas-widget"` and `data-widget-kind={widget.kind}`

UI requirements:
- Header: `Dynamic canvas preview`
- Subheader: `Read-only view derived from the saved brief.`
- Show account name, widget count, version.
- No composer, no action queue, no reset demo, no approve/reject/undo.

**Step 2: Add temporary build check**

Run:
```bash
cd web
npm run typecheck
```

Expected: PASS after component compiles. If it fails because component is unused but has typing issues, fix now.

**Step 3: Commit**

```bash
git add web/components/canvas/ReadOnlyCanvasView.tsx
git commit -m "feat: compose read-only canvas view"
```

---

## Task 5: Add private-page feature flag and toggle

**Objective:** Gate the new canvas on private brief pages while preserving existing default behavior.

**Files:**
- Modify: `web/app/brief/[id]/page.tsx`
- Create: `web/lib/canvas/flags.ts`

**Step 1: Add flag helper**

Create `web/lib/canvas/flags.ts`:

```ts
export function isCanvasBridgeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE === "1";
}
```

Use a `NEXT_PUBLIC_` flag because `web/app/brief/[id]/page.tsx` is a client component.

**Step 2: Modify private brief page**

In `web/app/brief/[id]/page.tsx`:
- import `useMemo`, `useState`
- import `buildReadOnlyCanvasFromBrief`
- import `ReadOnlyCanvasView`
- import `isCanvasBridgeEnabled`
- create:
  ```ts
  const canvasBridgeEnabled = isCanvasBridgeEnabled();
  const [viewMode, setViewMode] = useState<"brief" | "canvas">("brief");
  const canvas = useMemo(
    () => brief ? buildReadOnlyCanvasFromBrief({ briefId: params.id, brief }) : null,
    [brief, params.id],
  );
  ```
- render a small toggle above `BriefCanvas` only when enabled and `brief` exists:
  - `Brief view`
  - `Canvas view`
- default remains `Brief view`.
- only render `ReadOnlyCanvasView` when `viewMode === "canvas" && canvasBridgeEnabled && canvas`.
- otherwise render existing `BriefCanvas` with unchanged props.

Important: do not modify `web/app/s/[token]/page.tsx` in this PR.

**Step 3: Build with flag off**

Run:
```bash
cd web
npm run typecheck
npm run build
```

Expected: PASS. Existing default route behavior is unchanged.

**Step 4: Build with flag on**

Run:
```bash
cd web
NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 npm run build
```

Expected: PASS. This confirms the gated client bundle compiles under the intended lab/internal setting.

**Step 5: Commit**

```bash
git add web/app/brief/[id]/page.tsx web/lib/canvas/flags.ts
git commit -m "feat: gate read-only canvas view on private briefs"
```

---

## Task 6: Add integration tests for adapter behavior and guardrails

**Objective:** Lock in no-write/no-public/no-extensions-empty semantics before PR.

**Files:**
- Modify: `tests/canvasBridge.test.ts`

**Step 1: Add tests**

Add tests for:

1. Every generated widget has all controls disabled:
```ts
assert.ok(canvas.widgets.every((w) => w.controls.can_edit === false));
assert.ok(canvas.widgets.every((w) => w.controls.can_remove === false));
assert.ok(canvas.widgets.every((w) => w.controls.can_refresh === false));
```

2. Generated IDs are stable across repeated calls:
```ts
const a = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
const b = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
assert.deepEqual(a.widgets.map((w) => w.id), b.widgets.map((w) => w.id));
```

3. Evidence board contains no more than 8 snippets.

4. `action_panel` contains `next_action` but no extra invented account-specific action.

5. Empty extensions omit `section-extensions`; non-empty extensions include it.

For non-empty extension test, construct a small extension object inline using existing `BriefExtension` shape.

**Step 2: Run tests**

Run:
```bash
npx tsx --test tests/canvasBridge.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tests/canvasBridge.test.ts
git commit -m "test: cover read-only canvas bridge guardrails"
```

---

## Task 7: Local browser/route verification before PR

**Objective:** Prove both old and gated views work locally before opening the PR.

**Files:**
- No source changes expected.

**Step 1: Full local verification**

Run:
```bash
cd /home/ubuntu/account-research/web
npm run typecheck
npm run build
NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 npm run build
cd ..
npx tsx --test tests/canvasBridge.test.ts
npx tsx tests/schema.test.ts
npx tsx tests/briefMerge.test.ts
npx tsx tests/briefEvents.test.ts
```

Expected: all pass.

**Step 2: Manual local smoke with feature flag on**

Run local server:
```bash
cd /home/ubuntu/account-research/web
NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 npm run build
NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 npm run start -- -H 127.0.0.1 -p 3000
```

In a separate terminal/browser:
- Authenticate with existing local test/admin setup if needed.
- Open an existing brief.
- Confirm default is still `Brief view`.
- Click `Canvas view`.
- Confirm widgets render.
- Click several widgets and confirm drill modals open.
- Confirm there is no composer/action queue/approve/reject/undo.
- Confirm public share page `/s/[token]` still uses existing public `BriefCanvas` path and has no toggle.

If browser automation is unavailable, use a combination of SSR/client bundle marker checks and user browser QA after lab/staging deploy.

**Step 3: Commit only if smoke led to source changes**

If no changes, no commit.

---

## Task 8: Open PR with explicit out-of-scope guardrails

**Objective:** Prepare a reviewable PR that cannot be confused with autonomous dynamic canvas.

**Files:**
- No source changes expected.

**Step 1: Push branch**

```bash
git push -u origin hermes/read-only-canvas-bridge-<short>
```

**Step 2: Open PR to `main`**

Title:
```text
Add read-only dynamic canvas bridge behind feature flag
```

PR body must include:

```markdown
## Summary
- Adds production canvas schema subset and read-only widget renderers.
- Derives a dynamic canvas from existing Brief JSON without persistence or model calls.
- Gates private brief-page toggle behind NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1.
- Keeps existing BriefCanvas as default and leaves public share pages unchanged.

## Verification
- npm run typecheck
- npm run build
- NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1 npm run build
- npx tsx --test tests/canvasBridge.test.ts
- npx tsx tests/schema.test.ts
- npx tsx tests/briefMerge.test.ts
- npx tsx tests/briefEvents.test.ts

## Out of scope
- No DB migration or canvas_json persistence.
- No Hermes actions, reducer, store, localStorage, undo, approve/reject, or autonomous writes.
- No provider/model calls.
- No refresh/merge/version-history changes.
- No public-share canvas exposure.
```

**Step 3: Reviewer checklist**

Before merge, review specifically:
- Feature flag defaults off.
- Existing `BriefCanvas` path is still the default.
- Public share page untouched.
- All bridge widgets are read-only.
- Adapter does not invent facts.
- No secrets/env changes besides optional flag documentation.

---

## Optional deployment plan after PR approval

Do not deploy until PR is reviewed/merged and the user explicitly approves production rollout.

If approved:
1. SSH precheck to production.
2. Pre-deploy SQLite backup using existing backup script.
3. Pull merged `main` on production.
4. In `web/.env.local`, add:
   ```env
   NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=1
   ```
   only if the user wants the internal toggle visible in production.
5. Run:
   ```bash
   cd web
   npm ci
   npm run build
   pm2 reload account-brief-worker --update-env
   pm2 reload account-brief --update-env
   pm2 save
   ```
6. Verify:
   - deployed commit
   - no new migration expected; schema ledger unchanged from Track 1 unless intervening PRs exist
   - both PM2 apps online
   - prod-health-check OK
   - existing brief loads with flag behavior as expected
   - public share route still has no canvas toggle
   - logs quiet

Rollback:
- Fastest: remove or set `NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE=0`, rebuild, reload PM2.
- If code misbehaves independent of flag: revert PR and redeploy.

---

## Risks and mitigations

1. **Risk: Canvas view diverges from production brief semantics.**
   - Mitigation: adapter is pure and tested against `tests/sample_brief.json`; existing `BriefCanvas` remains source of truth/default.

2. **Risk: Users confuse read-only preview with autonomous canvas.**
   - Mitigation: label header `Dynamic canvas preview` and subtext `Read-only view derived from the saved brief.` No composer/action queue controls.

3. **Risk: Public-share exposure changes buyer-facing surface unexpectedly.**
   - Mitigation: do not touch `web/app/s/[token]/page.tsx` in this PR.

4. **Risk: Feature flag is client-visible.**
   - Mitigation: acceptable because it gates UI exposure only, not authorization or secrets. Do not put secrets in `NEXT_PUBLIC_*`.

5. **Risk: Build includes code even when flag off.**
   - Mitigation: acceptable for this PR; behavior remains off by default. If bundle size becomes a concern later, dynamic import `ReadOnlyCanvasView` behind the flag.

---

## Definition of done

- Plan implemented on a branch off latest `origin/main`.
- PR opened with the stated guardrails.
- All verification commands pass.
- Feature flag off: existing private brief behavior unchanged.
- Feature flag on: private brief page can switch to read-only canvas view.
- Public share routes unchanged.
- No production deploy until separately approved.
