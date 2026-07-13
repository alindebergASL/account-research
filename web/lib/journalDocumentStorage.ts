import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DATA_DIR, db } from "./db";

// Original uploaded document bytes are persisted content-addressed under
// <DATA_DIR>/journal-docs/<hh>/<sha256>. This co-locates them with the SQLite
// DB so the production backup of web/data captures them, and so tests that
// point BRIEF_DB_PATH at a tmp dir keep their blobs isolated.
const JOURNAL_DOCS_SUBDIR = "journal-docs";
export const INVALID_BLOB_PATH_ERROR = "Invalid journal document storage path";

let testWriteFailure: string | null = null;
let testRemoveFailure: string | null = null;

export function __setTestWriteOriginalBytesFailure(message: string | null): void {
  testWriteFailure = message;
}

export function __setTestRemoveOriginalBytesFailure(message: string | null): void {
  testRemoveFailure = message;
}

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
  return /^[a-f0-9]{64}$/i.test(hash);
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

function confinedBlobPath(relPath: string): string {
  if (!/^journal-docs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(relPath)) {
    throw new Error(INVALID_BLOB_PATH_ERROR);
  }
  const hash = relPath.slice(relPath.lastIndexOf("/") + 1);
  if (relPath !== storageRelPathForHash(hash)) throw new Error(INVALID_BLOB_PATH_ERROR);
  const root = path.resolve(DATA_DIR, JOURNAL_DOCS_SUBDIR);
  const absolute = path.resolve(DATA_DIR, ...relPath.split("/"));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(INVALID_BLOB_PATH_ERROR);
  return absolute;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type StoredOriginalBytes = { storagePath: string; created: boolean };

export function persistOriginalBytes(contentHash: string, bytes: Uint8Array): StoredOriginalBytes {
  if (testWriteFailure !== null) throw new Error(testWriteFailure);
  const rel = storageRelPathForHash(contentHash);
  if (hashBytes(bytes) !== contentHash.toLowerCase()) throw new Error("original bytes do not match content hash");
  const abs = confinedBlobPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  for (const candidate of [path.join(DATA_DIR, JOURNAL_DOCS_SUBDIR), path.dirname(abs)]) {
    if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error(INVALID_BLOB_PATH_ERROR);
  }
  const temporary = `${abs}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    try {
      fs.linkSync(temporary, abs);
      return { storagePath: rel, created: true };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = fs.readFileSync(abs);
      if (existing.byteLength !== bytes.byteLength || hashBytes(existing) !== contentHash.toLowerCase()) {
        throw new Error("existing journal document blob failed content verification");
      }
      return { storagePath: rel, created: false };
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function writeOriginalBytes(contentHash: string, bytes: Uint8Array): string {
  return persistOriginalBytes(contentHash, bytes).storagePath;
}

export function removeOriginalBytesIfUnreferenced(args: {
  storagePath: string;
  connection?: Database.Database;
}): boolean {
  if (testRemoveFailure !== null) throw new Error(testRemoveFailure);
  const absolute = confinedBlobPath(args.storagePath);
  const connection = args.connection ?? db();
  const ownsTransaction = !connection.inTransaction;
  try {
    if (ownsTransaction) connection.exec("BEGIN IMMEDIATE");
    const referenced = connection.prepare(
      "SELECT COUNT(*) AS n FROM journal_documents WHERE storage_path = ?",
    ).get(args.storagePath) as { n: number };
    if (referenced.n > 0 || !fs.existsSync(absolute)) {
      if (ownsTransaction) connection.exec("COMMIT");
      return false;
    }
    const root = path.join(DATA_DIR, JOURNAL_DOCS_SUBDIR);
    for (const candidate of [root, path.dirname(absolute), absolute]) {
      if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error(INVALID_BLOB_PATH_ERROR);
    }
    fs.rmSync(absolute);
    try { fs.rmdirSync(path.dirname(absolute)); } catch { /* shard still has content */ }
    if (ownsTransaction) connection.exec("COMMIT");
    return true;
  } catch (error) {
    if (ownsTransaction && connection.inTransaction) connection.exec("ROLLBACK");
    throw error;
  }
}

export function readOriginalBytes(relPath: string): Buffer | null {
  // Defense in depth: confine reads to the journal-docs subtree so a stored
  // path can never escape DATA_DIR (path traversal).
  const abs = path.resolve(absFromRel(relPath));
  const root = path.resolve(path.join(DATA_DIR, JOURNAL_DOCS_SUBDIR));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    for (const candidate of [root, path.dirname(abs), abs]) {
      if (fs.lstatSync(candidate).isSymbolicLink()) return null;
    }
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}
