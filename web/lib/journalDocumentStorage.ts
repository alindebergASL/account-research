import fs from "fs";
import path from "path";
import { DATA_DIR } from "./db";

// Original uploaded document bytes are persisted content-addressed under
// <DATA_DIR>/journal-docs/<hh>/<sha256>. This co-locates them with the SQLite
// DB so the production backup of web/data captures them, and so tests that
// point BRIEF_DB_PATH at a tmp dir keep their blobs isolated.
const JOURNAL_DOCS_SUBDIR = "journal-docs";

// MIME types we are willing to render INLINE in the browser. Everything else is
// served as a forced download. HTML and SVG are intentionally excluded —
// rendering attacker-influenced markup inline is an XSS vector.
export const INLINE_MIME_ALLOWLIST = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function canServeInline(mimeType: string): boolean {
  return INLINE_MIME_ALLOWLIST.has((mimeType || "").toLowerCase().split(";")[0].trim());
}

function isHexHash(hash: string): boolean {
  return /^[a-f0-9]{16,128}$/i.test(hash);
}

// Content-addressed relative path, sharded by the first two hex chars to avoid
// one enormous directory.
export function storageRelPathForHash(contentHash: string): string {
  if (!isHexHash(contentHash)) throw new Error("invalid content hash");
  const h = contentHash.toLowerCase();
  return path.posix.join(JOURNAL_DOCS_SUBDIR, h.slice(0, 2), h);
}

function absFromRel(relPath: string): string {
  return path.join(DATA_DIR, relPath);
}

export function writeOriginalBytes(contentHash: string, bytes: Uint8Array): string {
  const rel = storageRelPathForHash(contentHash);
  const abs = absFromRel(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Content-addressed: an existing file with this hash is byte-identical.
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, bytes);
  return rel;
}

export function readOriginalBytes(relPath: string): Buffer | null {
  // Defense in depth: confine reads to the journal-docs subtree so a stored
  // path can never escape DATA_DIR (path traversal).
  const abs = path.resolve(absFromRel(relPath));
  const root = path.resolve(path.join(DATA_DIR, JOURNAL_DOCS_SUBDIR));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}
