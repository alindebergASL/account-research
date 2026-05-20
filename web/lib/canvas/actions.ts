import { z } from "zod";
import { Confidence, Evidence, WidgetKind } from "./schema";
import { CanvasDocument } from "./document";
import { PrimitiveSurfaceSpec } from "./primitive";

const BaseEnvelope = z.object({
  confidence: Confidence.optional(),
  rationale: z.string().optional(),
  evidence: z.array(Evidence).optional(),
});

export const WidgetCapabilityProposal = z.object({
  id: z.string().min(1),
  proposed_widget_kind: z.string().regex(/^[a-z][a-z0-9_\-]{1,80}$/),
  rationale: z.string(),
  data_schema: z.unknown(),
  ts_renderer_source: z.string().max(50 * 1024),
  example_data: z.unknown(),
  primitive_fallback: PrimitiveSurfaceSpec,
  evidence: z.array(Evidence).default([]),
  proposed_at: z.string(),
  proposed_by: z.object({ kind: z.enum(["hermes", "user", "system", "legacy_conversion"]), job_id: z.string().optional(), user_id: z.string().optional(), at: z.string().optional() }),
});
export type WidgetCapabilityProposal = z.infer<typeof WidgetCapabilityProposal>;

export const CapabilityPlaceholderCreatePayload = z.object({
  capability_proposal_id: z.string().min(1),
  node_id: z.string().min(1),
  title: z.string(),
  section_id: z.string().optional(),
  layout_hint: z.object({ x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional() }).optional(),
  rationale: z.string(),
});
export type CapabilityPlaceholderCreatePayload = z.infer<typeof CapabilityPlaceholderCreatePayload>;

export const DocumentReplacePayload = z.object({
  next_document: CanvasDocument,
  prior_version: z.number().int().nonnegative(),
  preserve_node_ids: z.array(z.string()).optional(),
  rationale: z.string(),
});
export type DocumentReplacePayload = z.infer<typeof DocumentReplacePayload>;

