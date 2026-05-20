import { type CanvasAction } from "./actions";
import { type CanvasDocument, CanvasDocument as CanvasDocumentSchema } from "./document";

export type CanvasReduceResult =
  | { ok: true; document: CanvasDocument }
  | { ok: false; error_code: string };

function nowIso(): string {
  return new Date().toISOString();
}

export function reduceCanvasAction(document: CanvasDocument, action: CanvasAction): CanvasReduceResult {
  if (action.kind === "document.replace") {
    if (document.version !== action.payload.prior_version) return { ok: false, error_code: "version_stale" };
    if (action.payload.next_document.brief_id !== document.brief_id) return { ok: false, error_code: "brief_id_mismatch" };
    if (action.payload.next_document.document_id === document.document_id && action.payload.next_document.version < document.version) return { ok: false, error_code: "document_version_regressed" };
    for (const id of action.payload.preserve_node_ids ?? []) {
      if (!action.payload.next_document.nodes.some((n) => n.id === id)) {
        return { ok: false, error_code: "preserve_constraint_violated" };
      }
    }
    const next = { ...action.payload.next_document, version: document.version + 1, generated_at: nowIso() };
    const parsed = CanvasDocumentSchema.safeParse(next);
    return parsed.success ? { ok: true, document: parsed.data } : { ok: false, error_code: "document_schema_invalid" };
  }

  if (action.kind === "capability.placeholder.create") {
    if (document.nodes.some((n) => n.id === action.payload.node_id)) return { ok: false, error_code: "node_id_exists" };
    const at = nowIso();
    const node = {
      id: action.payload.node_id,
      title: action.payload.title,
      description: action.payload.rationale,
      sources: [],
      evidence: [],
      status: "fresh" as const,
      controls: { can_refresh: false, can_remove: true, can_edit: false, can_export: false },
      created_at: at,
      updated_at: at,
      provenance: { kind: "hermes" as const, at },
      layer: "D" as const,
      kind: "capability_placeholder" as const,
      capability_proposal_id: action.payload.capability_proposal_id,
    };
    const next = { ...document, version: document.version + 1, nodes: [...document.nodes, node] };
    const parsed = CanvasDocumentSchema.safeParse(next);
    return parsed.success ? { ok: true, document: parsed.data } : { ok: false, error_code: "placeholder_schema_invalid" };
  }

  if (action.kind === "capability.placeholder.remove") {
    const before = document.nodes.length;
    const next = {
      ...document,
      version: document.version + 1,
      nodes: document.nodes.filter((n) => n.id !== action.payload.node_id),
      edges: document.edges.filter((e) => e.from.node_id !== action.payload.node_id && e.to.node_id !== action.payload.node_id),
      sections: document.sections.map((s) => ({ ...s, node_ids: s.node_ids.filter((id) => id !== action.payload.node_id) })),
      views: document.views.map((v) => ({ ...v, node_ids: v.node_ids.filter((id) => id !== action.payload.node_id) })),
      layout: document.layout.mode === "grid" && document.layout.grid
        ? { ...document.layout, grid: { ...document.layout.grid, cells: document.layout.grid.cells.filter((c) => c.node_id !== action.payload.node_id) } }
        : document.layout.mode === "freeform" && document.layout.freeform
          ? { ...document.layout, freeform: { ...document.layout.freeform, positions: document.layout.freeform.positions.filter((p) => p.node_id !== action.payload.node_id) } }
          : document.layout,
    };
    if (before === next.nodes.length) return { ok: false, error_code: "node_missing" };
    return { ok: true, document: next };
  }

  if (action.kind === "primitive_surface.create") {
    if (document.nodes.some((n) => n.id === action.payload.node_id)) return { ok: false, error_code: "node_id_exists" };
    const at = nowIso();
    const node = {
      id: action.payload.node_id,
      title: action.payload.title,
      description: action.payload.rationale,
      confidence: action.payload.confidence,
      sources: [],
      evidence: action.payload.evidence ?? [],
      status: "fresh" as const,
      controls: { can_refresh: false, can_remove: true, can_edit: false, can_export: false },
      created_at: at,
      updated_at: at,
      provenance: { kind: "hermes" as const, at },
      layer: "C" as const,
      kind: "primitive_surface" as const,
      surface_spec: action.payload.surface_spec,
    };
    const next = { ...document, version: document.version + 1, nodes: [...document.nodes, node] };
    const parsed = CanvasDocumentSchema.safeParse(next);
    return parsed.success ? { ok: true, document: parsed.data } : { ok: false, error_code: "primitive_schema_invalid" };
  }

  return { ok: false, error_code: "action_not_implemented_phase_a" };
}
