import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCascadeImpact,
  validateAccountGraph,
} from "../web/lib/accountGraph/validation";
import { runSpikeA, runSpikeB } from "../web/lib/accountGraph/spikePipeline";
import type { AccountGraphDocument } from "../web/lib/accountGraph/schema";

function freshGraph(): AccountGraphDocument {
  const { graph } = runSpikeA(undefined, runSpikeB());
  return JSON.parse(JSON.stringify(graph)) as AccountGraphDocument;
}

test("valid Nueva fixture graph passes validation", () => {
  const r = validateAccountGraph(freshGraph());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.metrics.valid_excerpt_ratio >= 0.95);
  assert.equal(r.metrics.invented_reference_count, 0);
  assert.equal(r.metrics.high_confidence_claims_without_strong_evidence, 0);
  assert.ok(r.metrics.contradiction_count >= 1);
  assert.ok(r.metrics.conflict_count >= 1);
});

test("duplicate IDs fail", () => {
  const g = freshGraph();
  g.claims.push({ ...g.claims[0] });
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "duplicate_id"));
});

test("invented source reference fails", () => {
  const g = freshGraph();
  g.evidence_excerpts[0].source_document_id = "srcdoc_does_not_exist";
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "invented_source_reference"));
});

test("invented excerpt reference fails", () => {
  const g = freshGraph();
  g.claim_evidence[0].evidence_excerpt_id = "ex_does_not_exist";
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "invented_excerpt_reference"));
});

test("invented claim reference (in account object) fails", () => {
  const g = freshGraph();
  g.account_objects[0].claim_ids.push("claim_does_not_exist");
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "invented_claim_reference"));
});

test("verified claim without evidence fails", () => {
  const g = freshGraph();
  // Remove all evidence supporting claim_account_snapshot
  g.claim_evidence = g.claim_evidence.filter((ce) => ce.claim_id !== "claim_account_snapshot");
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "verified_without_evidence"));
});

test("high-confidence claim without strong/medium evidence fails", () => {
  const g = freshGraph();
  // Force all evidence for claim_signal_ai_pilot to weak
  for (const ce of g.claim_evidence) {
    if (ce.claim_id === "claim_signal_ai_pilot" && ce.role !== "contradicts") {
      ce.strength = "weak";
    }
  }
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "high_confidence_without_strong_evidence"));
});

test("disallowed source supporting verified claim fails", () => {
  const g = freshGraph();
  const src = g.source_documents.find((s) => s.id === "srcdoc_official_about")!;
  src.allowed = false;
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "disallowed_source_supports_verified_claim"));
});

test("excerpt span verification failure fails validation", () => {
  const g = freshGraph();
  g.evidence_excerpts[0].char_start += 3;
  const r = validateAccountGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "excerpt_verification_failed"));
});

test("contradictions are represented and counted", () => {
  const r = validateAccountGraph(freshGraph());
  assert.ok(r.metrics.contradiction_count >= 1);
});

test("cascade impact: claim_marked_wrong downgrades dependent objects", () => {
  const g = freshGraph();
  const impact = computeCascadeImpact(g, {
    type: "claim_marked_wrong",
    claim_id: "claim_initiative_network_refresh",
  });
  assert.ok(impact.affected_claim_ids.includes("claim_initiative_network_refresh"));
  assert.ok(impact.affected_object_ids.includes("obj_initiative_network_refresh"));
  assert.ok(impact.notes.length >= 1);
});

test("cascade impact: source_marked_unreliable affects linked claims", () => {
  const g = freshGraph();
  const impact = computeCascadeImpact(g, {
    type: "source_marked_unreliable",
    source_id: "srcdoc_procurement_rfp",
  });
  assert.ok(impact.affected_excerpt_ids.length >= 1);
  assert.ok(impact.affected_claim_evidence_ids.length >= 1);
  assert.ok(impact.affected_claim_ids.includes("claim_initiative_network_refresh"));
});

test("cascade impact: evidence_excerpt_invalidated propagates", () => {
  const g = freshGraph();
  const impact = computeCascadeImpact(g, {
    type: "evidence_excerpt_invalidated",
    excerpt_id: "ex_rfp_due_date",
  });
  assert.ok(impact.affected_excerpt_ids.includes("ex_rfp_due_date"));
  assert.ok(impact.affected_claim_ids.length >= 1);
});

test("validator rejects Zod-shape garbage", () => {
  const r = validateAccountGraph({ not: "a graph" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "zod_parse_error"));
});
