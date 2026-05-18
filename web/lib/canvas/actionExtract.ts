// Pure, deterministic heuristics that extract scannable substructure
// from a recommendation action. Used by the executive Recommended Move
// tile to render a tight Timing / Target / Ask / Why now / Expected
// outcome stack instead of one dense paragraph.
//
// Hard rules:
//  - React-free. No model calls. No fabrication.
//  - If a heuristic does not match, return null and the caller must
//    omit the row entirely.
//  - Operates on raw strings; safe to call with empty or undefined
//    inputs (treated as no-match).

export type ActionLike = {
  recommendation?: string;
  owner?: string;
};

// Order matters: longer / more specific phrases first so they win the
// race against generic single-word matches like "today".
const TIMING_PATTERNS: RegExp[] = [
  /\bbefore end of (?:the )?quarter\b/i,
  /\bby end of (?:the )?quarter\b/i,
  /\bbefore end of (?:the )?week\b/i,
  /\bbefore end of (?:the )?month\b/i,
  /\bthis quarter\b/i,
  /\bthis week\b/i,
  /\bthis month\b/i,
  /\bnext quarter\b/i,
  /\bnext week\b/i,
  /\bnext month\b/i,
  /\bwithin\s+\d+\s+(?:day|days|week|weeks|month|months)\b/i,
  /\bin\s+\d+\s+(?:day|days|week|weeks|month|months)\b/i,
  /\bbefore\s+[A-Z][a-zA-Z]+(?:\s+\d{1,2})?\b/,
  /\btoday\b/i,
  /\btomorrow\b/i,
];

function normalizeTimingMatch(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return cleaned;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function extractTiming(text: string | undefined | null): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  for (const pat of TIMING_PATTERNS) {
    const m = trimmed.match(pat);
    if (m && m[0]) return normalizeTimingMatch(m[0]);
  }
  return null;
}

// Stakeholder shorthands worth surfacing even when they aren't TitleCase
// (CMIO / CMO / CIO / CTO / CFO / CISO / VP / SVP / EVP).
const STAKEHOLDER_TOKEN = /\b(?:CMIO|CMO|CIO|CTO|CFO|CISO|COO|CEO|CDO|CSO|SVP|EVP|VP)\b/;

// Looks for "via …" / "through …" / "to <something>" pathway phrases.
const VIA_PATTERN = /\b(?:via|through)\s+([^.;]+?)(?=[.;]|$)/i;
const TO_PATTERN = /\bto\s+(?:the\s+)?([A-Z][^.;]*?)(?=[.;]|$)/;

export function extractTarget(action: ActionLike | null | undefined): string | null {
  if (!action) return null;
  if (typeof action.owner === "string" && action.owner.trim().length > 0) {
    return action.owner.trim();
  }
  const text = typeof action.recommendation === "string" ? action.recommendation : "";
  if (!text.trim()) return null;

  // Prefer recognised stakeholder shorthand (e.g. CMIO) when present.
  const stake = text.match(STAKEHOLDER_TOKEN);
  if (stake && stake[0]) {
    // If there's also a "via …" route, attach it so the cell reads
    // "CMIO via warm intro from …" rather than dropping the pathway.
    const via = text.match(VIA_PATTERN);
    if (via && via[1]) {
      return `${stake[0]} via ${via[1].trim()}`;
    }
    return stake[0];
  }

  const via = text.match(VIA_PATTERN);
  if (via && via[1]) {
    return via[1].trim();
  }

  const to = text.match(TO_PATTERN);
  if (to && to[1]) {
    return to[1].trim();
  }

  return null;
}

// Truncate the brief.next_action body for the cockpit pointer cell so
// the cockpit stays a status strip, not a duplicate of the Recommended
// Move card.
export function truncateForPointer(text: string, max = 80): string {
  const trimmed = (text ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "";
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd().replace(/[,:;—-]+$/, "") + "…";
}
