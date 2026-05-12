"use client";

import { useState } from "react";
import type { Canvas } from "@/lib/canvas/schema";
import { getDescriptor } from "@/lib/canvas/registry";
import WidgetTile from "./WidgetTile";
import DrillModal from "@/components/DrillModal";

export default function ReadOnlyCanvasView({ canvas }: { canvas: Canvas }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = canvas.widgets.find((w) => w.id === openId) ?? null;
  const Detail = open ? getDescriptor(open.kind).Detail : null;

  return (
    <section
      data-testid="read-only-canvas"
      className="max-w-7xl mx-auto px-6 pb-24"
    >
      <header className="pt-10 pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted">
          <span className="size-1.5 rounded-full bg-accent" /> Dynamic canvas
          preview
        </div>
        <h1 className="font-display text-4xl tracking-tight leading-tight mt-2">
          {canvas.account_name}
        </h1>
        <p className="text-sm text-muted mt-1">
          Read-only view derived from the saved brief.
        </p>
        <div className="text-xs text-muted mt-2 flex flex-wrap gap-3">
          <span>{canvas.widgets.length} widgets</span>
          <span>·</span>
          <span>version {canvas.version}</span>
        </div>
      </header>

      <div
        data-testid="canvas-widget-grid"
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        {canvas.widgets.map((w) => (
          <WidgetTile
            key={w.id}
            widget={w}
            onOpen={() => setOpenId(w.id)}
          />
        ))}
      </div>

      <DrillModal
        open={!!open}
        title={open?.title ?? ""}
        subtitle={open ? `Widget kind: ${open.kind}` : undefined}
        onClose={() => setOpenId(null)}
      >
        {open && Detail && <Detail widget={open as never} />}
      </DrillModal>
    </section>
  );
}
