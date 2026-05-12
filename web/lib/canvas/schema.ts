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

export const WidgetKind = z.enum([
  "section_ref",
  "evidence_board",
  "action_panel",
  "open_questions",
  "metric",
]);
export type WidgetKind = z.infer<typeof WidgetKind>;

export const WidgetSource = z.enum(["system", "model", "chat", "user"]);
export type WidgetSource = z.infer<typeof WidgetSource>;

export const WidgetStatus = z.enum(["fresh", "stale", "watching", "archived"]);
export type WidgetStatus = z.infer<typeof WidgetStatus>;

export const WidgetLayout = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
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
});
export type Evidence = z.infer<typeof Evidence>;

// ---- widget data shapes ----------------------------------------------------

export const SectionRefData = z.object({
  section_key: z.string(),
  preview: z.string(),
});

export const EvidenceItem = z.object({
  text: z.string(),
  source: z.string().optional(),
  confidence: Confidence.optional(),
});

export const EvidenceBoardData = z.object({
  items: z.array(EvidenceItem),
});

export const ActionItem = z.object({
  label: z.string(),
  detail: z.string().optional(),
});

export const ActionPanelData = z.object({
  actions: z.array(ActionItem),
});

export const OpenQuestionsData = z.object({
  questions: z.array(z.string()),
});

export const MetricData = z.object({
  label: z.string(),
  value: z.string(),
  helper: z.string().optional(),
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

export const CanvasWidget = z.discriminatedUnion("kind", [
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
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
