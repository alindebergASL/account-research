import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  nextJournalDeepLinkStep,
  resolveJournalDeepLinkRoot,
} = require("../web/lib/journalDeepLink") as typeof import("../web/lib/journalDeepLink");

// Everything open and mounted — the baseline the variations below perturb.
const landed = {
  inFullView: false,
  onTimelineTab: true,
  targetFound: true,
  rootExpanded: true,
  anchorMounted: true,
  showAllEntries: false,
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
