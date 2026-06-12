// Central model catalog for Account Research.
//
// Single source of truth for (1) which Claude model each product surface uses
// (the role constants) and (2) per-model pricing + capability metadata. Repoint
// a surface by editing its role constant here rather than hunting literals
// across call sites; bump pricing in one place.
//
// Pricing is per-million-token USD list price (verified against Anthropic docs,
// 2026-06). Cache read ≈ 0.1× input; cache write (5-min TTL) ≈ 1.25× input.
//
// Model IDs are PINNED snapshots — `claude-opus-4-7` does not silently become
// `-4-8`. Changing a role is a deliberate code change + deploy.

export type ModelPrice = {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
};

export type ModelCapabilities = {
  // The latest server-side web_search / web_fetch tools (`_20260209`, with
  // dynamic filtering) are supported. Per Anthropic docs these run on
  // Opus 4.6/4.7/4.8, Sonnet 4.6, and Fable 5 — NOT Haiku 4.5. Any surface that
  // declares web tools must use a model with this flag set (enforced by tests).
  webSearchLatest: boolean;
  // `output_config.effort` is accepted.
  effort: boolean;
};

export type ModelSpec = {
  id: string;
  price: ModelPrice;
  capabilities: ModelCapabilities;
};

function price(
  input: number,
  output: number,
): ModelPrice {
  return {
    input_per_mtok: input,
    output_per_mtok: output,
    cache_read_per_mtok: Number((input * 0.1).toFixed(4)),
    cache_write_per_mtok: Number((input * 1.25).toFixed(4)),
  };
}

export const MODELS: Record<string, ModelSpec> = {
  "claude-fable-5": {
    id: "claude-fable-5",
    price: price(10, 50),
    capabilities: { webSearchLatest: true, effort: true },
  },
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    price: price(5, 25),
    capabilities: { webSearchLatest: true, effort: true },
  },
  "claude-opus-4-7": {
    id: "claude-opus-4-7",
    price: price(5, 25),
    capabilities: { webSearchLatest: true, effort: true },
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    price: price(5, 25),
    capabilities: { webSearchLatest: true, effort: true },
  },
  "claude-opus-4-5": {
    id: "claude-opus-4-5",
    price: price(5, 25),
    capabilities: { webSearchLatest: false, effort: true },
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    price: price(3, 15),
    capabilities: { webSearchLatest: true, effort: true },
  },
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    price: price(3, 15),
    capabilities: { webSearchLatest: false, effort: false },
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    price: price(1, 5),
    capabilities: { webSearchLatest: false, effort: false },
  },
};

export const ALL_MODEL_IDS = Object.keys(MODELS);

export function modelSpec(id: string): ModelSpec | null {
  return MODELS[id] ?? null;
}

export function modelPrice(id: string): ModelPrice | null {
  return MODELS[id]?.price ?? null;
}

export function modelSupportsWebSearchLatest(id: string): boolean {
  return MODELS[id]?.capabilities.webSearchLatest ?? false;
}

// ---------------------------------------------------------------------------
// Role assignments — the model each product surface uses.
// ---------------------------------------------------------------------------

/** Quick research: single-pass snapshot, no scout, no web fetch. */
export const RESEARCH_QUICK_MODEL = "claude-sonnet-4-6";
/** Standard + Deep research main generation (heavy, web search + fetch). */
export const RESEARCH_HEAVY_MODEL = "claude-opus-4-8";
/** Source scout / triage before heavy research — uses latest web search. */
export const SOURCE_SCOUT_MODEL = "claude-sonnet-4-6";
/** Cheap no-tool JSON repair / cleanup. */
export const JSON_REPAIR_MODEL = "claude-haiku-4-5";

/** Writable + read-only brief chat (web search + local update_brief tool). */
export const BRIEF_CHAT_MODEL = "claude-sonnet-4-6";
/** Journal assistant replies (no tools). */
export const JOURNAL_MODEL = "claude-sonnet-4-6";
/** Comment AI-assist (no tools). */
export const COMMENT_MODEL = "claude-sonnet-4-6";
/** Monitor scan — web search + record_monitor_findings. */
export const MONITOR_SCAN_MODEL = "claude-sonnet-4-6";
/** Monitor triage — web search; moved off Haiku (no latest web-search support). */
export const MONITOR_TRIAGE_MODEL = "claude-sonnet-4-6";

// Fable 5 is admin/operator-only (30-day retention, no ZDR, 2× Opus 4.8 cost).
// Not wired to any end-user product role; exposed here as a named seam for the
// future admin-only strategic mode. Gate behind an explicit admin path before
// sending customer data.
export const ADMIN_STRATEGIC_MODEL = "claude-fable-5";

