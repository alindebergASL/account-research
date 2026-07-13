import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canWriteBrief, requireUser } from "@/lib/auth";
import { insertJournalEntry, rowToJournalDto, type JournalListRow } from "@/lib/journal";
import { db } from "@/lib/db";
import {
  insertJournalDocument,
  listDocumentsForEntries,
  loadJournalDocument,
  rowToJournalDocumentDto,
} from "@/lib/journalDocuments";
import { importJournalLink } from "@/lib/journalLinks";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_URL_CHARS = 2048;

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

function loadEntryDto(briefId: string, entryId: string) {
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

// Import a web link as a journal source. Fetch + extraction happen in
// importJournalLink with SSRF guards; this route handles auth + persistence.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  // Link import triggers server-side network egress + extraction, so it
  // requires write access (stricter than read-only document viewing).
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { url?: unknown };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "A url is required" }, { status: 400 });
  }
  if (url.length > MAX_URL_CHARS) {
    return NextResponse.json({ error: "URL is too long" }, { status: 400 });
  }

  let extracted;
  try {
    extracted = await importJournalLink(url);
  } catch (e: any) {
    // importJournalLink throws only safe, user-facing messages.
    return NextResponse.json(
      { error: e?.message || "Could not import that link" },
      { status: 400 },
    );
  }

  let persisted: { entryId: string; documentId: string };
  try {
    persisted = db().transaction(() => {
      const entryId = insertJournalEntry({
        briefId: params.id,
        userId: user.id,
        authorType: "user",
        body: `Added source link: ${extracted.filename}`,
        replyTo: null,
      });
      const documentId = insertJournalDocument({
        briefId: params.id,
        journalEntryId: entryId,
        userId: user.id,
        document: extracted,
      });
      return { entryId, documentId };
    })();
  } catch {
    return NextResponse.json({ error: "Saving the link failed" }, { status: 500 });
  }

  const documentRow = loadJournalDocument(params.id, persisted.documentId)!;
  const entry = loadEntryDto(params.id, persisted.entryId);
  return NextResponse.json({
    entry,
    document: rowToJournalDocumentDto(documentRow),
  });
}
