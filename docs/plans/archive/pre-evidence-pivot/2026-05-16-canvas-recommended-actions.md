# Canvas Recommended Actions Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add first-class Hermes recommended action objects to the read-only Canvas so the workspace shows prioritized next moves with rationale, expected outcome, risks, evidence backing, and non-executable approval posture.

**Architecture:** Keep this PR deterministic and UI-only. Derive action objects from the saved Brief (`next_action`, `top_initiatives`, `risks`, `personas`, `buying_path`, `first_angle`, `recent_signals`) inside the Canvas adapter with no provider calls, no DB migration, no public/share surface changes, and no live execution. Render the actions as an upgraded `action_panel` widget and richer detail modal content while preserving all controls disabled.

**Tech Stack:** Next.js 14 app router, React, TypeScript, Zod, node:test/tsx.

---

## Hard Scope

In scope:
- Add a richer action object shape to `web/lib/canvas/schema.ts`.
- Add deterministic helper(s) under `web/lib/canvas/` to derive 2–4 action objects from an existing saved brief.
- Replace the current single legacy `{ label: "Next action", detail: brief.next_action }` payload with richer action objects.
- Upgrade action panel tile/detail rendering to show recommendation, rationale, expected outcome, risk/caveat, evidence backing, and approval posture.
- Add regression tests in `tests/canvasBridge.test.ts`.

Out of scope:
- No DB migration.
- No API/model/provider calls.
- No actual execution, approvals API, audit table, localStorage, reducer/store, or side effects.
- No changes to auth, sharing, public token routes, worker, research job pipeline, SMTP, or production env.
- Do not touch/deploy production from the implementation PR.
- Do not revive or merge old PR #3.

---

## Design Notes

Current state from repo inspection:
- Adapter: `web/lib/canvas/fromBrief.ts`
  - Existing action widget is `id: "action-next"`, title `Recommended next action`, kind `action_panel`, width 8 / height 2.
  - It currently emits one legacy action: `{ label: "Next action", detail: brief.next_action }`.
- Schema: `web/lib/canvas/schema.ts`
  - `ActionItem` currently accepts legacy `{ label, detail? }` and lab-rich `{ text, why, owner?, severity }` shapes.
- Tile/detail rendering:
  - `web/components/canvas/tiles.tsx` has `ActionPanelTile` and `normalizeAction`.
  - `web/components/canvas/details.tsx` has `ActionPanelDetail` and `normalizeAction`.
- Tests: `tests/canvasBridge.test.ts`
  - Existing test around lines ~492 expects the legacy action shape and should be updated.

Recommended new rich action shape:

```ts
export const RecommendedActionItem = z.object({
  recommendation: z.string(),
  rationale: z.string(),
  expected_outcome: z.string(),
  risk: z.string().optional(),
  evidence: z.array(EvidenceItem).default([]),
  approval_state: z.enum(["suggested", "approved", "dismissed"]).default("suggested"),
  owner: z.string().optional(),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
});
```

Keep legacy shapes valid for backwards compatibility. The new adapter output should use `recommendation` objects.

---

### Task 1: Extend action schema without breaking legacy actions

**Objective:** Add a first-class recommended-action object shape while preserving existing action payload compatibility.

**Files:**
- Modify: `web/lib/canvas/schema.ts`
- Test: `tests/canvasBridge.test.ts`

**Steps:**
1. In `schema.ts`, define `RecommendedActionItem` near the existing `ActionItem`.
2. Update `ActionItem` union to include `RecommendedActionItem` in addition to both existing shapes.
3. Export the inferred type if useful.
4. Add/update a schema test proving `Canvas.parse` accepts an action with:
   - `recommendation`
   - `rationale`
   - `expected_outcome`
   - `risk`
   - `approval_state: "suggested"`
   - `evidence: [{ text, source, confidence }]`
   - `severity`
5. Run:
   - `./web/node_modules/.bin/tsx --test tests/canvasBridge.test.ts`

Expected: schema tests pass.

---

### Task 2: Add deterministic action derivation helper

**Objective:** Build 2–4 action objects from the saved brief without inventing unsupported facts.

**Files:**
- Create or modify: `web/lib/canvas/recommendedActions.ts`
- Modify: `web/lib/canvas/fromBrief.ts`
- Test: `tests/canvasBridge.test.ts`

**Rules for helper:**
- Export `buildRecommendedActions(brief: Brief)`.
- Always include one primary action from `brief.next_action` when non-empty and not `Not found`.
- Add at most three supporting actions, in priority order:
  1. Initiative follow-up from `brief.top_initiatives[0]`.
  2. Persona / stakeholder alignment from `brief.personas[0]` and/or `brief.buying_path`.
  3. Risk mitigation from `brief.risks[0]`.
- Use only brief fields and fixed labels. Do not create unverifiable account-specific facts.
- Evidence arrays should reference available backing fields:
  - Primary action: `brief.next_action`, plus strongest recent signal/initiative if available.
  - Initiative action: top initiative title/detail/source/confidence.
  - Persona action: persona opener/title/source/confidence or buying path text.
  - Risk action: risk text and optionally competitive signal.
