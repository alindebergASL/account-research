// Phase A.7 — Task 4: model-mode adapter boundary types.
//
// HARD SAFETY:
//   - This module defines the *seam* between system-owned and model-owned
//     steps. It does not import any provider SDK and must not read any
//     provider env var. It performs zero IO.
//   - Adapters can only reference SourceDocument/EvidenceExcerpt IDs the
//     system *provided in the input*. The runtime validator (see
//     `systemSteps.ts`) enforces this — the type system makes the contract
//     visible; the validator makes it enforceable against any adapter,
//     fake or otherwise.
//
// System owns: source IDs, fetch/capture, source hashes, excerpt verification
// (offset + paraphrase), referential integrity, artifact writing, budget.
// Model owns: excerpt proposal against known source IDs; claim/object
// synthesis against known SourceDocument/EvidenceExcerpt IDs.

import { z } from "zod";

// ---------- Inputs the system gives the adapter (system-owned IDs) ----------

export type SystemProvidedSourceChunk = {
  /** System-assigned source document ID. The model MUST cite this exact ID. */
  source_document_id: string;
  /** System-captured source text. Bounded per plan §3. */
  source_text: string;
  /** Optional chunk index within the source for traceability. */
  chunk_index?: number;
};

export type SystemProvidedExcerpt = {
  /** System-assigned excerpt ID assigned AFTER system-side verification. */
  evidence_excerpt_id: string;
  /** Always one of the source_document_ids in the same adapter input. */
  source_document_id: string;
  /** Verified excerpt text. */
  text: string;
};

export type AdapterExcerptProposalInput = {
  account_id: string;
  chunks: SystemProvidedSourceChunk[];
};

export type AdapterClaimSynthesisInput = {
  account_id: string;
  /** System-verified, system-ID'd excerpts. Adapter may only cite these. */
  accepted_excerpts: SystemProvidedExcerpt[];
};

// ---------- Outputs the adapter returns (proposals, not commitments) ----------

export const ExcerptProposalSchema = z.object({
  // Required: must equal one of the source IDs from input.
  source_document_id: z.string().min(1),
  text: z.string().min(1),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().positive(),
});
export type ExcerptProposal = z.infer<typeof ExcerptProposalSchema>;

export const ClaimEvidenceProposalSchema = z.object({
  // Adapter must reference an excerpt ID the system gave it.
  evidence_excerpt_id: z.string().min(1),
  role: z.enum(["supports", "partially_supports", "contradicts", "context"]),
  strength: z.enum(["strong", "medium", "weak"]),
  rationale: z.string().min(1),
});
export type ClaimEvidenceProposal = z.infer<typeof ClaimEvidenceProposalSchema>;

export const ClaimProposalSchema = z.object({
  text: z.string().min(1),
  type: z.enum([
    "fact",
    "inference",
    "hypothesis",
    "recommendation",
    "risk",
    "opportunity",
    "signal",
    "open_question",
  ]),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
  provenance_status: z.enum([
    "verified",
    "legacy_embedded_source",
    "chat_patch_object_level",
    "unverified",
    "source_unavailable",
    "contradicted",
    "source_document_only",
    "legacy_brief_json",
    "inferred_from_brief_json",
  ]),
  evidence: z.array(ClaimEvidenceProposalSchema).default([]),
});
export type ClaimProposal = z.infer<typeof ClaimProposalSchema>;

export const ObjectProposalSchema = z.object({
  type: z.enum([
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
  ]),
  title: z.string().min(1),
  body: z.string().optional(),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
  provenance_status: z.enum([
    "verified",
    "legacy_embedded_source",
    "chat_patch_object_level",
    "unverified",
    "source_unavailable",
    "contradicted",
    "source_document_only",
    "legacy_brief_json",
    "inferred_from_brief_json",
  ]),
  /** Index references into the claim proposals returned in the same call. */
  claim_proposal_indices: z.array(z.number().int().nonnegative()).default([]),
});
export type ObjectProposal = z.infer<typeof ObjectProposalSchema>;

export type AdapterClaimSynthesisOutput = {
  claims: ClaimProposal[];
  objects: ObjectProposal[];
};

// ---------- Adapter context + cost ----------

export type AdapterContext = {
  account_id: string;
  /** Hard remaining budget the orchestrator allows for this call (USD). */
  remaining_budget_usd: number;
};

export type CostObservation = {
  /** "observed" when the provider returns exact cost; "unknown_estimated"
   *  if the cost can only be estimated. Plan §6: unknown_estimated MUST NOT
   *  classify as pass. */
  status: "observed" | "unknown_estimated";
  observed_usd: number;
  estimated_usd: number | null;
  input_tokens: number;
  output_tokens: number;
};

export type AdapterCallResult<T> = {
  output: T;
  cost: CostObservation;
};

// ---------- ModelAdapter ----------
//
// Adapters MUST NOT:
//   - import provider SDKs (this PR ships only the fake deterministic one)
//   - read provider env vars
//   - call `fetch` or any network function
//   - perform filesystem writes
//
// The runtime guard for these constraints lives in the runner (model-mode
// is refused unless `--adapter fake`).

export interface ModelAdapter {
  readonly name: string;
  /** Provider label for the cost block. "fake" for the deterministic adapter. */
  readonly provider: string;
  /** Model label for the cost block. */
  readonly model: string;
  proposeExcerpts(
    input: AdapterExcerptProposalInput,
    ctx: AdapterContext,
  ): Promise<AdapterCallResult<ExcerptProposal[]>>;
  synthesizeClaims(
    input: AdapterClaimSynthesisInput,
    ctx: AdapterContext,
  ): Promise<AdapterCallResult<AdapterClaimSynthesisOutput>>;
}

// ---------- Pipeline-level result types ----------

export type HardInvariantKey =
  | "schema_parse"
  | "referential_integrity"
  | "invented_source_document_ids"
  | "invented_evidence_excerpt_ids"
  | "dangling_claim_evidence"
  | "false_verified"
  | "verified_high_claims_without_accepted_excerpts"
  | "accepted_paraphrases"
  | "production_writes"
  | "unbudgeted_model_calls"
  | "automatic_model_calls_from_tests_imports_fixture_mode";

export type HardInvariantViolation = {
  key: HardInvariantKey;
  detail: string;
};

export type AccountPipelineClassification =
  | "pass"
  | "borderline"
  | "fail"
  | "budget_exceeded"
  | "skipped_budget_exceeded";

export type PerAccountAdapterRun = {
  account_id: string;
  classification: AccountPipelineClassification;
  hard_invariant_violations: HardInvariantViolation[];
  excerpt_proposals: number;
  accepted_excerpts: number;
  claim_proposals: number;
  object_proposals: number;
  observed_usd: number;
  notes: string[];
};
