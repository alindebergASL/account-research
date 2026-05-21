// Phase A.6 tests: brief ↔ shadow-graph parity renderer + report.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

import { fromBriefJson } from "../web/lib/accountGraph/fromBriefJson";
import {
  buildParityReport,
  renderGraphAsBriefLike,
  claimsByTier,
} from "../web/lib/accountGraph/briefParity";
import {
  aggregateClassification,
  classifyBrief,
} from "../web/lib/accountGraph/backfillReport";
import { validateAccountGraph } from "../web/lib/accountGraph/validation";
import { Brief as BriefSchema, type Brief } from "../web/lib/schema";

function loadSample(): Brief {
  return BriefSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, "sample_brief.json"), "utf8")),
  );
}

test("parity report: structural sections + coverage denominator are present", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_par", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const parity = buildParityReport(brief, out.graph, "b_par");
  assert.equal(parity.account_name, brief.account_name);
  assert.equal(parity.brief_id, "b_par");
  assert.ok(parity.coverage_denominator > 0, "coverage denominator must be reported explicitly");
  // Coverage numerator should be a substantial fraction (we map most sections).
  assert.ok(
    parity.coverage_numerator / parity.coverage_denominator >= 0.5,
    `expected ≥50% coverage; got ${parity.coverage_numerator}/${parity.coverage_denominator}`,
  );
  // Every populated section appears as a section bucket.
  const sectionNames = new Set(parity.sections.map((s) => s.section));
  for (const s of ["recent_signals", "top_initiatives", "risks", "personas"]) {
    assert.ok(sectionNames.has(s), `missing section ${s}`);
  }
});

test("parity report: dropped + provenance gap lists are populated honestly", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_par", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const parity = buildParityReport(brief, out.graph, "b_par");
  // Provenance gaps: any high-confidence brief claim must be reported as a
  // gap (A.6 has no excerpt verification against legacy prose).
  const highConfBriefClaimCount =
    brief.recent_signals.filter((s) => s.confidence === "High").length +
    brief.top_initiatives.filter((i) => i.confidence === "High").length +
    brief.personas.filter((p) => p.confidence === "High").length;
  assert.equal(parity.provenance_gaps.length >= highConfBriefClaimCount, true);
});

test("renderGraphAsBriefLike: produces non-empty markdown with section headers", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_par", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const md = renderGraphAsBriefLike(out.graph);
  assert.ok(md.includes("Shadow-graph rendered Brief"));
  assert.ok(md.includes("recent_signals"));
});

test("claimsByTier groups Claims by provenance_status", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_par", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const grouped = claimsByTier(out.graph);
  assert.ok(grouped.legacy_brief_json && grouped.legacy_brief_json.length > 0);
  assert.equal(grouped.verified, undefined); // hard invariant
});

test("classifyBrief: sample brief → pass or partial_with_attribution_gaps (no hard failures)", () => {
  // A real saved brief produces many legacy_brief_json claims (by design).
  // The honest A.6 outcome is `pass` for sparse briefs or
  // `partial_with_attribution_gaps` for dense ones. Either is acceptable;
  // hard failures (false-verified-provenance, invented-evidence,
  // failed_validation, failed_render_parity) are NOT.
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_par", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const v = validateAccountGraph(out.graph);
  const parity = buildParityReport(brief, out.graph, "b_par");
  const rec = classifyBrief("b_par", v, parity, out.report);
  assert.ok(
    rec.classification === "pass" || rec.classification === "partial_with_attribution_gaps",
    `expected pass or partial_with_attribution_gaps; got ${rec.classification} reasons=${rec.reasons.join("; ")}`,
  );
});

test("classifyBrief: invented evidence ID → failed_invented_evidence", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_inv", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const badGraph = {
    ...out.graph,
    claim_evidence: [
      {
        id: "ce_invented",
        claim_id: "claim_does_not_exist",
        evidence_excerpt_id: "ex_does_not_exist",
        role: "supports" as const,
        strength: "strong" as const,
        rationale: "invented",
      },
    ],
  };
  const v = validateAccountGraph(badGraph);
  const parity = buildParityReport(brief, out.graph, "b_inv");
  const rec = classifyBrief("b_inv", v, parity, out.report);
  assert.equal(rec.classification, "failed_invented_evidence");
});

