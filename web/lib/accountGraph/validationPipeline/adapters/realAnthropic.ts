// Phase A.7 — Task 7: real Anthropic-backed ModelAdapter.
//
// HARD SAFETY:
//   - The provider SDK (`@anthropic-ai/sdk`) is imported DYNAMICALLY inside
//     `RealAnthropicAdapter.init()` ONLY. Importing this module is
//     side-effect-free: it does NOT load the SDK, does NOT read env vars,
//     does NOT call `fetch`.
//   - This module is loaded ONLY by the runner's `--adapter real` branch
//     AFTER every aggregated refusal check has passed (see
//     `web/scripts/run-account-graph-validation.ts`). The static-import
//     check in tests asserts the runner does NOT statically reference
//     `@anthropic-ai/sdk` and that this module is the only one that does.
//   - Tests inject a stub `providerClient` via `init({ providerClient })`
//     to exercise response validation, retry, budget, and error paths
//     WITHOUT loading the real SDK.
//
// A.7 graph-first writes remain BLOCKED per docs/BLOCKERS.md. This adapter
// only PROPOSES excerpts and synthesizes claim/object PROPOSALS that the
// system-side pipeline (`systemSteps.ts`) verifies.

import { z } from "zod";
import type {
  AdapterCallResult,
  AdapterClaimSynthesisInput,
  AdapterClaimSynthesisOutput,
  AdapterContext,
  AdapterExcerptProposalInput,
  CostObservation,
  CostRecordStage,
  ExcerptProposal,
  ModelAdapter,
  PerCallCostRecord,
} from "../types";
import { assertProviderCallsEnabled } from "../../../providerAccess";
import { ExcerptProposalSchema, ClaimProposalSchema, ObjectProposalSchema } from "../types";
import { callAndValidate, ProviderResponseInvalidError } from "../providerResponseValidation";
export { ProviderResponseInvalidError } from "../providerResponseValidation";
import {
  callWithRetry,
  classifyProviderError,
  createBudgetTally,
  PROVIDER_MAX_RETRIES,
} from "../providerErrors";
import {
  estimateCallCostUsd,
  lookupModelPricing,
  type ModelPricing,
} from "../budget";


export const REAL_ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

// ---------- Provider client seam ----------
//
// The adapter depends on a NARROW client surface — not on the SDK's full
// type. Tests pass a stub; production passes a thin wrapper around the
// dynamically-imported SDK. The shape mirrors Anthropic's Messages API but
// is intentionally minimal.

export type ProviderMessageContentPart = { type: "text"; text: string };

export type ProviderMessage = {
  role: "user";
  content: string | ProviderMessageContentPart[];
};

export type ProviderRequest = {
  model: string;
  system: string;
  messages: ProviderMessage[];
  max_tokens: number;
  temperature?: number;
  /** Operator-supplied; recorded but never required. */
  seed?: number;
};

export type ProviderResponse = {
  /** Concatenated text content of the assistant reply. */
  text: string;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
  };
  /** Observed cost in USD if the provider returned a priced usage block;
   *  otherwise null (the adapter then computes from PRICING_TABLE if known). */
  observed_usd?: number | null;
  /** Echo of seed actually used, if the provider exposes it. */
  seed_used?: number | null;
};

export interface ProviderClient {
  call(request: ProviderRequest): Promise<ProviderResponse>;
}

// ---------- Prompt construction (static strings; never loaded from env) ----------

const EXCERPT_SYSTEM_PROMPT =
  "You are an excerpt extraction assistant. The user supplies an account id " +
  "and one or more source chunks; each chunk has a `source_document_id` and " +
  "`source_text`. Propose excerpts that are VERBATIM spans of the supplied " +
  "source_text. Cite the exact source_document_id provided. Do NOT invent " +
  "source_document_ids. Do NOT paraphrase. Offset contract: char_start is " +
  "the zero-based index of the first character of `text` within " +
  "`source_text`; char_end is the zero-based exclusive end index immediately " +
  "after the last character of `text`. The verifier will check that " +
  "source_text.slice(char_start, char_end) MUST exactly equal text after " +
  "the same normalization. If you cannot determine exact offsets, return []. " +
  "Output ONLY a JSON array of objects with fields: source_document_id " +
  "(string), text (string, verbatim), char_start (integer >= 0), char_end " +
  "(integer > char_start). No prose, no markdown fences, JSON ONLY.";

