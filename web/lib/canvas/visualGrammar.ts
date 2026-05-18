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
