import { z } from "zod";

// Production read-only canvas subset.
//
// This intentionally ports ONLY the safe schema primitives from the
// lab prototype. No action schemas, no reducer, no store, no fakeHermes,
// no localStorage hooks. Every widget produced by the bridge has all
// controls = false; the field is kept so future PRs can selectively
// enable specific controls without a schema change.

export const Confidence = z.enum(["High", "Medium", "Low", "Not found"]);
export type Confidence = z.infer<typeof Confidence>;

export const Source = z.object({
  title: z.string(),
  url: z.string(),
  accessed: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

// Includes `extension` so brief extensions can be rendered as first-class
// canvas widgets (table / list / card / narrative) without a separate
// renderer pathway.
export const WidgetKind = z.enum([
  "section_ref",
  "evidence_board",
  "action_panel",
  "open_questions",
  "metric",
  "extension",
  // Canvas v2 strategic workspace (Phase 1)
  "strategic_signal_radar",
  "opportunity_risk_split",
  "momentum_strip",
  "ai_takeaways",
]);
export type WidgetKind = z.infer<typeof WidgetKind>;

// `refresh` and `hermes` are accepted now so a future Hermes-emitted
// widget passes schema validation without churn. `research` preserves
// PR-A research-generated extension provenance; `model` remains valid for
// legacy briefs.
export const WidgetSource = z.enum([
  "system",
  "model",
  "research",
  "chat",
  "user",
  "refresh",
  "hermes",
]);
export type WidgetSource = z.infer<typeof WidgetSource>;

export const WidgetStatus = z.enum(["fresh", "stale", "watching", "archived"]);
export type WidgetStatus = z.infer<typeof WidgetStatus>;

// Tightened to the 12-col grid the renderer uses. w >= 1 and <= 12,
// h >= 1 and <= 24. x/y are non-negative integers.
export const WidgetLayout = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
  pinned: z.boolean().default(false),
  collapsed: z.boolean().default(false),
});
export type WidgetLayout = z.infer<typeof WidgetLayout>;

export const WidgetControls = z.object({
  can_refresh: z.boolean().default(false),
  can_remove: z.boolean().default(false),
  can_edit: z.boolean().default(false),
  can_export: z.boolean().default(false),
});
export type WidgetControls = z.infer<typeof WidgetControls>;

