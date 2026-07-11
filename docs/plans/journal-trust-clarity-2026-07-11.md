# Journal Trust and Clarity Implementation Plan

> **For Hermes:** Use subagent-driven-development discipline to implement and independently review this plan.

**Goal:** Make the existing Journal calmer and more trustworthy by fixing wrong-channel composition, truthful review counts and labels, predictable navigation semantics, actionable search, and honest automated source checks without changing durable data models.

**Architecture:** Keep the existing endpoints, permissions, feed sequencing, review lifecycle, and drawer bodies. Add pure presentation helpers for pending-review counting and source-check labels, narrow the Journal composer to the Timeline, split persistent view tabs from drawer-launching tools, and make cross-workspace search results navigate to the matching surface. Record the later baseline → evidence → review → action redesign in the living product direction document rather than attempting a high-risk monolithic rewrite in this PR.

**Tech Stack:** Next.js 15.5, React 18, TypeScript, Node test runner via `tsx`, Tailwind.

---

## Task 1: Add truthful review-state helpers

**Files:**
- Modify: `web/app/brief/[id]/journal/helpers.ts`
- Test: `tests/journalDocuments.test.ts`

1. Add a pure predicate/count helper that treats only `new` and `reviewing` candidates as pending human review.
2. Add focused tests covering all six candidate statuses.
3. Use the pending count for header badges and the baseline summary; keep full candidate collections available inside Review history.

## Task 2: Correct channel and navigation trust

**Files:**
- Modify: `web/app/brief/[id]/JournalSection.tsx`
- Test: `tests/uiFollowup.test.ts`
- Test: `tests/journalDocuments.test.ts`

1. Render the Journal composer only while the Timeline is active; Team Room must expose only its own comment composer.
2. Give To-dos the correct drawer title.
3. Keep ARIA tabs only for persistent Journal/Team Room body switching.
4. Render To-dos, Sources, and Review Queue as labeled tool buttons that open drawers.
5. Remove the duplicate header Review Queue launcher; retain one tool launcher with the pending count.

## Task 3: Make labels and source checks honest

**Files:**
- Modify: `web/app/brief/[id]/JournalSection.tsx`
- Modify: `web/app/brief/[id]/journal/helpers.ts` if label helpers are shared
- Test: `tests/uiFollowup.test.ts`
- Test: `tests/journalDocuments.test.ts`

1. Rename `Current understanding` to `Current brief baseline`.
2. Rename `Recommended next move` to `Brief next action`.
3. Rename source-health presentation to `Automated checks`.
4. Replace `current` with `No automated issue detected`; keep warnings explicit and do not imply source authority.

## Task 4: Make global search navigable

**Files:**
- Modify: `web/app/brief/[id]/JournalSection.tsx`
- Test: `tests/journalDocuments.test.ts`

1. State that search spans Journal, Sources, and Review Queue.
2. Render Timeline, Sources, and Review result totals as buttons.
3. Clicking a total switches to the corresponding timeline or drawer while preserving the query.
4. Do not render Journal-wide search above Team Room comments; opening search from Team Room should return to Timeline.

## Task 5: Align the living product direction

**Files:**
- Modify: `docs/product/journal-next-generation-vision.md`

1. Add a dated product-direction update recording the observed IA problems.
2. Establish `baseline → evidence → review → action` as the current organizing principle.
3. Record the follow-up sequence: trust/clarity foundation, URL-addressable workspaces and one review inbox, then evidence-backed decisions/tasks and change radar.
4. Mark the old five-workspace/Intelligence status language as stale where it no longer matches the current UI.

## Task 6: Verification

Run from `web/`:

1. `npm ci --no-audit --no-fund`
2. Focused tests for Journal helpers/UI.
3. `npx tsx --test ../tests/*.test.ts`
4. `npm run typecheck`
5. `npm run lint -- --max-warnings=0`
6. `npm run build`
7. `git diff --check`
8. Production-build browser QA with realistic Journal content at 1440×900 and 390×844.
9. Verify no mobile horizontal overflow, Team Room has exactly one composer, review badges count only actionable items, To-dos title is correct, search result buttons navigate, and Sources uses honest automated-check wording.

## Out of scope

- Database/schema changes.
- Changes to permissions, review-status persistence, source inclusion/exclusion, model context, or provider behavior.
- Deployment.
- Full workspace-route decomposition, accepted-candidate → task conversion, or change-radar implementation; these are follow-up PRs after this foundation.
