"use client";

import { useState } from "react";
import { Lock, RefreshCw } from "lucide-react";
import type { Canvas } from "../../lib/canvas/schema";
import { getDescriptor } from "../../lib/canvas/registry";
import WidgetTile from "./WidgetTile";
import DrillModal from "../DrillModal";

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
            <Lock className="size-3" /> Read-only
          </span>
        </div>
        <h1 className="font-display text-4xl tracking-tight leading-tight mt-2">
          {canvas.account_name}
        </h1>
        <p className="text-sm text-muted mt-1">
          Read-only view derived from the saved brief.
        </p>
        <div className="text-xs text-muted mt-2 flex flex-wrap items-center gap-3">
          <span>{canvas.widgets.length} widgets</span>
          <span>·</span>
          <span>version {canvas.version}</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1 opacity-60">
            <RefreshCw className="size-3" />
            Refresh / actions coming later
          </span>
        </div>
      </header>

      {/* Grid */}
      <div
        data-testid="canvas-widget-grid"
        className="grid grid-cols-1 md:grid-cols-12 gap-4 auto-rows-min"
      >
        {canvas.widgets.map((w) => (
          <div
            key={w.id}
            className="col-span-1 min-w-0"
            style={{
              gridColumn: `span ${Math.min(Math.max(w.layout.w, 1), 12)} / span ${Math.min(Math.max(w.layout.w, 1), 12)}`,
            }}
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
      >
        {open && Detail && <Detail widget={open as never} />}
      </DrillModal>
    </section>
  );
}
