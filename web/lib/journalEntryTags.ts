import { db } from "@/lib/db";
import { newId } from "@/lib/password";

// Curated, low-cardinality labels for organizing the journal feed. Kept small
// and fixed so the filter UI stays legible; expand deliberately if needed.
export const JOURNAL_ENTRY_TAGS = [
  "decision",
  "risk",
  "follow_up",
  "question",
  "idea",
] as const;

export type JournalEntryTag = (typeof JOURNAL_ENTRY_TAGS)[number];

export function isJournalEntryTag(value: unknown): value is JournalEntryTag {
  return typeof value === "string" && (JOURNAL_ENTRY_TAGS as readonly string[]).includes(value);
}

export function parseJournalEntryTag(value: unknown): JournalEntryTag {
  if (!isJournalEntryTag(value)) {
    throw new Error(`tag must be one of: ${JOURNAL_ENTRY_TAGS.join(", ")}`);
  }
  return value;
}

type TagRow = { journal_entry_id: string; tag: string };

// Map of entryId -> sorted tag list, for the listed entries. Tags are returned
// in the curated order so the UI renders them consistently.
export function listTagsForEntries(entryIds: string[]): Map<string, JournalEntryTag[]> {
  const result = new Map<string, JournalEntryTag[]>();
  if (entryIds.length === 0) return result;
  const rows = db()
    .prepare(
      `SELECT journal_entry_id, tag
         FROM journal_entry_tags
        WHERE journal_entry_id IN (${entryIds.map(() => "?").join(",")})`,
    )
    .all(...entryIds) as TagRow[];
  const order = (t: string) => JOURNAL_ENTRY_TAGS.indexOf(t as JournalEntryTag);
  for (const row of rows) {
    if (!isJournalEntryTag(row.tag)) continue;
    const list = result.get(row.journal_entry_id) ?? [];
    list.push(row.tag);
    result.set(row.journal_entry_id, list);
  }
  for (const list of result.values()) list.sort((a, b) => order(a) - order(b));
  return result;
}

export function listTagsForEntry(entryId: string): JournalEntryTag[] {
  return listTagsForEntries([entryId]).get(entryId) ?? [];
}

// Confirms an entry exists, is live, and belongs to the brief before mutating
// its tags — so tag writes share the same boundary as the rest of the journal.
function liveEntryExists(briefId: string, entryId: string): boolean {
  const row = db()
    .prepare(
      `SELECT id FROM journal_entries
        WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
    )
    .get(entryId, briefId);
  return !!row;
}

export function addEntryTag(args: {
  briefId: string;
  entryId: string;
  tag: JournalEntryTag;
  userId: string | null;
}): JournalEntryTag[] {
  if (!liveEntryExists(args.briefId, args.entryId)) throw new Error("entry not found");
  db()
    .prepare(
      `INSERT OR IGNORE INTO journal_entry_tags
         (id, brief_id, journal_entry_id, tag, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), args.briefId, args.entryId, args.tag, args.userId, Date.now());
  return listTagsForEntry(args.entryId);
}

export function removeEntryTag(args: {
  briefId: string;
  entryId: string;
  tag: JournalEntryTag;
}): JournalEntryTag[] {
  if (!liveEntryExists(args.briefId, args.entryId)) throw new Error("entry not found");
  db()
    .prepare(
      `DELETE FROM journal_entry_tags
        WHERE brief_id = ? AND journal_entry_id = ? AND tag = ?`,
    )
    .run(args.briefId, args.entryId, args.tag);
  return listTagsForEntry(args.entryId);
}
