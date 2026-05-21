// Phase A.7 — Task 7: provider error classification + retry policy.
//
// HARD SAFETY:
//   - This module performs ZERO IO. It does not import any provider SDK,
//     does not read env vars, does not call fetch. It is a pure function
//     library for classifying and waiting between retries.
//   - It must NEVER be imported by fixture / fake-adapter / local-corpus
//     code paths; the runner uses it indirectly via the real adapter only.

export type ProviderErrorClass =
  | "auth"          // 401/403 — fail fast, no retry
  | "bad_request"   // 400 — fail fast, no retry
  | "rate_limited"  // 429 — retry with backoff
  | "server"        // 5xx — retry with backoff
  | "timeout"       // request timed out — retry with backoff
  | "network"       // generic network/transport error — retry with backoff
  | "unknown";      // unknown shape — fail fast, no retry

export type ClassifiedProviderError = {
  class: ProviderErrorClass;
  status: number | null;
  message: string;
  /** retry-after hint in seconds, if the provider supplied one. */
  retryAfterSec: number | null;
};

export const PROVIDER_RETRYABLE_CLASSES: ReadonlySet<ProviderErrorClass> =
  new Set<ProviderErrorClass>(["rate_limited", "server", "timeout", "network"]);

export const PROVIDER_MAX_RETRIES = 3;

/**
 * Classify a thrown provider error WITHOUT importing the provider SDK.
 * We probe shape-only (status, name, message) so this remains SDK-agnostic.
 */
export function classifyProviderError(err: unknown): ClassifiedProviderError {
  if (err && typeof err === "object") {
    const e = err as {
      status?: unknown;
      statusCode?: unknown;
      name?: unknown;
      message?: unknown;
      code?: unknown;
      headers?: { get?: (k: string) => string | null } | Record<string, string>;
    };
    const status = pickStatus(e.status, e.statusCode);
    const message = typeof e.message === "string" ? e.message : String(err);
    const retryAfterSec = pickRetryAfter(e.headers);
    if (status === 401 || status === 403) {
      return { class: "auth", status, message, retryAfterSec };
    }
    if (status === 400) {
      return { class: "bad_request", status, message, retryAfterSec };
    }
    if (status === 429) {
      return { class: "rate_limited", status, message, retryAfterSec };
    }
    if (typeof status === "number" && status >= 500 && status < 600) {
      return { class: "server", status, message, retryAfterSec };
    }
    const name = typeof e.name === "string" ? e.name : "";
    const code = typeof e.code === "string" ? e.code : "";
    if (
      /timeout/i.test(name) ||
      /timeout/i.test(message) ||
      code === "ETIMEDOUT" ||
      code === "ESOCKETTIMEDOUT"
    ) {
      return { class: "timeout", status, message, retryAfterSec };
    }
    if (
      name === "FetchError" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      /network|fetch failed/i.test(message)
    ) {
      return { class: "network", status, message, retryAfterSec };
    }
    return { class: "unknown", status, message, retryAfterSec };
  }
  return {
    class: "unknown",
    status: null,
    message: typeof err === "string" ? err : String(err),
    retryAfterSec: null,
  };
}

function pickStatus(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

function pickRetryAfter(
  headers: { get?: (k: string) => string | null } | Record<string, string> | undefined,
): number | null {
  if (!headers) return null;
  let raw: string | null | undefined;
  if (typeof (headers as { get?: (k: string) => string | null }).get === "function") {
    raw = (headers as { get: (k: string) => string | null }).get("retry-after");
  } else {
    const h = headers as Record<string, string>;
    raw = h["retry-after"] ?? h["Retry-After"];
  }
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return null;
}

/** Exponential backoff with jitter; capped. Returns milliseconds. */
export function computeBackoffMs(
  attempt: number,
  retryAfterSec: number | null,
  opts?: { baseMs?: number; capMs?: number; jitterMs?: number },
): number {
  if (retryAfterSec !== null && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, opts?.capMs ?? 30_000);
  }
  const base = opts?.baseMs ?? 500;
  const cap = opts?.capMs ?? 30_000;
  const jitter = opts?.jitterMs ?? 0;
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  return exp + Math.floor(Math.random() * (jitter + 1));
}