- Every action defaults to `approval_state: "suggested"`.
- Choose severity deterministically:
  - primary next action: `high`
  - initiative/persona: `medium`
  - risk: `medium` or `high` if risk contains words like `block`, `delay`, `complex`, `risk`, `procurement`, `security`, `governance`.
- Keep output cap: max 4 actions.
- Return `[]` only if all candidate source fields are missing/empty.

**Tests:**
- Existing sample brief returns at least 2 recommended actions and at most 4.
- First action recommendation or rationale includes `brief.next_action` or a concise title plus detail derived from it.
- Every action has `approval_state === "suggested"`.
- Every action has `rationale` and `expected_outcome` non-empty.
- Evidence text for each action is drawn from saved brief fields.
- Sparse brief does not produce fake actions.

---

### Task 3: Use rich actions in the Canvas adapter

**Objective:** Replace the single legacy action payload with the new recommended action objects.

**Files:**
- Modify: `web/lib/canvas/fromBrief.ts`
- Test: `tests/canvasBridge.test.ts`

**Steps:**
1. Import `buildRecommendedActions`.
2. Replace `actions: [{ label: "Next action", detail: brief.next_action }]` with `actions: buildRecommendedActions(brief)`.
3. Set the widget `source: "hermes"` and `why_included` to something like:
   `Hermes-ranked action queue derived deterministically from next_action, initiatives, risks, personas, and evidence in the saved brief.`
4. Consider widening/heightening the action widget if needed, e.g. `w=12`, `h=3` or `h=4`, so it reads as a workspace object instead of a tiny note.
5. Keep all controls disabled.
6. Update tests that previously expected the legacy shape.

Expected: `Canvas.parse(buildReadOnlyCanvasFromBrief(...))` still passes, and no controls are enabled.

---

### Task 4: Upgrade action tile rendering

**Objective:** Make the Canvas card show an action queue, not just a paragraph.

**Files:**
- Modify: `web/components/canvas/tiles.tsx`
- Test: `tests/canvasBridge.test.ts` via source assertions if appropriate

**Rendering requirements:**
- `ActionPanelTile` should normalize all three supported shapes:
  - legacy `{ label, detail? }`
  - lab `{ text, why, owner?, severity }`
  - new `{ recommendation, rationale, expected_outcome, risk?, evidence?, approval_state, owner?, severity }`
- Card preview should show:
  - a small `Suggested` / `Approved` / `Dismissed` chip for the first action
  - first action recommendation as the primary line
  - expected outcome or rationale as secondary copy
  - if multiple actions, `+N more recommended moves · open to view`
- Do not render visible repeated `View details` text.
- Do not render empty/zero evidence/source counts.
- Keep visual tone professional and readable at 780px.

---

### Task 5: Upgrade action modal/detail rendering

**Objective:** Let users inspect action rationale and evidence without enabling execution.

**Files:**
- Modify: `web/components/canvas/details.tsx`
- Test: `tests/canvasBridge.test.ts` source/logic assertions as appropriate

**Detail requirements:**
- Render each action as a structured card with fields:
  - Recommendation
  - Rationale
  - Expected outcome
  - Risk / caveat, only when present
  - Evidence backing, only when present
  - Approval state chip, always present for new shape
  - Owner, only when present
- Add a read-only posture line such as:
  `Suggested only · approval and execution are not enabled in this preview.`
- Do not add buttons that imply execution (`Run`, `Approve`, `Dismiss`) in this PR.
- Keep legacy action rendering functional.

---

### Task 6: Full verification

Run from repo root:

```bash
./web/node_modules/.bin/tsx --test tests/canvasBridge.test.ts
cd web && npm run typecheck
cd web && npm run build
 git diff --check
```

Note: remove the accidental leading space before `git diff --check` if copying commands literally.

Expected:
- canvasBridge tests pass.
- Typecheck passes.
- Build passes.
- Diff check clean.

Manual/browser QA expectation for PR report:
- Load a real brief, e.g. Misty Robotics.
- Switch to Canvas view.
- Verify action card appears as `Recommended next action` or equivalent.
- Verify it shows multiple suggested recommended moves if available.
- Open detail modal.
- Verify recommendation/rationale/expected outcome/risk/evidence fields are visible.
- Verify no execution/approval buttons exist.
- Verify no horizontal overflow at ~780px.
- Verify no visible repeated `View details` text, `Drill`, `0 sources`, or `0 evidence items`.

---

## PR Requirements

Branch:
- `feat/canvas-recommended-actions`

Title:
- `feat(canvas): add Hermes recommended action queue`

PR body must include:
- Summary of schema/helper/rendering changes.
- Explicit statement: no DB migration, no provider calls, no execution, no public/share route changes.
- Verification commands and results.
- Browser QA notes if run.

Do not deploy. Hermes will review, merge, and deploy separately after verification.
