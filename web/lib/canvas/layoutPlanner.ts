// Deterministic Canvas layout planner.
//
// Pure TypeScript. No React. No Zod parse at module load. No provider
// calls. Given a saved `Brief`, produces a `CanvasLayoutPlan` that the
// `fromBrief` adapter consumes to set `form` and grid coordinates.
//
// Hermes' fingerprint lives in: signal extraction, story classification,
// and visual-form selection. None of these are model calls; every choice
// is deterministic and inspectable.

import type { Brief } from "../schema";
import {
  isBarStyleModule,
  formForStoryAndSection,
  VISUAL_GRAMMAR_RULES,
  type CanvasStoryType,
  type VisualForm,
} from "./visualGrammar";

// ---- Signal extraction ----------------------------------------------------

export type Bucket = "none" | "low" | "med" | "high";

export interface BriefSignals {
  signalRecency: Bucket;
  personaDepth: Bucket;
  initiativeStrength: Bucket;
  riskWeight: Bucket;
  buyingPathRichness: Bucket;
  technicalFootprintRichness: Bucket;
  // Procurement uses a small integer (0 / 1 / 2+) because the cascade
  // thresholds compare against it directly.
  procurementSignal: number;
  hasRecommendedAction: boolean;
}

function countBucket(n: number): Bucket {
  if (n <= 0) return "none";
  if (n === 1) return "low";
  if (n <= 2) return "med";
  return "high";
}

const BUCKET_ORDER: Record<Bucket, number> = {
  none: 0,
  low: 1,
  med: 2,
  high: 3,
};

function bucketGte(a: Bucket, b: Bucket): boolean {
  return BUCKET_ORDER[a] >= BUCKET_ORDER[b];
}

function bucketLte(a: Bucket, b: Bucket): boolean {
  return BUCKET_ORDER[a] <= BUCKET_ORDER[b];
}

function bucketLt(a: Bucket, b: Bucket): boolean {
  return BUCKET_ORDER[a] < BUCKET_ORDER[b];
}

// Technical footprint richness uses a different scale (count of populated
// fields). Map 0/2/4/6+ to none/low/med/high.
function techFootprintBucket(count: number): Bucket {
  if (count < 2) return "none";
  if (count < 4) return "low";
  if (count < 6) return "med";
  return "high";
}

// Buying path tokenisation: counts non-stopword tokens. "Rich" means a
// detailed prose paragraph; "Low" is a one-liner; "None" is empty/"not
// found".
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "by", "as", "at", "this", "that", "it", "its",
  "from", "but", "not", "found",
]);

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function buyingPathBucket(brief: Brief): Bucket {
  const raw = (brief.buying_path || "").trim();
  if (!raw || raw.toLowerCase().startsWith("not found")) return "none";
  const tokens = tokenize(raw);
  // Stakeholder mentions: count personas whose name/title token appears.
  let stakeholderMentions = 0;
  for (const p of brief.personas) {
    const personaTokens = new Set([...tokenize(p.name), ...tokenize(p.title)]);
    let matched = false;
    for (const t of personaTokens) {
      if (tokens.includes(t)) {
        matched = true;
        break;
      }
    }
    if (matched) stakeholderMentions += 1;
  }
  const score = tokens.length + stakeholderMentions * 4;
  if (score === 0) return "none";
  if (score < 8) return "low";
  if (score < 20) return "med";
  return "high";
}

function technicalFootprintRichness(brief: Brief): Bucket {
  const tf = brief.technical_footprint;
  let filled = 0;
  if (tf.ai_in_production.length > 0) filled += 1;
  if (tf.active_pilots.length > 0) filled += 1;
  if (tf.cloud_platforms.length > 0) filled += 1;
  if (tf.data_infrastructure && !tf.data_infrastructure.toLowerCase().startsWith("not found")) filled += 1;
  if (tf.clinical_platforms && !tf.clinical_platforms.toLowerCase().startsWith("not found")) filled += 1;
  if (tf.analytics_bi_stack && !tf.analytics_bi_stack.toLowerCase().startsWith("not found")) filled += 1;
  if (tf.build_vs_buy_posture && !tf.build_vs_buy_posture.toLowerCase().startsWith("not found")) filled += 1;
  if (tf.competitive_incumbents.length > 0) filled += 1;
  return techFootprintBucket(filled);
}

// Bucket helper that boosts the raw count when a meaningful share of the
// items carry High/Medium confidence. Keeps everything deterministic.
function confidenceWeightedBucket(
  items: ReadonlyArray<{ confidence?: string }>,
): Bucket {
  const n = items.length;
  if (n === 0) return "none";
  const strong = items.filter(
    (i) => i.confidence === "High" || i.confidence === "Medium",
  ).length;
  // If at least half are confident, bump the bucket one step.
  const boosted = strong * 2 >= n ? n + 1 : n;
  return countBucket(boosted);
}

