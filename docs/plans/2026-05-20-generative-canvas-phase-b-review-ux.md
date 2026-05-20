# Generative Canvas Phase B Review UX Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Phase A's raw lab proposal surfaces into an admin-only, human-reviewable Generative Canvas workflow with safe summaries, approve/reject controls, capability-source inspection, and a seeded proposal trigger for lab QA.

**Architecture:** Keep the Phase A server-side rails and safety posture: feature flags gate all generative routes, public share surfaces remain unaffected, and generated renderer source is displayed as inert text only. Add a small review-oriented UI layer over existing `canvas-runtime`, proposal list, approve/reject, and capability proposal endpoints; add only narrowly scoped server helpers if the UI needs safer summaries or seed data. Do not enable arbitrary generated TypeScript execution, production generative flags, or provider spend in this PR.

**Tech Stack:** Next.js App Router, React client components, TypeScript, SQLite via `better-sqlite3`, node:test, existing Tailwind classes.

---

## Current State

Phase A exists in commit `656ef5bdeffe39a80b8e3dca0d063ae39242b370`:

- Runtime lab page: `web/app/lab/canvas/runtime/page.tsx`
- Runtime client: `web/app/lab/canvas/runtime/CanvasRuntimeClient.tsx`
- Capability viewer page: `web/app/lab/canvas/capability/page.tsx`
- Capability viewer client: `web/app/lab/canvas/capability/CapabilityProposalClient.tsx`
- API routes:
  - `web/app/api/briefs/[id]/canvas-runtime/route.ts`
  - `web/app/api/briefs/[id]/canvas-proposals/route.ts`
  - `web/app/api/briefs/[id]/canvas-proposals/[pid]/approve/route.ts`
  - `web/app/api/briefs/[id]/canvas-proposals/[pid]/reject/route.ts`
  - `web/app/api/briefs/[id]/canvas-capability-proposals/route.ts`
  - `web/app/api/briefs/[id]/canvas-capability-proposals/[cpid]/route.ts`
  - `web/app/api/briefs/[id]/canvas-capability-proposals/[cpid]/withdraw/route.ts`
  - `web/app/api/briefs/[id]/canvas-capability-proposals/[cpid]/mark-promoted/route.ts`
- Gateway: `web/lib/hermes/canvasGenerativeGateway.ts`
- Tests: `tests/canvasGateway.test.ts`, `tests/canvasDocument.test.ts`

Primary Phase A caveat: `CanvasRuntimeClient.tsx` renders raw `JSON.stringify(payload.proposals)` in the proposal queue, which is safe but not human-reviewable.

---

## Hard Guardrails

- Do not deploy from this implementation task.
- Do not enable production flags.
- Do not add or enable `dangerouslySetInnerHTML`, `eval`, `new Function`, dynamic generated imports, script injection, or renderer-source execution.
- Do not expose these pages/routes to public share links.
- Preserve route auth through `requireGenerativeCanvasRead` / `requireGenerativeCanvasWrite`.
- Generated widget source remains source text only.
- Approval applies only existing queued Canvas document/action proposals; it must not promote arbitrary code execution.
- Keep generated capability promotion as a registry/audit marker only unless a later PR adds reviewed static code.
- Avoid provider-spend tests; use seeded/fake proposals.

---

## Acceptance Criteria

1. `/lab/canvas/runtime?briefId=...` shows:
   - Canvas preview.
   - Human-readable proposal queue grouped by status/layer/kind.
   - Collapsed rows by default with title/kind/status/layer/confidence/rationale/evidence count/version before/after.
   - Expandable details including payload/evidence/raw JSON.
   - Approve/reject controls only for queued approvable proposals.
   - Clear stale/error status for non-approvable proposals.
   - Capability proposal summary cards with source-viewer link and inert/source-only copy.
