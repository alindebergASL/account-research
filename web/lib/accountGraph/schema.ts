// Phase A.5 — Evidence Object Graph Spike
// Zod schemas for the evidence-first AccountObject graph. Schemas only — no
// network, no model calls, no production migration. See
// docs/plans/2026-05-20-phase-a5-evidence-object-graph-spike-spec.md.

import { z } from "zod";

// ---------- Account hierarchy reference ----------

export const AccountHierarchyReference = z.object({
  account_id: z.string().min(1),
  account_name: z.string().min(1),
  parent_account_id: z.string().min(1).nullable().optional(),
  scope: z.enum([
    "enterprise",
    "parent",
    "subsidiary",
    "division",
    "department",
    "site",
    "program",
    "unknown",
  ]),
  scope_note: z.string().optional(),
});
export type AccountHierarchyReference = z.infer<typeof AccountHierarchyReference>;

// ---------- SourceDocument ----------

export const SourceKind = z.enum([
  "public_web",
  "public_news",
  "public_filing",
  "public_procurement",
  "public_job_posting",
  "public_social",
  "official_site",
  "internal_note",
  "call_transcript",
  "third_party_intent",
  "crm_record",
  "unknown",
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceRetention = z.enum([
  "store_excerpt_only",
  "store_full_text_lab",
  "store_full_text_allowed",
  "do_not_store",
]);
export type SourceRetention = z.infer<typeof SourceRetention>;

export const PiiRisk = z.enum(["none", "low", "medium", "high", "unknown"]);
export type PiiRisk = z.infer<typeof PiiRisk>;

export const SourceDocument = z.object({
  id: z.string().min(1),
  kind: SourceKind,
  title: z.string().min(1),
  url: z.string().url().nullable(),
  publisher: z.string().nullable().optional(),
  captured_at: z.string().datetime(),
  published_at: z.string().datetime().nullable().optional(),
  fetched_at: z.string().datetime().nullable().optional(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_text: z.string().min(1),
  allowed: z.boolean(),
  allowlist_rule: z.string().min(1),
  pii_risk: PiiRisk,
  retention: SourceRetention,
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SourceDocument = z.infer<typeof SourceDocument>;

// ---------- EvidenceExcerpt ----------

export const ExtractionMethod = z.enum([
  "exact_span",
  "normalized_span",
  "model_suggested_verified",
  "manual",
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethod>;

export const EvidenceExcerpt = z.object({
  id: z.string().min(1),
  source_document_id: z.string().min(1),
  text: z.string().min(20),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().positive(),
  extraction_method: ExtractionMethod,
  captured_at: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EvidenceExcerpt = z.infer<typeof EvidenceExcerpt>;

// ---------- Claim ----------

export const ClaimType = z.enum([
  "fact",
  "inference",
  "hypothesis",
  "recommendation",
  "risk",
  "opportunity",
  "signal",
  "open_question",
]);
export type ClaimType = z.infer<typeof ClaimType>;

export const ClaimOrigin = z.enum([
  "research_pipeline",
  "hermes_graph_assembly",
  "chat_patch",
  "user_edit",
  "legacy_backfill",
  "watcher_loop",
]);
export type ClaimOrigin = z.infer<typeof ClaimOrigin>;

export const ProvenanceStatus = z.enum([
  "verified",
  "legacy_embedded_source",
  "chat_patch_object_level",
  "unverified",
  "source_unavailable",
  "contradicted",
]);
export type ProvenanceStatus = z.infer<typeof ProvenanceStatus>;

export const ClaimStatus = z.enum([
  "proposed",
  "ratified",
  "rejected",
  "superseded",
  "marked_wrong",
]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const ConfidenceLevel = z.enum(["high", "medium", "low", "unknown"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const Freshness = z.enum(["fresh", "aging", "stale", "unknown"]);
export type Freshness = z.infer<typeof Freshness>;

export const CreatedBy = z.enum(["hermes", "user", "system", "migration"]);
export type CreatedBy = z.infer<typeof CreatedBy>;

export const MeddpiccField = z.enum([
  "metrics",
  "economic_buyer",
  "decision_criteria",
  "decision_process",
  "paper_process",
  "identify_pain",
  "champion",
]);
export type MeddpiccField = z.infer<typeof MeddpiccField>;

export const Claim = z.object({
  id: z.string().min(1),
  account_ref: AccountHierarchyReference,
  type: ClaimType,
  text: z.string().min(1),
  summary: z.string().optional(),
  origin: ClaimOrigin,
  provenance_status: ProvenanceStatus,
  status: ClaimStatus.default("proposed"),
  confidence: ConfidenceLevel,
  confidence_rationale: z.string().optional(),
  freshness: Freshness,
  valid_from: z.string().datetime().nullable().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: CreatedBy,
  tags: z.array(z.string()).default([]),
  meddpicc_field: MeddpiccField.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Claim = z.infer<typeof Claim>;

// ---------- AccountObject ----------

export const AccountObjectType = z.enum([
  "account_snapshot",
  "signal",
  "stakeholder",
  "initiative",
  "risk",
  "opportunity",
  "technical_footprint",
  "procurement_program",
  "competitor",
  "recommended_action",
  "open_question",
  "meddpicc_field",
]);
export type AccountObjectType = z.infer<typeof AccountObjectType>;

export const AccountObjectStatus = z.enum([
  "proposed",
  "ratified",
  "rejected",
  "superseded",
  "marked_wrong",
]);
export type AccountObjectStatus = z.infer<typeof AccountObjectStatus>;

export const AccountObject = z.object({
  id: z.string().min(1),
  account_ref: AccountHierarchyReference,
  type: AccountObjectType,
  title: z.string().min(1),
  body: z.string().optional(),
  status: AccountObjectStatus.default("proposed"),
  claim_ids: z.array(z.string()).default([]),
  origin: ClaimOrigin,
  provenance_status: ProvenanceStatus,
  confidence: ConfidenceLevel,
  freshness: Freshness,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: CreatedBy,
  object_data: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AccountObject = z.infer<typeof AccountObject>;

// ---------- ClaimEvidence ----------

export const ClaimEvidenceRole = z.enum([
  "supports",
  "partially_supports",
  "contradicts",
  "context",
]);
export type ClaimEvidenceRole = z.infer<typeof ClaimEvidenceRole>;

export const ClaimEvidenceStrength = z.enum(["strong", "medium", "weak"]);
export type ClaimEvidenceStrength = z.infer<typeof ClaimEvidenceStrength>;

export const ClaimEvidence = z.object({
  id: z.string().min(1),
  claim_id: z.string().min(1),
  evidence_excerpt_id: z.string().min(1),
  role: ClaimEvidenceRole,
  strength: ClaimEvidenceStrength,
  rationale: z.string().min(1),
});
export type ClaimEvidence = z.infer<typeof ClaimEvidence>;

// ---------- GraphEdge ----------

export const GraphEdgeKind = z.enum([
  "evidences",
  "relates_to",
  "contradicts",
  "supports",
  "supersedes",
  "derived_from",
]);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKind>;

export const GraphNodeKind = z.enum([
  "claim",
  "account_object",
  "source_document",
  "evidence_excerpt",
]);
export type GraphNodeKind = z.infer<typeof GraphNodeKind>;

export const GraphEdge = z.object({
  id: z.string().min(1),
  from_id: z.string().min(1),
  from_type: GraphNodeKind,
  to_id: z.string().min(1),
  to_type: GraphNodeKind,
  kind: GraphEdgeKind,
  rationale: z.string().optional(),
  created_at: z.string().datetime(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

// ---------- ConflictRecord ----------

export const ConflictRecord = z.object({
  id: z.string().min(1),
  account_ref: AccountHierarchyReference,
  claim_ids: z.array(z.string()).min(2),
  summary: z.string().min(1),
  reconciliation_status: z.enum([
    "unresolved",
    "reconciled",
    "user_resolved",
    "dismissed",
  ]),
  current_resolution: z.string().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ConflictRecord = z.infer<typeof ConflictRecord>;

// ---------- AccountGraphDocument ----------

export const AccountGraphDocument = z.object({
  schema_version: z.literal(1),
  graph_id: z.string().min(1),
  generated_at: z.string().datetime(),
  account_ref: AccountHierarchyReference,
  source_documents: z.array(SourceDocument),
  evidence_excerpts: z.array(EvidenceExcerpt),
  claims: z.array(Claim),
  claim_evidence: z.array(ClaimEvidence),
  account_objects: z.array(AccountObject),
  edges: z.array(GraphEdge).default([]),
  conflicts: z.array(ConflictRecord).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AccountGraphDocument = z.infer<typeof AccountGraphDocument>;
