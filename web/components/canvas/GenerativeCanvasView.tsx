"use client";

import type { CanvasDocument } from "@/lib/canvas/document";
import { PrimitiveSurfaceRenderer } from "./PrimitiveSurfaceRenderer";

export function GenerativeCanvasView({ document }: { document: CanvasDocument }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4 text-slate-100">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Generative Canvas</h2>
          <p className="text-xs text-slate-500">schema v{document.schema_version} · document {document.document_id} · mode {document.layout.mode}</p>
        </div>
        <span className="rounded-full border border-emerald-800 px-3 py-1 text-xs text-emerald-300">Phase A rails</span>
      </div>
      <div className="grid grid-cols-12 gap-3">
        {document.nodes.map((node) => (
          <article key={node.id} className="col-span-12 rounded-xl border border-slate-800 bg-slate-900/70 p-3 md:col-span-6 xl:col-span-4">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{node.title}</h3>
                {node.description ? <p className="text-sm text-slate-400">{node.description}</p> : null}
              </div>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">Layer {node.layer}</span>
            </div>
            {node.kind === "primitive_surface" ? <PrimitiveSurfaceRenderer spec={node.surface_spec} sources={node.sources} /> : null}
            {node.kind === "capability_placeholder" ? <div className="rounded border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-100">New widget proposed. Capability proposal: <code>{node.capability_proposal_id}</code></div> : null}
            {node.kind === "widget" ? <pre className="max-h-48 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-300">{JSON.stringify({ widget_kind: node.widget_kind, data: node.widget_data }, null, 2)}</pre> : null}
          </article>
        ))}
      </div>
    </div>
  );
}
