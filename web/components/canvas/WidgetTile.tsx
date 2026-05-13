"use client";

import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import type { CanvasWidget } from "../../lib/canvas/schema";
import { getDescriptor } from "../../lib/canvas/registry";
import { ConfidenceChip } from "../DrillModal";

function StatusChip({ status }: { status: CanvasWidget["status"] }) {
  const cls =
    status === "fresh"
      ? "chip-high"
      : status === "stale"
        ? "chip-low"
        : status === "watching"
          ? "chip-med"
          : "chip-na";
  return <span className={`chip ${cls} text-[10px]`}>{status}</span>;
}

function kindLabel(widget: CanvasWidget, fallback: string): string {
  if (widget.kind === "extension") return `${fallback} · ${widget.data.ext_kind}`;
  return fallback;
}

function sourceSummary(widget: CanvasWidget): string {
  const source = widget.source.replace(/_/g, " ");
  const count = widget.sources.length;
  return `${source} · ${count} source${count === 1 ? "" : "s"}`;
}

export default function WidgetTile({
  widget,
  onOpen,
}: {
  widget: CanvasWidget;
  onOpen: () => void;
}) {
  const descriptor = getDescriptor(widget.kind);
  const Tile = descriptor.Tile;
  const label = kindLabel(widget, descriptor.label);

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="card p-5 flex flex-col h-full"
      data-testid="canvas-widget"
      data-widget-kind={widget.kind}
      data-widget-id={widget.id}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-widest text-muted mb-1">
            {label}
          </div>
          <button
            type="button"
            onClick={onOpen}
            className="block max-w-full truncate text-left text-sm font-medium leading-tight text-ink hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
            title={widget.title}
          >
            {widget.title}
          </button>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {widget.confidence && <ConfidenceChip value={widget.confidence} />}
          <StatusChip status={widget.status} />
          {widget.source === "chat" && (
            <span className="chip chip-na text-[10px]" title="Added in chat">
              Added in chat
            </span>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <Tile widget={widget as never} />
      </div>

      <footer className="mt-3 pt-3 border-t border-[var(--line)] flex items-center justify-between gap-2 text-xs text-muted">
        <span className="min-w-0 truncate" title={sourceSummary(widget)}>
          {sourceSummary(widget)}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-0.5 text-muted hover:text-accent whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
        >
          Drill <ChevronRight className="size-3" />
        </button>
      </footer>
    </motion.article>
  );
}
