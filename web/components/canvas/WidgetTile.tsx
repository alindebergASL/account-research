"use client";

import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { CanvasWidget } from "../../lib/canvas/schema";
import { getDescriptor } from "../../lib/canvas/registry";
import { widgetFraming } from "../../lib/canvas/framing";
import { ConfidenceChip } from "../DrillModal";
import {
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
  return <span className={`chip ${cls} text-[10px] capitalize`}>{status}</span>;
}

function shouldShowStatusChip(status: CanvasWidget["status"]): boolean {
  // Normal fresh cards should not carry a repeated badge. Show status only
  // when it changes the reader's decision: stale, watched, or archived.
  return status !== "fresh";
}

function provenanceSummary(widget: CanvasWidget): string {
  const sourceCount = widget.sources.length;
  const evidenceCount =
    widget.evidence.length +
    (widget.kind === "evidence_board" ? widget.data.items.length : 0);

  if (sourceCount > 0 && evidenceCount > 0) {
    return `${sourceCount} source${sourceCount === 1 ? "" : "s"} · ${evidenceCount} evidence item${evidenceCount === 1 ? "" : "s"}`;
  }
  if (sourceCount > 0) {
    return `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;
  }
  if (evidenceCount > 0) {
    return `${evidenceCount} evidence item${evidenceCount === 1 ? "" : "s"}`;
  }
  if (widget.source === "chat") return "Conversation insight";
  if (widget.source === "research") return "Research-backed";
  if (widget.source === "model") return "Modeled insight";
  if (widget.source === "refresh") return "Refreshed insight";
  if (widget.source === "user") return "User-added";
  return "";
}

function sectionLabel(sectionKey: string): string {
  switch (sectionKey) {
    case "snapshot":
      return "Account context";
    case "why_now":
    case "priority_summary":
      return "Why now";
    case "recent_signals":
      return "Recent signals";
    case "ai_tech_maturity":
      return "AI readiness";
    case "top_initiatives":
      return "Priority initiatives";
    case "technical_footprint":
      return "Technical landscape";
    case "programs_procurement":
      return "Procurement path";
    case "personas":
      return "Buying committee";
    case "buying_path":
      return "Decision path";
    case "first_angle":
      return "Conversation angle";
    case "risks":
      return "Risk watch";
    case "competitive_signals":
      return "Vendor landscape";
    case "sources":
      return "Source coverage";
    case "extensions":
      return "Added insight";
    default:
      return "Brief insight";
  }
}

function kindLabel(widget: CanvasWidget, fallback: string): string {
  // Prefer the Hermes-voiced eyebrow from framing.ts when the helper has
  // one for this widget kind. Falls back to the legacy section / registry
  // label so we never render an empty eyebrow.
  const framing = widgetFraming(widget);
  if (framing.eyebrow) return framing.eyebrow;
  if (widget.kind === "section_ref") return sectionLabel(widget.data.section_key);
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
  const framing = widgetFraming(widget);
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
  // Wrap to two lines so tablet-width viewports (around 780px) don't clip
  // the right edge of long titles; everything beyond that is still
  // available in the drill-in modal.
  const titleClass = isAction
    ? "block max-w-full text-left text-[15px] font-semibold leading-snug tracking-tight text-white whitespace-normal break-words line-clamp-2"
    : "block max-w-full text-left text-[15px] font-semibold leading-snug tracking-tight text-ink whitespace-normal break-words line-clamp-2";
  const footerClass = isAction
    ? "mt-4 pt-3 border-t border-white/15 flex items-center justify-between gap-3 text-xs text-white/75"
    : "mt-4 pt-3 border-t border-[var(--line)] flex items-center justify-between gap-3 text-xs text-muted";
  const provenance = provenanceSummary(widget);

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
      aria-label={`View details for ${widget.title}`}
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
          {framing.oneLine && (
            <p
              data-testid="widget-framing"
              className={
                isAction
                  ? "mt-1 text-[12px] italic leading-snug text-white/75 line-clamp-1 break-words"
                  : "mt-1 text-[12px] italic leading-snug text-muted line-clamp-1 break-words"
              }
              title={framing.oneLine}
            >
              {framing.oneLine}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {widget.confidence && <ConfidenceChip value={widget.confidence} />}
          {shouldShowStatusChip(widget.status) && <StatusChip status={widget.status} />}
        </div>
      </header>

      <div className="flex-1 min-h-0 min-w-0 break-words">
        <Tile widget={widget as never} />
      </div>

      <footer className={footerClass}>
        {provenance ? (
          <span className="min-w-0 truncate" title={provenance}>
            {provenance}
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        {/*
          Open affordance. Whole card is already the click target; this is a
          subtle iconographic cue, not repeated "View details" text on every
          card. The article carries the accessible name in `aria-label`, so
          this element stays aria-hidden and visual-only. On the dark
          action_panel we paint explicit border + background so contrast
          stays readable (PR #17 guard rail).
        */}
        <span
          aria-hidden="true"
          title="Open details"
          className={
            isAction
              ? "inline-flex shrink-0 items-center justify-center rounded-full size-7 border transition-colors"
              : "inline-flex shrink-0 items-center justify-center rounded-full size-7 border border-[var(--line)] bg-white text-muted group-hover:text-accent group-hover:border-accent/50 group-hover:bg-accent/5 transition-colors"
          }
          style={
            isAction
              ? {
                  borderColor: "rgba(255,255,255,0.32)",
                  backgroundColor: "rgba(255,255,255,0.06)",
                  color: "white",
                }
              : undefined
          }
        >
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </span>
      </footer>
    </motion.article>
  );
}
