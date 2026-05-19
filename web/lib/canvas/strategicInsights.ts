// Deterministic strategic insight helpers for the Canvas v2 workspace.
//
// Pure / React-free / never throws. All account-specific strings come
// from the saved Brief; the only adapter-provided strings are fixed
// labels (quadrant names, velocity labels, etc.). No live model calls,
// no network access, no schema migration.

import type { Brief } from "@/lib/schema";
import type { Confidence } from "./schema";

// ---- Strategic Signal Radar ------------------------------------------------

export type RadarQuadrantKey =
  | "strategy"
  | "tech"
  | "procurement"
  | "leadership";

export type RadarQuadrant = {
  key: RadarQuadrantKey;
  label: string;
  count: number;
  confidence?: Confidence;
  sample?: string;
};

export type StrategicSignalRadarData = {
  quadrants: RadarQuadrant[];
};

const QUADRANT_LABEL: Record<RadarQuadrantKey, string> = {
  strategy: "Strategy",
  tech: "Tech & AI",
  procurement: "Procurement",
  leadership: "Leadership",
};

// Ordered: longest / most-specific words first so two matchers don't
// double-count the same signal.
const QUADRANT_RULES: Array<{ key: RadarQuadrantKey; pattern: RegExp }> = [
  {
    key: "leadership",
    pattern:
      /\b(ceo|cio|cto|ciso|cmio|cdo|cfo|coo|cmo|chief|appointed|named|hired|hire|leadership)\b/i,
  },
  {
    key: "procurement",
    pattern:
      /\b(rfp|contract|procurement|grant|consortium|cooperative|purchasing|sourcewell|naspo|omnia|awarded|tender)\b/i,
  },
  {
    key: "tech",
    pattern:
      /\b(ai|ml|cloud|platform|data|infrastructure|digital|automation|analytics|copilot|model|llm|saas)\b/i,
  },
  {
    key: "strategy",
    pattern:
      /\b(strategy|strategic|priority|transformation|modernization|modernisation|vision|plan|roadmap|mandate)\b/i,
  },
];

// Strict ranking of confidence labels so we can "max" across signals.
const CONF_RANK: Record<Confidence, number> = {
  High: 3,
  Medium: 2,
  Low: 1,
  "Not found": 0,
};

function maxConfidence(a: Confidence | undefined, b: Confidence | undefined): Confidence | undefined {
  if (!a) return b;
  if (!b) return a;
  return CONF_RANK[a] >= CONF_RANK[b] ? a : b;
}

function pickQuadrant(text: string): RadarQuadrantKey | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  for (const rule of QUADRANT_RULES) {
    if (rule.pattern.test(text)) return rule.key;
  }
  return null;
}

export function buildStrategicSignalRadar(brief: Brief): StrategicSignalRadarData {
  const seed: Record<RadarQuadrantKey, RadarQuadrant> = {
    strategy: { key: "strategy", label: QUADRANT_LABEL.strategy, count: 0 },
    tech: { key: "tech", label: QUADRANT_LABEL.tech, count: 0 },
    procurement: { key: "procurement", label: QUADRANT_LABEL.procurement, count: 0 },
    leadership: { key: "leadership", label: QUADRANT_LABEL.leadership, count: 0 },
  };

  const allSignals: Array<{ text: string; confidence?: Confidence }> = [];
  for (const s of brief.recent_signals ?? []) {
    if (s && typeof s.text === "string") {
      allSignals.push({ text: s.text, confidence: s.confidence as Confidence | undefined });
    }
  }
  for (const c of brief.competitive_signals ?? []) {
    if (typeof c === "string") {
      allSignals.push({ text: c });
    }
  }

  for (const sig of allSignals) {
    const q = pickQuadrant(sig.text);
    if (!q) continue;
    const bucket = seed[q];
    bucket.count += 1;
    if (!bucket.sample) bucket.sample = sig.text;
    bucket.confidence = maxConfidence(bucket.confidence, sig.confidence);
  }

  return {
    quadrants: [seed.strategy, seed.tech, seed.procurement, seed.leadership],
  };
}

// ---- Opportunity / Risk Split ---------------------------------------------

export type OpportunityRiskSplitData = {
  opportunities: {
    count: number;
    top: { text: string; confidence?: Confidence; tag?: string } | null;
  };
  risks: {
    count: number;
    top: { text: string } | null;
  };
  balance: "opportunity-heavy" | "risk-heavy" | "balanced";
};

