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

export const SectionRefData = z.object({
  section_key: z.string(),
  preview: z.string(),
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
// lab-aligned shape with `text` / `why` / `owner` / `severity`. Renderers
// fall back gracefully when fields are absent.
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

export const CanvasWidget = z.discriminatedUnion("kind", [
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
  ExtensionWidget,
]);
export type CanvasWidget = z.infer<typeof CanvasWidget>;

export const CanvasMeta = z.object({
  layout_mode: z.enum(["grid", "freeform"]).default("grid"),
  pinned_order: z.array(z.string()).default([]),
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
