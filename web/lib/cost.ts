// Per-million-token prices in USD. Override via env at boot if Anthropic
// pricing shifts (RESEARCH_PRICE_<MODEL_ID>_INPUT, _OUTPUT, _CACHE_READ,
// _CACHE_WRITE). Unknown models return null cost — never a wrong number.

import { modelPrice, type ModelPrice } from "./models";

export type StageUsage = {
  name: string;
  model: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type AggregateUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

type Price = ModelPrice;

const warned = new Set<string>();

function envOverride(model: string): Partial<Price> {
  const k = model.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  const num = (s: string | undefined) =>
    s !== undefined && s !== "" ? Number(s) : undefined;
  return {
    input_per_mtok: num(process.env[`RESEARCH_PRICE_${k}_INPUT`]),
    output_per_mtok: num(process.env[`RESEARCH_PRICE_${k}_OUTPUT`]),
    cache_read_per_mtok: num(process.env[`RESEARCH_PRICE_${k}_CACHE_READ`]),
    cache_write_per_mtok: num(process.env[`RESEARCH_PRICE_${k}_CACHE_WRITE`]),
  };
}

function priceFor(model: string): Price | null {
  const base = modelPrice(model);
  if (!base) {
    if (!warned.has(model)) {
      // eslint-disable-next-line no-console
      console.warn(`[cost] unknown model — cost will be null model=${model}`);
      warned.add(model);
    }
    return null;
  }
  const ovr = envOverride(model);
  return {
    input_per_mtok: ovr.input_per_mtok ?? base.input_per_mtok,
    output_per_mtok: ovr.output_per_mtok ?? base.output_per_mtok,
    cache_read_per_mtok: ovr.cache_read_per_mtok ?? base.cache_read_per_mtok,
    cache_write_per_mtok: ovr.cache_write_per_mtok ?? base.cache_write_per_mtok,
  };
}

export function estimateAnthropicCostCents(
  stages: StageUsage[],
): number | null {
  let totalCents = 0;
  for (const s of stages) {
    const p = priceFor(s.model);
    if (!p) return null;
    const u = s.usage;
    const dollars =
      ((u.input_tokens ?? 0) * p.input_per_mtok +
        (u.output_tokens ?? 0) * p.output_per_mtok +
        (u.cache_read_input_tokens ?? 0) * p.cache_read_per_mtok +
        (u.cache_creation_input_tokens ?? 0) * p.cache_write_per_mtok) /
      1_000_000;
    totalCents += dollars * 100;
  }
  return Math.round(totalCents);
}

export function aggregateUsage(stages: StageUsage[]): AggregateUsage {
  const total: AggregateUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for (const s of stages) {
    total.input_tokens += s.usage.input_tokens ?? 0;
    total.output_tokens += s.usage.output_tokens ?? 0;
    total.cache_read_input_tokens += s.usage.cache_read_input_tokens ?? 0;
    total.cache_creation_input_tokens +=
      s.usage.cache_creation_input_tokens ?? 0;
  }
  return total;
}
