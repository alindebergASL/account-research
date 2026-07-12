import { NextResponse } from "next/server";

export const PROVIDER_CONCURRENCY_LIMITS = {
  global: 3,
  perKey: 1,
} as const;

export const PROVIDER_BUSY_BODY = {
  error: "Too many AI requests are already running",
} as const;

export class ProviderConcurrencyError extends Error {
  readonly status = 429;
  constructor() {
    super(PROVIDER_BUSY_BODY.error);
    this.name = "ProviderConcurrencyError";
  }
}

export class ProviderSemaphore {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly keyLimit: number,
  ) {}

  tryAcquire(key: string): (() => void) | null {
    const keyActive = this.activeByKey.get(key) ?? 0;
    if (this.active >= this.globalLimit || keyActive >= this.keyLimit) return null;
    this.active += 1;
    this.activeByKey.set(key, keyActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const remaining = (this.activeByKey.get(key) ?? 1) - 1;
      if (remaining <= 0) this.activeByKey.delete(key);
      else this.activeByKey.set(key, remaining);
    };
  }

  snapshot(): { global: number; keys: ReadonlyMap<string, number> } {
    return { global: this.active, keys: new Map(this.activeByKey) };
  }
}

const appProviderSemaphore = new ProviderSemaphore(
  PROVIDER_CONCURRENCY_LIMITS.global,
  PROVIDER_CONCURRENCY_LIMITS.perKey,
);

export function reserveProviderConcurrency(key: string): () => void {
  const release = appProviderSemaphore.tryAcquire(key);
  if (!release) throw new ProviderConcurrencyError();
  return release;
}

export async function withProviderConcurrency<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const release = reserveProviderConcurrency(key);
  try {
    return await work();
  } finally {
    release();
  }
}

export function providerConcurrencyErrorResponse(error: unknown): NextResponse | null {
  return error instanceof ProviderConcurrencyError
    ? NextResponse.json(PROVIDER_BUSY_BODY, { status: 429 })
    : null;
}
