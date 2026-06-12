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
