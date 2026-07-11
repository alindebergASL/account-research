# Journal Addressable Workspaces and Review Inbox Implementation Plan

> **For Hermes:** Use subagent-driven-development discipline to implement and independently review this plan.

**Goal:** Give every reachable Journal workspace a restorable URL and replace the duplicated Review Queue surfaces with one calm, filtered human-review inbox.

**Architecture:** Keep the current client-rendered Brief page and existing Journal APIs. Add pure location/inbox helpers, mirror user navigation to `history.pushState`, restore state from `popstate`/`hashchange`, and preserve entry/comment hash precedence. Rebuild only the Review Queue drawer body around pending/history tabs, type filters, one candidate list, the existing explicit status/handoff actions, and a collapsed create form.

**Tech Stack:** Next.js 15.5, React 18, TypeScript, native History API, Node test runner via `tsx`, Tailwind.

---

## Product and QA decisions

1. Use `/brief/<id>?view=journal` for Timeline and add `workspace=team|sources|review|tasks` for non-default Journal destinations. Keep defaults omitted where possible.
2. Reserve URL hashes for existing `#journal-entry-*` and `#comment-*` anchors. On initial load, repeat notification clicks, and failed-first-load recovery, a route-owning hash wins over query state; a Journal entry hash restores Timeline and a comment hash restores Brief. Explicit user navigation away from the hash-owned destination must clear that incompatible hash so it cannot force the old destination again.
3. User navigation pushes history. Invalid/capability-incompatible query normalization and hash-forced transitions replace history. Back/forward must restore state without reload.
4. The inbox has two disjoint tabs:
   - `Pending (N)`: `new` and `reviewing`.
   - `History (N)`: `accepted`, `sent_to_brief_chat`, `applied`, and `dismissed`.
   Their counts sum to total candidates. Never label total history as pending or show ambiguous bare numbers.
5. Keep type filters in memory for this slice: All, Brief updates, Actions, Decisions, Open questions.
6. Keep all current explicit controls: status update, evidence/baseline/risk, copy brief-chat prompt, open Brief to apply, and create-card flow. No silent brief mutation.
7. Remove the Review drawer's duplicated intro action grid, structured candidate boards, and second Full Review Queue representation. Keep AI suggestion prompts reachable through one compact disclosure and the existing Ask/palette paths.
8. Production QA follow-ups:
   - This PR directly addresses Review Queue first-screen density and the `3 pending` versus `5 total` clarity problem.
   - Search query must survive workspace transitions.
   - The narrow global-header username clipping is real but explicitly out of scope for this PR; track separately.

## URL contract

| URL state | Restored UI |
| --- | --- |
| `/brief/<id>` | Brief view |
| `?view=canvas` | Canvas when capability allows; otherwise normalize to Brief |
| `?view=journal` | Journal Timeline |
| `?view=journal&workspace=team` | Team Room |
| `?view=journal&workspace=sources` | Sources drawer |
| `?view=journal&workspace=tasks` | To-dos drawer |
| `?view=journal&workspace=review` | Review inbox, Pending tab |
| `?view=journal&workspace=review&review=history` | Review inbox, History tab |
| `#journal-entry-<id>` | Journal Timeline, then existing deep-link widening/scroll behavior |
| `#comment-<id>` | Brief-family view, then existing comment behavior |

Unknown `view`, `workspace`, or `review` values normalize to valid defaults with `replaceState`. Unrelated query parameters are preserved. Route-owning hashes are preserved while being processed, but explicit user navigation to another top-level view or Journal workspace clears an incompatible `#journal-entry-*` or `#comment-*` hash before pushing the new canonical URL.

---

### Task 1: Add pure URL parsing and building helpers

**Objective:** Define one tested contract for translating browser location to Brief/Journal state without reading `window` during render.

**Files:**
- Create: `web/lib/journalWorkspaceLocation.ts`
- Create: `tests/journalWorkspaceLocation.test.ts`

