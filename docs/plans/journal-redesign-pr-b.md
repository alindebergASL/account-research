# PR-B — Journal Intelligence Cockpit redesign

## Context

PR-A (#110) extracted the Journal's stable substrate (types, prompt catalogs, pure
helpers) out of the 2,750-line `JournalSection.tsx`. PR-B is the **bolder visual
redesign** that makes the Journal feel professional, calm, and easy to use, and
re-componentizes the workspaces/cards as they are restyled.

Today the Journal is **five flat tabs** (team / timeline / sources / intelligence /
review) stacked above a bottom composer, with an ad-hoc palette (amber, violet,
rose, emerald, sky used inconsistently) and dense, uneven card chrome. The
information hierarchy is flat and tab-heavy; the cockpit/intelligence — the most
valuable surface — is buried as one tab among five.

## Target: a three-zone cockpit

Adopt the layout the vision doc already specifies ("three-panel Journal", inspired
by NotebookLM/Linear):

- **Left rail — Navigate & context.** Account context header (name, priority,
  next action), and primary navigation: Feed, Sources, Review boards (Actions /
  Decisions / Questions / Brief updates), Team. Replaces the flat tab strip with a
  grouped, scannable rail. Collapses to a top bar on narrow screens.
- **Center — The Feed (default surface).** The journal timeline + team discussion
  unified into one chronological feed with a filter (All / Notes / Assistant /
  Documents / Discussion / Deleted). Entries, document cards, citation chips, and
  inline review-candidate suggestions live here. A **sticky command bar** at the
  bottom for note / ask-assistant with the source-scope affordances.
- **Right rail — Intelligence.** Persistent (not a tab): the cockpit summary
  (reviewed / pending / dismissed), catch-up windows, the "what changed" actions,
  and priority cards. Always visible on wide screens so the cockpit is the
  Journal's spine; collapses behind a button on narrow screens.

Sources and the Review boards become focused center-surface views reachable from
the left rail (not peer tabs), keeping the Feed + Intelligence as the durable frame.

## Visual system (applied consistently)

- **Disciplined palette.** Replace the ad-hoc rainbow with tokens: neutral surfaces
  (`--surface`, `--line`, `--ink`, `--muted`), a single brand accent, and *semantic*
  colors used only for meaning — assistant (violet), needs-review (amber),
  risk/conflict (rose), accepted/applied (emerald), source/link (sky). No decorative
  color.
- **Consistent card chrome.** One `Card`/`Panel` primitive (radius, border, padding,
  shadow, header pattern) reused everywhere; one section-header pattern; one badge
  component for status/health.
- **Spacing & type scale.** A small fixed scale; tighten the current uneven margins.
- **Calmer density.** Progressive disclosure for audit detail (consistent with #107),
  fewer always-on buttons, clearer empty states.

## Component breakdown (built in the new style)

Re-componentize into `app/brief/[id]/journal/` as part of the restyle (reusing the
PR-A substrate): `CockpitRail`, `LeftRail`, `FeedView` + `TimelineEntry`,
`SourcesView` + `SourceCard` + `SourcePreview`, `ReviewView` + `ReviewCandidateCard`,
`AssistantReviewSuggestions`, `CitationChips`, `CitationContextPanel`, `CommandBar`,
plus shared UI primitives (`Card`, `SectionHeader`, `Badge`). `JournalSection`
becomes a thin orchestrator (state + data loaders + handlers) wiring these together.

## Phased, reviewable implementation

1. **Design-system primitives + shell.** Add `Card`, `SectionHeader`, `Badge`, and
   palette tokens; introduce the three-zone responsive shell while still rendering
   the existing workspace bodies inside it (no content change yet). Verifiable: build
   + visual smoke.
2. **Center Feed.** Extract `TimelineEntry` + unify timeline/team into `FeedView`
   with the new filter and sticky `CommandBar`.
3. **Right Intelligence rail.** Make the cockpit persistent (`CockpitRail`): summary,
   catch-up, what-changed actions, priority cards.
4. **Left rail + Sources/Review views.** `LeftRail` nav + `SourcesView` /
   `ReviewView` as center surfaces with restyled cards.
5. **Polish pass.** Empty states, transitions, responsive (rails collapse), a11y
   (tab roles, focus), and remove dead styles.

### Phase 1 preview feedback (incorporated / tracked)

From the live Phase 1 preview:
- **Empty space under the left rail + tall baseline band** → Phase 2 moves a
  **compact** Brief baseline into the left rail (priority + next action visible;
  sources count, explanatory copy, and the "View brief baseline first" action
  behind a `Details` disclosure). Fills the rail's empty space and removes the
  dominant top band.
- **Left rail width** is good — keep ~as-is (two-line labels need room).
- **Mobile "Full Review Queue" heading wrapped** to "Full / Review / Queue" →
  Phase 2 stacks that header as a block on narrow widths.
- **Composer as a repeated footer on long sections** → Phases 4–5 make it
  contextual/collapsed (prominent in Timeline/Team Room; quiet elsewhere).
- **Sources card density** still high inside the new shell → Phases 2/4 push
  source actions into clearer hierarchy/overflow.
- **Intelligence** is the strongest direction — keep building the cockpit feel.

Behavior is preserved throughout (same endpoints, same handlers, same data flow);
this is a presentation/IA change, not a feature change. Each phase keeps `npm run
typecheck` + `npm run build` green and is independently reviewable.

## Verification

- `typecheck` + `build` after every phase.
- The existing `tests/` suite (`npx tsx --test ../tests/*.ts`) is unaffected (no
  lib/API/DB change).
- Manual visual smoke per phase against a brief with entries, documents, review
  candidates, and an empty account.

## Out of scope (kept for the lifecycle track / PR-B+1)

- Source-change rollups and the durable review checkpoint (see the roadmap's
  corrected sequencing — lifecycle + checkpoint land before rollups).
- Any new durable data, brief mutation, or feature behavior.
