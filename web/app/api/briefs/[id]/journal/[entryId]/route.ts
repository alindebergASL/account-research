import { NextRequest, NextResponse } from "next/server";
import { db, type JournalEntryRow } from "@/lib/db";
import {
  HttpError,
  canManageBrief,
  canReadBrief,
  requireUser,
} from "@/lib/auth";
import {
  listMentionsForEntry,
  syncEntryMentionsFromBody,
} from "@/lib/journalMentions";
import { notifyJournalMentions } from "@/lib/journalMentionNotifications";
import { createMentionNotifications } from "@/lib/notifications";

export const runtime = "nodejs";

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY_CHARS = 4000;

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

function loadEntry(briefId: string, entryId: string): JournalEntryRow | null {
  const row = db()
    .prepare(`SELECT * FROM journal_entries WHERE id = ? AND brief_id = ?`)
    .get(entryId, briefId) as JournalEntryRow | undefined;
  return row ?? null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; entryId: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = loadEntry(params.id, params.entryId);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.deleted_at !== null) {
    return NextResponse.json({ error: "Entry was deleted" }, { status: 400 });
  }
  // Assistant entries are not editable by anyone.
  if (row.author_type !== "user" || row.user_id !== user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  if (Date.now() - row.created_at > EDIT_WINDOW_MS) {
    return NextResponse.json({ error: "Edit window expired" }, { status: 403 });
  }

  let body: { body?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json(
      { error: `Entry too long (max ${MAX_BODY_CHARS} chars)` },
      { status: 400 },
    );
  }

  const now = Date.now();
  // Capture who was already mentioned so we only notify people the edit adds.
  const previouslyMentioned = new Set(
    listMentionsForEntry(params.entryId).map((m) => m.user_id),
  );
  db()
    .prepare(`UPDATE journal_entries SET body = ?, edited_at = ? WHERE id = ?`)
    .run(text, now, params.entryId);
  // Keep mentions in sync with the edited body: a handle added or removed in
  // the edit is reflected immediately (resolved against current brief members).
  const mentionedUserIds = syncEntryMentionsFromBody({ briefId: params.id, entryId: params.entryId, body: text });
  const newlyMentioned = mentionedUserIds.filter((id) => !previouslyMentioned.has(id));
  createMentionNotifications({ briefId: params.id, entryId: params.entryId, actorId: user.id, recipientUserIds: newlyMentioned });
  void notifyJournalMentions({
    briefId: params.id,
    entryId: params.entryId,
    body: text,
    createdAt: now,
    authorId: user.id,
    authorDisplayName: user.display_name,
    authorEmail: user.email,
    mentionedUserIds: newlyMentioned,
  });

  return NextResponse.json({ ok: true, edited_at: now });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; entryId: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = loadEntry(params.id, params.entryId);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.deleted_at !== null) {
    // Idempotent: already deleted.
    return NextResponse.json({ ok: true, deleted_at: row.deleted_at });
  }
  // Own 'user' entries OR a brief manager/admin (owner or admin). Assistant
  // entries can only be removed by a manager/admin.
  const isOwnUserEntry =
    row.author_type === "user" && row.user_id === user.id;
  if (!isOwnUserEntry && !canManageBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const now = Date.now();
  db()
    .prepare(`UPDATE journal_entries SET deleted_at = ? WHERE id = ?`)
    .run(now, params.entryId);

  return NextResponse.json({ ok: true, deleted_at: now });
}
