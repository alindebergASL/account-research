// Pure helpers for the Canvas visuals. Kept React-free so they can be
// imported by Node test runners without dragging in React / framer /
// lucide. The TSX visuals module (`visuals.tsx`) re-uses these.

export type ConfidenceBucket = "high" | "medium" | "low" | "na";

export type ConfidenceCounts = Record<ConfidenceBucket, number>;

// Maps a Confidence label (or anything string-ish / missing) to a bucket.
// Unknown / null inputs fall into the "na" bucket — never throws.
export function confidenceBucket(value: unknown): ConfidenceBucket {
  if (typeof value !== "string") return "na";
  const v = value.toLowerCase();
  if (v === "high") return "high";
  if (v === "medium") return "medium";
  if (v === "low") return "low";
  return "na";
}

// Counts how many items fall into each confidence bucket. The shape of
// the items array is intentionally loose — works for evidence_board
// items, brief signals, initiatives, personas, etc.
export function aggregateConfidence(
  items: ReadonlyArray<{ confidence?: unknown } | null | undefined>,
): ConfidenceCounts {
  const counts: ConfidenceCounts = { high: 0, medium: 0, low: 0, na: 0 };
  if (!Array.isArray(items)) return counts;
  for (const it of items) {
    if (!it) {
      counts.na += 1;
      continue;
    }
    counts[confidenceBucket(it.confidence)] += 1;
  }
  return counts;
}

export function totalConfidence(counts: ConfidenceCounts): number {
  return counts.high + counts.medium + counts.low + counts.na;
}

// Parses a metric `value` field. When the value looks like "N/M"
// (positive integers, max >= current), returns the parsed pair so the
// metric tile can render a gauge. Returns null for anything else —
// the tile then falls back to plain text rendering.
export function parseFractionValue(
  value: unknown,
): { current: number; max: number } | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
  if (!m) return null;
  const current = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(current) || !Number.isFinite(max)) return null;
  if (max <= 0 || current < 0) return null;
  if (current > max) return null;
  return { current, max };
}

// Maps a widget source string to a short label. Unknown / null values
// fall back to "Source" so the tile/footer never renders empty or
// throws on a legacy value.
export function sourceTypeLabel(source: unknown): string {
  if (typeof source !== "string" || source.trim() === "") return "Source";
  const v = source.trim().toLowerCase();
  switch (v) {
    case "system":
      return "System";
    case "research":
      return "Research";
    case "chat":
      return "Chat";
    case "model":
      return "Model";
    case "refresh":
      return "Refresh";
    case "hermes":
      return "Hermes";
    case "user":
      return "User";
    default:
      return "Source";
  }
}

// Returns a 0..1 weight for a confidence value, used to size bars in
// landscape-style visualizations the way BriefCanvas' InitiativeBars does.
// Unknown / null inputs fall to a small visible weight so a bar is still
// drawn (helps the eye see the row exists) but stays visually muted.
export function confidenceWeight(value: unknown): number {
  switch (confidenceBucket(value)) {
    case "high":
      return 1;
    case "medium":
      return 0.66;
    case "low":
      return 0.33;
    default:
      return 0.12;
  }
}

// Returns the tone class (used by SemanticAccent) for a given
// section_ref section_key. Falls back to "neutral" for anything the
// canvas hasn't given a dedicated palette to.
export type AccentTone = "risk" | "opportunity" | "signal" | "neutral";

export function sectionKeyTone(sectionKey: unknown): AccentTone {
  if (typeof sectionKey !== "string") return "neutral";
  switch (sectionKey) {
    case "risks":
      return "risk";
    case "competitive_signals":
      return "signal";
    case "recent_signals":
      return "signal";
    case "top_initiatives":
      return "opportunity";
    default:
      return "neutral";
  }
}