export function computeBriefSignals(brief: Brief): BriefSignals {
  const signalRecency = confidenceWeightedBucket(brief.recent_signals);
  const personaDepth = confidenceWeightedBucket(brief.personas);
  const initiativeStrength = confidenceWeightedBucket(brief.top_initiatives);
  const riskItemCount = brief.risks.length + brief.competitive_signals.length;
  const riskWeight = countBucket(riskItemCount);
  const buyingPathRichness = buyingPathBucket(brief);
  const technicalFootprintRichnessVal = technicalFootprintRichness(brief);
  const procurementSignal =
    brief.programs_procurement.active_rfps_contracts.length +
    brief.programs_procurement.modernization_grants.length;
  const hasRecommendedAction =
    !!brief.next_action &&
    !brief.next_action.toLowerCase().startsWith("not found");
  return {
    signalRecency,
    personaDepth,
    initiativeStrength,
    riskWeight,
    buyingPathRichness,
    technicalFootprintRichness: technicalFootprintRichnessVal,
    procurementSignal,
    hasRecommendedAction,
  };
}

// ---- Story classification cascade -----------------------------------------

export function classifyStory(signals: BriefSignals): CanvasStoryType {
  // Rule order matters; first match wins.
  if (signals.signalRecency === "high" && signals.procurementSignal >= 1) {
    return "momentum";
  }
  if (
    bucketGte(signals.personaDepth, "high") &&
    bucketGte(signals.buyingPathRichness, "med")
  ) {
    return "stakeholder-led";
  }
  if (
    bucketGte(signals.initiativeStrength, "med") &&
    bucketGte(signals.riskWeight, "med")
  ) {
    return "risk-balanced";
  }
  if (
    bucketGte(signals.technicalFootprintRichness, "high") &&
    bucketGte(signals.initiativeStrength, "med")
  ) {
    return "tech-modernization";
  }
  if (signals.procurementSignal >= 2 && bucketLt(signals.riskWeight, "med")) {
    return "procurement-window";
  }
  if (
    signals.hasRecommendedAction &&
    bucketLte(signals.signalRecency, "low") &&
    bucketLte(signals.personaDepth, "low") &&
    bucketLte(signals.initiativeStrength, "low")
  ) {
    return "single-action";
  }
  return "balanced";
}

// ---- Visual form selection ------------------------------------------------

export interface PlannedModule {
  id: string;
  kind: string;
  sectionKey?: string;
  form: VisualForm;
  // Audit-only reason string. Never surfaced to users.
  reason: string;
  // Suggested width/height; planner-only. The packer applies it.
  w: number;
  h: number;
}

// Section keys whose section_ref data is "rich" enough that promoting to
// a richer visual is useful when the story supports it.
function sectionItemCount(brief: Brief, key: string): number {
  switch (key) {
    case "top_initiatives":
      return brief.top_initiatives.length;
    case "recent_signals":
      return brief.recent_signals.length;
    case "personas":
      return brief.personas.length;
    case "risks":
      return brief.risks.length;
    case "competitive_signals":
      return brief.competitive_signals.length;
    default:
      return 0;
  }
}

// Selects forms for the planner-promoted modules. The list captures
// section_ref + opportunity_risk_split modules whose form can be
// promoted; other modules keep their default. The packer fills in the
// layout coordinates afterwards.
//
// We do NOT emit unrelated modules here; this returns the planner's view
// of the *form-aware* modules in their preferred top-cluster order.
export function selectVisualForms(
  story: CanvasStoryType,
  signals: BriefSignals,
  brief: Brief,
): PlannedModule[] {
  const out: PlannedModule[] = [];

  // Each candidate produces a `form` based on the story; the loop later
  // enforces the grammar rules (max one bar-style in top cluster, no two
  // adjacent in y).
  const candidates: Array<{
    id: string;
    kind: string;
    sectionKey?: string;
    w: number;
    h: number;
    eligibleForm: VisualForm;
  }> = [
    {
      id: "section-recent-signals",
      kind: "section_ref",
      sectionKey: "recent_signals",
      w: 6,
      h: 3,
      eligibleForm: formForStoryAndSection(story, "recent_signals"),
    },
    {
      id: "section-personas",
      kind: "section_ref",
      sectionKey: "personas",
      w: 6,
      h: 3,
      eligibleForm: formForStoryAndSection(story, "personas"),
    },
    {
      id: "insight-opportunity-risk",
      kind: "opportunity_risk_split",
      w: 6,
      h: 4,
      eligibleForm:
        story === "risk-balanced" &&
        bucketGte(signals.initiativeStrength, "med") &&
        bucketGte(signals.riskWeight, "med")
          ? "tension-matrix"
          : "default",
    },
  ];

  // Apply the "rich data threshold" rule: promote section_ref → richer
  // form only when there are >=4 items and (for personas) buying-path
  // depth is at least medium.
  for (const c of candidates) {
    let form: VisualForm = c.eligibleForm;
    let reason = `story=${story}`;
    if (c.kind === "section_ref" && c.sectionKey) {
      const count = sectionItemCount(brief, c.sectionKey);
      if (form === "persona-map") {
        if (count < 4 || bucketLt(signals.buyingPathRichness, "med")) {
          form = "default";
          reason = "persona-map requires personas>=4 and buyingPath>=med";
        }
      } else if (form === "timeline") {
        if (count < 3) {
          form = "default";
          reason = "timeline requires recent_signals>=3";
        }
      } else if (
        form === "default" &&
        count <= VISUAL_GRAMMAR_RULES.landscapeSparseThreshold
      ) {
        reason = "sparse list keeps default landscape";
      }
    } else if (c.kind === "opportunity_risk_split") {
      if (form === "tension-matrix" && brief.top_initiatives.length === 0) {
        form = "default";
        reason = "tension-matrix needs >=1 initiative";
      }
    }
    out.push({
      id: c.id,
      kind: c.kind,
      sectionKey: c.sectionKey,
      form,
      reason,
      w: c.w,
      h: c.h,
    });
  }
  return out;
}

