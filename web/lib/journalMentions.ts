import { db } from "@/lib/db";
import { newId } from "@/lib/password";

// A user who can be @mentioned on a brief: the owner plus everyone the brief
// is shared with. Mirrors listBriefEmailRecipients, but is NOT filtered by
// email_notifications_enabled — being mentionable is about brief access, not
// notification preferences. Disabled accounts are excluded.
export type BriefMember = {
  id: string;
  email: string;
  display_name: string | null;
};

export function listBriefMembers(briefId: string): BriefMember[] {
  return db()
    .prepare(
      `SELECT DISTINCT u.id, u.email, u.display_name
         FROM users u
        WHERE u.disabled_at IS NULL
          AND (
                u.id = (SELECT user_id FROM briefs WHERE id = @briefId)
             OR u.id IN (SELECT user_id FROM brief_shares WHERE brief_id = @briefId)
          )`,
    )
    .all({ briefId }) as BriefMember[];
}

// Surfaced on each entry's DTO so a renderer can highlight who was mentioned.
export type JournalMentionDto = {
  user_id: string;
  display_name: string | null;
  email: string;
};

// Upper bound on resolved mentions stored per entry — bounds the writes a
// single post can fan out to, even if the body is stuffed with handles.
export const MAX_ENTRY_MENTIONS = 20;

// Matches an `@handle` token: letters, digits, and `. _ -`, up to 64 chars.
// Handles are compared case-insensitively against a member's email local-part
// and a normalized display name (see normalizeHandle). The leading char must
// not be part of a longer word (e.g. an email address) so "a@b.com" doesn't
// register "@b" — we require a non-handle char (or start) before the `@`.
const MENTION_TOKEN = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]{1,64})/g;

// Collapse a member identifier to a comparable handle: lowercase, and for
// display names strip anything that can't appear in a typed handle (spaces,
// punctuation) so "Alice Smith" is reachable as @alicesmith.
function normalizeHandle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

// Extract the distinct, lowercased handles typed in a body, in first-seen
// order. Exported for tests and any future autocomplete preview.
export function parseMentionHandles(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_TOKEN)) {
    const handle = m[2].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

// Resolve the handles in `text` to brief member user ids, in first-mentioned
// order, deduped, and capped at MAX_ENTRY_MENTIONS. Only members of the brief
// resolve — an unknown or non-member handle is silently ignored, so you can't
// mention someone who can't read the brief. The author may mention themselves;
// callers decide whether that's meaningful.
export function resolveMentionedUserIds(briefId: string, text: string): string[] {
  const handles = parseMentionHandles(text);
  if (handles.length === 0) return [];
  const members = listBriefMembers(briefId);
  // Build handle -> userId, preferring the first member that claims a handle so
  // resolution is deterministic when two members would normalize the same.
  const byHandle = new Map<string, string>();
  for (const member of members) {
    const candidates = [
      normalizeHandle(member.email.split("@")[0] ?? ""),
      member.display_name ? normalizeHandle(member.display_name) : "",
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!byHandle.has(candidate)) byHandle.set(candidate, member.id);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const handle of handles) {
    const userId = byHandle.get(handle);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    out.push(userId);
    if (out.length >= MAX_ENTRY_MENTIONS) break;
  }
  return out;
}

// Replace the mention rows for an entry with exactly `userIds` (deduped by the
// table's UNIQUE constraint). Used on create and on edit — re-resolving on edit
// keeps mentions in sync when a handle is added or removed. Caller is trusted
// to pass ids that are real brief members (resolveMentionedUserIds guarantees
// this).
export function setEntryMentions(args: {
  briefId: string;
  entryId: string;
  userIds: string[];
}): void {
  const conn = db();
  conn
    .prepare(`DELETE FROM journal_entry_mentions WHERE journal_entry_id = ?`)
    .run(args.entryId);
  if (args.userIds.length === 0) return;
  const insert = conn.prepare(
    `INSERT OR IGNORE INTO journal_entry_mentions
       (id, brief_id, journal_entry_id, mentioned_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (const userId of args.userIds) {
    insert.run(newId(), args.briefId, args.entryId, userId, now);
  }
}

// Convenience: resolve from body text and persist in one call. Returns the
// resolved user ids (for callers that want to act on them, e.g. tests).
export function syncEntryMentionsFromBody(args: {
  briefId: string;
  entryId: string;
  body: string;
}): string[] {
  const userIds = resolveMentionedUserIds(args.briefId, args.body);
  setEntryMentions({ briefId: args.briefId, entryId: args.entryId, userIds });
  return userIds;
}

type MentionRow = {
  journal_entry_id: string;
  user_id: string;
  display_name: string | null;
  email: string;
};

// Map of entryId -> mentioned users, for the listed entries. Joins users so a
// renderer gets display name + email without a second round-trip. A mentioned
// user who was later disabled/deleted simply drops out (the row is gone via
// ON DELETE CASCADE, or the JOIN excludes a missing user).
export function listMentionsForEntries(
  entryIds: string[],
): Map<string, JournalMentionDto[]> {
  const result = new Map<string, JournalMentionDto[]>();
  if (entryIds.length === 0) return result;
  const rows = db()
    .prepare(
      `SELECT m.journal_entry_id, u.id AS user_id, u.display_name, u.email
         FROM journal_entry_mentions m
         JOIN users u ON u.id = m.mentioned_user_id
        WHERE m.journal_entry_id IN (${entryIds.map(() => "?").join(",")})
        ORDER BY m.created_at ASC, m.rowid ASC`,
    )
    .all(...entryIds) as MentionRow[];
  for (const row of rows) {
    const list = result.get(row.journal_entry_id) ?? [];
    list.push({
      user_id: row.user_id,
      display_name: row.display_name,
      email: row.email,
    });
    result.set(row.journal_entry_id, list);
  }
  return result;
}

export function listMentionsForEntry(entryId: string): JournalMentionDto[] {
  return listMentionsForEntries([entryId]).get(entryId) ?? [];
}

// Entry ids in a brief that mention a given user — backs a server-side
// "mentions me" feed filter. Ordered by mention recency is unnecessary here
// (the caller orders entries); we just return the set of ids.
export function listEntryIdsMentioningUser(
  briefId: string,
  userId: string,
): Set<string> {
  const rows = db()
    .prepare(
      `SELECT journal_entry_id FROM journal_entry_mentions
        WHERE brief_id = ? AND mentioned_user_id = ?`,
    )
    .all(briefId, userId) as Array<{ journal_entry_id: string }>;
  return new Set(rows.map((r) => r.journal_entry_id));
}
