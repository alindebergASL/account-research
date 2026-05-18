"use client";

import { Activity, AlertTriangle, Sparkles, Target, TrendingUp } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { Canvas } from "../../lib/canvas/schema";
import {
  buildExecutiveCockpit,
  type ExecutiveCockpitData,
} from "../../lib/canvas/cockpit";
import { ConfidenceChip } from "../DrillModal";
import { ConfidenceBar, ConfidenceCountsInline, MiniGauge } from "./visuals";

// Executive Cockpit — a short, presentational status strip above the
// Canvas widget grid. Five compact cells summarising what an account
// owner most needs at a glance:
//
//   1. AI maturity (numeric gauge)
//   2. Top opportunity (first item from section-top-initiatives)
//   3. Top risk (first item from section-risks)
//   4. Evidence confidence (distribution from evidence-board)
//   5. Recommended next action (from action-next, ink-on-white)
//
// Strictly read-only:
//   - no onClick / role="button" / tabIndex
//   - no hover lift
//   - no keyboard activation
//   - never triggers a drill-in
//
// Mount notes: this component is mounted inside ReadOnlyCanvasView,
// which already provides `max-w-7xl mx-auto px-6`. The outer wrapper
// here MUST NOT re-add a max-width container or it will double-indent.

const CELL_BASE =
  "rounded-2xl border border-[var(--line)] bg-white p-4 flex flex-col gap-2 min-w-0";
const LABEL_BASE =
  "inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted";

function CockpitCell({
  label,
  icon,
  className = "",
  style,
  children,
  testId,
}: {
  label: string;
  icon?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={`${CELL_BASE} ${className}`}
      style={style}
      data-testid={testId}
    >
      <div className={LABEL_BASE}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function EmptyValue({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

function MaturityCell({ data }: { data: ExecutiveCockpitData["maturity"] }) {
  return (
    <CockpitCell
      label="AI maturity"
      icon={<Sparkles className="size-3" aria-hidden="true" />}
      testId="cockpit-cell-maturity"
    >
      {data ? (
        <div className="flex items-center gap-3">
          <MiniGauge current={data.current} max={data.max} size={48} />
          <div className="min-w-0">
            <div className="font-display text-2xl leading-none tracking-tight">
              {data.current}
              <span className="text-muted text-base"> / {data.max}</span>
            </div>
            {data.rationale && (
              <p
                className="mt-1 text-[11px] text-muted line-clamp-2"
                title={data.rationale}
              >
                {data.rationale}
              </p>
            )}
          </div>
        </div>
      ) : (
        <EmptyValue>—</EmptyValue>
      )}
    </CockpitCell>
  );
}

function TopOpportunityCell({
  data,
}: {
  data: ExecutiveCockpitData["topOpportunity"];
}) {
  return (
    <CockpitCell
      label="Top opportunity"
      icon={
        <TrendingUp
          className="size-3"
          style={{ color: "var(--tone-opportunity)" }}
          aria-hidden="true"
        />
      }
      style={{ borderLeftColor: "var(--tone-opportunity)", borderLeftWidth: "4px" }}
      testId="cockpit-cell-top-opportunity"
    >
      {data ? (
        <div className="space-y-1.5 min-w-0">
          <p
            className="text-sm font-medium leading-tight text-ink line-clamp-2"
            title={data.text}
          >
            {data.text}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {data.confidence && <ConfidenceChip value={data.confidence} />}
            {data.tag && (
              <span
                className="text-[11px] text-muted line-clamp-1"
                title={data.tag}
              >
                {data.tag}
              </span>
            )}
          </div>
        </div>
      ) : (
        <EmptyValue>No initiatives surfaced.</EmptyValue>
      )}
    </CockpitCell>
  );
}

function TopRiskCell({ data }: { data: ExecutiveCockpitData["topRisk"] }) {
  return (
    <CockpitCell
      label="Top risk"
      icon={
        <AlertTriangle
          className="size-3"
          style={{ color: "var(--tone-risk)" }}
          aria-hidden="true"
        />
      }
      style={{ borderLeftColor: "var(--tone-risk)", borderLeftWidth: "4px" }}
      testId="cockpit-cell-top-risk"
    >
      {data ? (
        <div className="space-y-1.5 min-w-0">
          <p
            className="text-sm font-medium leading-tight text-ink line-clamp-2"
            title={data.text}
          >
            {data.text}
          </p>
          {data.confidence && (
            <div className="flex flex-wrap items-center gap-2">
              <ConfidenceChip value={data.confidence} />
            </div>
          )}
        </div>
      ) : (
        <EmptyValue>No risks identified.</EmptyValue>
      )}
    </CockpitCell>
  );
}

function EvidenceConfidenceCell({
  data,
}: {
  data: ExecutiveCockpitData["evidence"];
}) {
  return (
    <CockpitCell
      label="Evidence confidence"
      icon={
        <Activity
          className="size-3"
          style={{ color: "var(--tone-signal)" }}
          aria-hidden="true"
        />
      }
      testId="cockpit-cell-evidence"
    >
      {data ? (
        <div className="space-y-1.5">
          <ConfidenceBar counts={data.counts} size="md" />
          <ConfidenceCountsInline counts={data.counts} />
          <p className="text-[11px] text-muted">
            {data.total} evidence item{data.total === 1 ? "" : "s"}
          </p>
        </div>
      ) : (
        <EmptyValue>No evidence yet.</EmptyValue>
      )}
    </CockpitCell>
  );
}

function NextActionCell({
  data,
}: {
  data: ExecutiveCockpitData["nextAction"];
}) {
  // Inline-style background/foreground/border so the cell stays dark
  // even if some surrounding rule (e.g. .card hover) tries to repaint
  // it. This is the same guard rail PR #17 applied to WidgetTile.
  const inkStyle: CSSProperties = {
    backgroundColor: "var(--ink)",
    color: "white",
    borderColor: "var(--ink)",
  };
  const rawText = data?.detail || data?.label || "";
  // Pointer-only: render a fixed status label plus an in-page link to the
  // Recommended Move card. The cockpit cell must not duplicate the body
  // copy of the action card itself.
  const hasPriority = !!(data && rawText.trim().length > 0);
  return (
    <div
      className={`${CELL_BASE} lg:col-span-1`}
      style={inkStyle}
      data-testid="cockpit-pointer"
    >
      <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/70">
        <Target className="size-3" aria-hidden="true" />
        <span>Priority move</span>
      </div>
      {hasPriority ? (
        <>
          <p
            className="text-sm font-medium leading-snug line-clamp-1"
            style={{ color: "white" }}
          >
            Priority move ready
          </p>
          <a
            href="#action-next"
            className="text-[11px] underline-offset-2 hover:underline"
            style={{ color: "rgba(255,255,255,0.7)" }}
          >
            See Recommended Move below
          </a>
        </>
      ) : (
        <p className="text-sm" style={{ color: "rgba(255,255,255,0.7)" }}>
          No priority move yet
        </p>
      )}
    </div>
  );
}

export default function ExecutiveCockpit({ canvas }: { canvas: Canvas }) {
  const data = buildExecutiveCockpit(canvas);

  return (
    <section
      aria-label="Executive cockpit"
      data-testid="executive-cockpit"
      className="mb-5"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 auto-rows-min">
        <MaturityCell data={data.maturity} />
        <TopOpportunityCell data={data.topOpportunity} />
        <TopRiskCell data={data.topRisk} />
        <EvidenceConfidenceCell data={data.evidence} />
        <NextActionCell data={data.nextAction} />
      </div>
    </section>
  );
}