**Steps:**
1. Write failing tests for default Brief, Canvas, Timeline, Team Room, Sources, To-dos, Review Pending, Review History, invalid values, unrelated query preservation, and hash precedence.
2. Add exported types for Brief view, Journal workspace, and Review inbox tab.
3. Implement pure parsing from `{ search, hash, canvasAllowed? }`.
4. Implement pure search building that preserves unrelated parameters and omits default workspace/review values.
5. Run the focused test and confirm it passes.

**Expected command:**

```bash
cd web
npx tsx --test ../tests/journalWorkspaceLocation.test.ts
```

### Task 2: Make top-level Brief/Canvas/Journal view state addressable

**Objective:** Restore top-level view state from the URL and make user tab changes participate in browser history.

**Files:**
- Modify: `web/app/brief/[id]/page.tsx`
- Test: `tests/journalWorkspaceLocation.test.ts`
- Test: `tests/uiFollowup.test.ts`

**Steps:**
1. Add a post-mount location sync effect; do not read `window` in initial render state.
2. Extend the established hash-routing effect so Journal entry hashes force Journal and comment hashes force Brief-family rendering.
3. Listen for `popstate` and `hashchange`, parse current location, and update `viewMode`.
4. Route every reachable top-level transition—not only tabs—through one helper that updates state, clears any incompatible route-owning hash for explicit user navigation, and pushes the canonical search. This includes `onViewBriefBaseline` / `openBriefToApply`; browser Back must return to Review.
5. Once Canvas capability is known, normalize disallowed Canvas URLs with `replaceState`.
6. Verify notification hash behavior remains unchanged and add tests proving explicit Journal navigation clears `#comment-*` while explicit non-Timeline navigation clears `#journal-entry-*`.

### Task 3: Make Journal workspaces and review tab addressable

**Objective:** Replace direct workspace state setters in user navigation paths with one URL-aware navigation function.

**Files:**
- Modify: `web/app/brief/[id]/JournalSection.tsx`
- Modify: `web/app/brief/[id]/journal/types.ts`
- Test: `tests/uiFollowup.test.ts`
- Test: `tests/journalDeepLink.test.ts`

**Steps:**
1. Add `reviewInboxTab` state and a location-to-state synchronization effect.
2. Add `navigateJournalWorkspace(workspace, options)` that updates `centerTab`, `activeFullView`, review tab, and canonical URL.
3. Use push semantics for every user-initiated reachable transition: Journal, Team Room, To-dos, Sources, Review Queue, Review Pending/History tabs, search-result destinations (including automatic Pending/History selection), close/backdrop/Escape, cockpit-to-review links, create/promote-to-review callbacks, and Review `openBriefToApply` through the parent top-level helper.
4. Use replace semantics for programmatic hash/deep-link widening and invalid-state normalization. Explicit user navigation away from a route-owning hash clears that incompatible hash before pushing.
5. Preserve `journalSearchQuery`; workspace navigation must never clear it.
6. Confirm browser back closes/reopens drawers and forward restores them without remounting Journal.
7. Keep unreachable legacy Intelligence code out of the URL contract and otherwise untouched.

### Task 4: Add pure review-inbox partition/filter helpers

**Objective:** Make pending/history/type/search behavior deterministic and independently tested.

**Files:**
- Create: `web/lib/journalReviewInbox.ts`
- Create: `tests/journalReviewInbox.test.ts`

**Steps:**
1. Write failing tests for all six candidate statuses.
2. Implement disjoint Pending and History partitions.
3. Implement counts for each tab and candidate type within the active tab.
4. Implement filtering by tab, type, and optional search-match IDs.
5. Implement search-arrival selection: if matches exist only in History, open History; otherwise prefer Pending.
6. Test zero states and mixed-status/type fixtures.

### Task 5: Replace Review Queue duplication with one inbox

**Objective:** Put actual pending work on the first screen while preserving every explicit review action.

**Files:**
- Modify: `web/app/brief/[id]/JournalSection.tsx`
- Test: `tests/uiFollowup.test.ts`
- Test: `tests/journalDocuments.test.ts`

