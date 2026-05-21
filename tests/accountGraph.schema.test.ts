import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountGraphDocument,
  AccountHierarchyReference,
  Claim,
  ConflictRecord,
  SourceDocument,
} from "../web/lib/accountGraph/schema";
import { runSpikeA } from "../web/lib/accountGraph/spikePipeline";

test("AccountHierarchyReference parses valid input", () => {
  const r = AccountHierarchyReference.safeParse({
    account_id: "acct_x",
    account_name: "X",
    scope: "enterprise",
  });
  assert.equal(r.success, true);
});

test("AccountHierarchyReference rejects invalid scope", () => {
  const r = AccountHierarchyReference.safeParse({
    account_id: "acct_x",
    account_name: "X",
    scope: "galaxy",
  });
  assert.equal(r.success, false);
});

test("SourceDocument requires sha256-shaped hash", () => {
  const r = SourceDocument.safeParse({
    id: "srcdoc_x",
    kind: "public_web",
    title: "X",
    url: "https://example.com/a",
    captured_at: "2026-05-20T00:00:00.000Z",
    content_sha256: "not-a-hash",
    content_text: "body",
    allowed: true,
    allowlist_rule: "allow_public_web",
    pii_risk: "none",
    retention: "store_full_text_lab",
  });
  assert.equal(r.success, false);
});

test("Claim accepts MEDDPICC metadata", () => {
  const r = Claim.safeParse({
    id: "claim_x",
    account_ref: { account_id: "a", account_name: "A", scope: "enterprise" },
    type: "fact",
    text: "x",
    origin: "hermes_graph_assembly",
    provenance_status: "verified",
    confidence: "high",
    freshness: "fresh",
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
    created_by: "hermes",
    meddpicc_field: "champion",
  });
  assert.equal(r.success, true);
});

test("Claim rejects invalid enum", () => {
  const r = Claim.safeParse({
    id: "claim_x",
    account_ref: { account_id: "a", account_name: "A", scope: "enterprise" },
    type: "not_a_type",
    text: "x",
    origin: "hermes_graph_assembly",
    provenance_status: "verified",
    confidence: "high",
    freshness: "fresh",
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
    created_by: "hermes",
  });
  assert.equal(r.success, false);
});

test("ConflictRecord requires at least two claim_ids", () => {
  const r = ConflictRecord.safeParse({
    id: "conflict_x",
    account_ref: { account_id: "a", account_name: "A", scope: "enterprise" },
    claim_ids: ["only_one"],
    summary: "x",
    reconciliation_status: "unresolved",
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(r.success, false);
});

test("Spike A fixture graph parses against AccountGraphDocument", () => {
  const { graph } = runSpikeA();
  const r = AccountGraphDocument.safeParse(graph);
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
});

test("AccountGraphDocument rejects missing required collections", () => {
  const r = AccountGraphDocument.safeParse({
    schema_version: 1,
    graph_id: "x",
    generated_at: "2026-05-20T00:00:00.000Z",
    account_ref: { account_id: "a", account_name: "A", scope: "enterprise" },
    // missing source_documents/claims/etc.
  });
  assert.equal(r.success, false);
});
