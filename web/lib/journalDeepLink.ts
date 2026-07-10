// Pure decision logic for the journal deep-link handler (#journal-entry-<id>).
//
// Entry anchors render only inside an EXPANDED activity row on the timeline
// tab, so getting a target into the DOM may take several passes; each pass
// performs exactly one step and lets the re-render retry. Kept pure so the
// step order — the part that regressed in review — is directly testable
// without a DOM.

export type JournalDeepLinkStep =
  | "leave-full-view" // a full view (sources/tasks/…) hides the timeline
  | "show-timeline-tab" // the team tab hides the timeline
  | "expand-root" // target's thread row is collapsed; anchor not mounted
  | "scroll" // anchor is in the DOM — scroll + highlight it
  | "show-all" // target is past the compact recent-view cut-off
  | "clear-tag" // tag filter hides the target's thread
  | "clear-kind" // kind (timeline) filter hides the target's thread
  | "clear-search" // search filter hides the target's thread
  | "give-up"; // nothing left to widen (e.g. entry no longer exists)

export function nextJournalDeepLinkStep(s: {
  inFullView: boolean;
  onTimelineTab: boolean;
  /** Target entry exists in the loaded feed (root resolved). */
  targetFound: boolean;
  /** The target's thread root is expanded. */
  rootExpanded: boolean;
  /** document.getElementById found the anchor. */
  anchorMounted: boolean;
  showAllEntries: boolean;
  hasTagFilter: boolean;
  hasKindFilter: boolean;
  hasSearch: boolean;
}): JournalDeepLinkStep {
  if (s.inFullView) return "leave-full-view";
  if (!s.onTimelineTab) return "show-timeline-tab";
  if (s.targetFound && !s.rootExpanded) return "expand-root";
  if (s.anchorMounted) return "scroll";
  if (!s.showAllEntries) return "show-all";
  if (s.hasTagFilter) return "clear-tag";
  if (s.hasKindFilter) return "clear-kind";
  if (s.hasSearch) return "clear-search";
  return "give-up";
}

// A reply's anchor renders under its thread root, so the root is what must be
// expanded. Returns null when the entry isn't in the feed at all.
export function resolveJournalDeepLinkRoot(
  entries: Array<{ id: string; reply_to: string | null }>,
  entryId: string,
): string | null {
  const target = entries.find((e) => e.id === entryId);
  if (!target) return null;
  return target.reply_to ?? target.id;
}