2. Approve/reject interactions call existing endpoints, update status without full-page reload, and show success/error messages.
3. Capability viewer remains inert, readable, mobile-safe, and explicitly says source is not executed.
4. A lab/admin-only seed trigger exists to create deterministic fake proposals for QA without provider spend.
5. Tests cover summary/seed/approve/reject/stale behavior and security source checks.
6. `npm run typecheck`, targeted node tests, full relevant tests, and `npm run build` pass.
7. Browser QA covers desktop/mobile no horizontal overflow and no console errors.

---

### Task 1: Add proposal summary helpers with tests

**Objective:** Centralize safe display summaries for Canvas and capability proposals so the UI does not reason over raw JSON directly.

**Files:**
- Create: `web/lib/hermes/canvasProposalSummary.ts`
- Test: `tests/canvasProposalSummary.test.ts`

**Step 1: Write failing tests**

Create tests that assert:

- A Canvas proposal summary includes `id`, `status`, `action_kind`, `action_layer`, `confidence`, `rationale`, `evidence_count`, `canvas_version_before`, `canvas_version_after`, `is_approvable`, `is_stale_candidate`, and a short `display_title`.
- Long rationale/evidence text is truncated for preview but raw fields remain available in the original API payload.
- A capability proposal summary includes `id`, `status`, `proposed_widget_kind`, `rationale_preview`, `evidence_count`, `has_renderer_source`, `source_length`, and `viewer_href`.
- Unknown/missing optional fields do not throw.

Run:

```bash
npm test -- tests/canvasProposalSummary.test.ts
```

Expected: FAIL because `canvasProposalSummary.ts` does not exist.

**Step 2: Implement minimal helpers**

Implement pure functions only:

```ts
export function summarizeCanvasProposal(row: ParsedCanvasProposalLike, currentCanvasVersion?: number): CanvasProposalSummary
export function summarizeCapabilityProposal(row: ParsedCapabilityProposalLike, briefId: string): CapabilityProposalSummary
export function previewText(value: unknown, max?: number): string
```

Do not import React or route code. Keep this pure and deterministic.

**Step 3: Verify**

Run:

```bash
npm test -- tests/canvasProposalSummary.test.ts
npm run typecheck
```

Expected: PASS.

---

### Task 2: Return summaries from the runtime API

**Objective:** Make `/api/briefs/[id]/canvas-runtime` return review-friendly summaries alongside existing raw proposal payloads.

**Files:**
- Modify: `web/app/api/briefs/[id]/canvas-runtime/route.ts`
- Test: extend `tests/canvasGateway.test.ts` or create `tests/canvasRuntimeRouteShape.test.ts`

**Step 1: Write failing shape/security test**

Assert the route source or route handler payload includes:

- `proposal_summaries`
- `capability_proposal_summaries`
- existing `proposals` and `capability_proposals` remain for debug disclosure
- no `dangerouslySetInnerHTML`, `eval`, `new Function`, or dynamic generated import in lab client files

Run targeted tests. Expected: FAIL due missing summary keys.

**Step 2: Implement route shape**

In `canvas-runtime/route.ts`:

- Read current document via `getCurrentCanvasDocument(id)`.
- List proposals/capability proposals as today.
- Add summaries using Task 1 helpers.
- Return both raw arrays and summary arrays.

**Step 3: Verify**

Run:

```bash
npm test -- tests/canvasGateway.test.ts tests/canvasProposalSummary.test.ts
npm run typecheck
```

Expected: PASS.

---

### Task 3: Replace raw runtime queue with collapsible review cards

**Objective:** Make the runtime lab page usable for human proposal review.

**Files:**
- Modify: `web/app/lab/canvas/runtime/CanvasRuntimeClient.tsx`
- Optionally create: `web/app/lab/canvas/runtime/ProposalReviewPanel.tsx`
- Optionally create: `web/app/lab/canvas/runtime/CapabilityProposalPanel.tsx`

**Step 1: Write failing source-level UI tests**

In a node test, read the runtime client/panel source and assert:

