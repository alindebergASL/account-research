// Phase A.7 — Task 4: budget / cost enforcement primitives.
//
// System-owned. The adapter cannot mutate this state directly; the runner
// records each observed cost and asks the budget tracker whether the next
// call is allowed.

import type { CostObservation } from "./types";

export type BudgetConfig = {
  /** Hard ceiling on total observed cost (USD) across the entire run. */
  max_cost_usd: number;
  /** Plan §6: any --max-cost > 25 requires explicit override. */
  allow_high_cost: boolean;
};

export type AdapterCostRollup = {
  adapter_name: string;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  observed_usd: number;
};

export type BudgetState = {
  config: BudgetConfig;
  total_observed_usd: number;
  total_estimated_usd: number;
  any_unknown_estimated: boolean;
  by_adapter: Map<string, AdapterCostRollup>;
};

export function createBudgetState(config: BudgetConfig): BudgetState {
  return {
    config,
    total_observed_usd: 0,
    total_estimated_usd: 0,
    any_unknown_estimated: false,
    by_adapter: new Map(),
  };
}

/**
 * Plan §6: per-run hard cap is 25 USD unless explicit override. Returns
 * a human-readable error string when the requested max_cost is not allowed,
 * otherwise null.
 */
export function validateBudgetConfig(config: BudgetConfig): string | null {
  if (!Number.isFinite(config.max_cost_usd) || config.max_cost_usd < 0) {
    return `--max-cost must be a non-negative number; got ${config.max_cost_usd}`;
  }
  if (config.max_cost_usd > 25 && !config.allow_high_cost) {
    return `--max-cost ${config.max_cost_usd} exceeds the per-run hard cap of 25 USD; pass --allow-high-cost to override`;
  }
  return null;
}

/**
 * Returns true if a hypothetical next call costing `worstCaseUsd` would still
 * stay within budget. Use BEFORE making a call to avoid silently exceeding
 * the cap.
 */
export function canAffordNextCall(state: BudgetState, worstCaseUsd: number): boolean {
  return state.total_observed_usd + worstCaseUsd <= state.config.max_cost_usd;
}

export function remainingBudget(state: BudgetState): number {
  return Math.max(0, state.config.max_cost_usd - state.total_observed_usd);
}

/**
 * Record a cost observation. Mutates `state`. Returns true if the observed
 * total is still within budget after the recording.
 */
export function recordCost(
  state: BudgetState,
  adapter: { name: string; provider: string; model: string },
  cost: CostObservation,
): boolean {
  state.total_observed_usd += cost.observed_usd;
  state.total_estimated_usd += cost.estimated_usd ?? 0;
  if (cost.status === "unknown_estimated") state.any_unknown_estimated = true;

  let roll = state.by_adapter.get(adapter.name);
  if (!roll) {
    roll = {
      adapter_name: adapter.name,
      provider: adapter.provider,
      model: adapter.model,
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      observed_usd: 0,
    };
    state.by_adapter.set(adapter.name, roll);
  }
  roll.calls += 1;
  roll.input_tokens += cost.input_tokens;
  roll.output_tokens += cost.output_tokens;
  roll.observed_usd += cost.observed_usd;

  return state.total_observed_usd <= state.config.max_cost_usd;
}

export function budgetExceeded(state: BudgetState): boolean {
  return state.total_observed_usd > state.config.max_cost_usd;
}

export type BudgetReportBlock = {
  status: "observed" | "unknown_estimated";
  observed_usd: number;
  estimated_usd: number | null;
  max_cost_usd: number;
  allow_high_cost: boolean;
  by_adapter: AdapterCostRollup[];
};

export function buildBudgetReportBlock(state: BudgetState): BudgetReportBlock {
  return {
    status: state.any_unknown_estimated ? "unknown_estimated" : "observed",
    observed_usd: state.total_observed_usd,
    estimated_usd: state.any_unknown_estimated ? state.total_estimated_usd : null,
    max_cost_usd: state.config.max_cost_usd,
    allow_high_cost: state.config.allow_high_cost,
    by_adapter: Array.from(state.by_adapter.values()),
  };
}
