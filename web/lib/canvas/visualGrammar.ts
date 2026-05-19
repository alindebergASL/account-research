// Visual grammar rules and helpers for the Canvas layout planner.
//
// Pure TS, no React, no Zod (the Zod enum lives in `schema.ts`). This
// module documents the constraint set the planner enforces and exposes
// small helpers used by `layoutPlanner.ts` and by tests.

// Source of truth for the Zod enum lives in `schema.ts`. We re-export the
// inferred type here so the planner / helpers stay React-free without
// touching Zod at module load.
export type VisualForm = "default" | "timeline" | "persona-map" | "tension-matrix";

export type CanvasStoryType =
  | "momentum"
  | "stakeholder-led"
  | "risk-balanced"
  | "tech-modernization"
  | "procurement-window"
  | "single-action"
  | "balanced";

// Audit-only metadata describing the grammar constraints. Used by tests
// and as documentation. Not surfaced to users.
export const VISUAL_GRAMMAR_RULES = {
  // First N modules after the cockpit/action-spine constitute the "top
  // cluster" the grammar guards.
  topClusterSize: 5,
  // Hard cap on the vertical extent of the top cluster.
  topClusterMaxY: 18,
  // The top cluster contains at most this many bar-style modules.
  maxBarStyleInTopCluster: 1,
  // Two bar-style modules may not share or be adjacent on the y axis.
  noAdjacentBarStyleByY: true,
  // Preferred non-bar forms.
  preferredNonBarForms: ["timeline", "persona-map", "tension-matrix"] as const,
  // section_refs (personas / recent_signals / etc.) keep their existing
  // landscape only when the structured list is short.
  landscapeSparseThreshold: 3,
} as const;

// Bar-style forms are the visual forms that read like a bar chart row.
// The "default" form of a section_ref using InitiativeLandscape is the
// canonical bar-style form. The dedicated `momentum_strip` and
// `strategic_signal_radar` widget kinds also count.
export function isBarStyleForm(form: VisualForm | undefined): boolean {
  if (!form || form === "default") return true;
  return false;
}

// Widget kinds whose default rendering is bar-style.
const BAR_STYLE_KINDS = new Set<string>([
  "momentum_strip",
  "strategic_signal_radar",
  // section_ref is bar-style ONLY when its data.form is default and
  // section_key is in the landscape set; we check that at call sites.
]);

export function isBarStyleKind(kind: string): boolean {
  return BAR_STYLE_KINDS.has(kind);
}

const LANDSCAPE_SECTION_KEYS = new Set([
  "top_initiatives",
  "recent_signals",
  "personas",
  "risks",
  "competitive_signals",
]);

// Predicate for an *emitted* canvas widget — the public adapter shape.
// Mirrors `isBarStyleModule` but reads `kind`, `data.section_key`, and
// `data.form` straight off a widget. The cap rule on the top cluster is
// enforced via this predicate against the final widget list, not the
// planner's internal module list.
export function isBarStyleEmittedWidget(widget: {
  kind: string;
  data?: unknown;
}): boolean {
  if (BAR_STYLE_KINDS.has(widget.kind)) return true;
  const data = (widget.data ?? {}) as {
    section_key?: string;
    form?: VisualForm;
  };
  if (widget.kind === "section_ref") {
    if (!data.form || data.form === "default") {
      return !!data.section_key && LANDSCAPE_SECTION_KEYS.has(data.section_key);
    }
    return false;
  }
  if (widget.kind === "opportunity_risk_split") {
    return !data.form || data.form === "default";
  }
  return false;
}

// Decide whether a planned module emits a bar-style visual. Combines
// kind + form + section_key so the planner can count "bar-ness" across
// section_refs and dedicated widget kinds uniformly.
export function isBarStyleModule(input: {
  kind: string;
  form?: VisualForm;
  sectionKey?: string;
}): boolean {
  if (BAR_STYLE_KINDS.has(input.kind)) return true;
  if (input.kind === "section_ref") {
    if (!input.form || input.form === "default") {
      return !!input.sectionKey && LANDSCAPE_SECTION_KEYS.has(input.sectionKey);
    }
    return false;
  }
  if (input.kind === "opportunity_risk_split") {
    return !input.form || input.form === "default";
  }
  return false;
}

// ---- Tier assignment ------------------------------------------------------
//
// Group emitted widgets into named visual tiers for the read-only canvas
// view. Pure helper — used by the canvas view to render lightweight
// section headers between widget groups. Tier order is canonical and
// fixed; empty tiers must not render headers.

export type TierName =
  | "executive-decision"
  | "strategic-signals"
  | "evidence"
  | "buying-committee"
  | "risks-gaps"
  | "supporting-context";

export const TIER_ORDER: readonly TierName[] = [
  "executive-decision",
  "strategic-signals",
  "evidence",
  "buying-committee",
  "risks-gaps",
  "supporting-context",
] as const;

export const TIER_LABELS: Record<TierName, string> = {
  "executive-decision": "Executive decision",
  "strategic-signals": "Strategic signals",
  evidence: "Evidence",
  "buying-committee": "Buying committee",
  "risks-gaps": "Risks & gaps",
  "supporting-context": "Supporting context",
};

