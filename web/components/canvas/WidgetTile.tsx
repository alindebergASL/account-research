"use client";

import { motion } from "framer-motion";
import type { CanvasWidget } from "@/lib/canvas/schema";
import { getDescriptor } from "@/lib/canvas/registry";

export default function WidgetTile({
  widget,
  onOpen,
}: {
  widget: CanvasWidget;
  onOpen: () => void;
}) {
  const descriptor = getDescriptor(widget.kind);
  const Tile = descriptor.Tile;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onOpen}
      className="card p-5 cursor-pointer"
      data-testid="canvas-widget"
      data-widget-kind={widget.kind}
      data-widget-id={widget.id}
    >
      <Tile widget={widget as never} />
    </motion.div>
  );
}
