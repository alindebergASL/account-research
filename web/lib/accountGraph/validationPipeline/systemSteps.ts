// Phase A.7 — Task 4: system-owned orchestration of the staged pipeline.
//
// This module wires the system-owned validation steps around the
// model-owned excerpt/claim/object proposals. Adapters can ONLY reference
// SourceDocument and EvidenceExcerpt IDs the system supplied in the input;
// any other reference produces a hard-invariant violation.
//
// HARD SAFETY:
//   - Zero network. Zero provider SDKs. Zero env reads.
//   - Adapter inputs are constructed from system-provided fixture text
//     (caller-supplied). The orchestrator never fetches from URLs.
//   - All produced excerpts are run through `verifyExcerpt` from
//     `web/lib/accountGraph/excerpts.ts`; paraphrases are rejected.
//   - The full graph is then run through `validateAccountGraph` from
//     `web/lib/accountGraph/validation.ts`; that validator already enforces
//     dangling reference + verified-without-evidence + high-confidence
//     hard invariants. We mirror those into Task-4-named keys for the
//     hard-invariant report.

import {
  ClaimEvidenceProposalSchema,
  ClaimProposalSchema,
  ExcerptProposalSchema,
  ObjectProposalSchema,
  type AdapterClaimSynthesisOutput,
  type ExcerptProposal,
  type HardInvariantKey,
  type HardInvariantViolation,
  type ModelAdapter,
  type PerAccountAdapterRun,
  type SystemProvidedExcerpt,
  type SystemProvidedSourceChunk,
} from "./types";
import type {
  AccountGraphDocument,
  AccountHierarchyReference,
  EvidenceExcerpt,
  SourceDocument,
} from "../schema";
import { verifyExcerpt } from "../excerpts";
import { validateAccountGraph } from "../validation";
import {
  budgetExceeded,
  canAffordNextCall,
  recordCost,
  remainingBudget,
  type BudgetState,
} from "./budget";

export type AdapterAccountInput = {
  account_id: string;
  account_ref: AccountHierarchyReference;
  source_documents: SourceDocument[];
};

export type RunAccountResult = {
  per_account: PerAccountAdapterRun;
  graph: AccountGraphDocument | null;
  /** True if the orchestrator stopped before finishing this account because
   *  the next adapter call would have exceeded budget. */
  budget_stopped: boolean;
};

/**
 * Run the system-owned pipeline for a single account using the supplied
 * adapter. The adapter is invoked through the `ModelAdapter` seam only;
 * the system retains ID assignment, excerpt verification, and graph build.
 */
