import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildJournalWorkspaceSearch,
  hashForExplicitNavigation,
  parseJournalWorkspaceLocation,
} = require("../web/lib/journalWorkspaceLocation") as typeof import("../web/lib/journalWorkspaceLocation");

test("parses every supported Brief and Journal destination", () => {
  const cases = [
    ["", { view: "brief", workspace: "timeline", reviewInboxTab: "pending" }],
    ["?view=canvas", { view: "canvas", workspace: "timeline", reviewInboxTab: "pending" }],
    ["?view=journal", { view: "journal", workspace: "timeline", reviewInboxTab: "pending" }],
    ["?view=journal&workspace=team", { view: "journal", workspace: "team", reviewInboxTab: "pending" }],
    ["?view=journal&workspace=sources", { view: "journal", workspace: "sources", reviewInboxTab: "pending" }],
    ["?view=journal&workspace=tasks", { view: "journal", workspace: "tasks", reviewInboxTab: "pending" }],
    ["?view=journal&workspace=review", { view: "journal", workspace: "review", reviewInboxTab: "pending" }],
    ["?view=journal&workspace=review&review=history", { view: "journal", workspace: "review", reviewInboxTab: "history" }],
  ] as const;

  for (const [search, expected] of cases) {
    const parsed = parseJournalWorkspaceLocation({ search, hash: "", canvasAllowed: true });
    assert.deepEqual(
      { view: parsed.view, workspace: parsed.workspace, reviewInboxTab: parsed.reviewInboxTab },
      expected,
    );
    assert.equal(parsed.needsNormalization, false, search);
  }
});

test("normalizes invalid and capability-incompatible values", () => {
  const invalid = parseJournalWorkspaceLocation({
    search: "?view=wat&workspace=nope&review=l ater&keep=yes",
    hash: "",
    canvasAllowed: true,
  });
  assert.deepEqual(
    { view: invalid.view, workspace: invalid.workspace, reviewInboxTab: invalid.reviewInboxTab },
    { view: "brief", workspace: "timeline", reviewInboxTab: "pending" },
  );
  assert.equal(invalid.canonicalSearch, "?keep=yes");
  assert.equal(invalid.needsNormalization, true);

  const canvas = parseJournalWorkspaceLocation({
    search: "?keep=yes&view=canvas",
    hash: "",
    canvasAllowed: false,
  });
  assert.equal(canvas.view, "brief");
  assert.equal(canvas.canonicalSearch, "?keep=yes");
  assert.equal(canvas.needsNormalization, true);
});

test("building search preserves unrelated parameters and omits defaults", () => {
  assert.equal(
    buildJournalWorkspaceSearch("?q=retained&view=canvas&workspace=review&review=history", {
      view: "brief",
      workspace: "timeline",
      reviewInboxTab: "pending",
    }),
    "?q=retained",
  );
  assert.equal(
    buildJournalWorkspaceSearch("?q=retained", {
      view: "journal",
      workspace: "review",
      reviewInboxTab: "history",
    }),
    "?q=retained&view=journal&workspace=review&review=history",
  );
});

test("route-owning hashes override conflicting query state", () => {
  const entry = parseJournalWorkspaceLocation({
    search: "?view=journal&workspace=review&review=history&keep=1",
    hash: "#journal-entry-entry-1",
    canvasAllowed: true,
  });
  assert.deepEqual(
    { view: entry.view, workspace: entry.workspace, reviewInboxTab: entry.reviewInboxTab },
    { view: "journal", workspace: "timeline", reviewInboxTab: "pending" },
  );
  assert.equal(entry.canonicalSearch, "?keep=1&view=journal");
  assert.equal(entry.needsNormalization, true);

  const comment = parseJournalWorkspaceLocation({
    search: "?view=journal&workspace=sources&keep=1",
    hash: "#comment-comment-1",
    canvasAllowed: true,
  });
  assert.equal(comment.view, "brief");
  assert.equal(comment.canonicalSearch, "?keep=1");
});

test("explicit navigation clears only incompatible route-owning hashes", () => {
  assert.equal(
    hashForExplicitNavigation("#comment-1", { view: "journal", workspace: "timeline" }),
    "",
  );
  for (const workspace of ["team", "sources", "tasks", "review"] as const) {
    assert.equal(
      hashForExplicitNavigation("#journal-entry-1", { view: "journal", workspace }),
      "",
    );
  }
  assert.equal(
    hashForExplicitNavigation("#journal-entry-1", { view: "journal", workspace: "timeline" }),
    "#journal-entry-1",
  );
  assert.equal(
    hashForExplicitNavigation("#comment-1", { view: "brief", workspace: "timeline" }),
    "#comment-1",
  );
  assert.equal(
    hashForExplicitNavigation("#unrelated", { view: "journal", workspace: "review" }),
    "#unrelated",
  );
});

test("a back/forward workspace sequence restores state while preserving unrelated search", () => {
  const sequence = [
    { view: "journal", workspace: "timeline", reviewInboxTab: "pending" },
    { view: "journal", workspace: "team", reviewInboxTab: "pending" },
    { view: "journal", workspace: "sources", reviewInboxTab: "pending" },
    { view: "journal", workspace: "review", reviewInboxTab: "pending" },
    { view: "journal", workspace: "review", reviewInboxTab: "history" },
  ] as const;
  const searches = sequence.map((state) => buildJournalWorkspaceSearch("?search=procurement", state));

  for (let index = searches.length - 1; index >= 0; index -= 1) {
    const restored = parseJournalWorkspaceLocation({ search: searches[index], hash: "" });
    assert.deepEqual(
      { view: restored.view, workspace: restored.workspace, reviewInboxTab: restored.reviewInboxTab },
      sequence[index],
    );
    assert.equal(new URLSearchParams(searches[index]).get("search"), "procurement");
  }

  const reviewSearch = searches.at(-1)!;
  const briefSearch = buildJournalWorkspaceSearch(reviewSearch, {
    view: "brief",
    workspace: "timeline",
    reviewInboxTab: "pending",
  });
  assert.equal(briefSearch, "?search=procurement");
  assert.equal(parseJournalWorkspaceLocation({ search: reviewSearch, hash: "" }).reviewInboxTab, "history");
});