export function buildOpportunityRiskSplit(brief: Brief): OpportunityRiskSplitData {
  const initiatives = Array.isArray(brief.top_initiatives) ? brief.top_initiatives : [];
  const risks = Array.isArray(brief.risks) ? brief.risks : [];

  const opTop = initiatives[0];
  const riskTop = risks[0];

  let balance: OpportunityRiskSplitData["balance"] = "balanced";
  if (initiatives.length > risks.length) balance = "opportunity-heavy";
  else if (risks.length > initiatives.length) balance = "risk-heavy";

  return {
    opportunities: {
      count: initiatives.length,
      top: opTop
        ? {
            text: opTop.title,
            confidence: opTop.confidence as Confidence | undefined,
            tag: opTop.detail,
          }
        : null,
    },
    risks: {
      count: risks.length,
      top: typeof riskTop === "string" && riskTop.length > 0 ? { text: riskTop } : null,
    },
    balance,
  };
}

// ---- Momentum Strip --------------------------------------------------------

export type MomentumSegmentKey = "signals" | "initiatives" | "pilots" | "programs";

export type MomentumSegment = {
  key: MomentumSegmentKey;
  label: string;
  count: number;
};

export type MomentumStripData = {
  segments: MomentumSegment[];
  total: number;
  velocity_label: "High momentum" | "Steady" | "Low momentum" | "Quiet";
};

function len(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function buildMomentumStrip(brief: Brief): MomentumStripData {
  const segments: MomentumSegment[] = [
    { key: "signals", label: "Signals", count: len(brief.recent_signals) },
    { key: "initiatives", label: "Initiatives", count: len(brief.top_initiatives) },
    {
      key: "pilots",
      label: "Pilots",
      count: len(brief.technical_footprint?.active_pilots),
    },
    {
      key: "programs",
      label: "Programs",
      count: len(brief.programs_procurement?.active_rfps_contracts),
    },
  ];
  const total = segments.reduce((n, s) => n + s.count, 0);
  let velocity_label: MomentumStripData["velocity_label"] = "Quiet";
  if (total >= 8) velocity_label = "High momentum";
  else if (total >= 4) velocity_label = "Steady";
  else if (total >= 1) velocity_label = "Low momentum";

  return { segments, total, velocity_label };
}

// ---- AI Takeaways ---------------------------------------------------------

export type Takeaway = {
  headline: string;
  detail: string;
  source_field: string;
};

export type AITakeawaysData = {
  takeaways: Takeaway[];
};

const MATURITY_INTERPRETATION: Record<number, string> = {
  1: "No AI activity surfaced.",
  2: "Exploring; no confirmed tools or budget yet.",
  3: "Piloting; active POCs but limited committed budget.",
  4: "Deploying at scale; vendor relationships established.",
  5: "Scaling; multiple programs in production.",
};

function notEmpty(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  // Treat scaffold placeholders ("Not found", "—", "n/a", "unknown") as
  // missing so executive copy never surfaces raw placeholder text.
  return !/^(not found|—|n\/a|unknown)\.?$/i.test(trimmed);
}

export function buildAITakeaways(brief: Brief): AITakeawaysData {
  const takeaways: Takeaway[] = [];

  // 1. AI maturity reading
  const rating = brief.ai_tech_maturity?.rating;
  if (typeof rating === "number" && rating >= 1 && rating <= 5) {
    takeaways.push({
      headline: `AI maturity ${rating}/5`,
      detail:
        MATURITY_INTERPRETATION[rating] ??
        "Rating taken from the saved brief.",
      source_field: "ai_tech_maturity",
    });
  }

  // 2. Top initiative
  const topInitiative = brief.top_initiatives?.[0];
  if (topInitiative && notEmpty(topInitiative.title)) {
    takeaways.push({
      headline: "Top initiative",
      detail: notEmpty(topInitiative.detail)
        ? `${topInitiative.title} — ${topInitiative.detail}`
        : topInitiative.title,
      source_field: "top_initiatives",
    });
  }

  // 3. Top risk
  const topRisk = brief.risks?.[0];
  if (notEmpty(topRisk)) {
    takeaways.push({
      headline: "Top watch-out",
      detail: topRisk,
      source_field: "risks",
    });
  }

  // 4. Buying path
  if (notEmpty(brief.buying_path)) {
    takeaways.push({
      headline: "Buying path",
      detail: brief.buying_path,
      source_field: "buying_path",
    });
  }

  // 5. Recommended next action — always last so a downstream "cap at 5"
  // keeps the action visible when all five takeaways are present.
  if (notEmpty(brief.next_action)) {
    takeaways.push({
      headline: "Recommended next action",
      detail: brief.next_action,
      source_field: "next_action",
    });
  }

  return { takeaways: takeaways.slice(0, 5) };
}
