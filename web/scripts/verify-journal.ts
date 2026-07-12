// Local verification for the per-brief Journal feature.
//
// Proves end-to-end without model spend or network:
//   1. Migration 016 creates journal_entries; rows round-trip through
//      listEntryRowsForBrief + rowToJournalDto with correct author handling
//      (user vs assistant vs soft-deleted).
//   2. journalAi.buildJournalMessages embeds (capped) brief context + the
//      recent entry feed in the system prompt.
//   3. runJournalReply uses an injected stub client (no API key) and returns
//      the model text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (!process.env.BRIEF_DB_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abb-journal-verify-"));
  process.env.BRIEF_DB_PATH = path.join(tmpDir, "verify.sqlite");
}
if (!process.env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = "verify-journal@example.com";
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = "VerifyTempPass123!";
delete process.env.ANTHROPIC_API_KEY;
process.env.PROVIDER_CALLS_ENABLED = "1"; // Deterministic injected client; no provider/network.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db, initDb } = require("../lib/db") as typeof import("../lib/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  listEntryRowsForBrief,
  rowToJournalDto,
  ASSISTANT_DISPLAY_NAME,
} = require("../lib/journal") as typeof import("../lib/journal");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildJournalMessages,
  runJournalReply,
  __setTestJournalClient,
} = require("../lib/journalAi") as typeof import("../lib/journalAi");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { promoteReviewCandidate } = require("../lib/journalPromotion") as typeof import("../lib/journalPromotion");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { insertDecision, getDecision } = require("../lib/journalDecisions") as typeof import("../lib/journalDecisions");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildJournalRadarManifest } = require("../lib/journalRadarManifest") as typeof import("../lib/journalRadarManifest");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { compareJournalRadarManifests, totalJournalRadarChanges } = require("../lib/journalRadar") as typeof import("../lib/journalRadar");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readJournalRadarCheckpoint, saveJournalRadarCheckpoint } = require("../lib/journalRadarCheckpoints") as typeof import("../lib/journalRadarCheckpoints");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  initDb();
  const adminId = (
    db().prepare("SELECT id FROM users LIMIT 1").get() as { id: string }
  ).id;

  // Seed a brief.
  const briefId = randomUUID();
  const briefObj = { account_name: "Acme Corp", segment: "Enterprise", note: "x".repeat(6000) };
  db()
    .prepare(
      `INSERT INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json)
       VALUES (?, ?, ?, ?, 'internal', ?, ?, ?)`,
    )
    .run(briefId, adminId, "Acme Corp", "Enterprise", new Date().toISOString(), Date.now(), JSON.stringify(briefObj));

  // Seed entries: a user entry, an assistant reply, and a soft-deleted entry.
  const userEntryId = randomUUID();
  const assistantEntryId = randomUUID();
  const deletedEntryId = randomUUID();
  const now = Date.now();
  const ins = db().prepare(
    `INSERT INTO journal_entries (id, brief_id, user_id, author_type, body, reply_to, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(userEntryId, briefId, adminId, "user", "What is the renewal date?", null, now, null);
  ins.run(assistantEntryId, briefId, adminId, "assistant", "The brief does not list one.", userEntryId, now + 1, null);
  ins.run(deletedEntryId, briefId, adminId, "user", "secret text", null, now + 2, now + 3);

  const rows = listEntryRowsForBrief(briefId);
  assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);

  const dtos = rows.map((r) => rowToJournalDto(r));
  const userDto = dtos.find((d) => d.id === userEntryId)!;
  const aiDto = dtos.find((d) => d.id === assistantEntryId)!;
  const delDto = dtos.find((d) => d.id === deletedEntryId)!;

  assert(userDto.author?.id === adminId, "user entry exposes author id");
  assert(aiDto.author_type === "assistant", "assistant entry typed");
  assert(aiDto.author?.display_name === ASSISTANT_DISPLAY_NAME, "assistant label");
  assert(aiDto.author?.id === "" && aiDto.author?.email === "", "assistant entry leaks no user id/email");
  assert(aiDto.reply_to === userEntryId, "assistant reply_to links the user entry");
  assert(delDto.body === null && delDto.author === null, "deleted entry blanks body + author");

  // Plan 4 load-bearing contract: deterministic, explicit per-user radar
  // checkpoint. Building/reading does not write; a checkpoint is saved only
  // through the explicit CAS helper, and subsequent structural edits compare
  // against the frozen manifest without touching brief_json.
  const radarBefore = buildJournalRadarManifest(briefId);
  const radarRepeat = buildJournalRadarManifest(briefId);
  assert(radarBefore.canonicalJson === radarRepeat.canonicalJson, "radar canonical JSON is stable");
  assert(radarBefore.hash === radarRepeat.hash, "radar hash is stable");
  const noCheckpoint = compareJournalRadarManifests({ checkpoint: null, current: radarBefore.manifest, reviewedAt: null });
  assert(noCheckpoint.state === "no_checkpoint", "missing radar checkpoint is explicit");
  assert(totalJournalRadarChanges(noCheckpoint.buckets) === 0, "missing checkpoint fabricates no diff");
  const briefJsonBeforeRadar = (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as { brief_json: string }).brief_json;
  saveJournalRadarCheckpoint({ briefId, userId: adminId, expectedHash: radarBefore.hash, expectedSchemaVersion: radarBefore.manifest.schema_version, now: now + 4 });
  const checkpoint = readJournalRadarCheckpoint(briefId, adminId);
  assert(checkpoint.state === "valid", "explicit radar checkpoint round-trips");
  db().prepare("UPDATE journal_entries SET body = ?, edited_at = ? WHERE id = ?").run("Renewal date still unknown.", now + 5, userEntryId);
  const radarAfter = buildJournalRadarManifest(briefId);
  const radarDiff = compareJournalRadarManifests({ checkpoint: checkpoint.manifest, current: radarAfter.manifest, reviewedAt: checkpoint.reviewed_at });
  assert(radarDiff.buckets.edited_entries.count === 1, "radar detects an edited Journal entry");
  assert((db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as { brief_json: string }).brief_json === briefJsonBeforeRadar, "radar leaves brief_json byte-for-byte unchanged");

  // Prompt construction.
  const { system, user } = buildJournalMessages({
    brief_json: briefObj,
    entries: rows
      .filter((r) => r.deleted_at === null)
      .map((r) => ({
        author_type: r.author_type,
        author_display_name: r.author_type === "assistant" ? "Assistant" : r.author_display_name,
        body: r.body,
        created_at: r.created_at,
      })),
  });
  assert(system.includes("Acme Corp"), "system prompt embeds brief content");
  assert(system.includes("…[truncated]"), "oversized brief is truncated");
  assert(system.includes("What is the renewal date?"), "system prompt embeds journal context");
  assert(user.length > 0, "user turn is non-empty");

  // Stubbed model call.
  let receivedSystem = "";
  __setTestJournalClient({
    messages: {
      create: async (args) => {
        receivedSystem = args.system;
        return { content: [{ type: "text", text: "Stub reply grounded in brief." }] };
      },
    },
  });
  const result = await runJournalReply({ brief_json: briefObj, entries: [] });
  assert(result.text === "Stub reply grounded in brief.", "stub reply returned");
  assert(receivedSystem.includes("Acme Corp"), "stub received brief-grounded system prompt");
  __setTestJournalClient(null);

  // Plan 3 load-bearing contract: accepted action/decision candidates promote
  // into durable tables without touching brief_json, with frozen evidence and
  // auditable two-way supersession linkage.
  const briefJsonBeforePromotion = (
    db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as { brief_json: string }
  ).brief_json;
  const actionCandidateId = randomUUID();
  db().prepare(
    `INSERT INTO journal_review_candidates
     (id, brief_id, user_id, source_entry_id, candidate_type, status, title, proposed_text,
      evidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'action_item', 'accepted', 'Follow up', 'Call the buyer', 'CRM note', ?, ?)`,
  ).run(actionCandidateId, briefId, adminId, assistantEntryId, now + 10, now + 10);
  const promoted = promoteReviewCandidate({
    briefId, candidateId: actionCandidateId, actorUserId: adminId,
    input: { body: "Call the buyer", priority: "high" },
  });
  assert(promoted.kind === "task", "accepted action promotes to task");
  assert(promoted.task.evidence_snapshot?.includes("CRM note"), "task freezes candidate evidence");
  const promotedRetry = promoteReviewCandidate({
    briefId, candidateId: actionCandidateId, actorUserId: adminId, input: {},
  });
  assert(promotedRetry.kind === "task", "promotion retry remains a task");
  assert(promotedRetry.task.id === promoted.task.id, "promotion retry resolves durable task");
  const decision = insertDecision({
    briefId, title: "Commercial model", decisionStatement: "Use annual terms",
    rationale: "Approved pricing", decisionAt: now + 20, createdBy: adminId,
  });
  const replacement = insertDecision({
    briefId, title: "Commercial model", decisionStatement: "Use monthly terms",
    rationale: "Customer request", decisionAt: now + 30, supersedesId: decision.id,
    createdBy: adminId,
  });
  const prior = getDecision(briefId, decision.id);
  assert(prior.lifecycle === "superseded", "prior decision lifecycle becomes superseded");
  assert(prior.superseded_by_id === replacement.id && replacement.supersedes_id === prior.id, "supersession links both records");
  assert(
    (db().prepare("SELECT brief_json FROM briefs WHERE id = ?").get(briefId) as { brief_json: string }).brief_json === briefJsonBeforePromotion,
    "promotion and decisions leave brief_json byte-for-byte unchanged",
  );

  // eslint-disable-next-line no-console
  console.log("verify-journal: OK");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
