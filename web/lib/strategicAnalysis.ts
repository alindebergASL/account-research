// Admin-only "strategic analysis" surface. This is the FIRST product surface
// to route to ADMIN_STRATEGIC_MODEL (Fable 5), and it exists to make the admin
// model gate load-bearing rather than latent: `runStrategicAnalysis` calls
// `assertAdminModelAllowed` as its FIRST action, so the Fable API call is
// unreachable unless the caller presents an authenticated admin context that
// has explicitly acknowledged the model's weaker data posture (30-day
// retention, no ZDR, ~2x Opus 4.8 cost).
//
// The route guard (`requireAdmin`) already rejects non-admins, but the gate is
// deliberately re-checked here at the model-selection boundary as defence in
// depth AND because the gate enforces something route auth does not: a
// per-call data-posture acknowledgement. An admin who omits the ack is still
// refused — by the gate, before any data reaches Fable.
//
// The `StrategicClient` seam lets tests inject a stub Anthropic-compatible
// client without a live API key. In production the route passes `undefined`
// and a fresh `new Anthropic()` is used (same pattern as `briefCommentsAi.ts`).

import {
  ADMIN_STRATEGIC_MODEL,
  assertAdminModelAllowed,
  type AdminModelContext,
} from "./models";
import Anthropic from "@anthropic-ai/sdk";
import { assertProviderCallsEnabled } from "./providerAccess";

// Brief JSON is hard-truncated to this many chars before being placed in the
// system prompt. Strategic analysis gets a larger window than the comments
// assist surface because it reasons over the whole brief.
export const BRIEF_INPUT_CHAR_CAP = 12_000;
export const MAX_OUTPUT_TOKENS = 2_000;
export const MAX_STRATEGIC_PROMPT_BYTES = 8 * 1024;
export const MAX_STRATEGIC_OUTPUT_BYTES = 24 * 1024;

export const STRATEGIC_SYSTEM_PROMPT = `You are a strategic analysis assistant for an internal admin reviewing a sales research brief.

You produce candid, decision-oriented strategic analysis: where the opportunity is strongest, what the risks and unknowns are, and what the team should do next. Stay grounded in the brief provided — do NOT invent facts, named people, or figures that are not present in it. When the brief lacks the information needed to answer, say so explicitly rather than guessing.

Output plain text or simple Markdown. No preamble like "Sure, here is...".`;

export type StrategicInput = {
  /** The full brief JSON the analysis reasons over. Truncated to the cap. */
  brief_json: unknown;
  /** The admin's free-text question / focus for the analysis. */
  prompt: string;
};

export type StrategicResult = {
  text: string;
  model: typeof ADMIN_STRATEGIC_MODEL;
};

// Truncate the brief JSON to the input cap. Truncation marker is appended so
// the model knows context was cut. Callers must NOT bypass this for the live
// API — it is the single place brief context is bounded.
export function truncateBriefForPrompt(briefJson: unknown): string {
  const raw = JSON.stringify(briefJson, null, 2);
  if (raw.length <= BRIEF_INPUT_CHAR_CAP) return raw;
  return raw.slice(0, BRIEF_INPUT_CHAR_CAP) + "\n…[truncated]";
}

export function buildStrategicMessages(input: StrategicInput): {
  system: string;
  user: string;
} {
  const briefStr = truncateBriefForPrompt(input.brief_json);
  const system = `${STRATEGIC_SYSTEM_PROMPT}

---
BRIEF:
${briefStr}`;
  const user = input.prompt.trim() || "Provide a strategic analysis of this account.";
  return { system, user };
}

// Minimal client shape the analysis function depends on. Lets tests inject a
// stub without pulling in a real Anthropic SDK instance.
export interface StrategicClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

// Test seam: when set, `runStrategicAnalysis` uses this client instead of a
// fresh `new Anthropic()`. Route handlers can't accept extra exports under
// Next.js' route type-check, so the seam lives here on the helper module.
let _testClient: StrategicClient | null = null;
export function __setTestStrategicClient(c: StrategicClient | null) {
  _testClient = c;
}

/**
 * Run an admin-only strategic analysis over a brief using ADMIN_STRATEGIC_MODEL.
 *
 * FAIL-CLOSED: the very first thing this does is assert the admin model gate
 * against `ctx`. If the gate refuses (caller not admin, or data posture not
 * acknowledged) it throws `AdminModelGateError` BEFORE building any prompt,
 * constructing a client, or making any network call — so no brief data can
 * reach Fable on a refused request.
 */
export async function runStrategicAnalysis(
  input: StrategicInput,
  ctx: AdminModelContext,
  client?: StrategicClient,
): Promise<StrategicResult> {
  // Load-bearing gate: must run before any client construction or I/O.
  assertAdminModelAllowed(ADMIN_STRATEGIC_MODEL, ctx);
  assertProviderCallsEnabled();

  const { system, user } = buildStrategicMessages(input);
  if (Buffer.byteLength(user, "utf8") > MAX_STRATEGIC_PROMPT_BYTES) throw new Error("Strategic prompt is too large");
  const c: StrategicClient =
    client ?? _testClient ?? (new Anthropic({ timeout: 45_000, maxRetries: 1 }) as unknown as StrategicClient);
  const response = await c.messages.create({
    model: ADMIN_STRATEGIC_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text =
    response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim() || "(no analysis)";
  if (Buffer.byteLength(text, "utf8") > MAX_STRATEGIC_OUTPUT_BYTES) throw new Error("Strategic analysis output is too large");
  return { text, model: ADMIN_STRATEGIC_MODEL };
}