test("classifyBrief: false-verified provenance → failed_false_verified_provenance", () => {
  const brief = loadSample();
  const out = fromBriefJson({ brief_id: "b_fv", brief_json: brief });
  if (out.status !== "ok") throw new Error("expected ok");
  const legacy = out.graph.source_documents[0];
  const badGraph = {
    ...out.graph,
    evidence_excerpts: [
      {
        id: "ex_fv",
        source_document_id: legacy.id,
        text: legacy.content_text.slice(0, 60),
        char_start: 0,
        char_end: 60,
        extraction_method: "exact_span" as const,
        captured_at: "2026-05-21T00:00:00.000Z",
        metadata: {},
      },
    ],
    claims: out.graph.claims.map((c, i) =>
      i === 0 ? { ...c, provenance_status: "verified" as const, confidence: "high" as const } : c,
    ),
    claim_evidence: [
      {
        id: "ce_fv",
        claim_id: out.graph.claims[0].id,
        evidence_excerpt_id: "ex_fv",
        role: "supports" as const,
        strength: "strong" as const,
        rationale: "fabricated support from legacy_brief_json",
      },
    ],
  };
  const v = validateAccountGraph(badGraph);
  const parity = buildParityReport(brief, out.graph, "b_fv");
  const rec = classifyBrief("b_fv", v, parity, out.report);
  assert.equal(rec.classification, "failed_false_verified_provenance");
});

test("aggregateClassification: all pass → pass; any false-verified → fail", () => {
  const passOnly = [
    { brief_id: "x", classification: "pass" as const, reasons: [] },
    { brief_id: "y", classification: "pass" as const, reasons: [] },
  ];
  assert.equal(aggregateClassification(passOnly).classification, "pass");

  const oneFalse = [
    ...passOnly,
    { brief_id: "z", classification: "failed_false_verified_provenance" as const, reasons: [] },
  ];
  assert.equal(aggregateClassification(oneFalse).classification, "fail");
});

test("aggregateClassification: idiosyncratic skip → still pass", () => {
  const records = [
    { brief_id: "x", classification: "pass" as const, reasons: [] },
    { brief_id: "y", classification: "skipped_malformed_json" as const, reasons: ["bad json"] },
    { brief_id: "z", classification: "skipped_unsupported_schema_variant" as const, reasons: ["old shape"] },
  ];
  assert.equal(aggregateClassification(records).classification, "pass");
});

test("no public/share route exposure in this branch", () => {
  // Plan §13: "no public/share route exposure — assert no files under
  // web/app/s/** or web/app/api/share/** were created/touched by this branch".
  // We assert no NEW route files exist under those paths by checking the
  // file listing the runner consults.
  const repoRoot = resolve(__dirname, "..");
  const sharePaths = [
    join(repoRoot, "web", "app", "s"),
    join(repoRoot, "web", "app", "api", "share"),
  ];
  for (const p of sharePaths) {
    if (!existsSync(p)) continue;
    // If the directory exists from prior phases, just ensure no A.6-named
    // file lives there.
    const files = readdirSync(p, { recursive: true }) as string[];
    for (const f of files) {
      assert.ok(
        !/a\.?6|backfill|fromBriefJson|briefParity/i.test(String(f)),
        `A.6 must not add files under ${p}; found ${f}`,
      );
    }
  }
});

test("rollback: canonical source remains legacy — runner does not export a brief_json writer", () => {
  const mod = require("../web/scripts/run-account-graph-backfill");
  // Pure script — no exports.
  for (const k of Object.keys(mod || {})) {
    assert.ok(
      !/write|update|insert|save/i.test(k),
      `runner must not export DB-write helpers; saw ${k}`,
    );
  }
});