export const CanvasAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document.replace"), payload: DocumentReplacePayload }),
  z.object({ kind: z.literal("capability.propose"), payload: WidgetCapabilityProposal }),
  z.object({ kind: z.literal("capability.placeholder.create"), payload: CapabilityPlaceholderCreatePayload }),
  z.object({ kind: z.literal("capability.placeholder.remove"), payload: z.object({ node_id: z.string().min(1) }) }),
  z.object({ kind: z.literal("capability.withdraw"), payload: z.object({ capability_proposal_id: z.string().min(1), reason: z.string() }) }),
  z.object({ kind: z.literal("primitive_surface.create"), payload: BaseEnvelope.extend({ node_id: z.string().min(1), title: z.string(), surface_spec: PrimitiveSurfaceSpec }) }),
  z.object({ kind: z.literal("primitive_surface.update"), payload: BaseEnvelope.extend({ node_id: z.string().min(1), surface_spec: PrimitiveSurfaceSpec }) }),
  z.object({ kind: z.literal("primitive_surface.remove"), payload: z.object({ node_id: z.string().min(1) }) }),
  z.object({ kind: z.literal("widget.create"), payload: BaseEnvelope.extend({ node_id: z.string().min(1), widget_kind: WidgetKind, title: z.string(), widget_data: z.unknown() }) }),
  z.object({ kind: z.literal("widget.update"), payload: BaseEnvelope.extend({ node_id: z.string().min(1), patch: z.record(z.string(), z.unknown()) }) }),
  z.object({ kind: z.literal("widget.remove"), payload: z.object({ node_id: z.string().min(1) }) }),
  z.object({ kind: z.literal("widget.add_evidence"), payload: z.object({ node_id: z.string().min(1), evidence: Evidence }) }),
  z.object({ kind: z.literal("widget.mark_status"), payload: z.object({ node_id: z.string().min(1), status: z.enum(["fresh", "stale", "watching", "archived"]) }) }),
  z.object({ kind: z.literal("node.move"), payload: BaseEnvelope.extend({ node_id: z.string().min(1), x: z.number(), y: z.number() }) }),
  z.object({ kind: z.literal("node.resize"), payload: BaseEnvelope.extend({ node_id: z.string().min(1), w: z.number().positive(), h: z.number().positive() }) }),
  z.object({ kind: z.literal("node.group"), payload: BaseEnvelope.extend({ node_id: z.string().min(1), section_id: z.string().min(1) }) }),
  z.object({ kind: z.literal("edge.create"), payload: BaseEnvelope.extend({ id: z.string().min(1), from_node_id: z.string().min(1), to_node_id: z.string().min(1), edge_kind: z.enum(["supports", "blocks", "depends_on", "evidences", "follows", "elaborates", "contrasts", "groups"]) }) }),
  z.object({ kind: z.literal("edge.remove"), payload: z.object({ edge_id: z.string().min(1) }) }),
  z.object({ kind: z.literal("section.create"), payload: BaseEnvelope.extend({ id: z.string().min(1), title: z.string(), intent: z.enum(["summary", "evidence", "decisions", "risks", "next_actions", "people", "questions", "freeform"]) }) }),
  z.object({ kind: z.literal("section.reorder"), payload: BaseEnvelope.extend({ section_ids: z.array(z.string()) }) }),
  z.object({ kind: z.literal("section.remove"), payload: z.object({ section_id: z.string().min(1) }) }),
  z.object({ kind: z.literal("layout.propose"), payload: BaseEnvelope.extend({}) }),
  z.object({ kind: z.literal("layout.apply"), payload: BaseEnvelope.extend({}) }),
  z.object({ kind: z.literal("view.create"), payload: BaseEnvelope.extend({ id: z.string().min(1), name: z.string(), node_ids: z.array(z.string()) }) }),
  z.object({ kind: z.literal("view.update"), payload: BaseEnvelope.extend({ id: z.string().min(1), patch: z.record(z.string(), z.unknown()) }) }),
  z.object({ kind: z.literal("view.delete"), payload: z.object({ id: z.string().min(1) }) }),
  z.object({ kind: z.literal("rationale.add"), payload: z.object({ text: z.string(), target_id: z.string().optional() }) }),
  z.object({ kind: z.literal("evidence.add"), payload: z.object({ node_id: z.string().min(1), evidence: Evidence }) }),
  z.object({ kind: z.literal("risk.add"), payload: BaseEnvelope.extend({ node_id: z.string().optional(), text: z.string() }) }),
  z.object({ kind: z.literal("hypothesis.add"), payload: BaseEnvelope.extend({ node_id: z.string().optional(), text: z.string() }) }),
  z.object({ kind: z.literal("decision.add"), payload: BaseEnvelope.extend({ node_id: z.string().optional(), text: z.string() }) }),
  z.object({ kind: z.literal("action.add"), payload: BaseEnvelope.extend({ node_id: z.string().optional(), text: z.string() }) }),
  z.object({ kind: z.literal("propose_refresh"), payload: BaseEnvelope.extend({ reason: z.string().optional() }) }),
]);
export type CanvasAction = z.infer<typeof CanvasAction>;

export type CanvasActionLayer = "A" | "B" | "C" | "D";
export function actionLayer(kind: CanvasAction["kind"]): CanvasActionLayer {
  if (kind.startsWith("widget.")) return "A";
  if (kind.startsWith("primitive_surface.")) return "C";
  if (kind.startsWith("capability.")) return "D";
  return "B";
}

export function canSourcePropose(source: "hermes" | "user" | "system", kind: CanvasAction["kind"]): boolean {
  const layer = actionLayer(kind);
  if (source === "hermes") return true;
  if (source === "user") return layer === "A" || layer === "B" || kind === "capability.placeholder.remove";
  return kind === "widget.mark_status" || kind === "widget.add_evidence" || kind === "rationale.add";
}

export function isAutoApplyAction(action: CanvasAction): boolean {
  if (action.kind === "document.replace") return false;
  const layer = actionLayer(action.kind);
  if (layer === "D") return false;
  if (action.kind.endsWith(".remove") || action.kind === "view.delete" || action.kind === "propose_refresh") return false;
  const payload = action.payload as { confidence?: string; rationale?: string; evidence?: unknown[] };
  if (layer === "B") return !!payload.rationale;
  return payload.confidence === "High" || payload.confidence === "Medium";
}