// ---- Layout plan ----------------------------------------------------------

export interface CanvasLayoutPlan {
  story: CanvasStoryType;
  signals: BriefSignals;
  // Map widget id -> chosen visual form. The adapter applies this onto
  // the widgets it emits.
  forms: Record<string, VisualForm>;
  // The order in which "form-aware" modules appear in the top cluster.
  // The adapter uses this order to influence y placement. Other modules
  // keep their existing relative order.
  topClusterOrder: string[];
  // Audit-only.
  modules: PlannedModule[];
}

// Enforce the "no two bar-style modules adjacent by y" rule by reordering
// the top-cluster module list. Determinism: we keep relative order and
// only swap a bar-style module with the next non-bar module when an
// adjacency would otherwise occur. If no non-bar swap target exists the
// module is left in place — the bar-count cap above already prevents
// runaway clustering.
function enforceNoAdjacentBars(
  modules: PlannedModule[],
): PlannedModule[] {
  const out = modules.slice();
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const prevBar = isBarStyleModule({
      kind: prev.kind,
      form: prev.form,
      sectionKey: prev.sectionKey,
    });
    const curBar = isBarStyleModule({
      kind: cur.kind,
      form: cur.form,
      sectionKey: cur.sectionKey,
    });
    if (prevBar && curBar) {
      // Find the next non-bar module and swap it forward.
      for (let j = i + 1; j < out.length; j++) {
        const cand = out[j];
        const candBar = isBarStyleModule({
          kind: cand.kind,
          form: cand.form,
          sectionKey: cand.sectionKey,
        });
        if (!candBar) {
          [out[i], out[j]] = [out[j], out[i]];
          break;
        }
      }
    }
  }
  return out;
}

// Enforce the "max one bar-style module in the top cluster" rule. When
// more than one bar-style module sits in the first `topClusterSize`
// modules, we mark the later ones for demotion: their form stays the
// same, but the planner exposes the list so the adapter can emit them
// after the cluster boundary.
function enforceTopClusterBarCap(
  modules: PlannedModule[],
): PlannedModule[] {
  // Single-pass partition: the first `topClusterSize` slots of the input
  // list form the "top cluster". Bar-style modules in the top cluster
  // beyond the cap are deterministically moved to a demoted bucket
  // appended after the rest. A single pass guarantees termination.
  const head: PlannedModule[] = [];
  const demoted: PlannedModule[] = [];
  const rest: PlannedModule[] = [];
  const cap = VISUAL_GRAMMAR_RULES.maxBarStyleInTopCluster;
  let barsSeen = 0;
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    const inTop = i < VISUAL_GRAMMAR_RULES.topClusterSize;
    const isBar = isBarStyleModule({
      kind: m.kind,
      form: m.form,
      sectionKey: m.sectionKey,
    });
    if (!inTop) {
      rest.push(m);
      continue;
    }
    if (!isBar) {
      head.push(m);
      continue;
    }
    if (barsSeen < cap) {
      head.push(m);
      barsSeen += 1;
    } else {
      demoted.push(m);
    }
  }
  return [...head, ...rest, ...demoted];
}

export function buildCanvasLayoutPlan(brief: Brief): CanvasLayoutPlan {
  const signals = computeBriefSignals(brief);
  const story = classifyStory(signals);
  const raw = selectVisualForms(story, signals, brief);
  // The planner only owns modules it actively promoted away from the
  // default bar-style form. Modules that stayed default fall back to
  // the adapter's existing emission path, so they are not tracked here.
  // This keeps the top-cluster bar cap a planner-local invariant.
  const promoted = raw.filter((m) => m.form !== "default");
  const cappedFirst = enforceTopClusterBarCap(promoted);
  const noAdjacent = enforceNoAdjacentBars(cappedFirst);

  const forms: Record<string, VisualForm> = {};
  for (const m of noAdjacent) {
    forms[m.id] = m.form;
  }
  return {
    story,
    signals,
    forms,
    topClusterOrder: noAdjacent.map((m) => m.id),
    modules: noAdjacent,
  };
}

// Re-export VISUAL_GRAMMAR_RULES for callers that want a single import
// path for planner + rules.
export { VISUAL_GRAMMAR_RULES };
