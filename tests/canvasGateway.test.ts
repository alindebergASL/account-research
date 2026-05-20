import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(os.tmpdir(), "canvas-gateway-"));
process.env.BRIEF_DB_PATH = path.join(tmp, "test.sqlite");
process.env.HERMES_RUNTIME_ENABLED = "1";
process.env.HERMES_CANVAS_PROPOSALS_ENABLED = "1";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "Password123!";

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { db } = require("../web/lib/db") as typeof import("../web/lib/db");
const { ingestCanvasResponse, listProposals, getCurrentCanvasDocument, listCapabilityProposals, approveProposal } = require("../web/lib/hermes/canvasGenerativeGateway") as typeof import("../web/lib/hermes/canvasGenerativeGateway");

function seedBrief(id: string) {
  db().prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, role, display_name, created_at, created_by, must_change_password) VALUES (?, ?, ?, 'admin', 'Admin', ?, null, 0)`).run("u1", `u1-${id}@example.com`, "hash", Date.now());
  db().prepare(`INSERT OR IGNORE INTO briefs (id, user_id, account_name, segment, audience, generated_at, created_at, brief_json) VALUES (?, 'u1', 'Acme', 'Ent', 'internal', ?, ?, ?)`).run(id, new Date().toISOString(), Date.now(), JSON.stringify({ account_name: "Acme", segment: "Ent", audience: "internal", generated_at: new Date().toISOString(), snapshot: "s", current_state: "c", goals: "g", landscape: "l", opportunities: [], risks: [], recommended_actions: [], sources: [] }));
}

test("duplicate ingest returns existing proposal id and creates no duplicate event", () => {
  seedBrief("brief-idem");
  const resp = { reply: "", patches_applied: [], patch_errors: [], canvas_actions: [{ kind: "primitive_surface.create", payload: { node_id: "n1", title: "Summary", confidence: "Low", rationale: "queue me", surface_spec: { root: { p: "text", text: "Hello" } } } }] } as any;
  const ctx = { briefId: "brief-idem", userId: "u1", canWrite: true, proposedBy: "hermes" as const, requestId: "req-1" };
  const first = ingestCanvasResponse(ctx, resp);
  const eventCount1 = (db().prepare(`SELECT COUNT(*) as n FROM hermes_job_events`).get() as any).n;
  const second = ingestCanvasResponse(ctx, resp);
  const eventCount2 = (db().prepare(`SELECT COUNT(*) as n FROM hermes_job_events`).get() as any).n;
  assert.deepEqual(second.proposal_ids, first.proposal_ids);
  assert.equal(listProposals({ briefId: "brief-idem" }).length, 1);
  assert.equal(eventCount2, eventCount1);
});

test("different request_action_index creates a separate proposal and auto-applies safe primitive action", () => {
  seedBrief("brief-auto");
  const resp = { reply: "", patches_applied: [], patch_errors: [], canvas_actions: [
    { kind: "primitive_surface.create", payload: { node_id: "n1", title: "One", confidence: "High", rationale: "auto", surface_spec: { root: { p: "text", text: "One" } } } },
    { kind: "primitive_surface.create", payload: { node_id: "n2", title: "Two", confidence: "High", rationale: "auto", surface_spec: { root: { p: "text", text: "Two" } } } },
  ] } as any;
  const result = ingestCanvasResponse({ briefId: "brief-auto", userId: "u1", canWrite: true, proposedBy: "hermes", requestId: "req-2" }, resp);
  assert.equal(result.proposal_ids.length, 2);
  const proposals = listProposals({ briefId: "brief-auto" });
  assert.equal(proposals.length, 2);
  assert.equal(proposals.every((p) => p.status === "auto_applied"), true);
  assert.equal(getCurrentCanvasDocument("brief-auto").document.nodes.length, 2);
});


test("approving a queued proposal rejects stale canvas versions", () => {
  seedBrief("brief-stale");
  const queued = ingestCanvasResponse({ briefId: "brief-stale", userId: "u1", canWrite: true, proposedBy: "hermes", requestId: "req-stale-a" }, { reply: "", patches_applied: [], patch_errors: [], canvas_actions: [
    { kind: "primitive_surface.create", payload: { node_id: "queued", title: "Queued", confidence: "Low", rationale: "manual", surface_spec: { root: { p: "text", text: "Queued" } } } },
  ] } as any);
  ingestCanvasResponse({ briefId: "brief-stale", userId: "u1", canWrite: true, proposedBy: "hermes", requestId: "req-stale-b" }, { reply: "", patches_applied: [], patch_errors: [], canvas_actions: [
    { kind: "primitive_surface.create", payload: { node_id: "auto", title: "Auto", confidence: "High", rationale: "auto", surface_spec: { root: { p: "text", text: "Auto" } } } },
  ] } as any);
  assert.throws(() => approveProposal({ briefId: "brief-stale", userId: "u1", canWrite: true, proposedBy: "user" }, queued.proposal_ids[0]), /proposal_version_stale/);
});


test("capability.propose writes capability row only", () => {
  seedBrief("brief-cap");
  const proposal = {
    id: "cap-1",
    proposed_widget_kind: "relationship_radar",
    rationale: "Needs a new visual",
    data_schema: { type: "object" },
    ts_renderer_source: "export function Widget(){ return null }",
    example_data: {},
    primitive_fallback: { root: { p: "text", text: "Fallback" } },
    evidence: [],
    proposed_at: new Date().toISOString(),
    proposed_by: { kind: "hermes" },
  };
  ingestCanvasResponse({ briefId: "brief-cap", userId: "u1", canWrite: true, proposedBy: "hermes", requestId: "req-3" }, { reply: "", patches_applied: [], patch_errors: [], canvas_actions: [{ kind: "capability.propose", payload: proposal }] } as any);
  assert.equal(listCapabilityProposals({ briefId: "brief-cap" }).length, 1);
  assert.equal(listProposals({ briefId: "brief-cap" }).length, 0);
  assert.equal(getCurrentCanvasDocument("brief-cap").document.nodes.length, 0);
});


test("capability viewer endpoint is JSON-only with nosniff and browser viewer renders source in pre", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const routeSource = fs.readFileSync(path.join(__dirname, "../web/app/api/briefs/[id]/canvas-capability-proposals/[cpid]/route.ts"), "utf8");
  const pageSource = fs.readFileSync(path.join(__dirname, "../web/app/lab/canvas/capability/CapabilityProposalClient.tsx"), "utf8");
  assert.match(routeSource, /requireGenerativeCanvasRead/);
  assert.match(routeSource, /NextResponse\.json/);
  assert.match(routeSource, /X-Content-Type-Options/);
  assert.match(routeSource, /nosniff/);
  assert.match(pageSource, /<pre[\s\S]*\{proposal\.ts_renderer_source\}/);
  assert.doesNotMatch(pageSource, /dangerouslySetInnerHTML|eval\s*\(|new Function|import\(/);
});