/**
 * RB1: a mutable accumulator threaded through retry + corrective-retry call
 * sites so the budget gate is CUMULATIVE across attempts. Every attempt
 * RESERVES its conservative pre-call estimate into `attemptedEstimatedUsd`
 * BEFORE the provider call is made. The gate then compares
 *   `remaining_budget_usd - attemptedEstimatedUsd >= nextEst`
 * which correctly refuses the Nth attempt when the cumulative reserved spend
 * would exceed the original remaining budget — even though the immutable
 * `ctx.remaining_budget_usd` snapshot has not changed during this stage.
 *
 * Why this design (vs. mutating `remaining_budget_usd`): the budget state
 * lives one layer up in BudgetState; mutating ctx mid-stage would diverge
 * from the system-owned cost roll-up which only records OBSERVED cost.
 * Reservations are conservative and per-stage; reconciliation happens when
 * the system layer eventually calls `recordCost` with the observed value.
 */
export type BudgetTally = {
  attemptedEstimatedUsd: number;
};

export function createBudgetTally(): BudgetTally {
  return { attemptedEstimatedUsd: 0 };
}

export type CallWithRetryOpts = {
  maxRetries?: number;
  /** Async sleep injection (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** RB1: budget gate evaluated BEFORE each attempt, INCLUDING the first.
   * Receives the prospective next-attempt estimate. The callee is responsible
   * for cumulating it into the tally only when the gate returns true. If it
   * returns false the call is NOT made, retries stop, and a
   * `ProviderBudgetHaltError` is thrown. */
  canAffordNext?: () => boolean;
  /** RB1: invoked AFTER `canAffordNext` returns true and BEFORE the provider
   * call is attempted. The caller uses this hook to add the conservative
   * pre-call estimate for this attempt into the cumulative `BudgetTally`,
   * so subsequent attempts see the increased reserved spend. */
  reserveAttempt?: (attempt: number) => void;
  /** Pre-attempt hook (for logging/tracing). Never used for budget gating. */
  onAttempt?: (attempt: number) => void;
};

export class ProviderRetriesExhaustedError extends Error {
  readonly classified: ClassifiedProviderError;
  readonly attempts: number;
  constructor(classified: ClassifiedProviderError, attempts: number) {
    super(
      `provider call failed after ${attempts} attempts (class=${classified.class}, status=${classified.status ?? "null"}): ${classified.message}`,
    );
    this.name = "ProviderRetriesExhaustedError";
    this.classified = classified;
    this.attempts = attempts;
  }
}

export class ProviderBudgetHaltError extends Error {
  readonly classified: ClassifiedProviderError;
  constructor(classified: ClassifiedProviderError) {
    super(
      `provider retry halted: budget exhausted before next retry (last class=${classified.class}, status=${classified.status ?? "null"})`,
    );
    this.name = "ProviderBudgetHaltError";
    this.classified = classified;
  }
}

/**
 * Run a provider call with exponential backoff on transient errors. Auth /
 * bad-request / unknown errors fail immediately. Budget-gate is consulted
 * BEFORE each retry; budget exhaustion prevents further attempts.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: CallWithRetryOpts = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? PROVIDER_MAX_RETRIES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastClassified: ClassifiedProviderError | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // RB1: reserve the conservative estimate for THIS attempt before issuing
    // it, so the gate on the NEXT iteration sees the cumulative reserved
    // spend. The first attempt is already gated by the adapter's preflight
    // check; the gate here covers retries 2..maxRetries+1.
    opts.reserveAttempt?.(attempt);
    opts.onAttempt?.(attempt);
    try {
      return await fn();
    } catch (err) {
      const classified = classifyProviderError(err);
      lastClassified = classified;
      if (!PROVIDER_RETRYABLE_CLASSES.has(classified.class)) {
        throw err;
      }
      if (attempt > maxRetries) break;
      if (opts.canAffordNext && !opts.canAffordNext()) {
        throw new ProviderBudgetHaltError(classified);
      }
      await sleep(computeBackoffMs(attempt, classified.retryAfterSec));
    }
  }
  throw new ProviderRetriesExhaustedError(lastClassified!, maxRetries + 1);
}
