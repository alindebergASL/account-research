import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Plan 3 routes and UI retain the deliberate-promotion contracts", () => {
  const promotionRoute = read("web/app/api/briefs/[id]/journal/review-candidates/[candidateId]/promote/route.ts");
  assert.match(promotionRoute, /canWriteBrief/);
  assert.match(promotionRoute, /promoteReviewCandidate/);
  const journal = read("web/app/brief/[id]/JournalSection.tsx");
  for (const contract of ["Create to-do", "Record decision", "Confirm exactly what will be created", "Frozen evidence and provenance", "Created →"]) {
    assert.ok(journal.includes(contract), `missing Journal UI contract: ${contract}`);
  }
  const decisions = read("web/app/brief/[id]/journal/JournalDecisions.tsx");
  for (const contract of ["active", "superseded", "revoked", "Supersede", "Revoke", "journal-decision-"]) {
    assert.ok(decisions.includes(contract), `missing Decisions UI contract: ${contract}`);
  }
  const tasks = read("web/app/brief/[id]/journal/JournalTasks.tsx");
  for (const contract of ["Owner:", "Assignee:", "Due:", "Priority:", "Completed", "Open", "Frozen evidence", "Evidence", "journal-task-"]) {
    assert.ok(tasks.includes(contract), `missing task UI contract: ${contract}`);
  }
  for (const source of [tasks, decisions]) {
    assert.match(source, /recordAnchorIdFromHash/);
    assert.match(source, /scrollIntoView/);
    assert.match(source, /focus/);
  }
  assert.doesNotMatch(journal, /setTimeout\(\(\) => \{ window\.location\.hash/);
});
