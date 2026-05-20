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
const { ingestCanvasResponse, listProposals, getCurrentCanvasDocument, listCapabilityProposals, approveProposal, rejectProposal } = require("../web/lib/hermes/canvasGenerativeGateway") as typeof import("../web/lib/hermes/canvasGenerativeGateway");
const { seedReviewProposals } = require("../web/lib/hermes/canvasSeedFixtures") as typeof import("../web/lib/hermes/canvasSeedFixtures");
const { summarizeCanvasProposal, summarizeCapabilityProposal } = require("../web/lib/hermes/canvasProposalSummary") as typeof import("../web/lib/hermes/canvasProposalSummary");

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


test("seedReviewProposals creates deterministic proposals without provider calls", () => {
  seedBrief("brief-seed");
  const first = seedReviewProposals({ briefId: "brief-seed", userId: "u1", canWrite: true, proposedBy: "hermes" });
  assert.ok(first.proposal_ids.length >= 1, "should create at least one canvas proposal");
  assert.ok(first.capability_proposal_ids.length >= 1, "should create at least one capability proposal");
  const proposalsAfterFirst = listProposals({ briefId: "brief-seed" }).length;
  const capsAfterFirst = listCapabilityProposals({ briefId: "brief-seed" }).length;
  // Idempotent: re-running with same brief should not spam duplicates.
  const second = seedReviewProposals({ briefId: "brief-seed", userId: "u1", canWrite: true, proposedBy: "hermes" });
  assert.deepEqual(second.proposal_ids, first.proposal_ids);
  assert.equal(listProposals({ briefId: "brief-seed" }).length, proposalsAfterFirst);
  assert.equal(listCapabilityProposals({ briefId: "brief-seed" }).length, capsAfterFirst);
});

test("runtime route returns proposal_summaries with review-friendly shape", () => {
  seedBrief("brief-summary");
  seedReviewProposals({ briefId: "brief-summary", userId: "u1", canWrite: true, proposedBy: "hermes" });
  const current = getCurrentCanvasDocument("brief-summary");
  const proposals = listProposals({ briefId: "brief-summary" });
  const caps = listCapabilityProposals({ briefId: "brief-summary" });
  const summaries = proposals.map((p) => summarizeCanvasProposal(p, current.stateVersion));
  const capSummaries = caps.map((c) => summarizeCapabilityProposal(c, "brief-summary"));
  assert.ok(summaries.length > 0);
  for (const s of summaries) {
    assert.ok(typeof s.id === "string");
    assert.ok(typeof s.display_title === "string");
    assert.ok(typeof s.is_approvable === "boolean");
    assert.ok(typeof s.is_stale_candidate === "boolean");
  }
  assert.ok(capSummaries.length > 0);
  for (const s of capSummaries) {
    assert.ok(s.viewer_href.includes("brief-summary"));
    assert.ok(s.viewer_href.includes(s.id));
    assert.equal(typeof s.has_renderer_source, "boolean");
  }
});

test("seed route file uses requireGenerativeCanvasWrite and avoids external runtime calls", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "../web/app/api/briefs/[id]/canvas-proposals/seed/route.ts"), "utf8");
  assert.match(source, /requireGenerativeCanvasWrite/);
  assert.doesNotMatch(source, /fetch\(|HERMES_RUNTIME_URL|http:\/\/|https:\/\//);
  const helper = fs.readFileSync(path.join(__dirname, "../web/lib/hermes/canvasSeedFixtures.ts"), "utf8");
  assert.doesNotMatch(helper, /fetch\(|HERMES_RUNTIME_URL|http:\/\/|https:\/\//);
});

test("rejecting a queued proposal records decision and a second reject is a no-op", () => {
  seedBrief("brief-reject");
  const queued = ingestCanvasResponse({ briefId: "brief-reject", userId: "u1", canWrite: true, proposedBy: "hermes", requestId: "req-reject" }, { reply: "", patches_applied: [], patch_errors: [], canvas_actions: [
    { kind: "primitive_surface.create", payload: { node_id: "rej", title: "Reject me", confidence: "Low", rationale: "queued", surface_spec: { root: { p: "text", text: "Reject" } } } },
  ] } as any);
  const pid = queued.proposal_ids[0];
  rejectProposal({ briefId: "brief-reject", userId: "u1", canWrite: true, proposedBy: "user" }, pid, "lab reject");
  const row = db().prepare(`SELECT status, decided_at, decided_by, error FROM canvas_proposals WHERE id = ?`).get(pid) as any;
  assert.equal(row.status, "rejected");
  assert.ok(row.decided_at);
  assert.equal(row.decided_by, "u1");
  assert.equal(row.error, "lab reject");
  // Second reject must not crash and must not change recorded values.
  rejectProposal({ briefId: "brief-reject", userId: "u1", canWrite: true, proposedBy: "user" }, pid, "second reject");
  const row2 = db().prepare(`SELECT status, error FROM canvas_proposals WHERE id = ?`).get(pid) as any;
  assert.equal(row2.status, "rejected");
  assert.equal(row2.error, "lab reject");
});

test("approving an already-applied proposal throws proposal_not_approvable", () => {
  seedBrief("brief-double-approve");
  const queued = ingestCanvasResponse({ briefId: "brief-double-approve", userId: "u1", canWrite: true, proposedBy: "hermes", requestId: "req-da" }, { reply: "", patches_applied: [], patch_errors: [], canvas_actions: [
    { kind: "primitive_surface.create", payload: { node_id: "da", title: "Approve once", confidence: "Low", rationale: "queued", surface_spec: { root: { p: "text", text: "Approve" } } } },
  ] } as any);
  const pid = queued.proposal_ids[0];
  approveProposal({ briefId: "brief-double-approve", userId: "u1", canWrite: true, proposedBy: "user" }, pid);
  assert.throws(() => approveProposal({ briefId: "brief-double-approve", userId: "u1", canWrite: true, proposedBy: "user" }, pid), /proposal_not_approvable/);
});

test("runtime route source returns summaries and uses requireGenerativeCanvasRead", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "../web/app/api/briefs/[id]/canvas-runtime/route.ts"), "utf8");
  assert.match(source, /requireGenerativeCanvasRead/);
  assert.match(source, /proposal_summaries/);
  assert.match(source, /capability_proposal_summaries/);
});

test("lab canvas client files do not contain forbidden execution patterns", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const files = [
    "../web/app/lab/canvas/runtime/CanvasRuntimeClient.tsx",
    "../web/app/lab/canvas/capability/CapabilityProposalClient.tsx",
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, rel), "utf8");
    assert.doesNotMatch(text, /dangerouslySetInnerHTML/);
    assert.doesNotMatch(text, /\beval\s*\(/);
    assert.doesNotMatch(text, /new\s+Function\s*\(/);
    assert.doesNotMatch(text, /import\s*\(\s*[`'"][^`'"]*(?:proposal|source|payload)/);
  }
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
