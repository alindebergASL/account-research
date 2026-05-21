// Phase A.6 tests: deterministic brief_json → graph decomposition.
// Pure tests, no network. Exercise §4 mapping, §5 provenance tiers, plus
// the HARD INVARIANT enforcement and failure-classification edge cases.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fromBriefJson } from "../web/lib/accountGraph/fromBriefJson";
import { validateAccountGraph } from "../web/lib/accountGraph/validation";
import { Brief as BriefSchema } from "../web/lib/schema";
import type { Brief } from "../web/lib/schema";

function loadSample(): Brief {
  const p = resolve(__dirname, "sample_brief.json");
  return BriefSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

test("fromBriefJson: section mapping covers core Brief sections", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_sample", brief_json: brief });
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;
  const sections = new Set(
    out.graph.claims.map(
      (c) => ((c.metadata as Record<string, unknown>).section as string) || "(none)",
    ),
  );
  for (const expected of [
    "recent_signals",
    "ai_tech_maturity",
    "top_initiatives",
    "personas",
    "risks",
    "competitive_signals",
    "next_action",
    "buying_path",
  ]) {
    assert.ok(sections.has(expected), `missing claims for section ${expected}`);
  }
});

test("fromBriefJson: every Claim provenance_status is a valid §5 tier (no `verified`)", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_sample", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const allowed = new Set([
    "source_document_only",
    "legacy_brief_json",
    "inferred_from_brief_json",
    "chat_patch_object_level",
    "source_unavailable",
  ]);
  for (const c of out.graph.claims) {
    assert.notEqual(c.provenance_status, "verified", `Claim ${c.id} was marked verified`);
    assert.ok(allowed.has(c.provenance_status), `Claim ${c.id} tier ${c.provenance_status} not allowed`);
  }
});

test("fromBriefJson: signals with `source` populated → source_document_only; without → legacy_brief_json", () => {
  const brief: Brief = {
    ...loadSample(),
    recent_signals: [
      { text: "Signal with source", source: "https://example.com/a", confidence: "High" },
      { text: "Signal without source", source: "", confidence: "Low" },
    ],
  };
  const out = fromBriefJson({ brief_id: "b_test", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const sig = out.graph.claims.filter((c) => (c.metadata as any).section === "recent_signals");
  assert.equal(sig.length, 2);
  assert.equal(sig.find((c) => c.text.includes("with source"))?.provenance_status, "source_document_only");
  assert.equal(sig.find((c) => c.text.includes("without source"))?.provenance_status, "legacy_brief_json");
});

test("fromBriefJson: NEVER fabricates EvidenceExcerpt against external SourceDocument from brief prose", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_sample", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  // No EvidenceExcerpts at all in pure legacy backfill.
  assert.equal(out.graph.evidence_excerpts.length, 0);
  assert.equal(out.graph.claim_evidence.length, 0);
  // The only allowed synthetic source is `legacy_brief_json`. External
  // SourceDocuments materialized from Brief `source` strings must exist
  // *without* any excerpt referencing them.
  const externalSourceIds = out.graph.source_documents
    .filter((s) => (s.metadata as any).subtype !== "legacy_brief_json")
    .map((s) => s.id);
  for (const sid of externalSourceIds) {
    const refs = out.graph.evidence_excerpts.filter((e) => e.source_document_id === sid);
    assert.equal(refs.length, 0, `external source ${sid} must NOT have a fabricated excerpt`);
  }
});

test("fromBriefJson: graph validates without errors (warnings allowed)", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_sample", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const v = validateAccountGraph(out.graph);
  assert.equal(v.errors.length, 0, `unexpected errors: ${JSON.stringify(v.errors)}`);
});

test("validator: HARD INVARIANT — verified claim backed only by synthetic legacy_brief_json source fails", () => {
  // Hand-craft an invalid graph that the mapper would never produce, then
  // confirm the validator rejects it.
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_hard", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const legacySrcId = out.graph.source_documents[0].id;
  const badGraph = {
    ...out.graph,
    evidence_excerpts: [
      {
        id: "ex_bad",
        source_document_id: legacySrcId,
        text: out.graph.source_documents[0].content_text.slice(0, 60),
        char_start: 0,
        char_end: 60,
        extraction_method: "exact_span" as const,
        captured_at: "2026-05-21T00:00:00.000Z",
        metadata: {},
      },
    ],
    claims: [
      {
        ...out.graph.claims[0],
        id: "claim_bad",
        provenance_status: "verified" as const,
        confidence: "high" as const,
      },
    ],
    claim_evidence: [
      {
        id: "ce_bad",
        claim_id: "claim_bad",
        evidence_excerpt_id: "ex_bad",
        role: "supports" as const,
        strength: "strong" as const,
        rationale: "supposed support from legacy brief",
      },
    ],
    account_objects: [],
  };
  const v = validateAccountGraph(badGraph);
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => e.code === "verified_from_legacy_brief_only"),
    `expected verified_from_legacy_brief_only; got: ${v.errors.map((e) => e.code).join(",")}`,
  );
});

