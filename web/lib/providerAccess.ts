import { NextResponse } from "next/server";

export const PROVIDER_DISABLED_BODY = {
  error: "AI provider access is temporarily unavailable",
} as const;

export class ProviderAccessDisabledError extends Error {
  readonly status = 503;
  constructor() {
    super(PROVIDER_DISABLED_BODY.error);
    this.name = "ProviderAccessDisabledError";
  }
}

export function providerCallsEnabled(): boolean {
  return process.env.PROVIDER_CALLS_ENABLED === "1";
}

export function assertProviderCallsEnabled(): void {
  if (!providerCallsEnabled()) throw new ProviderAccessDisabledError();
}

export function providerAccessErrorResponse(error: unknown): NextResponse | null {
  return error instanceof ProviderAccessDisabledError
    ? NextResponse.json(PROVIDER_DISABLED_BODY, { status: 503 })
    : null;
}