- It no longer renders the entire proposal array as the primary UI with `JSON.stringify(payload.proposals, null, 2)` outside an expandable/debug disclosure.
- It contains `<details>` / `<summary>` or equivalent collapsed disclosure UI.
- It labels approve/reject controls.
- It links to `/lab/canvas/capability?briefId=...&capabilityProposalId=...` for capability proposals.
- It uses `whitespace-pre-wrap`, `break-words`, and `overflow-auto` for raw/debug blocks.
- It does not contain forbidden execution patterns.

Expected: FAIL before implementation.

**Step 2: Implement UI**

Design shape:

- Header: `Generative Canvas Review Lab`, flag/status copy, “source proposals are inert unless approved” posture.
- Proposal queue section:
  - Summary cards grouped or sorted by `queued`, `failed`, `applied`, `auto_applied`, `rejected`.
  - Badges: status, layer, action kind, confidence.
  - Preview: rationale, evidence count, version before/after.
  - Expandable details: evidence, payload JSON, before/after version, error.
  - Buttons: Approve, Reject only if `summary.is_approvable` and status is `queued`.
  - Disable buttons while request pending; show success/error inline.
- Capability proposals section:
  - Summary cards with proposed widget kind, status, rationale preview, source length, evidence count.
  - Link/button to source viewer.
  - Copy: “Renderer source is displayed as inert text only. Promotion requires static code review in a later PR.”
- Debug disclosure at bottom can still show raw JSON, collapsed by default.

**Step 3: Implement client actions**

Add functions:

```ts
async function approveProposal(pid: string)
async function rejectProposal(pid: string)
async function refreshRuntime()
```

- POST to existing approve/reject endpoints.
- For reject, use a simple reason like `Rejected from Phase B review lab` unless a small text input is added.
- Refresh runtime payload after success.
- Surface endpoint errors without crashing.

**Step 4: Verify**

Run:

```bash
npm run typecheck
npm run build
```

Expected: PASS.

---

### Task 4: Improve capability source viewer copy and layout

**Objective:** Make capability source review explicit, inert, and mobile-safe.

**Files:**
- Modify: `web/app/lab/canvas/capability/CapabilityProposalClient.tsx`
- Test: extend source-level security/layout test from Task 3

**Step 1: Write failing source-level assertions**

Assert the viewer includes:

- “inert text” or equivalent explicit source-only copy.
- `data_schema` and `example_data` sections, not only source/fallback.
- `overflow-auto`, `whitespace-pre-wrap`, and `break-words` on source/raw blocks.
- No forbidden execution patterns.

Expected: FAIL before implementation.

**Step 2: Implement viewer polish**

- Add status/rationale/source-length metadata.
- Add explicit warning: “This source is not executed by production or lab runtime.”
- Add sections for data schema, example data, primitive fallback, evidence.
- Keep all source/raw content in `<pre>` text nodes.

**Step 3: Verify**

Run targeted tests and `npm run typecheck`.

---

### Task 5: Add deterministic lab seed trigger for proposal QA

**Objective:** Let lab admins create deterministic Canvas and capability proposals without provider spend.

**Files:**
- Create: `web/app/api/briefs/[id]/canvas-proposals/seed/route.ts`
- Modify: `web/app/lab/canvas/runtime/CanvasRuntimeClient.tsx`
- Test: extend `tests/canvasGateway.test.ts` or create `tests/canvasSeedRoute.test.ts`

**Step 1: Write failing tests**

Assert:

- Seed route imports `requireGenerativeCanvasWrite`.
- Seed route calls `ingestCanvasResponse` with deterministic fake `canvas_actions` and one `capability.propose` action.
- Seed route does not call external provider/runtime URL.
- Seed route is under `/api/briefs/[id]`, not public share.
- Seed action produces at least one queued proposal and one capability proposal in a temp DB when helpers are invoked directly.

Expected: FAIL before route exists.

**Step 2: Implement seed helper/route**

Preferred implementation:

- Add pure helper in `canvasGenerativeGateway.ts` or a new `canvasSeedFixtures.ts`:
  - `seedReviewProposals(ctx: CanvasGatewayContext): { proposal_ids: string[]; capability_proposal_ids: string[] }`