test("fromBriefJson: unsourced legacy content downgrade — tech footprint and risks → legacy_brief_json", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_sample", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const tfClaims = out.graph.claims.filter((c) =>
    ((c.metadata as any).section as string)?.startsWith("technical_footprint"),
  );
  assert.ok(tfClaims.length > 0);
  for (const c of tfClaims) assert.equal(c.provenance_status, "legacy_brief_json");

  const riskClaims = out.graph.claims.filter((c) => (c.metadata as any).section === "risks");
  assert.ok(riskClaims.length > 0);
  for (const c of riskClaims) assert.equal(c.provenance_status, "legacy_brief_json");
});

test("fromBriefJson: extensions[source=chat] → chat_patch_object_level tier", () => {
  const brief: Brief = {
    ...loadSample(),
    extensions: [
      {
        kind: "card",
        id: "ext_chat",
        title: "Chat-added card",
        source: "chat",
        created_at: "2026-05-20",
        why_included: "user added",
        confidence: "Medium",
        sources: [],
        body: "Added by user in chat",
        badges: [],
      },
    ],
  };
  const out = fromBriefJson({ brief_id: "b_chat", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const chatClaims = out.graph.claims.filter(
    (c) => c.provenance_status === "chat_patch_object_level",
  );
  assert.ok(chatClaims.length > 0, "expected at least one chat_patch_object_level claim");
});

test("fromBriefJson: extensions[kind=narrative] → ambiguous (no auto-claims)", () => {
  const brief: Brief = {
    ...loadSample(),
    extensions: [
      {
        kind: "narrative",
        id: "ext_narr",
        title: "Narrative",
        source: "research",
        created_at: "2026-05-20",
        why_included: "context",
        confidence: "Medium",
        sources: [],
        body: "A long narrative body that should not be auto-decomposed",
      },
    ],
  };
  const out = fromBriefJson({ brief_id: "b_narr", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const fromExtNarr = out.graph.claims.filter((c) =>
    ((c.metadata as any).section as string)?.startsWith("extensions.narrative"),
  );
  assert.equal(fromExtNarr.length, 0);
  assert.ok(out.report.ambiguous.some((a) => a.section.startsWith("extensions.narrative")));
});

test("fromBriefJson: malformed JSON string → skipped_malformed_json", () => {
  const out = fromBriefJson({ brief_id: "b_bad", brief_json: "{ not valid json" });
  assert.equal(out.status, "skipped_malformed_json");
});

test("fromBriefJson: unsupported schema variant → skipped_unsupported_schema_variant", () => {
  const out = fromBriefJson({
    brief_id: "b_variant",
    brief_json: { account_name: "X", some_old_field: true },
  });
  assert.equal(out.status, "skipped_unsupported_schema_variant");
});

test("fromBriefJson: stable IDs across runs (deterministic hashing)", () => {
  const brief = loadSample();
  const a = fromBriefJson({ brief_id: "b_same", brief_json: brief });
  const b = fromBriefJson({ brief_id: "b_same", brief_json: brief });
  if (a.status !== "ok" || b.status !== "ok") throw new Error("expected ok");
  assert.deepEqual(
    a.graph.claims.map((c) => c.id),
    b.graph.claims.map((c) => c.id),
  );
  assert.deepEqual(
    a.graph.account_objects.map((o) => o.id),
    b.graph.account_objects.map((o) => o.id),
  );
});

test("fromBriefJson: Jaccard dedup on near-duplicate recent_signals (≥0.7)", () => {
  const brief: Brief = {
    ...loadSample(),
    recent_signals: [
      { text: "Acme opened a new AI lab in Boston", source: "u1", confidence: "High" },
      { text: "Acme opened new AI lab in Boston", source: "u1b", confidence: "High" }, // near-dup
    ],
  };
  const out = fromBriefJson({ brief_id: "b_dup", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const sigClaims = out.graph.claims.filter((c) => (c.metadata as any).section === "recent_signals");
  assert.equal(sigClaims.length, 1, "near-duplicate signals should dedupe via Jaccard ≥ 0.7");
});

test("rollback: no A.6 code touches public share or admin routes", () => {
  // Pure-code assertion: this test does not write files; it documents the
  // requirement. Static check is performed by the package layout (no files
  // under web/app/s/** or web/app/api/share/** added in this branch — see
  // `git diff` in CI). This test simply asserts the runner does not export
  // anything that resembles a route handler.
  const mod = require("../web/lib/accountGraph/fromBriefJson");
  for (const k of Object.keys(mod)) {
    assert.ok(
      !/route|handler|GET|POST/i.test(k),
      `fromBriefJson must not export route-like symbol: ${k}`,
    );
  }
});