**Steps:**
1. Add compact inbox header copy: `Human review before anything reaches the brief.`
2. Add `Pending (N)` and `History (N)` tabs using unfiltered candidate counts.
3. Add type filter chips with counts scoped to the active tab.
4. Render exactly one filtered candidate list using the existing candidate-card renderer and status/handoff functions.
5. Keep the create-card form as one collapsed disclosure below the filters/list; newly created or assistant-promoted cards land in Pending.
6. Move Review Queue AI prompt actions into one compact `Suggest with AI` disclosure; keep them discoverable in the Ask/palette flow.
7. Remove the Review drawer's introductory action-card grid, candidate `Structured review boards`, and duplicate `Full Review Queue` list. Do not remove cockpit usage of `STRUCTURED_REVIEW_BOARDS`.
8. When status moves a card between tabs, update counts immediately and show a concise moved notice.
9. Add precise empty states for tab/type/search combinations and a route to the other tab when it contains cards.
10. For cross-surface search arrival, open History only when all matching review cards are historical; otherwise open Pending.

### Task 6: Preserve deep links, search, and no-mutation boundaries

**Objective:** Prove the new URL behavior does not regress notification recovery, search, or review safety.

**Files:**
- Test: `tests/journalDeepLink.test.ts`
- Test: `tests/uiFollowup.test.ts`
- Test: `tests/journalDocuments.test.ts`
- Modify only if needed: `web/lib/journalDeepLink.ts`

**Steps:**
1. Add conflict cases such as `?view=journal&workspace=review#journal-entry-<id>` and verify Timeline wins without an extra history entry while notification handling is active.
2. Add explicit-navigation cases in both directions: navigating from a Journal entry hash to Team/Sources/Tasks/Review clears the entry hash, and navigating from a comment hash to Journal clears the comment hash.
3. Cover repeat notification clicks and the existing failed-first-load recovery path.
4. Assert search remains unchanged across Timeline, Sources, Review, Review Pending/History selection, and browser back/forward.
5. Assert pending/history counts are independent of search filters and disjoint.
6. Assert Review `openBriefToApply` updates the URL to Brief and browser Back restores Review.
7. Assert all brief mutation and candidate status changes still require the existing explicit controls.

### Task 7: Update living direction and verification

**Objective:** Record the shipped slice accurately and run complete local/visual gates before PR creation.

**Files:**
- Modify: `docs/product/journal-next-generation-vision.md`

**Steps:**
1. Mark URL-addressable workspaces and one review inbox as implemented only after code and QA pass.
2. Keep evidence-backed decisions/tasks and change radar as the next sequence.
3. Run from `web/`:

```bash
npm ci --no-audit --no-fund
npx tsx --test ../tests/journalWorkspaceLocation.test.ts ../tests/journalReviewInbox.test.ts ../tests/journalDeepLink.test.ts ../tests/uiFollowup.test.ts ../tests/journalDocuments.test.ts
npx tsx --test ../tests/*.test.ts
npm run typecheck
npm run lint -- --max-warnings=0
npm run build
npm run verify:journal
git diff --check
```

4. Run a production-build browser fixture at 1440×900 and 390×844.
5. Browser acceptance:
   - cold-load each URL contract destination;
   - back/forward through Timeline → Team → Sources → Review Pending → Review History;
   - confirm search query survives each transition;
   - confirm notification entry hash wins over Review URL state;
   - confirm Review mobile first screen contains header, tabs, filters, and the first pending card;
   - confirm no page-level horizontal overflow or console errors;
   - confirm candidate status changes still require explicit interaction and no Brief mutation occurs.
6. Obtain independent spec and code-quality reviews plus a final MoA acceptance pass.
7. Open a scoped PR against `main`; do not merge or deploy without explicit approval.

## Out of scope

- Database/schema/API/auth/provider changes.
- Automatic brief edits, automatic task creation, or changed authorization.
- Candidate lifecycle/status schema simplification.
- Durable decisions/tasks or change radar.
- Global-header narrow-width clipping fix.
- Making the unreachable legacy Intelligence drawer addressable or deleting it.
- Production deployment.
