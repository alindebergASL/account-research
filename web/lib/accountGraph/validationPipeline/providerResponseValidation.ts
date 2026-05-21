// Phase A.7 — Task 7: provider response validation flow.
//
// HARD SAFETY:
//   - This module performs ZERO IO. No SDK imports, no env reads, no network.
//   - The model's text output is UNTRUSTED. We strip-then-parse JSON, then
//     Zod-validate. Invalid JSON or schema mismatch → retry ONCE with a
//     corrective framing supplied by the caller; further failures yield a
//     non-pass classification for the affected stage (system layer handles).

import { z } from "zod";

/** Try to extract a JSON value from raw model text. Tolerates a fenced code
 *  block (```json … ```) but does NOT attempt to repair invalid JSON. */
export function extractJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "empty model response" };
  }
  let text = raw.trim();
  // Strip optional code fence.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  // Strip leading commentary up to the first { or [.
  const firstBrace = text.search(/[\[{]/);
  if (firstBrace > 0) text = text.slice(firstBrace);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ValidatedResponse<T> =
  | { status: "ok"; value: T; attempts: number }
  | { status: "json_parse_failed"; lastError: string; attempts: number }
  | { status: "schema_mismatch"; lastError: string; attempts: number };

export type CallRawFn = (correction?: {
  reason: "json_parse_failed" | "schema_mismatch";
  detail: string;
}) => Promise<string>;

/**
 * Call a provider once, then RETRY ONCE with corrective framing if the raw
 * text fails JSON parse or Zod parse. Anything beyond the single retry is
 * considered a stage failure; the caller (system layer) records the
 * appropriate hard-invariant violation and preserves partial artifacts.
 */
export async function callAndValidate<T>(
  schema: z.ZodType<T>,
  call: CallRawFn,
): Promise<ValidatedResponse<T>> {
  let attempts = 0;
  let lastJsonError = "";
  let lastSchemaError = "";
  for (let i = 0; i < 2; i++) {
    attempts += 1;
    const correction =
      i === 0
        ? undefined
        : lastSchemaError
          ? { reason: "schema_mismatch" as const, detail: lastSchemaError }
          : { reason: "json_parse_failed" as const, detail: lastJsonError };
    const raw = await call(correction);
    const extracted = extractJson(raw);
    if (!extracted.ok) {
      lastJsonError = extracted.error;
      lastSchemaError = "";
      continue;
    }
    const parsed = schema.safeParse(extracted.value);
    if (parsed.success) {
      return { status: "ok", value: parsed.data, attempts };
    }
    lastSchemaError = parsed.error.issues
      .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
      .join("; ");
    lastJsonError = "";
  }
  if (lastSchemaError) {
    return { status: "schema_mismatch", lastError: lastSchemaError, attempts };
  }
  return { status: "json_parse_failed", lastError: lastJsonError, attempts };
}
