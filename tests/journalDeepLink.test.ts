import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  nextJournalDeepLinkStep,
  resolveJournalDeepLinkRoot,
} = require("../web/lib/journalDeepLink") as typeof import("../web/lib/journalDeepLink");
const location = require("../web/lib/journalWorkspaceLocation") as typeof import("../web/lib/journalWorkspaceLocation");

// Everything open and mounted — the baseline the variations below perturb.
const landed = {
  inFullView: false,
  onTimelineTab: true,
  targetFound: true,
  rootExpanded: true,
  anchorMounted: true,
  showAllEntries: false,
  hasMentionsFilter: false,
  hasTagFilter: false,
  hasKindFilter: false,
  hasSearch: false,
};

test("anchor in the DOM scrolls immediately, even with filters active", () => {
  assert.equal(nextJournalDeepLinkStep(landed), "scroll");
  assert.equal(
    nextJournalDeepLinkStep({ ...landed, hasTagFilter: true, hasSearch: true }),
    "scroll",
    "filters are only cleared when they actually hide the anchor",
  );
});

test("a collapsed root is expanded BEFORE any view widening", () => {
  // The regression: widening ran first, never mounted the anchor, then marked
  // the hash handled. Expansion must win over show-all / filter clearing.
  const collapsed = { ...landed, rootExpanded: false, anchorMounted: false };
  assert.equal(nextJournalDeepLinkStep(collapsed), "expand-root");
  assert.equal(
    nextJournalDeepLinkStep({ ...collapsed, hasTagFilter: true, hasSearch: true }),
    "expand-root",
  );
});

test("subview comes first: full views and the team tab hide the timeline", () => {
  assert.equal(
    nextJournalDeepLinkStep({ ...landed, inFullView: true, rootExpanded: false, anchorMounted: false }),
    "leave-full-view",
  );
  assert.equal(
    nextJournalDeepLinkStep({ ...landed, onTimelineTab: false, anchorMounted: false }),
    "show-timeline-tab",
  );
});

test("expanded root with the anchor still missing widens one constraint at a time", () => {
  const hidden = {
    ...landed,
    anchorMounted: false,
    showAllEntries: false,
    hasTagFilter: true,
    hasKindFilter: true,
    hasSearch: true,
  };
  assert.equal(nextJournalDeepLinkStep(hidden), "show-all");
  assert.equal(nextJournalDeepLinkStep({ ...hidden, showAllEntries: true }), "clear-tag");
  assert.equal(
    nextJournalDeepLinkStep({ ...hidden, showAllEntries: true, hasTagFilter: false }),
    "clear-kind",
  );
  assert.equal(
    nextJournalDeepLinkStep({
      ...hidden,
      showAllEntries: true,
      hasTagFilter: false,
      hasKindFilter: false,
    }),
    "clear-search",
  );
});

test("a target absent from the feed clears the server-side mentions filter first", () => {
  // The regression: ?mentions=me filters SERVER-side, so an entry whose
  // mention was edited away is missing from `entries` entirely. Client-side
  // widening can never surface it; the mentions filter must be cleared (and
  // the refetch awaited) before any other widening or give-up.
  const absent = {
    ...landed,
    targetFound: false,
    rootExpanded: false,
    anchorMounted: false,
    hasMentionsFilter: true,
  };
  assert.equal(nextJournalDeepLinkStep(absent), "clear-mentions");
  assert.equal(
    nextJournalDeepLinkStep({ ...absent, hasTagFilter: true, hasSearch: true }),
    "clear-mentions",
    "clear-mentions outranks client-side filter widening",
  );
  assert.equal(
    nextJournalDeepLinkStep({ ...absent, showAllEntries: true }),
    "clear-mentions",
    "clear-mentions outranks give-up",
  );
  // Subview normalization still wins — the timeline must be mounted first.
  assert.equal(nextJournalDeepLinkStep({ ...absent, inFullView: true }), "leave-full-view");
});

test("a target PRESENT under the mentions filter proceeds normally without clearing it", () => {
  assert.equal(
    nextJournalDeepLinkStep({ ...landed, hasMentionsFilter: true }),
    "scroll",
  );
  assert.equal(
    nextJournalDeepLinkStep({
      ...landed,
      hasMentionsFilter: true,
      rootExpanded: false,
      anchorMounted: false,
    }),
    "expand-root",
  );
});

test("after the full-feed refetch restores the target, the normal sequence continues", () => {
  // Step 1: filtered feed omits the target -> clear the mentions filter.
  const before = {
    ...landed,
    targetFound: false,
    rootExpanded: false,
    anchorMounted: false,
    hasMentionsFilter: true,
  };
  assert.equal(nextJournalDeepLinkStep(before), "clear-mentions");
  // Step 2: refetch landed, target is back -> expand its collapsed root.
  const after = { ...before, hasMentionsFilter: false, targetFound: true };
  assert.equal(nextJournalDeepLinkStep(after), "expand-root");
  // Step 3: root expanded, anchor mounted -> scroll.
  assert.equal(
    nextJournalDeepLinkStep({ ...after, rootExpanded: true, anchorMounted: true }),
    "scroll",
  );
});

test("an entry that no longer exists gives up after everything is widened", () => {
  assert.equal(
    nextJournalDeepLinkStep({
      ...landed,
      targetFound: false,
      rootExpanded: false,
      anchorMounted: false,
      showAllEntries: true,
    }),
    "give-up",
  );
});

test("a reply resolves to its thread root for expansion", () => {
  const entries = [
    { id: "root-1", reply_to: null },
    { id: "reply-1", reply_to: "root-1" },
    { id: "root-2", reply_to: null },
  ];
  assert.equal(resolveJournalDeepLinkRoot(entries, "reply-1"), "root-1");
  assert.equal(resolveJournalDeepLinkRoot(entries, "root-2"), "root-2");
  assert.equal(resolveJournalDeepLinkRoot(entries, "missing"), null);
});

test("an entry notification hash replaces a conflicting Review URL with Timeline state", () => {
  const parsed = location.parseJournalWorkspaceLocation({
    search: "?view=journal&workspace=review&review=history&search=kept",
    hash: "#journal-entry-entry-1",
  });
  assert.equal(parsed.view, "journal");
  assert.equal(parsed.workspace, "timeline");
  assert.equal(parsed.canonicalSearch, "?search=kept&view=journal");
  assert.equal(parsed.needsNormalization, true);
});

test("explicit navigation clears incompatible notification hashes in both directions", () => {
  assert.equal(
    location.hashForExplicitNavigation("#comment-1", { view: "journal", workspace: "timeline" }),
    "",
  );
  for (const workspace of ["team", "sources", "tasks", "review"] as const) {
    assert.equal(
      location.hashForExplicitNavigation("#journal-entry-1", { view: "journal", workspace }),
      "",
    );
  }
});
