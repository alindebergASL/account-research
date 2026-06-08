import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow } from "@/lib/db";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import {
  insertJournalEntry,
  listEntryRowsForBrief,
  listRecentEntryRowsForBrief,
  rowToJournalDto,
  type JournalEntryDto,
  type JournalListRow,
} from "@/lib/journal";
import {
  formatJournalSourceLegend,
  runJournalReply,
  sanitizeInlinePromptField,
  sanitizeJournalAssistantText,
  type JournalContextEntry,
} from "@/lib/journalAi";
import { friendlyAnthropicError } from "@/lib/anthropicError";
import { parseSourceLegendEntries } from "@/lib/journalSourceLegend";
import {
  listDocumentsForBriefByIds,
  listDocumentsForEntries,
  listRecentDocumentsForBrief,
} from "@/lib/journalDocuments";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_CHARS = 4000;
const MAX_SCOPED_DOCUMENTS = 5;
const MAX_EXCLUDED_DOCUMENTS = 50;
const MAX_SCOPED_DOCUMENT_ID_CHARS = 128;

function parseDocumentIds(value: unknown, fieldName: string, maxIds: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  if (!value.every((id) => typeof id === "string")) {
    throw new Error(`${fieldName} must contain document ids`);
  }
  const ids = Array.from(new Set(value.map((id) => id.trim()))).filter(Boolean);
  if (ids.length > maxIds) {
    throw new Error(`${fieldName} may include at most ${maxIds} documents`);
  }
  if (ids.some((id) => id.length > MAX_SCOPED_DOCUMENT_ID_CHARS)) {
    throw new Error(`${fieldName} contains an invalid document id`);
  }
  return ids;
}

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
  const docs = listDocumentsForEntries([entryId]).get(entryId) ?? [];
  return rowToJournalDto(row, docs);
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
  const docsByEntry = listDocumentsForEntries(rows.map((r) => r.id));
  return NextResponse.json({
    entries: rows.map((r) => rowToJournalDto(r, docsByEntry.get(r.id) ?? [])),
  });
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

  let body: {
    body?: unknown;
    ask_ai?: unknown;
    source_document_ids?: unknown;
    excluded_source_document_ids?: unknown;
  };
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
  const hasScopedDocumentScope = askAi && body.source_document_ids !== undefined;
  let scopedDocumentIds: string[] = [];
  let excludedDocumentIds: string[] = [];
  try {
    scopedDocumentIds = askAi
      ? parseDocumentIds(body.source_document_ids, "source_document_ids", MAX_SCOPED_DOCUMENTS)
      : [];
    excludedDocumentIds = askAi
      ? parseDocumentIds(body.excluded_source_document_ids, "excluded_source_document_ids", MAX_EXCLUDED_DOCUMENTS)
      : [];
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Invalid source document scope" },
      { status: 400 },
    );
  }
  const excludedDocumentSet = new Set(excludedDocumentIds);
  const excludedDocuments = excludedDocumentIds.length > 0
    ? listDocumentsForBriefByIds(params.id, excludedDocumentIds)
    : [];
  const excludedDocumentLegendTexts = new Set(
    excludedDocuments.map((doc) => sanitizeInlinePromptField(doc.filename)),
  );
  const effectiveScopedDocumentIds = scopedDocumentIds.filter((id) => !excludedDocumentSet.has(id));
  if (effectiveScopedDocumentIds.length > 0) {
    const scopedDocuments = listDocumentsForBriefByIds(params.id, effectiveScopedDocumentIds);
    if (scopedDocuments.length !== effectiveScopedDocumentIds.length) {
      return NextResponse.json(
        { error: "Selected source document was not found" },
        { status: 400 },
      );
    }
  }

  const userEntryId = insertJournalEntry({
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

  // Build context from the recent non-deleted feed including the just-posted
  // user entry. Query a bounded slice so large journals do not make assistant
  // requests increasingly expensive over time.
  const recentEntryRows = listRecentEntryRowsForBrief(params.id);
  const documentsByRecentEntry = listDocumentsForEntries(recentEntryRows.map((row) => row.id));
  const entryUsesExcludedDocumentLegend = (row: JournalListRow): boolean => {
    if (row.author_type !== "assistant" || excludedDocumentLegendTexts.size === 0) return false;
    return parseSourceLegendEntries(row.body ?? "").some(
      (entry) => entry.kind === "document" && excludedDocumentLegendTexts.has(entry.text.trim()),
    );
  };
  const contextEntries: JournalContextEntry[] = recentEntryRows
    .filter((row) => {
      if (entryUsesExcludedDocumentLegend(row)) return false;
      const attachedDocuments = documentsByRecentEntry.get(row.id) ?? [];
      return !attachedDocuments.some((doc) => excludedDocumentSet.has(doc.id));
    })
    .map((r) => ({
      author_type: r.author_type,
      author_display_name:
        r.author_type === "assistant" ? "Assistant" : r.author_display_name,
      body: r.body,
      created_at: r.created_at,
    }));

  const documents = hasScopedDocumentScope
    ? effectiveScopedDocumentIds.length > 0
      ? listDocumentsForBriefByIds(params.id, effectiveScopedDocumentIds)
      : []
    : listRecentDocumentsForBrief(params.id).filter((doc) => !excludedDocumentSet.has(doc.id));

  try {
    const result = await runJournalReply({
      brief_json: briefJson,
      entries: contextEntries,
      documents,
    });
    const safeReplyText = sanitizeJournalAssistantText(result.text);
    const aiEntryId = insertJournalEntry({
      briefId: params.id,
      userId: user.id,
      authorType: "assistant",
      body: `${safeReplyText}${formatJournalSourceLegend(
        {
          brief_json: briefJson,
          entries: contextEntries,
          documents,
        },
        safeReplyText,
      )}`,
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