- Route `POST /api/briefs/[id]/canvas-proposals/seed`:
  - `requireGenerativeCanvasWrite(req, id)`
  - call seed helper with `proposedBy: "system"` or `"hermes"` only if `canSourcePropose` permits needed action kinds.
  - return IDs only.

Make sure deterministic request IDs avoid duplicate spam, or intentionally include timestamp only if a repeat seed is desired. Prefer deterministic idempotency for QA.

**Step 3: Add UI seed button**

Runtime page:

- Show “Seed review proposals” button in lab header.
- Include clear copy: “Creates deterministic fake proposals for review QA; no provider call.”
- Disable while pending; refresh after success.

**Step 4: Verify**

Run:

```bash
npm test -- tests/canvasGateway.test.ts tests/canvasProposalSummary.test.ts
npm run typecheck
npm run build
```

Expected: PASS.

---

### Task 6: Add approve/reject stale-state tests

**Objective:** Ensure review controls represent stale/non-approvable state safely.

**Files:**
- Modify: `tests/canvasGateway.test.ts`
- Maybe modify: `web/lib/hermes/canvasGenerativeGateway.ts`

**Step 1: Write failing/confirming tests**

Add tests for:

- `rejectProposal` changes only queued proposals and records `decided_at`/`decided_by`.
- Rejecting already applied/stale proposal does not mutate it. If current implementation silently no-ops, decide whether to keep or throw `proposal_not_rejectable`; prefer throwing for UI clarity.
- `approveProposal` stale failure remains covered and route/UI can display `proposal_version_stale`.

**Step 2: Implement minimal behavior if needed**

If tests reveal silent no-op problems, update gateway to throw explicit errors when `changes !== 1` for reject/withdraw actions.

**Step 3: Verify**

Run targeted tests.

---

### Task 7: Final security/build verification

**Objective:** Prove Phase B keeps Phase A safety rails.

**Commands:**

```bash
git diff --check
npm test -- tests/canvasDocument.test.ts tests/canvasGateway.test.ts tests/canvasProposalSummary.test.ts
npm run typecheck
npm run build
python3 - <<'PY'
from pathlib import Path
forbidden = ['dangerouslySetInnerHTML', 'eval(', 'new Function', 'import(proposal', 'import(payload', 'import(source']
paths = list(Path('web/app/lab/canvas').rglob('*.tsx')) + list(Path('web/components/canvas').rglob('*.tsx'))
text = '\n'.join(p.read_text() for p in paths)
for f in forbidden:
    assert f not in text, f
print('forbidden_execution_grep_ok')
PY
```

Expected: all pass.

---

### Task 8: PR preparation

**Objective:** Open a clean PR targeting `main` without deploying.

**Commands:**

```bash
git status --short
git checkout -b feat/generative-canvas-review-ux
# stage only intended files; do not add unrelated untracked docs unless this plan is intentionally included
git add web/app/lab/canvas web/app/api/briefs/[id]/canvas-proposals web/app/api/briefs/[id]/canvas-runtime web/lib/hermes tests docs/plans/2026-05-20-generative-canvas-phase-b-review-ux.md
git diff --cached --stat
git commit -m "feat: add generative Canvas review UX"
git push -u origin HEAD
```

PR body checklist:

- Summary of review UX, seed trigger, capability source viewer, approve/reject behavior.
- Safety rails: no execution of generated source, public share unaffected, flags still required.
- Verification commands and outputs.
- Explicit: “Not deployed.”

---

## Review Gates

Before merge:

1. Spec review:
   - Did the PR implement exactly Phase B review UX and no execution rails?
   - Are routes still auth/flag-gated?
   - Are public share surfaces unchanged?
2. Security review:
   - No generated source execution patterns.
   - Capability source viewer inert.
   - Approve/reject only existing queued actions.
3. Product review:
   - Proposal summaries are actually readable.
   - Raw JSON is available but not the primary UI.
   - Mobile/desktop layout has no horizontal overflow.
4. Deployment review:
   - Deploy to lab first with flags enabled.
   - Keep production flags off unless separately approved.
