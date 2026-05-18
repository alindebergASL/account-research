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

// Tokens that imply we have sliced into the ASK body rather than landed
// on a target. If a candidate target contains any of these, it should
// be rejected.
const ASK_VERBS = [
  "request",
  "book",
  "send",
  "share",
  "present",
  "propose",
  "schedule",
  "set up",
  "email",
  "reach out",
  "arrange",
  "prepare",
  "align",
  "sequence",
  "follow up",
  "meet",
  "confirm",
];

// Generic head-only role tokens. If the candidate is exactly one of
// these (case-insensitive, ignoring trailing punctuation), we drop it.
const GENERIC_ROLE_TOKENS = new Set([
  "VP",
  "CDO",
  "CIO",
  "CTO",
  "CISO",
  "CMIO",
  "CFO",
  "CEO",
  "COO",
  "CHRO",
  "CMO",
  "SVP",
  "EVP",
  "DIRECTOR",
  "HEAD",
  "MANAGER",
  "LEAD",
  "TEAM",
]);

function parensBalanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function containsAskVerb(s: string): boolean {
  const lower = s.toLowerCase();
  for (const v of ASK_VERBS) {
    // word-ish boundary check
    const re = new RegExp(`\\b${v.replace(/ /g, "\\s+")}\\b`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

function isGenericRole(candidate: string): boolean {
  const cleaned = candidate.trim().replace(/[.,;:!?]+$/, "");
  return GENERIC_ROLE_TOKENS.has(cleaned.toUpperCase());
}

function endsWithUnmatchedCloser(s: string): boolean {
  const last = s.trim().slice(-1);
  if (last !== ")" && last !== "]" && last !== "}") return false;
  const opener = last === ")" ? "(" : last === "]" ? "[" : "{";
  // Look backwards for an unmatched opener earlier in the candidate.
  let bal = 0;
  for (const ch of s) {
    if (ch === opener) bal++;
    else if (ch === last) bal--;
  }
  return bal < 0;
}

function validateCandidate(raw: string): string | null {
  let c = raw.trim();
  // Strip leading conjunctions if remainder still passes.
  const leadingMatch = c.match(/^(to|with|via)\s+(.+)$/i);
  if (leadingMatch) {
    const rest = leadingMatch[2].trim();
    if (rest.length >= 4) c = rest;
  }
  // Strip trailing punctuation we'd later trip on (but keep parens which
  // we test for balance below).
  c = c.replace(/[.,;:!?]+$/, "").trim();
  if (c.length < 4 || c.length > 80) return null;
  if (!parensBalanced(c)) return null;
  if (containsAskVerb(c)) return null;
  if (isGenericRole(c)) return null;
  if (endsWithUnmatchedCloser(c)) return null;
  return c;
}

function cleanupUnmatchedCloser(raw: string): string {
  // If candidate has a ')' with no '(' earlier in the candidate, strip
  // the candidate from that ')' onward.
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        return raw.slice(0, i).trim();
      }
      depth--;
    }
  }
  return raw;
}

export function extractTarget(action: ActionLike | null | undefined): string | null {
  if (!action) return null;
  if (typeof action.owner === "string" && action.owner.trim().length > 0) {
    return action.owner.trim();
  }
  const text = typeof action.recommendation === "string" ? action.recommendation : "";
  if (!text.trim()) return null;

  const candidates: string[] = [];

  // Heuristic 1: stakeholder shorthand (e.g. CMIO), optionally extended
  // by a qualifier that follows it (e.g. "VP of Digital", "CDO/CIO office").
  const stake = text.match(STAKEHOLDER_TOKEN);
  if (stake && stake[0]) {
    const idx = text.indexOf(stake[0]);
    // Grab the stake + up to ~6 trailing words to recover qualifiers like
    // "of Digital", "/CIO office", "at Tufts Medicine".
    const tail = text.slice(idx).match(
      /^([A-Z]+(?:\/[A-Z]+)?(?:\s+(?:of|for)\s+[A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})?(?:\s+(?:office|team))?(?:\s+at\s+[A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,4})?)/,
    );
    if (tail && tail[1]) {
      const extended = tail[1].trim();
      // If we have a "at <Company>" tail, strip the "at <Company>" so we
      // surface just the role+qualifier (e.g. "VP of Digital").
      const stripped = extended.replace(/\s+at\s+[A-Za-z][\w\s.&'-]*$/, "").trim();
      if (stripped && !isGenericRole(stripped)) {
        candidates.push(stripped);
      }
    }
    // Also attach a via-route variant if present.
    const via = text.match(VIA_PATTERN);
    if (via && via[1]) {
      const route = via[1].trim();
      const base = candidates[0] && !isGenericRole(candidates[0]) ? candidates[0] : stake[0];
      if (!isGenericRole(base)) {
        candidates.push(`${base} via ${route}`);
      }
    }
    // Plain stake last (likely to fail isGenericRole and be dropped).
    candidates.push(stake[0]);
  }

  // Heuristic 2: via/through phrase.
  const via = text.match(VIA_PATTERN);
  if (via && via[1]) candidates.push(via[1].trim());

  // Heuristic 3: "to <TitleCase…>".
  const to = text.match(TO_PATTERN);
  if (to && to[1]) candidates.push(to[1].trim());

  for (const raw of candidates) {
    const ok = validateCandidate(raw);
    if (ok) return ok;
  }

  // Final safety: try cleaning unmatched closing paren from the most
  // promising raw candidate (the first one).
  if (candidates.length > 0) {
    const cleaned = cleanupUnmatchedCloser(candidates[0]);
    if (cleaned && cleaned !== candidates[0]) {
      const ok = validateCandidate(cleaned);
      if (ok) return ok;
    }
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
