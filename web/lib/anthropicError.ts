import Anthropic from "@anthropic-ai/sdk";

// Maps raw Anthropic SDK / API errors to a short, user-safe message.
// `label` names the surface (e.g. "Journal assistant") so the out-of-credits
// copy reads naturally. Mirrors the inline friendlyError() helpers in the
// chat and comments routes; new surfaces should import this instead of
// re-implementing the same checks.
export function friendlyAnthropicError(err: unknown, label = "Request"): string {
  const msg = String((err as any)?.message ?? err ?? "");
  if (/credit balance/i.test(msg) && /too low|insufficient/i.test(msg)) {
    return `${label} is temporarily unavailable — the Anthropic account is out of credits. Top up at https://console.anthropic.com/billing and try again.`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Anthropic rate limit reached — please retry in a moment.";
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return "Server is misconfigured (invalid Anthropic API key).";
  }
  return msg || `${label} failed`;
}
