import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  countReviewInbox,
  filterReviewInboxCandidates,
  partitionReviewInbox,
  selectReviewInboxTabForMatches,
} = require("../web/lib/journalReviewInbox") as typeof import("../web/lib/journalReviewInbox");

const candidates = [
  { id: "new-brief", status: "new", candidate_type: "brief_update" },
  { id: "review-action", status: "reviewing", candidate_type: "action_item" },
  { id: "accepted-decision", status: "accepted", candidate_type: "decision" },
  { id: "sent-question", status: "sent_to_brief_chat", candidate_type: "open_question" },
  { id: "applied-brief", status: "applied", candidate_type: "brief_update" },
  { id: "dismissed-action", status: "dismissed", candidate_type: "action_item" },
] as const;

test("partitions all six statuses into disjoint pending and history sets", () => {
  const partition = partitionReviewInbox(candidates);
  assert.deepEqual(partition.pending.map((candidate) => candidate.id), ["new-brief", "review-action"]);
  assert.deepEqual(partition.history.map((candidate) => candidate.id), [
    "accepted-decision",
    "sent-question",
    "applied-brief",
    "dismissed-action",
  ]);
  assert.equal(partition.pending.length + partition.history.length, candidates.length);
});

test("counts tabs and types within the active tab independently of search", () => {
  const pending = countReviewInbox(candidates, "pending");
  assert.deepEqual(pending, {
    pending: 2,
    history: 4,
    types: { all: 2, brief_update: 1, action_item: 1, decision: 0, open_question: 0 },
  });
  const history = countReviewInbox(candidates, "history");
  assert.deepEqual(history.types, {
    all: 4,
    brief_update: 1,
    action_item: 1,
    decision: 1,
    open_question: 1,
  });
});

test("filters by tab, type, and optional search-match IDs", () => {
  assert.deepEqual(
    filterReviewInboxCandidates(candidates, { tab: "history", type: "action_item" }).map((c) => c.id),
    ["dismissed-action"],
  );
  assert.deepEqual(
    filterReviewInboxCandidates(candidates, {
      tab: "history",
      type: "all",
      searchMatchIds: new Set(["sent-question", "new-brief"]),
    }).map((c) => c.id),
    ["sent-question"],
  );
  assert.deepEqual(
    filterReviewInboxCandidates(candidates, {
      tab: "pending",
      type: "all",
      searchMatchIds: new Set(),
    }),
    [],
  );
});

test("search arrival selects History only when every match is historical", () => {
  assert.equal(selectReviewInboxTabForMatches(candidates, new Set(["accepted-decision"])), "history");
  assert.equal(selectReviewInboxTabForMatches(candidates, new Set(["new-brief"])), "pending");
  assert.equal(
    selectReviewInboxTabForMatches(candidates, new Set(["new-brief", "accepted-decision"])),
    "pending",
  );
  assert.equal(selectReviewInboxTabForMatches(candidates, new Set()), "pending");
});

test("zero states produce zero counts and no candidates", () => {
  assert.deepEqual(countReviewInbox([], "pending"), {
    pending: 0,
    history: 0,
    types: { all: 0, brief_update: 0, action_item: 0, decision: 0, open_question: 0 },
  });
  assert.deepEqual(filterReviewInboxCandidates([], { tab: "history", type: "all" }), []);
});
