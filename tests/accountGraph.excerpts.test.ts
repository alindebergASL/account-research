import assert from "node:assert/strict";
import test from "node:test";

import { verifyExcerpt, normalizeForMatch, snippetAppearsInSource } from "../web/lib/accountGraph/excerpts";
import type { EvidenceExcerpt, SourceDocument } from "../web/lib/accountGraph/schema";
import { NUEVA_SOURCES } from "../web/lib/accountGraph/fixtures/nueva/sources";
import { runSpikeB } from "../web/lib/accountGraph/spikePipeline";

const SRC: SourceDocument = NUEVA_SOURCES[0];
const TEXT = SRC.content_text;
const idx = TEXT.indexOf("design thinking");
const sample = TEXT.slice(idx, idx + 60); // ≥20 chars

test("exact_span valid when offsets match text", () => {
  const ex: EvidenceExcerpt = {
    id: "ex_x",
    source_document_id: SRC.id,
    text: sample,
    char_start: idx,
    char_end: idx + sample.length,
    extraction_method: "exact_span",
    captured_at: "2026-05-20T00:00:00.000Z",
    metadata: {},
  };
  const r = verifyExcerpt(ex, SRC);
  assert.equal(r.ok, true);
});

test("exact_span invalid when offsets wrong", () => {
  const ex: EvidenceExcerpt = {
    id: "ex_x",
    source_document_id: SRC.id,
    text: sample,
    char_start: idx + 5,
    char_end: idx + 5 + sample.length,
    extraction_method: "exact_span",
    captured_at: "2026-05-20T00:00:00.000Z",
    metadata: {},
  };
  const r = verifyExcerpt(ex, SRC);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.reason, "exact_mismatch");
});

test("normalized_span valid when whitespace differs", () => {
  // Build a normalized variant
  const variant = sample.replace(/ /g, "   ");
  const ex: EvidenceExcerpt = {
    id: "ex_x",
    source_document_id: SRC.id,
    text: variant,
    char_start: idx,
    char_end: idx + sample.length,
    extraction_method: "normalized_span",
    captured_at: "2026-05-20T00:00:00.000Z",
    metadata: {},
  };
  const r = verifyExcerpt(ex, SRC);
  assert.equal(r.ok, true);
});

test("paraphrase rejected as excerpt", () => {
  const ex: EvidenceExcerpt = {
    id: "ex_para",
    source_document_id: SRC.id,
    text: "Nueva is a school for elite robots in outer space orbit.",
    char_start: 0,
    char_end: 60,
    extraction_method: "normalized_span",
    captured_at: "2026-05-20T00:00:00.000Z",
    metadata: {},
  };
  const r = verifyExcerpt(ex, SRC);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.reason, "paraphrase_not_found_in_source");
});

test("missing source rejected", () => {
  const ex: EvidenceExcerpt = {
    id: "ex_x",
    source_document_id: "srcdoc_missing",
    text: sample,
    char_start: idx,
    char_end: idx + sample.length,
    extraction_method: "exact_span",
    captured_at: "2026-05-20T00:00:00.000Z",
    metadata: {},
  };
  const r = verifyExcerpt(ex, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.reason, "missing_source");
});

test("normalizeForMatch collapses whitespace and case", () => {
  assert.equal(normalizeForMatch("  Hello   WORLD  "), "hello world");
});

test("snippetAppearsInSource detects normalized hits", () => {
  assert.equal(
    snippetAppearsInSource("Design THINKING, social-emotional   learning", SRC),
    true,
  );
  assert.equal(snippetAppearsInSource("brand new AI teacher robot", SRC), false);
});

test("Spike B rejects paraphrase target and accepts expected snippets", () => {
  const b = runSpikeB();
  assert.equal(b.metrics.accepted_paraphrases, 0);
  assert.ok(b.metrics.expected_matchable > 0);
  // every accepted excerpt has valid offsets and correct text slice
  for (const ex of b.excerpts) {
    const src = NUEVA_SOURCES.find((s) => s.id === ex.source_document_id)!;
    if (ex.extraction_method === "exact_span") {
      assert.equal(src.content_text.slice(ex.char_start, ex.char_end), ex.text);
    } else {
      assert.equal(
        normalizeForMatch(src.content_text.slice(ex.char_start, ex.char_end)),
        normalizeForMatch(ex.text),
      );
    }
    assert.ok(ex.text.length >= 20);
  }
});
