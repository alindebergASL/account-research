"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import type { Canvas, CanvasWidget } from "../../lib/canvas/schema";
import { getDescriptor } from "../../lib/canvas/registry";
import WidgetTile from "./WidgetTile";
import DrillModal from "../DrillModal";

function gridSpanClass(span: number): string {
  const safe = Math.min(Math.max(Math.round(span), 1), 12);
  switch (safe) {
    case 2:
      return "md:col-span-2";
    case 3:
      return "md:col-span-3";
    case 4:
      return "md:col-span-4";
    case 5:
      return "md:col-span-5";
    case 6:
      return "md:col-span-6";
    case 7:
      return "md:col-span-7";
    case 8:
      return "md:col-span-8";
    case 9:
      return "md:col-span-9";
    case 10:
      return "md:col-span-10";
    case 11:
      return "md:col-span-11";
    case 12:
      return "md:col-span-12";
    default:
      return "md:col-span-1";
  }
}

function formatGeneratedAt(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value || "unknown";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function widgetEvidenceCount(widget: CanvasWidget): number {
  return widget.evidence.length +
    (widget.kind === "evidence_board" ? widget.data.items.length : 0);
}

function ModalFooter({ widget }: { widget: CanvasWidget }) {
  const evidenceCount = widgetEvidenceCount(widget);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>Provenance: {widget.source.replace(/_/g, " ")}</span>
      <span>{widget.sources.length} source{widget.sources.length === 1 ? "" : "s"}</span>
      <span>{evidenceCount} evidence item{evidenceCount === 1 ? "" : "s"}</span>
      <span>Controls disabled · audit-ready preview</span>
      <span>Updated {formatGeneratedAt(widget.updated_at)}</span>
    </div>
  );
}

export default function ReadOnlyCanvasView({ canvas }: { canvas: Canvas }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = canvas.widgets.find((w) => w.id === openId) ?? null;
  const Detail = open ? getDescriptor(open.kind).Detail : null;
  const descriptor = open ? getDescriptor(open.kind) : null;

  return (
    <section
      data-testid="read-only-canvas"
      className="max-w-7xl mx-auto px-6 pb-24"
    >
      {/* Header */}
      <header className="pt-10 pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted">
          <span className="size-1.5 rounded-full bg-accent" />
          Dynamic canvas preview
          <span
            className="inline-flex items-center gap-1 chip chip-na text-[10px] ml-2"
            title="Read-only preview derived from the saved brief"
          >
            <Lock className="size-3" aria-hidden="true" /> Read-only
          </span>
        </div>
        <h1 className="font-display text-4xl tracking-tight leading-tight mt-2">
          {canvas.account_name}
        </h1>
        <p className="text-sm text-muted mt-1">
          Read-only view derived from the saved brief. Widget actions are disabled
          until controlled agent approvals are enabled.
        </p>
        <div className="text-xs text-muted mt-2 flex flex-wrap items-center gap-3">
          <span>{canvas.widgets.length} widgets</span>
          <span>Generated {formatGeneratedAt(canvas.generated_at)}</span>
          <span>{canvas.meta.agent_readiness.source_count} sources</span>
          <span>{canvas.meta.agent_readiness.evidence_count} evidence items</span>
          <span>
            {canvas.meta.agent_readiness.controls_enabled
              ? "Controls enabled"
              : "Controls disabled"}
          </span>
        </div>
      </header>

      {/* Grid */}
      <div
        data-testid="widget-grid"
        data-legacy-testid="canvas-widget-grid"
        className="grid grid-cols-1 md:grid-cols-12 gap-4 auto-rows-min"
      >
        {canvas.widgets.map((w) => (
          <div
            key={w.id}
            className={`col-span-1 min-w-0 ${gridSpanClass(w.layout.w)}`}
          >
            <WidgetTile widget={w} onOpen={() => setOpenId(w.id)} />
          </div>
        ))}
      </div>

      <DrillModal
        open={!!open}
        title={open?.title ?? ""}
        subtitle={open && descriptor ? descriptor.label : undefined}
        onClose={() => setOpenId(null)}
        footer={open ? <ModalFooter widget={open} /> : undefined}
      >
        {open && Detail && <Detail widget={open as never} />}
      </DrillModal>
    </section>
  );
}
