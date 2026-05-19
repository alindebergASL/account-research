// Shared Hermes string / object sanitizers.
//
// Pure helpers. No DB, no env. Used by both the write boundary
// (`appendHermesEvent` in `./events.ts`) and the read boundary
// (`stripSensitive` in the internal hermes-events route) so token /
// cookie / header redaction is consistent across both perimeters.

// Strip ANSI escape sequences ("\x1b[...m" etc.) — they're noise in a
// DB and can carry weird control bytes into log viewers.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// Token-shaped substring patterns. We replace with a constant marker so
// surrounding context remains debuggable but the secret material is
// gone. Patterns are intentionally broad; false positives are
// acceptable since this is operator-debug telemetry.
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9._\-]+/gi, replacement: "Bearer [redacted]" },
  { re: /\bsk-[A-Za-z0-9_\-]{20,}\b/g, replacement: "[redacted-api-key]" },
  // Whole-line header forms (run-of-line up to newline).
  { re: /Cookie:[^\n\r]*/gi, replacement: "Cookie: [redacted]" },
  { re: /set-cookie:[^\n\r]*/gi, replacement: "set-cookie: [redacted]" },
  { re: /authorization:[^\n\r]*/gi, replacement: "authorization: [redacted]" },
  // Inline (non-line-anchored) header forms found mid-string.
  { re: /\bcookie\s*:\s*[^\s,;]+/gi, replacement: "cookie: [redacted]" },
  { re: /\bauthorization\s*:\s*\S+/gi, replacement: "authorization: [redacted]" },
];

/** Redact token / cookie / header substrings from a single string. Pure. */
export function redactSensitiveString(s: string): string {
  let out = s.replace(ANSI_RE, "");
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
