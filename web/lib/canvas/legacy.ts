import { Canvas, type Canvas as LegacyCanvas, type CanvasWidget } from "./schema";
import { CanvasDocument, type CanvasDocument as CanvasDocumentType, type CanvasSection } from "./document";

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function sectionIntentFor(kind: CanvasWidget["kind"]): CanvasSection["intent"] {
  if (kind === "evidence_board") return "evidence";
  if (kind === "action_panel") return "next_actions";
  if (kind === "open_questions") return "questions";
  if (kind === "opportunity_risk_split") return "risks";
  return "freeform";
}

export function isCanvasDocument(raw: unknown): raw is CanvasDocumentType {
  return CanvasDocument.safeParse(raw).success;
}

export function isLegacyCanvas(raw: unknown): raw is LegacyCanvas {
  if (!raw || typeof raw !== "object") return false;
  if ("schema_version" in raw) return false;
  return Canvas.safeParse(raw).success;
}

export function legacyCanvasToDocument(c: LegacyCanvas, briefId: string): CanvasDocumentType {
  const generatedAt = c.generated_at || new Date(0).toISOString();
  const provenance = { kind: "legacy_conversion" as const, at: generatedAt };
  const sectionMap = new Map<CanvasSection["intent"], string[]>();
  for (const w of c.widgets) {
    const intent = sectionIntentFor(w.kind);
    sectionMap.set(intent, [...(sectionMap.get(intent) ?? []), w.id]);
  }
  const sections = Array.from(sectionMap.entries()).map(([intent, nodeIds]) => ({
    id: `legacy-section-${intent}`,
    title: intent.replace(/_/g, " "),
    intent,
    node_ids: nodeIds,
    collapse_default: false,
    provenance,
  }));
  const doc = {
    schema_version: 1 as const,
    document_id: `legacy-${briefId}-${c.version}`,
    brief_id: briefId,
    version: c.version,
    generated_at: generatedAt,
    generated_by: provenance,
    nodes: c.widgets.map((w) => ({
      id: w.id,
      title: w.title,
      description: w.description,
      confidence: w.confidence,
      source: w.source,
      why_included: w.why_included,
      sources: w.sources,
      evidence: w.evidence,
      status: w.status,
      controls: w.controls,
      created_at: w.created_at,
      updated_at: w.updated_at,
      provenance,
      layer: "A" as const,
      kind: "widget" as const,
      widget_kind: w.kind,
      widget_data: w.data,
      legacy_widget: w,
    })),
    edges: [],
    sections,
    layout: {
      mode: "grid" as const,
      grid: { cols: 12 as const, cells: c.widgets.map((w) => ({ node_id: w.id, ...w.layout })) },
    },
    views: [],
    rationale: [],
    meta: { legacy_canvas_hash: stableStringify(c) },
  };
  return CanvasDocument.parse(doc);
}
