import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
import { loadLiveJournalDocumentRow } from "@/lib/journalDocuments";
import { canServeInline, readOriginalBytes } from "@/lib/journalDocumentStorage";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json(e.body, { status: e.status });
  return null;
}

// Filenames go into a quoted Content-Disposition header. Keep only printable
// ASCII, dropping the double-quote and backslash (which would break or escape
// the quoted value) and path separators; everything else becomes "_". Written
// with numeric char-code checks so the source carries no control bytes.
function safeAsciiFilename(name: string): string {
  let out = "";
  for (const ch of name || "file") {
    const code = ch.codePointAt(0) ?? 0;
    const printableAscii = code >= 0x20 && code <= 0x7e;
    const forbidden = ch === '"' || ch === "\\" || ch === "/";
    out += printableAscii && !forbidden ? ch : "_";
  }
  out = out.trim();
  return out.slice(0, 180) || "file";
}

// Serves the ORIGINAL uploaded bytes. Inline only for an allowlist of safe
// types (PDF/images); everything else is forced to download as an opaque
// octet-stream. HTML/SVG are never served inline (XSS). Same live-entry and
// brief-access boundary as the full-text route.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; documentId: string } },
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

  const row = loadLiveJournalDocumentRow(params.id, params.documentId);
  if (!row || !row.storage_path) {
    // No row, or an older extract-only document with no stored bytes.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bytes = readOriginalBytes(row.storage_path);
  if (!bytes) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const inline = canServeInline(row.mime_type);
  const filename = safeAsciiFilename(row.filename);
  // For non-allowlisted types, hand back an opaque octet-stream attachment so
  // the browser never sniffs or renders it.
  const contentType = inline ? row.mime_type : "application/octet-stream";
  const disposition = inline ? "inline" : "attachment";

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      // Private to the authenticated viewer; don't let shared caches keep it.
      "Cache-Control": "private, no-store",
    },
  });
}
