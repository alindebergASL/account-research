// OOXML (.xlsx/.docx) package preflight. Runs after the ZIP magic-byte check
// and BEFORE handing the file to exceljs/mammoth, as defense-in-depth against
// malformed or hostile packages (zip bombs, path-traversal entries, missing
// required parts). It only reads the ZIP central directory — it never
// decompresses anything — so the preflight itself cannot be used as a bomb.
//
// Note: declared central-directory sizes can lie; the bounded extraction child
// process (memory/time/output caps) remains the backstop for actual
// decompression. These checks add cheap structural + ratio screening on top.

export type ZipEntryMeta = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
};

export const MAX_OOXML_ENTRIES = 2_000;
export const MAX_OOXML_ENTRY_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB per entry
export const MAX_OOXML_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024; // 200 MB total
export const MAX_OOXML_COMPRESSION_RATIO = 200; // zip-bomb heuristic
const RATIO_MIN_UNCOMPRESSED = 1024 * 1024; // only ratio-screen once expansion is non-trivial

const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const CDH_SIG = 0x02014b50; // "PK\x01\x02"
const ZIP64_SENTINEL = 0xffffffff;

const REQUIRED_COMMON = "[Content_Types].xml";
const REQUIRED_BY_KIND: Record<"xlsx" | "docx", string> = {
  xlsx: "xl/workbook.xml",
  docx: "word/document.xml",
};

function findEocd(view: DataView, length: number): number {
  // The End Of Central Directory record is 22 bytes + an optional comment of up
  // to 0xffff bytes, so scan backwards over that window for its signature.
  const minEocd = 22;
  if (length < minEocd) throw new Error("Invalid Office package: not a ZIP archive");
  const earliest = Math.max(0, length - (minEocd + 0xffff));
  for (let i = length - minEocd; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error("Invalid Office package: ZIP central directory not found");
}

// Parse the ZIP central directory into per-entry metadata without decompressing.
export function parseZipEntries(bytes: Uint8Array): ZipEntryMeta[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const eocd = findEocd(view, len);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === ZIP64_SENTINEL || count === 0xffff) {
    throw new Error("Invalid Office package: ZIP64 archives are not supported");
  }
  const entries: ZipEntryMeta[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > len) throw new Error("Invalid Office package: corrupt central directory");
    if (view.getUint32(p, true) !== CDH_SIG) {
      throw new Error("Invalid Office package: corrupt central directory header");
    }
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const nameStart = p + 46;
    if (nameStart + nameLen > len) {
      throw new Error("Invalid Office package: corrupt central directory entry name");
    }
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    entries.push({ name, compressedSize, uncompressedSize });
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function assertSafeEntryName(name: string): void {
  if (!name || name.length > 512) {
    throw new Error("Invalid Office package: empty or overlong entry name");
  }
  if (hasControlChar(name)) {
    throw new Error("Invalid Office package: control characters in entry name");
  }
  if (name.startsWith("/") || name.includes("\\") || /^[a-zA-Z]:/.test(name)) {
    throw new Error("Invalid Office package: absolute or non-portable entry path");
  }
  if (name.split("/").some((seg) => seg === "..")) {
    throw new Error("Invalid Office package: path-traversal entry");
  }
}

// Enforce structural + size limits over parsed entries. Pure and synchronous so
// every cap is deterministically testable.
export function assertOoxmlSafe(entries: ZipEntryMeta[], kind: "xlsx" | "docx"): void {
  if (entries.length === 0) {
    throw new Error("Invalid Office package: no entries");
  }
  if (entries.length > MAX_OOXML_ENTRIES) {
    throw new Error("Invalid Office package: too many entries");
  }
  let totalUncompressed = 0;
  let totalCompressed = 0;
  const names = new Set<string>();
  for (const e of entries) {
    assertSafeEntryName(e.name);
    names.add(e.name);
    if (e.uncompressedSize === ZIP64_SENTINEL || e.compressedSize === ZIP64_SENTINEL) {
      throw new Error("Invalid Office package: ZIP64/oversized entry not supported");
    }
    if (e.uncompressedSize > MAX_OOXML_ENTRY_UNCOMPRESSED) {
      throw new Error("Invalid Office package: an entry is too large");
    }
    totalUncompressed += e.uncompressedSize;
    totalCompressed += e.compressedSize;
  }
  if (totalUncompressed > MAX_OOXML_TOTAL_UNCOMPRESSED) {
    throw new Error("Invalid Office package: uncompressed size exceeds the limit");
  }
  if (
    totalCompressed > 0 &&
    totalUncompressed > RATIO_MIN_UNCOMPRESSED &&
    totalUncompressed / totalCompressed > MAX_OOXML_COMPRESSION_RATIO
  ) {
    throw new Error("Invalid Office package: suspicious compression ratio (possible zip bomb)");
  }
  if (!names.has(REQUIRED_COMMON)) {
    throw new Error("Invalid Office package: missing [Content_Types].xml");
  }
  const required = REQUIRED_BY_KIND[kind];
  if (!names.has(required)) {
    throw new Error(
      `Invalid ${kind === "xlsx" ? "spreadsheet" : "Word document"}: missing ${required}`,
    );
  }
}

// Convenience: parse + validate raw bytes for the given OOXML kind.
export function assertSafeOoxmlPackage(bytes: Uint8Array, kind: "xlsx" | "docx"): void {
  assertOoxmlSafe(parseZipEntries(bytes), kind);
}
