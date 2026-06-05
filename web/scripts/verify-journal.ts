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

  // eslint-disable-next-line no-console
  console.log("verify-journal: OK");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