export async function runAccountThroughAdapter(
  input: AdapterAccountInput,
  adapter: ModelAdapter,
  budget: BudgetState,
  now: Date,
): Promise<RunAccountResult> {
  const violations: HardInvariantViolation[] = [];
  const notes: string[] = [];

  // System-provided chunks. Adapter sees source IDs the system assigned.
  const chunks: SystemProvidedSourceChunk[] = input.source_documents.map(
    (s, i) => ({
      source_document_id: s.id,
      source_text: s.content_text,
      chunk_index: i,
    }),
  );
  const knownSourceIds = new Set(input.source_documents.map((s) => s.id));

  // -- Step 1: excerpt proposal --

  // Worst-case per-call cost guard: if the budget already cannot afford a
  // hypothetical $0 call (i.e. we're at the cap), refuse.
  if (budgetExceeded(budget) || !canAffordNextCall(budget, 0)) {
    return {
      per_account: {
        account_id: input.account_id,
        classification: "skipped_budget_exceeded",
        hard_invariant_violations: violations,
        excerpt_proposals: 0,
        accepted_excerpts: 0,
        claim_proposals: 0,
        object_proposals: 0,
        observed_usd: 0,
        notes: ["budget already exceeded before account started"],
      },
      graph: null,
      budget_stopped: true,
    };
  }

  let excerptProposals: ExcerptProposal[] = [];
  const proposeResult = await adapter.proposeExcerpts(
    { account_id: input.account_id, chunks },
    {
      account_id: input.account_id,
      remaining_budget_usd: remainingBudget(budget),
    },
  );
  recordCost(budget, adapter, proposeResult.cost);
  // Schema-validate adapter output. A failing parse is a hard invariant
  // (`schema_parse`).
  const proposalArrayParse = ExcerptProposalSchema.array().safeParse(
    proposeResult.output,
  );
  if (!proposalArrayParse.success) {
    violations.push({
      key: "schema_parse",
      detail: `excerpt proposals failed schema parse: ${proposalArrayParse.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    });
  } else {
    excerptProposals = proposalArrayParse.data;
  }

  // -- Step 2: system-owned excerpt verification & ID assignment --

  const acceptedExcerpts: SystemProvidedExcerpt[] = [];
  const evidenceExcerpts: EvidenceExcerpt[] = [];
  const sourceById = new Map(input.source_documents.map((s) => [s.id, s]));

  let excerptCounter = 0;
  for (const prop of excerptProposals) {
    // Hard invariant: invented SourceDocument ID.
    if (!knownSourceIds.has(prop.source_document_id)) {
      violations.push({
        key: "invented_source_document_ids",
        detail: `adapter cited source ${prop.source_document_id} not in system-provided inputs`,
      });
      continue;
    }
    // Build a candidate EvidenceExcerpt to run through `verifyExcerpt`. The
    // ID is system-assigned.
    const candidateId = `ex_${input.account_id}_${excerptCounter++}`;
    const candidate: EvidenceExcerpt = {
      id: candidateId,
      source_document_id: prop.source_document_id,
      text: prop.text,
      char_start: prop.char_start,
      char_end: prop.char_end,
      extraction_method: "model_suggested_verified",
      captured_at: now.toISOString(),
      metadata: {},
    };
    const src = sourceById.get(prop.source_document_id)!;
    const verifyResult = verifyExcerpt(candidate, src);
    if (!verifyResult.ok) {
      if (verifyResult.reason === "paraphrase_not_found_in_source") {
        violations.push({
          key: "accepted_paraphrases",
          detail: `adapter proposed a paraphrase not found in source ${prop.source_document_id}: "${prop.text.slice(0, 60)}"`,
        });
      } else if (
        verifyResult.reason === "exact_mismatch" ||
        verifyResult.reason === "normalized_mismatch" ||
        verifyResult.reason === "offsets_out_of_range" ||
        verifyResult.reason === "offsets_invalid" ||
        verifyResult.reason === "text_too_short" ||
        verifyResult.reason === "missing_source"
      ) {
        // Excerpts that fail verification do not enter the accepted set.
        // A failed verification with text actually present in source but
        // mis-offset is recorded as a paraphrase-class violation only when
        // the text cannot be located at all. Otherwise it's an excerpt
        // verification failure surfaced through `validateAccountGraph`.
        // We do not push a synthetic excerpt into the graph; this means
        // the adapter's proposal silently fails verification — which is
        // *the correct safe outcome* (no false-verified provenance).
        notes.push(
          `dropped excerpt proposal (reason=${verifyResult.reason}) for source ${prop.source_document_id}`,
        );
      }
      continue;
    }
    evidenceExcerpts.push(candidate);
    acceptedExcerpts.push({
      evidence_excerpt_id: candidateId,
      source_document_id: prop.source_document_id,
      text: prop.text,
    });
  }

  // -- Step 3: claim/object synthesis (only if there is *something* to feed) --

  let synthesis: AdapterClaimSynthesisOutput = { claims: [], objects: [] };
  if (canAffordNextCall(budget, 0) && !budgetExceeded(budget)) {
    const synthResult = await adapter.synthesizeClaims(
      { account_id: input.account_id, accepted_excerpts: acceptedExcerpts },
      {
        account_id: input.account_id,
        remaining_budget_usd: remainingBudget(budget),
      },
    );
    recordCost(budget, adapter, synthResult.cost);
    const claimsParse = ClaimProposalSchema.array().safeParse(
      synthResult.output.claims,
    );
    const objectsParse = ObjectProposalSchema.array().safeParse(
      synthResult.output.objects,
    );
    if (!claimsParse.success) {
      violations.push({
        key: "schema_parse",
        detail: `claim proposals failed schema parse: ${claimsParse.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      });
    }
    if (!objectsParse.success) {
      violations.push({
        key: "schema_parse",
        detail: `object proposals failed schema parse: ${objectsParse.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      });
    }
    synthesis = {
      claims: claimsParse.success ? claimsParse.data : [],
      objects: objectsParse.success ? objectsParse.data : [],
    };
    // Also schema-check each claim's evidence sub-array (already done via
    // ClaimProposalSchema, but we keep the explicit defensive parse for
    // future divergence).
    for (const c of synthesis.claims) {
      const evParse = ClaimEvidenceProposalSchema.array().safeParse(c.evidence);
      if (!evParse.success) {
        violations.push({
          key: "schema_parse",
          detail: `claim evidence failed schema parse: ${evParse.error.issues
            .map((i) => i.message)
            .join("; ")}`,
        });
      }
    }
  } else {
    notes.push("synthesis skipped: budget exhausted after excerpt step");
  }

  // -- Step 4: system-owned graph assembly --

  const knownExcerptIds = new Set(acceptedExcerpts.map((e) => e.evidence_excerpt_id));
  const graphClaims: AccountGraphDocument["claims"] = [];
  const graphClaimEvidence: AccountGraphDocument["claim_evidence"] = [];

  // Map claim proposals to system-assigned claim IDs. Reject any evidence
  // reference to an EvidenceExcerpt the system did not produce.
  let claimCounter = 0;
  const claimIdByIndex = new Map<number, string>();
  synthesis.claims.forEach((c, idx) => {
    const claimId = `cl_${input.account_id}_${claimCounter++}`;
    claimIdByIndex.set(idx, claimId);

    // Check evidence refs.
    let danglingForThisClaim = false;
    for (const ev of c.evidence) {
      if (!knownExcerptIds.has(ev.evidence_excerpt_id)) {
        violations.push({
          key: "invented_evidence_excerpt_ids",
          detail: `claim_${idx} cites unknown evidence_excerpt_id ${ev.evidence_excerpt_id}`,
        });
        danglingForThisClaim = true;
      }
    }
    // We still emit the claim, but evidence rows referencing unknown
    // excerpts are dropped from the graph so `validateAccountGraph`
    // doesn't double-report dangling_claim_evidence. We've already
    // recorded the invented-ID violation above.
    const supportingEv = c.evidence.filter((ev) =>
      knownExcerptIds.has(ev.evidence_excerpt_id),
    );

    graphClaims.push({
      id: claimId,
      account_ref: input.account_ref,
      type: c.type,
      text: c.text,
      origin: "research_pipeline",
      provenance_status: c.provenance_status,
      status: "proposed",
      confidence: c.confidence,
      freshness: "fresh",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      created_by: "system",
      tags: [],
      metadata: {},
    });
    supportingEv.forEach((ev, eidx) => {
      graphClaimEvidence.push({
        id: `ce_${input.account_id}_${claimCounter - 1}_${eidx}`,
        claim_id: claimId,
        evidence_excerpt_id: ev.evidence_excerpt_id,
        role: ev.role,
        strength: ev.strength,
        rationale: ev.rationale,
      });
    });
    if (danglingForThisClaim) notes.push(`dropped invented-evidence links for claim_${idx}`);
  });

  // Map object proposals.
  const graphObjects: AccountGraphDocument["account_objects"] = [];
  synthesis.objects.forEach((o, idx) => {
    const claimIds: string[] = [];
    for (const ci of o.claim_proposal_indices) {
      const cid = claimIdByIndex.get(ci);
      if (cid) claimIds.push(cid);
    }
    graphObjects.push({
      id: `obj_${input.account_id}_${idx}`,
      account_ref: input.account_ref,
      type: o.type,
      title: o.title,
      body: o.body,
      status: "proposed",
      claim_ids: claimIds,
      origin: "research_pipeline",
      provenance_status: o.provenance_status,
      confidence: o.confidence,
      freshness: "fresh",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      created_by: "system",
      object_data: {},
      metadata: {},
    });
  });

  // -- Step 5: full graph validation --

  const graph: AccountGraphDocument = {
    schema_version: 1,
    graph_id: `graph_${input.account_id}_${now.toISOString()}`,
    generated_at: now.toISOString(),
    account_ref: input.account_ref,
    source_documents: input.source_documents,
    evidence_excerpts: evidenceExcerpts,
    claims: graphClaims,
    claim_evidence: graphClaimEvidence,
    account_objects: graphObjects,
    edges: [],
    conflicts: [],
    metadata: {},
  };

  const validation = validateAccountGraph(graph);

  // Map validator errors → Task 4 hard-invariant keys.
  for (const err of validation.errors) {
    const mapped = mapValidatorErrorToInvariant(err.code);
    if (mapped) violations.push({ key: mapped, detail: err.message });
  }

  const adapterObserved = sumAdapterObserved(budget, adapter.name);
  const classification: PerAccountAdapterRun["classification"] = budgetExceeded(
    budget,
  )
    ? "budget_exceeded"
    : violations.length > 0
    ? "fail"
    : "pass";

  return {
    per_account: {
      account_id: input.account_id,
      classification,
      hard_invariant_violations: violations,
      excerpt_proposals: excerptProposals.length,
      accepted_excerpts: acceptedExcerpts.length,
      claim_proposals: synthesis.claims.length,
      object_proposals: synthesis.objects.length,
      observed_usd: adapterObserved,
      notes,
    },
    graph,
    budget_stopped: budgetExceeded(budget),
  };
}

function mapValidatorErrorToInvariant(code: string): HardInvariantKey | null {
  switch (code) {
    case "zod_parse_error":
      return "schema_parse";
    case "invented_source_reference":
      return "invented_source_document_ids";
    case "invented_excerpt_reference":
      return "dangling_claim_evidence";
    case "invented_claim_reference":
      return "referential_integrity";
    case "duplicate_id":
      return "referential_integrity";
    case "verified_without_evidence":
    case "verified_from_legacy_brief_only":
    case "disallowed_source_supports_verified_claim":
      return "verified_high_claims_without_accepted_excerpts";
    case "high_confidence_without_strong_evidence":
      return "verified_high_claims_without_accepted_excerpts";
    case "excerpt_verification_failed":
      return "accepted_paraphrases";
    case "edge_missing_endpoint":
      return "referential_integrity";
    default:
      return null;
  }
}

function sumAdapterObserved(state: BudgetState, adapterName: string): number {
  return state.by_adapter.get(adapterName)?.observed_usd ?? 0;
}