const CLAIM_SCHEMA_CONTRACT =
  "Exact schema contract. Claim required fields: text, type, confidence, " +
  "provenance_status, evidence. Evidence object required fields: " +
  "evidence_excerpt_id, role, strength, rationale. AccountObject required " +
  "fields: type, title, confidence, provenance_status, claim_proposal_indices " +
  "(body is optional). Claim.type allowed values: fact, inference, " +
  "hypothesis, recommendation, risk, opportunity, signal, open_question. " +
  "AccountObject.type allowed values: account_snapshot, signal, stakeholder, " +
  "initiative, risk, opportunity, technical_footprint, procurement_program, " +
  "competitor, recommended_action, open_question, meddpicc_field. " +
  "confidence allowed values: high, medium, low, unknown. confidence is " +
  "epistemic certainty, not evidence lineage. Do NOT use confidence values " +
  "like verified. provenance_status allowed values: verified, " +
  "legacy_embedded_source, chat_patch_object_level, unverified, " +
  "source_unavailable, contradicted, source_document_only, legacy_brief_json, " +
  "inferred_from_brief_json. provenance_status is evidence lineage, not " +
  "certainty. Do NOT use provenance_status values like verified_with_evidence. " +
  "Evidence.role allowed values: supports, partially_supports, contradicts, " +
  "context. Evidence.strength allowed values: strong, medium, weak. Do NOT " +
  "invent domain-specific enum values such as capability, procurement_activity, " +
  "technology_usage, government_entity, person, organization, technology, or " +
  "procurement. Valid minimal example: {\"claims\":[{\"text\":\"Example " +
  "claim grounded in an accepted excerpt.\",\"type\":\"fact\",\"confidence\":\"medium\",\"provenance_status\":\"source_document_only\",\"evidence\":[{\"evidence_excerpt_id\":\"ex_1\",\"role\":\"supports\",\"strength\":\"medium\",\"rationale\":\"The accepted excerpt directly states the claim.\"}]}],\"objects\":[{\"type\":\"account_snapshot\",\"title\":\"Example snapshot\",\"confidence\":\"medium\",\"provenance_status\":\"source_document_only\",\"claim_proposal_indices\":[0]}]}.";

const CLAIM_SYSTEM_PROMPT =
  "You are a claim synthesis assistant. The user supplies an account id and " +
  "system-verified `accepted_excerpts` (each with `evidence_excerpt_id`, " +
  "`source_document_id`, `text`). Synthesize Claim and AccountObject " +
  "proposals grounded ONLY in those accepted excerpts. Every " +
  "ClaimEvidenceProposal MUST reference an `evidence_excerpt_id` from the " +
  "input. Do NOT invent excerpt ids or source ids. Verified/high-confidence " +
  "claims REQUIRE at least one supporting accepted excerpt; if a claim " +
  "cannot be grounded, mark confidence <= medium and provenance_status as " +
  "source_document_only or legacy_brief_json. " +
  CLAIM_SCHEMA_CONTRACT +
  " Output ONLY a JSON object with shape {\"claims\": [...], " +
  "\"objects\": [...]}. No prose, no markdown fences, JSON ONLY.";

const ClaimSynthesisOutputSchema = z.object({
  claims: ClaimProposalSchema.array(),
  objects: ObjectProposalSchema.array(),
});

// Rough char→token estimate. We OVERESTIMATE on uncertainty: 1 token per 3
// chars (most English text is ~4) so the pre-call budget gate refuses
// before we spend.
function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3);
}

// Worst-case output tokens we permit per call. The pre-call budget gate
// uses this to overestimate.
const MAX_OUTPUT_TOKENS_EXCERPT = 2000;
const MAX_OUTPUT_TOKENS_CLAIM = 3000;

