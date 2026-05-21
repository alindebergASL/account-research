// Phase A.7 — Task 4: fake deterministic ModelAdapter.
//
// HARD SAFETY:
//   - Module import has NO side effects: no fs writes, no env reads, no
//     network, no provider SDK imports.
//   - Constructing this class is permitted; using it requires explicit
//     `--adapter fake` (test/dev only).
//   - Deterministic by construction: every output is a pure function of the
//     input. Zero randomness, zero clock reads, zero IO.
//   - Cost is hard-coded to $0 observed — this adapter never makes a
//     provider call.

import type {
  AdapterCallResult,
  AdapterClaimSynthesisInput,
  AdapterClaimSynthesisOutput,
  AdapterContext,
  AdapterExcerptProposalInput,
  ExcerptProposal,
  ModelAdapter,
} from "../types";

export type FakeDeterministicAdapterOptions = {
  /** Override: emit an extra excerpt that cites a SourceDocument ID NOT
   *  passed in. Used by hard-invariant tests only. */
  injectInventedSourceId?: string;
  /** Override: emit a claim whose evidence cites an EvidenceExcerpt ID NOT
   *  produced by the system. Used by hard-invariant tests only. */
  injectInventedExcerptId?: string;
  /** Override: emit a paraphrase that is not present in the source text. */
  injectParaphraseText?: string;
  /** Override: emit a verified/high claim with NO evidence. */
  emitVerifiedHighWithoutEvidence?: boolean;
  /** Override: emit a claim whose evidence rationale is empty (schema fail). */
  emitInvalidClaimSchema?: boolean;
  /** Override: report an observed USD cost per call (default 0). */
  costUsdPerCall?: number;
  /** Override: report cost as unknown_estimated. */
  unknownEstimatedCost?: boolean;
};

export class FakeDeterministicAdapter implements ModelAdapter {
  readonly name = "fake-deterministic";
  readonly provider = "fake";
  readonly model = "fake-v0";
  readonly options: FakeDeterministicAdapterOptions;

  constructor(options: FakeDeterministicAdapterOptions = {}) {
    this.options = options;
  }

  async proposeExcerpts(
    input: AdapterExcerptProposalInput,
    _ctx: AdapterContext,
  ): Promise<AdapterCallResult<ExcerptProposal[]>> {
    const proposals: ExcerptProposal[] = [];
    for (const chunk of input.chunks) {
      // Deterministic: propose the first 80 chars (or whole text) as an
      // exact-span excerpt.
      const end = Math.min(80, chunk.source_text.length);
      if (end >= 20) {
        proposals.push({
          source_document_id: chunk.source_document_id,
          text: chunk.source_text.slice(0, end),
          char_start: 0,
          char_end: end,
        });
      }
    }
    if (this.options.injectInventedSourceId) {
      proposals.push({
        source_document_id: this.options.injectInventedSourceId,
        text: "x".repeat(40),
        char_start: 0,
        char_end: 40,
      });
    }
    if (this.options.injectParaphraseText) {
      // Pick the first chunk's source_document_id to keep the source ID
      // known (the violation we want is "paraphrase", not "invented source").
      const sid = input.chunks[0]?.source_document_id ?? "unknown";
      proposals.push({
        source_document_id: sid,
        text: this.options.injectParaphraseText,
        char_start: 0,
        char_end: this.options.injectParaphraseText.length,
      });
    }
    return { output: proposals, cost: this.observation() };
  }

  async synthesizeClaims(
    input: AdapterClaimSynthesisInput,
    _ctx: AdapterContext,
  ): Promise<AdapterCallResult<AdapterClaimSynthesisOutput>> {
    const out: AdapterClaimSynthesisOutput = { claims: [], objects: [] };
    input.accepted_excerpts.forEach((ex) => {
      out.claims.push({
        text: `fixture claim derived from ${ex.evidence_excerpt_id}`,
        type: "fact",
        confidence: "medium",
        provenance_status: "verified",
        evidence: [
          {
            evidence_excerpt_id: ex.evidence_excerpt_id,
            role: "supports",
            strength: "medium",
            rationale: `deterministic fake rationale for ${ex.evidence_excerpt_id}`,
          },
        ],
      });
    });
    if (this.options.injectInventedExcerptId) {
      out.claims.push({
        text: `claim citing an invented excerpt`,
        type: "fact",
        confidence: "medium",
        provenance_status: "unverified",
        evidence: [
          {
            evidence_excerpt_id: this.options.injectInventedExcerptId,
            role: "supports",
            strength: "medium",
            rationale: "test-only invented excerpt id",
          },
        ],
      });
    }
    if (this.options.emitVerifiedHighWithoutEvidence) {
      out.claims.push({
        text: `verified high claim with no evidence`,
        type: "fact",
        confidence: "high",
        provenance_status: "verified",
        evidence: [],
      });
    }
    if (this.options.emitInvalidClaimSchema) {
      // Push a claim with an evidence row whose rationale is the empty
      // string — this fails ClaimEvidenceProposalSchema.
      (out.claims as unknown as object[]).push({
        text: "invalid schema claim",
        type: "fact",
        confidence: "medium",
        provenance_status: "unverified",
        evidence: [
          {
            evidence_excerpt_id: input.accepted_excerpts[0]?.evidence_excerpt_id ?? "ex_x",
            role: "supports",
            strength: "medium",
            rationale: "", // schema requires min(1)
          },
        ],
      });
    }
    return { output: out, cost: this.observation() };
  }

  private observation() {
    return {
      status: this.options.unknownEstimatedCost
        ? ("unknown_estimated" as const)
        : ("observed" as const),
      observed_usd: this.options.costUsdPerCall ?? 0,
      estimated_usd: this.options.unknownEstimatedCost
        ? (this.options.costUsdPerCall ?? 0)
        : null,
      input_tokens: 0,
      output_tokens: 0,
    };
  }
}
