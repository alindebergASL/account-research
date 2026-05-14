"use client";

import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { CanvasWidget } from "../../lib/canvas/schema";
import { getDescriptor } from "../../lib/canvas/registry";
import { ConfidenceChip } from "../DrillModal";
import {
  SourceTypeBadge,
  ToneIcon,
  semanticAccentClass,
  semanticAccentStyle,
  sectionKeyTone,
} from "./visuals";

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

// section_ref widgets get a tone left-accent based on section_key
// (e.g. risks → red, top_initiatives → green). Other kinds default
// to neutral / no accent.
function widgetTone(widget: CanvasWidget) {
  if (widget.kind === "section_ref") {
    return sectionKeyTone(widget.data.section_key);
  }
  return "neutral" as const;
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
  const tone = widgetTone(widget);
  const isAction = widget.kind === "action_panel";

  function handleCardKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  // Inverted treatment for the Recommended next action so it visually
  // stands out the way the Brief view's next-action callout does.
  const cardClass = [
    "card group p-5 flex flex-col h-full cursor-pointer transition-all",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
    isAction
      ? "bg-ink text-white border-ink hover:border-ink/80"
      : "hover:border-accent/40",
    semanticAccentClass(tone),
  ]
    .filter(Boolean)
    .join(" ");

  const accentStyle = semanticAccentStyle(tone);
  const style: CSSProperties | undefined = isAction
    ? {
        color: "white",
        backgroundColor: "var(--ink)",
        borderColor: "var(--ink)",
        ...(accentStyle ?? {}),
      }
    : accentStyle;

  const labelClass = isAction
    ? "inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/60 mb-1"
    : "inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted mb-1";
  // Slightly stronger title hierarchy than the previous text-sm — closer
  // to the Brief view's executive feel without becoming the same component.
  const titleClass = isAction
    ? "block max-w-full truncate text-left text-[15px] font-semibold leading-tight tracking-tight text-white"
    : "block max-w-full truncate text-left text-[15px] font-semibold leading-tight tracking-tight text-ink";
  const footerClass = isAction
    ? "mt-3 pt-3 border-t border-white/15 flex items-center justify-between gap-2 text-xs text-white/70"
    : "mt-3 pt-3 border-t border-[var(--line)] flex items-center justify-between gap-2 text-xs text-muted";

  return (
    <motion.article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleCardKeyDown}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      style={style}
      className={cardClass}
      data-testid="canvas-widget"
      data-widget-kind={widget.kind}
      data-widget-id={widget.id}
      data-widget-tone={tone}
      aria-label={`Drill into ${widget.title}`}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={labelClass}>
            {tone !== "neutral" && <ToneIcon tone={tone} className="size-3" />}
            <span>{label}</span>
          </div>
          <div className={titleClass} title={widget.title}>
            {widget.title}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {widget.confidence && <ConfidenceChip value={widget.confidence} />}
          <StatusChip status={widget.status} />
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <Tile widget={widget as never} />
      </div>

      <footer className={footerClass}>
        <span className="min-w-0 flex items-center gap-2 truncate">
          <SourceTypeBadge source={widget.source} />
          <span
            className="truncate"
            title={`${widget.sources.length} source${
              widget.sources.length === 1 ? "" : "s"
            }`}
          >
            {widget.sources.length} source
            {widget.sources.length === 1 ? "" : "s"}
          </span>
        </span>
        <span
          className={
            isAction
              ? "inline-flex items-center gap-0.5 text-white/70 group-hover:text-white whitespace-nowrap"
              : "inline-flex items-center gap-0.5 text-muted group-hover:text-accent whitespace-nowrap"
          }
        >
          Drill <ChevronRight className="size-3" aria-hidden="true" />
        </span>
      </footer>
    </motion.article>
  );
}
