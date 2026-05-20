import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildReadOnlyCanvasFromBrief } from "../web/lib/canvas/fromBrief";
import { Brief } from "../web/lib/schema";
import { CanvasAction } from "../web/lib/canvas/actions";
import { legacyCanvasToDocument, isCanvasDocument, isLegacyCanvas } from "../web/lib/canvas/legacy";
import { reduceCanvasAction } from "../web/lib/canvas/reducer";

const brief = Brief.parse(JSON.parse(readFileSync(path.join(__dirname, "sample_brief.json"), "utf8")));

test("legacy canvas converts deterministically to CanvasDocument without mutating shape", () => {
  const legacy = buildReadOnlyCanvasFromBrief({ briefId: "brief-1", brief });
  const before = JSON.stringify(legacy);
  assert.equal(isLegacyCanvas(legacy), true);
  const docA = legacyCanvasToDocument(legacy, "brief-1");
  const docB = legacyCanvasToDocument(legacy, "brief-1");
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(JSON.stringify(docA), JSON.stringify(docB));
  assert.equal(isCanvasDocument(docA), true);
  assert.equal(docA.schema_version, 1);
  assert.equal(docA.nodes.length, legacy.widgets.length);
  assert.equal(docA.layout.mode, "grid");
});

test("document.replace validates prior_version and preserve_node_ids", () => {
  const current = legacyCanvasToDocument(buildReadOnlyCanvasFromBrief({ briefId: "brief-2", brief }), "brief-2");
  const next = { ...current, document_id: "replacement", version: 999 };
  const stale = reduceCanvasAction(current, { kind: "document.replace", payload: { next_document: next, prior_version: current.version + 1, rationale: "stale" } });
  assert.equal(stale.ok, false);
  const mismatch = reduceCanvasAction(current, { kind: "document.replace", payload: { next_document: { ...next, brief_id: "other-brief" }, prior_version: current.version, rationale: "wrong brief" } });
  assert.equal(mismatch.ok, false);
  const preserveMissing = reduceCanvasAction(current, { kind: "document.replace", payload: { next_document: { ...next, nodes: [] }, prior_version: current.version, preserve_node_ids: [current.nodes[0].id], rationale: "missing" } });
  assert.equal(preserveMissing.ok, false);
  const ok = reduceCanvasAction(current, { kind: "document.replace", payload: { next_document: next, prior_version: current.version, preserve_node_ids: [current.nodes[0].id], rationale: "ok" } });
  assert.equal(ok.ok, true);
});

test("capability placeholder is not a widget.create widget_kind", () => {
  const parsed = CanvasAction.safeParse({ kind: "widget.create", payload: { node_id: "n1", widget_kind: "capability_placeholder", title: "Bad", widget_data: {} } });
  assert.equal(parsed.success, false);
  const placeholder = CanvasAction.parse({ kind: "capability.placeholder.create", payload: { capability_proposal_id: "cp1", node_id: "n1", title: "Needs widget", rationale: "new capability" } });
  assert.equal(placeholder.kind, "capability.placeholder.create");
});
