import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow } from "@/lib/db";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import { newId } from "@/lib/password";
import {
  listEntryRowsForBrief,
  rowToJournalDto,
  type JournalEntryDto,
  type JournalListRow,
} from "@/lib/journal";
import {
  runJournalReply,
  type JournalContextEntry,
} from "@/lib/journalAi";
import { friendlyAnthropicError } from "@/lib/anthropicError";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_CHARS = 4000;

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

function loadEntryDto(briefId: string, entryId: string): JournalEntryDto {
  const row = db()
    .prepare(
      `SELECT j.*, u.display_name AS author_display_name, u.email AS author_email
         FROM journal_entries j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE j.id = ? AND j.brief_id = ?`,
    )
    .get(entryId, briefId) as JournalListRow;
  return rowToJournalDto(row);
}

function insertEntry(args: {
  briefId: string;
  userId: string | null;
  authorType: "user" | "assistant";
  body: string;
  replyTo: string | null;
}): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO journal_entries
         (id, brief_id, user_id, author_type, body, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.briefId,
      args.userId,
      args.authorType,
      args.body,
      args.replyTo,
      Date.now(),
    );
  return id;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
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

  const rows = listEntryRowsForBrief(params.id);
  return NextResponse.json({ entries: rows.map(rowToJournalDto) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  // Everyone with access to the brief can post — the journal is shared by all
  // readers. Hide existence behind 404 for non-readers (mirrors comments).
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { body?: unknown; ask_ai?: unknown };
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
  const askAi = body.ask_ai === true;

  const userEntryId = insertEntry({
    briefId: params.id,
    userId: user.id,
    authorType: "user",
    body: text,
    replyTo: null,
  });
  const userEntry = loadEntryDto(params.id, userEntryId);

  if (!askAi) {
    return NextResponse.json({ entries: [userEntry] });
  }

  // AI participation path. A model failure must NOT lose the user's entry: we
  // return the persisted user entry plus a friendly ai_error instead of 500.
  if (!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV === "production") {
    return NextResponse.json({
      entries: [userEntry],
      ai_error: "Server is missing ANTHROPIC_API_KEY",
    });
  }

  const briefRow = db()
    .prepare(`SELECT brief_json FROM briefs WHERE id = ?`)
    .get(params.id) as Pick<BriefRow, "brief_json"> | undefined;
  if (!briefRow) {
    return NextResponse.json({
      entries: [userEntry],
      ai_error: "Brief not found",
    });
  }
  let briefJson: unknown;
  try {
    briefJson = JSON.parse(briefRow.brief_json);
  } catch {
    return NextResponse.json({
      entries: [userEntry],
      ai_error: "Stored brief JSON is corrupt",
    });
  }

  // Build context from the full (non-deleted) feed including the just-posted
  // user entry. selectJournalContext() bounds this to the most recent slice.
  const contextEntries: JournalContextEntry[] = listEntryRowsForBrief(params.id)
    .filter((r) => r.deleted_at === null)
    .map((r) => ({
      author_type: r.author_type,
      author_display_name:
        r.author_type === "assistant" ? "Assistant" : r.author_display_name,
      body: r.body,
      created_at: r.created_at,
    }));

  try {
    const result = await runJournalReply({
      brief_json: briefJson,
      entries: contextEntries,
    });
    const aiEntryId = insertEntry({
      briefId: params.id,
      userId: user.id,
      authorType: "assistant",
      body: result.text,
      replyTo: userEntryId,
    });
    const aiEntry = loadEntryDto(params.id, aiEntryId);
    return NextResponse.json({ entries: [userEntry, aiEntry] });
  } catch (err) {
    return NextResponse.json({
      entries: [userEntry],
      ai_error: friendlyAnthropicError(err, "Journal assistant"),
    });
  }
}
