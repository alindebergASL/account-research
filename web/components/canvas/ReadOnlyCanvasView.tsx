"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import type { Canvas, CanvasWidget } from "../../lib/canvas/schema";
import { getDescriptor } from "../../lib/canvas/registry";
import { tierFor, TIER_LABELS, type TierName } from "../../lib/canvas/visualGrammar";
import WidgetTile from "./WidgetTile";
import DrillModal from "../DrillModal";
import ExecutiveCockpit from "./ExecutiveCockpit";

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
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function widgetEvidenceCount(widget: CanvasWidget): number {
  return widget.evidence.length +
    (widget.kind === "evidence_board" ? widget.data.items.length : 0);
}

function provenanceLabel(source: CanvasWidget["source"]): string {
  // De-internalize raw provenance tags ("hermes" / "system" / etc.) so the
  // modal footer reads as authored prose rather than a debug line.
  switch (source) {
    case "hermes":
      return "Synthesized from brief evidence";
    case "system":
      return "Derived from the account brief";
    case "model":
      return "Modeled from the account brief";
    case "research":
      return "Research-backed";
    case "chat":
      return "Added in chat";
    case "user":
      return "Added by user";
    case "refresh":
      return "Refreshed insight";
    default:
      return "Derived from the account brief";
  }
}

// Consolidated footer: one provenance line plus counts and last-updated.
// The duplicate "Review-only recommendation" label lives on the primary
// Recommended Move dossier; surfacing it again here on every modal was
// noise.
function ModalFooter({ widget }: { widget: CanvasWidget }) {
  const sourceCount = widget.sources.length;
  const evidenceCount = widgetEvidenceCount(widget);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>{provenanceLabel(widget.source)}</span>
      {sourceCount > 0 && (
        <span>{sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
      )}
      {evidenceCount > 0 && (
        <span>{evidenceCount} evidence item{evidenceCount === 1 ? "" : "s"}</span>
      )}
      <span>Updated {formatGeneratedAt(widget.updated_at)}</span>
    </div>
  );
}

function TierHeader({ tier }: { tier: TierName }) {
  return (
    <div className="flex items-center gap-3 pb-2">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted">
        {TIER_LABELS[tier]}
      </span>
      <span className="flex-1 h-px bg-[var(--line)]" aria-hidden="true" />
    </div>
  );
}

function editorialModuleCount(canvas: Canvas): number {
  return canvas.widgets.filter((w) => w.kind !== "metric").length;
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
      <header className="pt-10 pb-7">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted">
          <span className="size-1.5 rounded-full bg-accent" />
          Hermes-built strategic canvas
          <span
            className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-white px-2.5 py-1 text-[10px] font-semibold text-ink shadow-sm"
            title="You can inspect details; editing and agent actions require a later approval flow."
          >
            <Lock className="size-3" aria-hidden="true" /> Review mode
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 min-w-0 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl min-w-0">
            <h1 className="font-display text-4xl tracking-tight leading-tight truncate">
              {canvas.account_name}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              Hermes arranges the saved brief into a dynamic account workspace:
              the strongest signals, evidence, risks, and next moves are composed
              for review, not merely listed as another brief page.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:min-w-[420px]">
            <span className="rounded-xl border border-[var(--line)] bg-white px-3 py-2 shadow-sm">
              <strong className="block text-base leading-none text-ink">
                {editorialModuleCount(canvas)}
              </strong>
              <span className="text-muted">priority areas</span>
            </span>
            <span className="rounded-xl border border-[var(--line)] bg-white px-3 py-2 shadow-sm">
              <strong className="block text-base leading-none text-ink">
                {canvas.meta.agent_readiness.source_count}
              </strong>
              <span className="text-muted">sources</span>
            </span>
            <span className="rounded-xl border border-[var(--line)] bg-white px-3 py-2 shadow-sm">
              <strong className="block text-base leading-none text-ink">
                {canvas.meta.agent_readiness.evidence_count}
              </strong>
              <span className="text-muted">evidence points</span>
            </span>
            <span className="rounded-xl border border-[var(--line)] bg-white px-3 py-2 shadow-sm">
              <strong className="block text-sm leading-none text-ink">
                {formatGeneratedAt(canvas.generated_at)}
              </strong>
              <span className="text-muted">generated</span>
            </span>
          </div>
        </div>
      </header>

      <ExecutiveCockpit canvas={canvas} />

      {/* Grid */}
      <div
        data-testid="widget-grid"
        data-legacy-testid="canvas-widget-grid"
        className="grid grid-cols-1 md:grid-cols-12 gap-4 auto-rows-min"
      >
        {(() => {
          // Walk widgets in emission order; insert a full-width tier
          // header before the first widget of each tier. Tiers with zero
          // widgets do not render a header — empty tiers are honest.
          // Subsequent widgets in the same tier (after another tier
          // intervened) follow without a duplicate header.
          const seenTiers = new Set<TierName>();
          const out: React.ReactNode[] = [];
          for (const w of canvas.widgets) {
            const tier = tierFor(w);
            if (!seenTiers.has(tier)) {
              seenTiers.add(tier);
              out.push(
                <div
                  key={`tier-${tier}`}
                  data-testid={`tier-header-${tier}`}
                  className="col-span-1 md:col-span-12 mt-4 first:mt-0"
                >
                  <TierHeader tier={tier} />
                </div>,
              );
            }
            out.push(
              <div
                key={w.id}
                id={w.id}
                className={`col-span-1 min-w-0 ${gridSpanClass(w.layout.w)} scroll-mt-24`}
              >
                <WidgetTile widget={w} onOpen={() => setOpenId(w.id)} />
              </div>,
            );
          }
          return out;
        })()}
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
