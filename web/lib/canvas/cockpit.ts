// Pure selectors that derive Executive Cockpit data from a Canvas.
//
// React-free so Node tests can import these without lucide /
// framer-motion in the load path. The presentational
// `ExecutiveCockpit` component wraps these.
//
// All selectors are total: they return null when the underlying
// widget is missing or its payload is unusable. They never throw.
//
// Derivation rules are deterministic and preserve the brief's order
// (the adapter already emits widget.evidence in brief order for
// section-top-initiatives / section-risks / etc.).

import type { Canvas, CanvasWidget, Confidence } from "./schema";
import {
  aggregateConfidence,
  parseFractionValue,
  type ConfidenceCounts,
} from "./visualHelpers";

export type CockpitItem = {
  text: string;
  confidence?: Confidence;
  tag?: string;
  source?: string;
};

export type CockpitMaturity = {
  current: number;
  max: number;
  rationale?: string;
};

export type CockpitEvidence = {
  counts: ConfidenceCounts;
  total: number;
};

export type CockpitAction = {
  label: string;
  detail: string;
};

export type ExecutiveCockpitData = {
  maturity: CockpitMaturity | null;
  topOpportunity: CockpitItem | null;
  topRisk: CockpitItem | null;
  evidence: CockpitEvidence | null;
  nextAction: CockpitAction | null;
};

function findWidget(
  canvas: Canvas | null | undefined,
  id: string,
): CanvasWidget | null {
  if (!canvas || !Array.isArray(canvas.widgets)) return null;
  return canvas.widgets.find((w) => w.id === id) ?? null;
}

export function selectMaturity(
  canvas: Canvas | null | undefined,
): CockpitMaturity | null {
  const w = findWidget(canvas, "metric-ai-maturity");
  if (!w || w.kind !== "metric") return null;
  const fraction = parseFractionValue(w.data.value);
  if (!fraction) return null;
  return {
    current: fraction.current,
    max: fraction.max,
    rationale: w.data.helper,
  };
}

function firstEvidenceItem(
  canvas: Canvas | null | undefined,
  widgetId: string,
): CockpitItem | null {
  const w = findWidget(canvas, widgetId);
  if (!w || w.kind !== "section_ref") return null;
  const ev = w.evidence[0];
  if (!ev || typeof ev.text !== "string" || ev.text.trim() === "") return null;
  return {
    text: ev.text,
    confidence: ev.confidence,
    tag: ev.tag,
    source: ev.source,
  };
}

export function selectTopOpportunity(
  canvas: Canvas | null | undefined,
): CockpitItem | null {
  return firstEvidenceItem(canvas, "section-top-initiatives");
}

export function selectTopRisk(
  canvas: Canvas | null | undefined,
): CockpitItem | null {
  return firstEvidenceItem(canvas, "section-risks");
}

export function selectEvidenceSummary(
  canvas: Canvas | null | undefined,
): CockpitEvidence | null {
  const w = findWidget(canvas, "evidence-board");
  if (!w || w.kind !== "evidence_board") return null;
  const items = w.data.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  return { counts: aggregateConfidence(items), total: items.length };
}

// Local action normaliser so we don't have to reach into tiles.tsx /
// details.tsx (and pull React with it). Handles all three supported
// ActionItem shapes:
//   - legacy { label, detail? }
//   - lab    { text, why, owner?, severity }
//   - hermes { recommendation, rationale, expected_outcome, ... }
type RawAction =
  | { label: string; detail?: string }
  | { text: string; why: string; owner?: string; severity?: "low" | "medium" | "high" }
  | {
      recommendation: string;
      rationale: string;
      expected_outcome: string;
      risk?: string;
      evidence?: unknown[];
      approval_state?: "suggested" | "approved" | "dismissed";
      owner?: string;
      severity?: "low" | "medium" | "high";
    };

function normaliseAction(raw: RawAction): CockpitAction {
  if ("recommendation" in raw) {
    // The cockpit cell surfaces the actual recommendation text (the cell
    // body); rationale / expected_outcome live in the drill-in panel.
    return {
      label: "Recommended next action",
      detail: raw.recommendation,
    };
  }
  if ("label" in raw) {
    return { label: raw.label, detail: raw.detail ?? "" };
  }
  return { label: raw.text, detail: raw.why };
}

export function selectNextAction(
  canvas: Canvas | null | undefined,
): CockpitAction | null {
  const w = findWidget(canvas, "action-next");
  if (!w || w.kind !== "action_panel") return null;
  const first = w.data.actions[0];
  if (!first) return null;
  const normalised = normaliseAction(first as RawAction);
  if (!normalised.label && !normalised.detail) return null;
  return normalised;
}

export function buildExecutiveCockpit(
  canvas: Canvas | null | undefined,
): ExecutiveCockpitData {
  return {
    maturity: selectMaturity(canvas),
    topOpportunity: selectTopOpportunity(canvas),
    topRisk: selectTopRisk(canvas),
    evidence: selectEvidenceSummary(canvas),
    nextAction: selectNextAction(canvas),
  };
}