export type RealAnthropicAdapterInit = {
  provider: string;
  model: string;
  apiKey: string;
  /** Test-only injection seam. Production omits this; init() then loads the
   *  Anthropic SDK via dynamic import. */
  providerClient?: ProviderClient;
  /** Optional override for the pricing lookup (tests). */
  pricing?: ModelPricing | null;
  /** Test-only seam for retry sleep. */
  sleep?: (ms: number) => Promise<void>;
};

export class RealAnthropicAdapter implements ModelAdapter {
  readonly name = "real-anthropic";
  readonly provider: string;
  readonly model: string;
  readonly pricing: ModelPricing | null;
  private readonly client: ProviderClient;
  private readonly sleep?: (ms: number) => Promise<void>;

  private constructor(args: {
    provider: string;
    model: string;
    pricing: ModelPricing | null;
    client: ProviderClient;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.provider = args.provider;
    this.model = args.model;
    this.pricing = args.pricing;
    this.client = args.client;
    this.sleep = args.sleep;
  }

  /**
   * Construct the adapter. If `providerClient` is supplied (tests), it is
   * used verbatim. Otherwise the Anthropic SDK is loaded via DYNAMIC import
   * — this is the ONLY place in the codebase that loads `@anthropic-ai/sdk`.
   */
  static async init(opts: RealAnthropicAdapterInit): Promise<RealAnthropicAdapter> {
    assertProviderCallsEnabled();
    const pricing = opts.pricing !== undefined ? opts.pricing : lookupModelPricing(opts.model);
    let client: ProviderClient;
    if (opts.providerClient) {
      client = opts.providerClient;
    } else {
      // Dynamic import: the SDK module is NOT in any default code path's
      // dependency graph. Fixture mode, fake-adapter mode, and the
      // local-corpus orchestrator never reach this line.
      const sdk = await import("@anthropic-ai/sdk");
      const Anthropic = (sdk as unknown as { default: new (cfg: { apiKey: string; timeout?: number; maxRetries?: number }) => unknown }).default;
      const inner = new Anthropic({ apiKey: opts.apiKey, timeout: 90_000, maxRetries: 1 }) as {
        messages: {
          create: (req: Record<string, unknown>) => Promise<{
            content?: Array<{ type: string; text?: string }>;
            usage?: { input_tokens?: number; output_tokens?: number };
          }>;
        };
      };
      client = {
        async call(req) {
          const resp = await inner.messages.create({
            model: req.model,
            system: req.system,
            messages: req.messages,
            max_tokens: req.max_tokens,
            temperature: req.temperature,
          });
          const text = (resp.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("");
          return {
            text,
            usage: {
              input_tokens: resp.usage?.input_tokens ?? null,
              output_tokens: resp.usage?.output_tokens ?? null,
            },
          };
        },
      };
    }
    return new RealAnthropicAdapter({
      provider: opts.provider,
      model: opts.model,
      pricing,
      client,
      sleep: opts.sleep,
    });
  }

  // ---------- proposeExcerpts ----------

  async proposeExcerpts(
    input: AdapterExcerptProposalInput,
    ctx: AdapterContext,
  ): Promise<AdapterCallResult<ExcerptProposal[]>> {
    const userMessage = JSON.stringify({
      account_id: input.account_id,
      chunks: input.chunks.map((c) => ({
        source_document_id: c.source_document_id,
        source_text: c.source_text,
        chunk_index: c.chunk_index,
      })),
    });
    const inputCharEstimate = EXCERPT_SYSTEM_PROMPT.length + userMessage.length;
    const inputTokensEstimate = estimateTokensFromChars(inputCharEstimate);
    const estimateUsd = estimateCallCostUsd(
      this.pricing,
      inputTokensEstimate,
      MAX_OUTPUT_TOKENS_EXCERPT,
    );
    this.preflight(estimateUsd, ctx);

    let usage: ProviderResponse["usage"] = { input_tokens: null, output_tokens: null };
    let providerObserved: number | null | undefined = null;
    let retries = 0;
    // RB1: cumulative tally of conservative pre-call reservations across
    // EVERY provider attempt for this stage (initial + provider retries +
    // corrective retry). The retry/corrective gate compares
    // `remaining_budget_usd - tally.attemptedEstimatedUsd >= nextEst`.
    const tally = createBudgetTally();

    const validated = await callAndValidate(
      ExcerptProposalSchema.array(),
      async (correction) => {
        const system = correction
          ? EXCERPT_SYSTEM_PROMPT +
            ` PRIOR RESPONSE WAS INVALID (${correction.reason}: ${correction.detail.slice(0, 240)}). Re-emit ONLY a valid JSON array; no prose; no markdown.`
          : EXCERPT_SYSTEM_PROMPT;
        const resp = await callWithRetry(
          () =>
            this.client.call({
              model: this.model,
              system,
              messages: [{ role: "user", content: userMessage }],
              max_tokens: MAX_OUTPUT_TOKENS_EXCERPT,
            }),
          {
            sleep: this.sleep,
            maxRetries: PROVIDER_MAX_RETRIES,
            // RB1: CUMULATIVE budget gate. Before each retry, ensure the
            // ALREADY-RESERVED spend plus this attempt's estimate still fits
            // within the original remaining budget. Without the tally, the
            // gate would keep saying yes to every retry against an unchanged
            // remaining-budget snapshot.
            canAffordNext: () => {
              const nextEst = estimateCallCostUsd(
                this.pricing,
                inputTokensEstimate,
                MAX_OUTPUT_TOKENS_EXCERPT,
              );
              if (nextEst === null) return false;
              return tally.attemptedEstimatedUsd + nextEst <= ctx.remaining_budget_usd;
            },
            reserveAttempt: () => {
              const est = estimateCallCostUsd(
                this.pricing,
                inputTokensEstimate,
                MAX_OUTPUT_TOKENS_EXCERPT,
              );
              if (est !== null) tally.attemptedEstimatedUsd += est;
            },
            onAttempt: (n) => { if (n > 1) retries = n - 1; },
          },
        );
        usage = resp.usage;
        providerObserved = resp.observed_usd ?? null;
        return resp.text;
      },
      {
        // RB1: the corrective retry must also count toward cumulative spend.
        canAffordCorrective: () => {
          const nextEst = estimateCallCostUsd(
            this.pricing,
            inputTokensEstimate,
            MAX_OUTPUT_TOKENS_EXCERPT,
          );
          if (nextEst === null) return false;
          return tally.attemptedEstimatedUsd + nextEst <= ctx.remaining_budget_usd;
        },
        reserveCorrective: () => {
          // Reservation for the corrective call's first inner attempt will
          // also be added by callWithRetry.reserveAttempt; we intentionally
          // do NOT double-count here. The gate above is enough; the inner
          // reserveAttempt will increment the tally exactly once for that
          // attempt before the provider call.
        },
      },
    );

    const cost = this.buildCostObservation(usage, providerObserved);
    if (validated.status !== "ok") {
      // Blocker 3: do NOT silently return []. Throw a tagged error so the
      // system layer records a per-account schema_parse violation and the
      // affected stage/account classifies non-pass.
      throw new ProviderResponseInvalidError({
        stage: "excerpt_proposal",
        reason: validated.status,
        detail: validated.lastError,
        attempts: validated.attempts,
        cost,
        partialCostRecord: this.buildCostRecord({
          account_label: input.account_id,
          stage: "excerpt_proposal",
          estimated_usd_pre_call: estimateUsd,
          cost,
          retry_count: retries,
          error: { code: validated.status, message: validated.lastError },
        }),
      });
    }
    // RB2: surface the pre-call estimate + retries to the system layer so
    // the per-call ledger row carries the real estimate, not 0.
    return {
      output: validated.value,
      cost,
      costMeta: {
        // preflight already threw when estimateUsd was null; coerce for the
        // type system. Real successful calls have a positive estimate.
        estimated_usd_pre_call: estimateUsd ?? 0,
        retry_count: retries,
        stage: "excerpt_proposal",
      },
    };
  }

  // ---------- synthesizeClaims ----------

  async synthesizeClaims(
    input: AdapterClaimSynthesisInput,
    ctx: AdapterContext,
  ): Promise<AdapterCallResult<AdapterClaimSynthesisOutput>> {
    const userMessage = JSON.stringify({
      account_id: input.account_id,
      accepted_excerpts: input.accepted_excerpts.map((e) => ({
        evidence_excerpt_id: e.evidence_excerpt_id,
        source_document_id: e.source_document_id,
        text: e.text,
      })),
    });
    const inputCharEstimate = CLAIM_SYSTEM_PROMPT.length + userMessage.length;
    const inputTokensEstimate = estimateTokensFromChars(inputCharEstimate);
    const estimateUsd = estimateCallCostUsd(
      this.pricing,
      inputTokensEstimate,
      MAX_OUTPUT_TOKENS_CLAIM,
    );
    this.preflight(estimateUsd, ctx);

    let usage: ProviderResponse["usage"] = { input_tokens: null, output_tokens: null };
    let providerObserved: number | null | undefined = null;
    let retries = 0;
    // RB1: see proposeExcerpts for the rationale of the cumulative tally.
    const tally = createBudgetTally();

    const validated = await callAndValidate(
      ClaimSynthesisOutputSchema,
      async (correction) => {
        const system = correction
          ? CLAIM_SYSTEM_PROMPT +
            ` PRIOR RESPONSE WAS INVALID (${correction.reason}: ${correction.detail.slice(0, 240)}). Re-emit ONLY a valid JSON object {claims:[],objects:[]}; no prose; no markdown.`
          : CLAIM_SYSTEM_PROMPT;
        const resp = await callWithRetry(
          () =>
            this.client.call({
              model: this.model,
              system,
              messages: [{ role: "user", content: userMessage }],
              max_tokens: MAX_OUTPUT_TOKENS_CLAIM,
            }),
          {
            sleep: this.sleep,
            maxRetries: PROVIDER_MAX_RETRIES,
            canAffordNext: () => {
              const nextEst = estimateCallCostUsd(
                this.pricing,
                inputTokensEstimate,
                MAX_OUTPUT_TOKENS_CLAIM,
              );
              if (nextEst === null) return false;
              return tally.attemptedEstimatedUsd + nextEst <= ctx.remaining_budget_usd;
            },
            reserveAttempt: () => {
              const est = estimateCallCostUsd(
                this.pricing,
                inputTokensEstimate,
                MAX_OUTPUT_TOKENS_CLAIM,
              );
              if (est !== null) tally.attemptedEstimatedUsd += est;
            },
            onAttempt: (n) => { if (n > 1) retries = n - 1; },
          },
        );
        usage = resp.usage;
        providerObserved = resp.observed_usd ?? null;
        return resp.text;
      },
      {
        canAffordCorrective: () => {
          const nextEst = estimateCallCostUsd(
            this.pricing,
            inputTokensEstimate,
            MAX_OUTPUT_TOKENS_CLAIM,
          );
          if (nextEst === null) return false;
          return tally.attemptedEstimatedUsd + nextEst <= ctx.remaining_budget_usd;
        },
        reserveCorrective: () => {
          // See proposeExcerpts: inner reserveAttempt handles the increment.
        },
      },
    );

    const cost = this.buildCostObservation(usage, providerObserved);
    if (validated.status !== "ok") {
      throw new ProviderResponseInvalidError({
        stage: "claim_synthesis",
        reason: validated.status,
        detail: validated.lastError,
        attempts: validated.attempts,
        cost,
        partialCostRecord: this.buildCostRecord({
          account_label: input.account_id,
          stage: "claim_synthesis",
          estimated_usd_pre_call: estimateUsd,
          cost,
          retry_count: retries,
          error: { code: validated.status, message: validated.lastError },
        }),
      });
    }
    const output: AdapterClaimSynthesisOutput = {
      claims: validated.value.claims.map((c) => ({
        ...c,
        evidence: c.evidence ?? [],
      })),
      objects: validated.value.objects.map((o) => ({
        ...o,
        claim_proposal_indices: o.claim_proposal_indices ?? [],
      })),
    };
    // RB2: surface the pre-call estimate + retries to the system layer.
    return {
      output,
      cost,
      costMeta: {
        // preflight already threw when estimateUsd was null; coerce for the
        // type system. Real successful calls have a positive estimate.
        estimated_usd_pre_call: estimateUsd ?? 0,
        retry_count: retries,
        stage: "claim_synthesis",
      },
    };
  }

  /**
   * Blocker 5: construct a per-call ledger record. Surface error metadata
   * when the call failed. Real-adapter calls always populate this, including
   * failure paths.
   */
  buildCostRecord(args: {
    account_label: string;
    stage: CostRecordStage;
    estimated_usd_pre_call: number | null;
    cost: CostObservation;
    retry_count: number;
    error: { code: string; message: string } | null;
  }): PerCallCostRecord {
    const cost_status: PerCallCostRecord["cost_status"] =
      args.cost.status === "observed"
        ? "observed"
        : args.error
          ? "estimated_only"
          : "unknown_estimated";
    return {
      provider: this.provider,
      model: this.model,
      account_label: args.account_label,
      stage: args.stage,
      input_tokens: args.cost.input_tokens > 0 ? args.cost.input_tokens : null,
      output_tokens: args.cost.output_tokens > 0 ? args.cost.output_tokens : null,
      estimated_usd_pre_call: args.estimated_usd_pre_call ?? 0,
      observed_usd: args.cost.observed_usd,
      cost_status,
      retry_count: args.retry_count,
      error: args.error,
    };
  }

  // ---------- internals ----------

  private preflight(estimateUsd: number | null, ctx: AdapterContext): void {
    if (estimateUsd === null) {
      // Pricing unknown — surface as unknown_estimated via the cost block,
      // but ALSO refuse the call up front: $0 is reserved for fake paths.
      throw new RealAdapterPreflightError(
        `Refusing real provider call: pricing for model ${this.model} is unknown; pre-call budget gate cannot pass. ${REAL_ADAPTER_BLOCKED_REMINDER_INLINE}`,
      );
    }
    if (estimateUsd > ctx.remaining_budget_usd) {
      throw new RealAdapterPreflightError(
        `Refusing real provider call: pre-call estimate ${estimateUsd.toFixed(4)} USD exceeds remaining budget ${ctx.remaining_budget_usd.toFixed(4)} USD. ${REAL_ADAPTER_BLOCKED_REMINDER_INLINE}`,
      );
    }
  }

  private buildCostObservation(
    usage: ProviderResponse["usage"],
    providerObserved: number | null | undefined,
  ): CostObservation {
    const input_tokens = usage.input_tokens ?? 0;
    const output_tokens = usage.output_tokens ?? 0;
    if (typeof providerObserved === "number" && Number.isFinite(providerObserved)) {
      return {
        status: "observed",
        observed_usd: providerObserved,
        estimated_usd: null,
        input_tokens,
        output_tokens,
      };
    }
    if (this.pricing && usage.input_tokens !== null && usage.output_tokens !== null) {
      const usd =
        (usage.input_tokens * this.pricing.input_usd_per_million) / 1_000_000 +
        (usage.output_tokens * this.pricing.output_usd_per_million) / 1_000_000;
      return {
        status: "observed",
        observed_usd: usd,
        estimated_usd: null,
        input_tokens,
        output_tokens,
      };
    }
    // Pricing or token usage missing — surface as unknown_estimated. NEVER
    // coerce to $0; $0 is reserved for fake/fixture paths. Blocker 6: use
    // `null` as the explicit "not zero, not knowable" sentinel.
    return {
      status: "unknown_estimated",
      observed_usd: null,
      estimated_usd: null,
      input_tokens,
      output_tokens,
    };
  }
}

const REAL_ADAPTER_BLOCKED_REMINDER_INLINE =
  "A.7 graph-first writes remain BLOCKED per docs/BLOCKERS.md.";

export class RealAdapterPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealAdapterPreflightError";
  }
}

// Re-export so tests can probe error classification without importing the
// internal modules.
export { classifyProviderError };
