import { test } from "node:test";
import assert from "node:assert/strict";

const ooxml = require("../web/lib/ooxml") as typeof import("../web/lib/ooxml");
const JSZip = require("../web/node_modules/jszip");
const ExcelJS = require("../web/node_modules/exceljs");

const CT = "[Content_Types].xml";
const ok = (name: string, u = 1, c = 1) => ({ name, uncompressedSize: u, compressedSize: c });

test("assertOoxmlSafe accepts a minimal valid package per kind", () => {
  ooxml.assertOoxmlSafe([ok(CT), ok("xl/workbook.xml")], "xlsx");
  ooxml.assertOoxmlSafe([ok(CT), ok("word/document.xml")], "docx");
});

test("assertOoxmlSafe rejects path traversal, absolute, and non-portable entry names", () => {
  for (const bad of ["../evil.xml", "/etc/passwd", "C:\\windows\\x", "a\\b.xml", "deep/../../x"]) {
    assert.throws(
      () => ooxml.assertOoxmlSafe([ok(CT), ok("xl/workbook.xml"), ok(bad)], "xlsx"),
      /absolute or non-portable|path-traversal/,
      `expected rejection for ${bad}`,
    );
  }
});

test("assertOoxmlSafe rejects control characters in entry names", () => {
  assert.throws(
    () => ooxml.assertOoxmlSafe([ok(CT), ok("xl/workbook.xml"), ok("xl/a" + String.fromCharCode(1) + ".xml")], "xlsx"),
    /control characters/,
  );
});

test("assertOoxmlSafe requires [Content_Types].xml and the kind-specific part", () => {
  assert.throws(() => ooxml.assertOoxmlSafe([ok("xl/workbook.xml")], "xlsx"), /missing \[Content_Types\]/);
  assert.throws(() => ooxml.assertOoxmlSafe([ok(CT)], "xlsx"), /missing xl\/workbook\.xml/);
  assert.throws(() => ooxml.assertOoxmlSafe([ok(CT)], "docx"), /missing word\/document\.xml/);
});

test("assertOoxmlSafe enforces entry-count, per-entry, total, and ratio caps", () => {
  // entry count
  assert.throws(
    () => ooxml.assertOoxmlSafe(Array.from({ length: ooxml.MAX_OOXML_ENTRIES + 1 }, (_, i) => ok(`f${i}.xml`)), "xlsx"),
    /too many entries/,
  );
  // per-entry uncompressed
  assert.throws(
    () => ooxml.assertOoxmlSafe([ok(CT), ok("xl/workbook.xml", ooxml.MAX_OOXML_ENTRY_UNCOMPRESSED + 1, 10)], "xlsx"),
    /an entry is too large/,
  );
  // total uncompressed across entries (each under the per-entry cap)
  const perEntry = 45 * 1024 * 1024; // < 50MB per-entry cap
  const manyBig = [ok(CT), ok("xl/workbook.xml")];
  for (let i = 0; i < 5; i += 1) manyBig.push(ok(`xl/part${i}.xml`, perEntry, perEntry)); // 225MB > 200MB total, ratio 1
  assert.throws(() => ooxml.assertOoxmlSafe(manyBig, "xlsx"), /uncompressed size exceeds/);
  // suspicious compression ratio (zip bomb)
  assert.throws(
    () => ooxml.assertOoxmlSafe([ok(CT), ok("xl/workbook.xml", 50 * 1024 * 1024, 1000)], "xlsx"),
    /suspicious compression ratio/,
  );
  // ZIP64 sentinel sizes
  assert.throws(
    () => ooxml.assertOoxmlSafe([ok(CT), ok("xl/workbook.xml", 0xffffffff, 10)], "xlsx"),
    /ZIP64\/oversized/,
  );
});

test("parseZipEntries reads central directory of a real exceljs workbook", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  ws.addRow(["a", "b"]);
  const bytes = new Uint8Array(Buffer.from(await wb.xlsx.writeBuffer()));
  const entries = ooxml.parseZipEntries(bytes);
  assert.ok(entries.length > 0);
  assert.ok(entries.some((e) => e.name === CT));
  assert.ok(entries.some((e) => e.name === "xl/workbook.xml"));
  ooxml.assertSafeOoxmlPackage(bytes, "xlsx");
});

test("parseZipEntries rejects non-ZIP and truncated input", () => {
  assert.throws(() => ooxml.parseZipEntries(new TextEncoder().encode("not a zip")), /not a ZIP|central directory not found/);
  assert.throws(() => ooxml.assertSafeOoxmlPackage(new Uint8Array([0x50, 0x4b]), "xlsx"), /not a ZIP/);
});

test("assertSafeOoxmlPackage accepts a jszip-built docx and rejects a traversal entry", async () => {
  const good = new JSZip();
  good.file(CT, "<x/>");
  good.folder("word").file("document.xml", "<w/>");
  const goodBytes = new Uint8Array(await good.generateAsync({ type: "nodebuffer" }));
  ooxml.assertSafeOoxmlPackage(goodBytes, "docx");

  const bad = new JSZip();
  bad.file(CT, "<x/>");
  bad.folder("word").file("document.xml", "<w/>");
  bad.file("../escape.xml", "<x/>");
  const badBytes = new Uint8Array(await bad.generateAsync({ type: "nodebuffer" }));
  assert.throws(() => ooxml.assertSafeOoxmlPackage(badBytes, "docx"), /path-traversal/);
});

// ---- central-directory bounds / ZIP64 hardening (mutating a real workbook) ----

async function realXlsxBytes(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  ws.addRow(["a", "b"]);
  ws.addRow([1, 2]);
  return new Uint8Array(Buffer.from(await wb.xlsx.writeBuffer()));
}

function findEocdOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("no EOCD in fixture");
}

test("parseZipEntries rejects a bogus central-directory extra length (truncated record)", async () => {
  const bytes = await realXlsxBytes();
  ooxml.parseZipEntries(bytes); // sanity: valid before mutation
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocdOffset(bytes);
  const cdOffset = view.getUint32(eocd + 16, true);
  // Inflate the first central-directory header's extra-field length past the
  // directory extent — the bytes it claims do not exist.
  view.setUint16(cdOffset + 30, 1000, true);
  assert.throws(
    () => ooxml.parseZipEntries(bytes),
    /corrupt central directory entry|central directory size mismatch|out of bounds/,
  );
});

test("parseZipEntries rejects truncated archives and trailing junk", async () => {
  const bytes = await realXlsxBytes();
  // Truncate the tail (drops/garbles the EOCD).
  assert.throws(() => ooxml.parseZipEntries(bytes.subarray(0, bytes.byteLength - 8)), /central directory/i);
  // Append trailing bytes so the real EOCD's comment no longer runs to EOF.
  const padded = new Uint8Array(bytes.byteLength + 5);
  padded.set(bytes, 0);
  assert.throws(() => ooxml.parseZipEntries(padded), /central directory not found/);
});

test("parseZipEntries rejects ZIP64 EOCD indicators", async () => {
  // cdSize sentinel in the classic EOCD.
  let bytes = await realXlsxBytes();
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = findEocdOffset(bytes);
  view.setUint32(eocd + 12, 0xffffffff, true);
  assert.throws(() => ooxml.parseZipEntries(bytes), /ZIP64/);

  // ZIP64 EOCD locator signature immediately before the EOCD.
  bytes = await realXlsxBytes();
  view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  eocd = findEocdOffset(bytes);
  if (eocd >= 20) {
    view.setUint32(eocd - 20, 0x07064b50, true);
    assert.throws(() => ooxml.parseZipEntries(bytes), /ZIP64/);
  }
});