// Assign an emitted widget to a tier by id or kind. The id check wins
// when present so synthetic gap widgets (e.g. `gaps-risks-gaps`) can
// declare their tier explicitly via id prefix.
export function tierFor(widget: {
  id: string;
  kind: string;
  data?: unknown;
}): TierName {
  // Synthetic collapse-gap widgets carry an id prefix that maps to a tier.
  if (widget.id.startsWith("gaps-")) {
    const slug = widget.id.slice("gaps-".length) as TierName;
    if (TIER_ORDER.includes(slug)) return slug;
  }
  // Action / cockpit. The cockpit cell renders outside the widget grid;
  // the only emitted widget belonging to this tier is action-next.
  if (widget.id === "action-next") return "executive-decision";

  // Strategic signals.
  if (widget.id === "section-recent-signals") return "strategic-signals";
  if (widget.kind === "momentum_strip") return "strategic-signals";
  if (widget.kind === "strategic_signal_radar") return "strategic-signals";

  // Evidence.
  if (widget.kind === "evidence_board") return "evidence";
  if (widget.id === "section-top-initiatives") return "evidence";
  if (widget.id === "section-programs-procurement") return "evidence";

  // Buying committee.
  if (widget.id === "section-personas") return "buying-committee";
  if (widget.id === "section-buying-path") return "buying-committee";

  // Risks & gaps.
  if (widget.id === "section-risks") return "risks-gaps";
  if (widget.id === "section-competitive-signals") return "risks-gaps";
  if (widget.kind === "opportunity_risk_split") return "risks-gaps";
  if (widget.id === "open-questions" || widget.kind === "open_questions")
    return "risks-gaps";

  // Supporting context — fallback (technical_footprint, extensions,
  // ai_takeaways, first_angle, snapshot, priority, ai_tech_maturity,
  // sources, AI maturity metric, etc.).
  return "supporting-context";
}

// ---- Empty-payload detection ---------------------------------------------
//
// A widget's payload is "empty" when its primary user-visible content is
// absent or a placeholder. Used by the "Missing intelligence" collapse:
// when ≥ 2 empties land in the same tier, we collapse them into a single
// open_questions widget so the tier doesn't render as visual debris.

const PLACEHOLDER_TEXT_RE = /^(not found|—|n\/a|unknown)\.?$/i;

function isPlaceholderText(s: string | undefined | null): boolean {
  if (s === undefined || s === null) return true;
  const t = s.trim();
  if (t.length === 0) return true;
  return PLACEHOLDER_TEXT_RE.test(t);
}

export function isEmptyWidgetPayload(widget: {
  kind: string;
  id: string;
  sources?: { url?: string; title?: string }[];
  evidence?: { text?: string }[];
  data?: unknown;
}): boolean {
  const data = (widget.data ?? {}) as Record<string, unknown>;
  switch (widget.kind) {
    case "section_ref": {
      const preview = data.preview as string | undefined;
      const fullText = data.full_text as string | undefined;
      const hasStructured = (widget.evidence ?? []).some(
        (e) => e.text && !isPlaceholderText(e.text),
      );
      const hasPreview = !isPlaceholderText(preview) || !isPlaceholderText(fullText);
      return !hasStructured && !hasPreview;
    }
    case "evidence_board": {
      const items = (data.items ?? []) as { text?: string }[];
      return items.length === 0;
    }
    case "strategic_signal_radar": {
      const quads = (data.quadrants ?? []) as { count?: number }[];
      return quads.every((q) => !q.count || q.count === 0);
    }
    case "opportunity_risk_split": {
      const opps = (data.opportunities ?? {}) as { count?: number };
      const risks = (data.risks ?? {}) as { count?: number };
      return (opps.count ?? 0) === 0 && (risks.count ?? 0) === 0;
    }
    case "momentum_strip": {
      const total = data.total as number | undefined;
      return !total || total === 0;
    }
    case "open_questions": {
      const qs = (data.questions ?? []) as unknown[];
      return qs.length === 0;
    }
    case "ai_takeaways": {
      const items = (data.takeaways ?? []) as unknown[];
      return items.length === 0;
    }
    case "metric": {
      const value = data.value as string | undefined;
      return isPlaceholderText(value);
    }
    case "extension": {
      const body = data.body as string | undefined;
      const items = (data.items ?? []) as unknown[];
      const rows = (data.rows ?? []) as unknown[];
      return isPlaceholderText(body) && items.length === 0 && rows.length === 0;
    }
    case "action_panel":
      // The recommended-move spine is never collapsed.
      return false;
    default:
      return false;
  }
}

// Deterministic mapping helper from (story, sectionKey) to a preferred
// non-default form. Returns "default" when the section has no preferred
// promotion under the given story.
export function formForStoryAndSection(
  story: CanvasStoryType,
  sectionKey: string,
): VisualForm {
  switch (story) {
    case "momentum":
      if (sectionKey === "recent_signals") return "timeline";
      return "default";
    case "stakeholder-led":
      if (sectionKey === "personas") return "persona-map";
      return "default";
    case "risk-balanced":
      // The tension-matrix lives on the opportunity_risk_split widget,
      // not on a section_ref. Return default here; the planner handles
      // ORS promotion separately.
      return "default";
    case "tech-modernization":
      if (sectionKey === "recent_signals") return "timeline";
      return "default";
    case "procurement-window":
      if (sectionKey === "recent_signals") return "timeline";
      return "default";
    case "single-action":
    case "balanced":
    default:
      return "default";
  }
}
