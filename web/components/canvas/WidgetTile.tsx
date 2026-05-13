"use client";

import { motion } from "framer-motion";
import { ChevronRight, Lock } from "lucide-react";
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

export default function WidgetTile({
  widget,
  onOpen,
}: {
  widget: CanvasWidget;
  onOpen: () => void;
}) {
  const descriptor = getDescriptor(widget.kind);
  const Tile = descriptor.Tile;
  const sourceCount = widget.sources.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      className="card p-5 cursor-pointer flex flex-col h-full"
      data-testid="canvas-widget"
      data-widget-kind={widget.kind}
      data-widget-id={widget.id}
    >
      {/* Body */}
      <div className="flex-1 min-h-0">
        <Tile widget={widget as never} />
      </div>

      {/* Footer */}
      <div className="mt-3 pt-3 border-t border-[var(--line)] flex items-center justify-between gap-2 text-xs text-muted">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {widget.confidence && <ConfidenceChip value={widget.confidence} />}
          <StatusChip status={widget.status} />
          {sourceCount > 0 && (
            <span>
              {sourceCount} source{sourceCount === 1 ? "" : "s"}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1 chip chip-na text-[10px]"
            title="Read-only preview"
          >
            <Lock className="size-3" /> Read-only
          </span>
        </div>
        <span className="inline-flex items-center gap-0.5 text-muted whitespace-nowrap">
          Drill <ChevronRight className="size-3" />
        </span>
      </div>
    </motion.div>
  );
}