export const Evidence = z.object({
  text: z.string(),
  source: z.string().optional(),
  confidence: Confidence.optional(),
  tag: z.string().optional(),
  added_at: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

// ---- widget data shapes ----------------------------------------------------

// Visual-form discriminator on the planner-aware data payloads. The Zod
// enum is the source of truth; the planner / helpers re-export the same
// string union from `visualGrammar.ts`. Only `SectionRefData` and
// `OpportunityRiskSplitData` carry this field — adding it on a shared
// base would broaden the schema surface unnecessarily.
export const VisualForm = z.enum([
  "default",
  "timeline",
  "persona-map",
  "tension-matrix",
]);
export type VisualForm = z.infer<typeof VisualForm>;

export const SectionRefData = z.object({
  section_key: z.string(),
  preview: z.string(),
  // Concise cards use `preview`; drill-in detail uses `full_text` when
  // available so opening a widget does not show the same truncated copy.
  full_text: z.string().optional(),
  // Optional planner-selected visual form. Defaults to "default", which
  // preserves the existing renderer path.
  form: VisualForm.optional(),
});

// Same shape used inline for evidence-board items; richer than the
// envelope-level Evidence because items can carry a structured source.
export const EvidenceItem = z.object({
  text: z.string(),
  source: z.string().optional(),
  confidence: Confidence.optional(),
  tag: z.string().optional(),
  added_at: z.string().optional(),
});

export const EvidenceBoardData = z.object({
  items: z.array(EvidenceItem),
});

// ActionItem accepts BOTH the existing minimal shape and the richer
// lab-aligned shape with `text` / `why` / `owner` / `severity`, PLUS the
// PR-N Hermes recommended-action shape (recommendation / rationale /
// expected_outcome / risk / evidence / approval_state). Renderers
// normalise across all three; no shape is mandatory.
export const ActionItem = z.union([
  z.object({
    label: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    text: z.string(),
    why: z.string(),
    owner: z.string().optional(),
    severity: z.enum(["low", "medium", "high"]).default("medium"),
  }),
  z.object({
    recommendation: z.string(),
    rationale: z.string(),
    expected_outcome: z.string(),
    risk: z.string().optional(),
    evidence: z.array(EvidenceItem).default([]),
    approval_state: z
      .enum(["suggested", "approved", "dismissed"])
      .default("suggested"),
    owner: z.string().optional(),
    severity: z.enum(["low", "medium", "high"]).default("medium"),
  }),
]);

export const ActionPanelData = z.object({
  actions: z.array(ActionItem),
});

// Accept plain strings (legacy / heuristic-derived) AND the richer lab
// shape with blocking + hypothesis. Renderers normalise to a single
// rendering path.
export const StructuredQuestion = z.object({
  text: z.string(),
  blocking: z.boolean().default(false),
  hypothesis: z.string().optional(),
});

export const OpenQuestionsData = z.object({
  questions: z.array(z.union([z.string(), StructuredQuestion])),
});

export const MetricData = z.object({
  label: z.string(),
  value: z.string(),
  helper: z.string().optional(),
  unit: z.string().optional(),
  as_of: z.string().optional(),
  delta: z.string().optional(),
});

// Extension widgets render Brief extensions (card / table / list /
// narrative) as native canvas widgets with deterministic IDs.
export const ExtensionListItemData = z.union([
  z.string(),
  z.object({
    heading: z.string().optional(),
    text: z.string(),
  }),
]);

export const ExtensionData = z.object({
  ext_kind: z.enum(["card", "table", "list", "narrative"]),
  body: z.string().optional(),
  items: z.array(ExtensionListItemData).optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
});

// ---- Canvas v2 strategic workspace data shapes ----------------------------

export const StrategicSignalRadarData = z.object({
  quadrants: z.array(
    z.object({
      key: z.enum(["strategy", "tech", "procurement", "leadership"]),
      label: z.string(),
      count: z.number().int().nonnegative(),
      confidence: Confidence.optional(),
      sample: z.string().optional(),
    }),
  ),
});

export const OpportunityRiskSplitData = z.object({
  opportunities: z.object({
    count: z.number().int().nonnegative(),
    top: z
      .object({
        text: z.string(),
        confidence: Confidence.optional(),
        tag: z.string().optional(),
      })
      .nullable(),
  }),
  risks: z.object({
    count: z.number().int().nonnegative(),
    top: z.object({ text: z.string() }).nullable(),
  }),
  balance: z.enum(["opportunity-heavy", "risk-heavy", "balanced"]),
  // Optional planner-selected visual form. When "tension-matrix" the
  // renderer dispatches to the matrix component instead of the bar split.
  form: VisualForm.optional(),
});

export const MomentumStripData = z.object({
  segments: z.array(
    z.object({
      key: z.enum(["signals", "initiatives", "pilots", "programs"]),
      label: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  total: z.number().int().nonnegative(),
  velocity_label: z.enum(["High momentum", "Steady", "Low momentum", "Quiet"]),
});

export const AITakeawayItem = z.object({
  headline: z.string(),
  detail: z.string(),
  source_field: z.string(),
});

export const AITakeawaysData = z.object({
  takeaways: z.array(AITakeawayItem),
});

// ---- widget discriminated union --------------------------------------------

const BaseWidget = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().default(""),
  source: WidgetSource,
  created_at: z.string(),
  updated_at: z.string(),
  confidence: Confidence.optional(),
  why_included: z.string().optional(),
  sources: z.array(Source).default([]),
  layout: WidgetLayout,
  controls: WidgetControls,
  status: WidgetStatus.default("fresh"),
  evidence: z.array(Evidence).default([]),
});

export const SectionRefWidget = BaseWidget.extend({
  kind: z.literal("section_ref"),
  data: SectionRefData,
});

export const EvidenceBoardWidget = BaseWidget.extend({
  kind: z.literal("evidence_board"),
  data: EvidenceBoardData,
});

export const ActionPanelWidget = BaseWidget.extend({
  kind: z.literal("action_panel"),
  data: ActionPanelData,
});

export const OpenQuestionsWidget = BaseWidget.extend({
  kind: z.literal("open_questions"),
  data: OpenQuestionsData,
});

export const MetricWidget = BaseWidget.extend({
  kind: z.literal("metric"),
  data: MetricData,
});

export const ExtensionWidget = BaseWidget.extend({
  kind: z.literal("extension"),
  data: ExtensionData,
});

export const StrategicSignalRadarWidget = BaseWidget.extend({
  kind: z.literal("strategic_signal_radar"),
  data: StrategicSignalRadarData,
});

export const OpportunityRiskSplitWidget = BaseWidget.extend({
  kind: z.literal("opportunity_risk_split"),
  data: OpportunityRiskSplitData,
});

export const MomentumStripWidget = BaseWidget.extend({
  kind: z.literal("momentum_strip"),
  data: MomentumStripData,
});

export const AITakeawaysWidget = BaseWidget.extend({
  kind: z.literal("ai_takeaways"),
  data: AITakeawaysData,
});

export const CanvasWidget = z.discriminatedUnion("kind", [
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
  ExtensionWidget,
  StrategicSignalRadarWidget,
  OpportunityRiskSplitWidget,
  MomentumStripWidget,
  AITakeawaysWidget,
]);
export type CanvasWidget = z.infer<typeof CanvasWidget>;

export const CanvasAgentReadiness = z.object({
  mode: z.literal("read_only_preview"),
  generated_from: z.literal("saved_brief"),
  controls_enabled: z.boolean().default(false),
  source_count: z.number().int().nonnegative().default(0),
  evidence_count: z.number().int().nonnegative().default(0),
});

export const CanvasMeta = z.object({
  layout_mode: z.enum(["grid", "freeform"]).default("grid"),
  pinned_order: z.array(z.string()).default([]),
  agent_readiness: CanvasAgentReadiness.default({
    mode: "read_only_preview",
    generated_from: "saved_brief",
    controls_enabled: false,
    source_count: 0,
    evidence_count: 0,
  }),
});

export const Canvas = z.object({
  account_id: z.string(),
  account_name: z.string(),
  version: z.number().int().positive(),
  generated_at: z.string(),
  widgets: z.array(CanvasWidget),
  meta: CanvasMeta,
});
export type Canvas = z.infer<typeof Canvas>;
