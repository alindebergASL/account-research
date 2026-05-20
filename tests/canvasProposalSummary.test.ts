import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeCanvasProposal, summarizeCapabilityProposal, previewText } = require("../web/lib/hermes/canvasProposalSummary") as typeof import("../web/lib/hermes/canvasProposalSummary");

function makeProposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    brief_id: "brief-1",
    job_id: null,
    request_id: "req-1",
    request_action_index: 0,
    action_kind: "primitive_surface.create",
    action_layer: "C",
    proposed_by: "hermes",
    action_payload_json: JSON.stringify({ node_id: "n1", title: "Summary", confidence: "Medium", rationale: "Adds a primitive surface" }),
    rationale: "Adds a primitive surface",
    evidence_json: JSON.stringify([{ source: "doc-1" }, { source: "doc-2" }]),
    confidence: "Medium",
    status: "queued",
    canvas_version_before: 3,
    canvas_version_after: 4,
    canvas_before_json: "{}",
    canvas_after_json: "{}",
    error: null,
    retry_of: null,
    capability_proposal_id: null,
    lab_only: 1,
    created_at: Date.now(),
    decided_at: null,
    decided_by: null,
    payload: { node_id: "n1", title: "Summary", confidence: "Medium", rationale: "Adds a primitive surface" },
    evidence: [{ source: "doc-1" }, { source: "doc-2" }],
    ...overrides,
  };
}

function makeCapabilityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cap-1",
    brief_id: "brief-1",
    proposed_widget_kind: "relationship_radar",
    rationale: "Needs a relationship-style visualization to surface stakeholder ties",
    data_schema_json: "{}",
    ts_renderer_source: "export function Widget(){ return null }",
    example_data_json: "{}",
    primitive_fallback_json: "{}",
    evidence_json: JSON.stringify([{ source: "doc-a" }]),
    status: "proposed",
    promoted_widget_kind: null,
    promoted_at: null,
    promoted_by: null,
    proposed_at: Date.now(),
    proposed_by_job_id: null,
    data_schema: {},
    example_data: {},
    primitive_fallback: {},
    evidence: [{ source: "doc-a" }],
    ...overrides,
  };
}

test("summarizeCanvasProposal returns review-friendly summary", () => {
  const s = summarizeCanvasProposal(makeProposalRow(), 3);
  assert.equal(s.id, "p-1");
  assert.equal(s.status, "queued");
  assert.equal(s.action_kind, "primitive_surface.create");
  assert.equal(s.action_layer, "C");
  assert.equal(s.confidence, "Medium");
  assert.equal(s.rationale, "Adds a primitive surface");
  assert.equal(s.evidence_count, 2);
  assert.equal(s.canvas_version_before, 3);
  assert.equal(s.canvas_version_after, 4);
  assert.equal(s.is_approvable, true);
  assert.equal(s.is_stale_candidate, false);
  assert.equal(typeof s.display_title, "string");
  assert.ok(s.display_title.length > 0);
});

test("summarizeCanvasProposal marks stale when current version diverges", () => {
  const s = summarizeCanvasProposal(makeProposalRow(), 7);
  assert.equal(s.is_stale_candidate, true);
});

test("summarizeCanvasProposal marks non-queued as non-approvable", () => {
  const s = summarizeCanvasProposal(makeProposalRow({ status: "applied" }), 4);
  assert.equal(s.is_approvable, false);
});

test("summarizeCanvasProposal marks queued without canvas_after as non-approvable", () => {
  const s = summarizeCanvasProposal(makeProposalRow({ canvas_after_json: null }), 3);
  assert.equal(s.is_approvable, false);
});

test("summarizeCanvasProposal truncates long rationale preview", () => {
  const long = "x".repeat(2000);
  const s = summarizeCanvasProposal(makeProposalRow({ rationale: long, payload: { rationale: long } }), 3);
  assert.ok(s.rationale_preview.length < long.length);
  assert.equal(s.rationale, long);
});

test("summarizeCanvasProposal does not throw on missing optional fields", () => {
  const minimal = makeProposalRow({ rationale: "", evidence: [], payload: {} });
  assert.doesNotThrow(() => summarizeCanvasProposal(minimal));
});

test("summarizeCapabilityProposal returns review-friendly summary", () => {
  const s = summarizeCapabilityProposal(makeCapabilityRow(), "brief-1");
  assert.equal(s.id, "cap-1");
  assert.equal(s.status, "proposed");
  assert.equal(s.proposed_widget_kind, "relationship_radar");
  assert.ok(s.rationale_preview.length > 0);
  assert.equal(s.evidence_count, 1);
  assert.equal(s.has_renderer_source, true);
  assert.equal(s.source_length, "export function Widget(){ return null }".length);
  assert.equal(s.viewer_href, "/lab/canvas/capability?briefId=brief-1&capabilityProposalId=cap-1");
});

test("summarizeCapabilityProposal does not throw on missing renderer source", () => {
  const s = summarizeCapabilityProposal(makeCapabilityRow({ ts_renderer_source: "" }), "brief-1");
  assert.equal(s.has_renderer_source, false);
  assert.equal(s.source_length, 0);
});

test("previewText truncates with ellipsis", () => {
  assert.equal(previewText("hello", 80), "hello");
  const out = previewText("x".repeat(200), 50);
  assert.ok(out.length <= 51);
  assert.ok(out.endsWith("…"));
});

test("previewText handles non-strings safely", () => {
  assert.equal(previewText(undefined), "");
  assert.equal(previewText(null), "");
  assert.equal(previewText(42), "42");
});

test("summary ids are stable across calls", () => {
  const row = makeProposalRow();
  const s1 = summarizeCanvasProposal(row, 3);
  const s2 = summarizeCanvasProposal(row, 3);
  assert.equal(s1.id, s2.id);
  assert.deepEqual(s1, s2);
});