// Surfaces that attach the latest web_search/web_fetch tools. Tests assert
// every entry here resolves to a model with `webSearchLatest: true`, so a
// model/tool mismatch (e.g. Haiku + web_search) cannot regress in.
export const WEB_SEARCH_ROLE_MODELS = [
  RESEARCH_QUICK_MODEL,
  RESEARCH_HEAVY_MODEL,
  SOURCE_SCOUT_MODEL,
  BRIEF_CHAT_MODEL,
  MONITOR_SCAN_MODEL,
  MONITOR_TRIAGE_MODEL,
];

// ---------------------------------------------------------------------------
// Admin-only model gate.
//
// Some catalogued models carry a weaker data posture than our end-user product
// surfaces are allowed to assume. Fable 5 has 30-day retention with NO
// zero-data-retention guarantee, and ~2x Opus 4.8 cost. It must never be
// reachable from an ordinary product surface: any caller that wants to route
// account/customer data to one of these models must first clear this gate with
// an explicit, authenticated admin context that acknowledges the data posture.
//
// The CLI real-adapter seam in run-account-graph-validation.ts is the operator
// path; this gate is the product-side equivalent — the guard a product surface
// must call BEFORE selecting an admin-only model. It is PURE and FAIL-CLOSED:
// no env reads, no I/O, and it refuses unless every requirement is met.
// ---------------------------------------------------------------------------

/** Models that require an explicit admin context before any data is routed. */
export const ADMIN_ONLY_MODELS = [ADMIN_STRATEGIC_MODEL] as const;

/** True if `id` may only be used through the admin gate. */
export function modelRequiresAdmin(id: string): boolean {
  return (ADMIN_ONLY_MODELS as readonly string[]).includes(id);
}

/** Human-readable data-posture warning surfaced on every admin-gate refusal. */
export const ADMIN_MODEL_DATA_POSTURE_WARNING =
  "claude-fable-5 has 30-day retention with no zero-data-retention guarantee " +
  "and ~2x Opus 4.8 cost; do not route account/customer data to it without an " +
  "authenticated admin who has acknowledged this data posture.";

export type AdminModelContext = {
  /** The resolved caller principal is an authenticated admin/operator. */
  isAdmin: boolean;
  /**
   * The caller has explicitly acknowledged the weaker data posture of the
   * admin-only model (30-day retention, no ZDR, higher cost). Acknowledgement
   * is required even for admins so the tradeoff is a deliberate per-call act,
   * not an ambient consequence of being an admin.
   */
  acknowledgedDataPosture: boolean;
};

/**
 * Aggregated, fail-closed refusal for the admin model gate. Returns `null` when
 * the model is not admin-only (ordinary product models are always allowed) OR
 * when every admin requirement is met. Otherwise returns the full list of unmet
 * requirements as a single human-readable message.
 *
 * Pure: no env reads, no filesystem, no network. Call it BEFORE selecting the
 * model for any request that carries account data.
 */
export function collectAdminModelRefusals(
  model: string,
  ctx: AdminModelContext,
): { reasons: string[]; message: string } | null {
  if (!modelRequiresAdmin(model)) return null;

  const reasons: string[] = [];
  if (!ctx.isAdmin) {
    reasons.push(
      `${model} is admin/operator-only; caller is not an authenticated admin`,
    );
  }
  if (!ctx.acknowledgedDataPosture) {
    reasons.push(
      `${model} requires explicit acknowledgement of its data posture (30-day retention, no ZDR)`,
    );
  }

  if (reasons.length === 0) return null;
  const bulletted = reasons.map((r) => `- ${r}`).join("\n");
  const message =
    `Refusing to route to admin-only model ${model}. Unmet requirements:\n` +
    bulletted +
    "\n" +
    ADMIN_MODEL_DATA_POSTURE_WARNING;
  return { reasons, message };
}

/** Thrown by `assertAdminModelAllowed` when the gate refuses. */
export class AdminModelGateError extends Error {
  readonly reasons: string[];
  constructor(refusal: { reasons: string[]; message: string }) {
    super(refusal.message);
    this.name = "AdminModelGateError";
    this.reasons = refusal.reasons;
  }
}

/**
 * Fail-closed assertion wrapper around `collectAdminModelRefusals`. Throws an
 * `AdminModelGateError` unless `model` is permitted for the given caller
 * context. No-op for ordinary product models.
 */
export function assertAdminModelAllowed(
  model: string,
  ctx: AdminModelContext,
): void {
  const refusal = collectAdminModelRefusals(model, ctx);
  if (refusal) throw new AdminModelGateError(refusal);
}
