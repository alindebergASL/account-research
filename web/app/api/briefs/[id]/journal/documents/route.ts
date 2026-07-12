import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { insertJournalEntry, rowToJournalDto, type JournalListRow } from "@/lib/journal";
import { listTagsForEntries } from "@/lib/journalEntryTags";
import { db } from "@/lib/db";
import {
  extractJournalDocument,
  insertJournalDocument,
  listDocumentsForEntries,
  loadJournalDocument,
  rowToJournalDocumentDto,
  MAX_DOCUMENT_BYTES,
  MAX_UPLOAD_BODY_BYTES,
} from "@/lib/journalDocuments";
import { writeOriginalBytes } from "@/lib/journalDocumentStorage";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BODY_CHARS = 4000;

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
  const tags = listTagsForEntries([entryId]).get(entryId) ?? [];
  return rowToJournalDto(row, docs, tags);
}

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
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Brief write access required" }, { status: 403 });
  }

  const parsedContentLength = parseContentLength(req.headers.get("content-length"));
  if (parsedContentLength === null) {
    return NextResponse.json(
      { error: "Content-Length required for document uploads" },
      { status: 411 },
    );
  }
  if (parsedContentLength > MAX_UPLOAD_BODY_BYTES) {
    return NextResponse.json(
      { error: `Document upload request too large (max ${Math.floor(MAX_UPLOAD_BODY_BYTES / 1024 / 1024)}MB)` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  const note = typeof form.get("body") === "string" ? String(form.get("body")).trim() : "";
  if (note.length > MAX_BODY_CHARS) {
    return NextResponse.json(
      { error: `Entry too long (max ${MAX_BODY_CHARS} chars)` },
      { status: 400 },
    );
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json(
      { error: `Document too large (max ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB)` },
      { status: 400 },
    );
  }

  let extracted;
  let storagePath: string | null = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    extracted = await extractJournalDocument({
      filename: file.name || "document.txt",
      mimeType: file.type || "application/octet-stream",
      bytes,
    });
    // Persist the original bytes (content-addressed) so the file can be viewed
    // or downloaded later. Best-effort: if storage fails, fall back to the
    // text-only document rather than failing the whole upload.
    try {
      storagePath = writeOriginalBytes(extracted.contentHash, bytes);
    } catch {
      storagePath = null;
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Document extraction failed" },
      { status: 400 },
    );
  }

  const body = note || `Uploaded document: ${extracted.filename}`;
  let persisted: { entryId: string; documentId: string };
  try {
    persisted = db().transaction(() => {
      const entryId = insertJournalEntry({
        briefId: params.id,
        userId: user.id,
        authorType: "user",
        body,
        replyTo: null,
      });
      const documentId = insertJournalDocument({
        briefId: params.id,
        journalEntryId: entryId,
        userId: user.id,
        document: extracted,
        storagePath,
      });
      return { entryId, documentId };
    })();
  } catch {
    return NextResponse.json({ error: "Document upload failed" }, { status: 500 });
  }
  const documentRow = loadJournalDocument(params.id, persisted.documentId)!;
  const entry = loadEntryDto(params.id, persisted.entryId);

  return NextResponse.json({
    entry,
    document: rowToJournalDocumentDto(documentRow),
  });
}
