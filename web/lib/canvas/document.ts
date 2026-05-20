import { z } from "zod";
import { CanvasWidget, Confidence, Evidence, Source, WidgetControls, WidgetKind, WidgetSource, WidgetStatus } from "./schema";
import { PrimitiveSurfaceSpec } from "./primitive";

export const NodeProvenance = z.object({
  kind: z.enum(["hermes", "user", "system", "legacy_conversion"]),
  job_id: z.string().optional(),
  user_id: z.string().optional(),
  model_version: z.string().optional(),
  at: z.string().optional(),
});
export type NodeProvenance = z.infer<typeof NodeProvenance>;

const NodeCommon = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  confidence: Confidence.optional(),
  source: WidgetSource.optional(),
  why_included: z.string().optional(),
  sources: z.array(Source).default([]),
  evidence: z.array(Evidence).default([]),
  status: WidgetStatus.default("fresh"),
  controls: WidgetControls.default({ can_refresh: false, can_remove: false, can_edit: false, can_export: false }),
  created_at: z.string(),
  updated_at: z.string(),
  provenance: NodeProvenance,
  layer: z.enum(["A", "B", "C", "D"]),
});

export const WidgetCanvasNode = NodeCommon.extend({
  kind: z.literal("widget"),
  widget_kind: WidgetKind,
  widget_data: z.unknown(),
  legacy_widget: CanvasWidget.optional(),
});
export const PrimitiveSurfaceCanvasNode = NodeCommon.extend({
  kind: z.literal("primitive_surface"),
  surface_spec: PrimitiveSurfaceSpec,
});
export const CapabilityPlaceholderCanvasNode = NodeCommon.extend({
  kind: z.literal("capability_placeholder"),
  capability_proposal_id: z.string().min(1),
});
export const CanvasNode = z.discriminatedUnion("kind", [WidgetCanvasNode, PrimitiveSurfaceCanvasNode, CapabilityPlaceholderCanvasNode]);
export type CanvasNode = z.infer<typeof CanvasNode>;

export const CanvasEdge = z.object({
  id: z.string().min(1),
  from: z.object({ node_id: z.string().min(1), handle_id: z.string().optional() }),
  to: z.object({ node_id: z.string().min(1), handle_id: z.string().optional() }),
  kind: z.enum(["supports", "blocks", "depends_on", "evidences", "follows", "elaborates", "contrasts", "groups"]),
  label: z.string().optional(),
  rationale: z.string().optional(),
  weight: z.number().min(0).max(1).optional(),
  provenance: NodeProvenance,
});
export type CanvasEdge = z.infer<typeof CanvasEdge>;

export const CanvasSection = z.object({
  id: z.string().min(1),
  title: z.string(),
  intent: z.enum(["summary", "evidence", "decisions", "risks", "next_actions", "people", "questions", "freeform"]),
  node_ids: z.array(z.string()),
  collapse_default: z.boolean().default(false),
  provenance: NodeProvenance,
});
export type CanvasSection = z.infer<typeof CanvasSection>;

export const CanvasLayout = z.object({
  mode: z.enum(["grid", "freeform", "hierarchical"]),
  grid: z.object({ cols: z.literal(12), cells: z.array(z.object({ node_id: z.string(), x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(24) })) }).optional(),
  freeform: z.object({ positions: z.array(z.object({ node_id: z.string(), x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })) }).optional(),
  hierarchical: z.object({ roots: z.array(z.string()), spacing: z.number().positive().optional() }).optional(),
});
export type CanvasLayout = z.infer<typeof CanvasLayout>;

export const CanvasView = z.object({
  id: z.string().min(1),
  name: z.string(),
  mode: z.enum(["executive", "operator", "risk", "evidence", "next_actions", "custom"]),
  node_ids: z.array(z.string()),
  section_ids: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});
export type CanvasView = z.infer<typeof CanvasView>;

export const CanvasRationale = z.object({
  id: z.string().min(1),
  target_id: z.string().optional(),
  text: z.string(),
  by: NodeProvenance,
  at: z.string(),
});
export type CanvasRationale = z.infer<typeof CanvasRationale>;

export const CanvasDocument = z.object({
  schema_version: z.literal(1),
  document_id: z.string().min(1),
  brief_id: z.string().min(1),
  version: z.number().int().nonnegative(),
  generated_at: z.string(),
  generated_by: NodeProvenance,
  nodes: z.array(CanvasNode),
  edges: z.array(CanvasEdge).default([]),
  sections: z.array(CanvasSection).default([]),
  layout: CanvasLayout,
  views: z.array(CanvasView).default([]),
  rationale: z.array(CanvasRationale).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type CanvasDocument = z.infer<typeof CanvasDocument>;

export function parseCanvasDocument(raw: unknown): CanvasDocument {
  return CanvasDocument.parse(raw);
}
