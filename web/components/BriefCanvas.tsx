"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Building2,
  TrendingUp,
  Cpu,
  Lightbulb,
  Users,
  ShoppingCart,
  Compass,
  AlertTriangle,
  Swords,
  Target,
  Link2,
  Server,
  FileSearch,
  Cloud,
  Database,
  BarChart3,
  Wrench,
  Award,
  ScrollText,
  ShieldCheck,
  PieChart,
  BarChart2,
  Download,
  Loader2,
} from "lucide-react";
import type {
  Brief,
  Initiative,
  Persona,
  ProgramsProcurement,
  Signal,
  Source,
  TechnicalFootprint,
} from "@/lib/schema";
import { briefCompleteness } from "@/lib/schema";
import Link from "next/link";
import { AlertCircle, RefreshCw } from "lucide-react";
import DrillModal, { ConfidenceChip, SourceLink } from "./DrillModal";
import BriefSwitcher from "./BriefSwitcher";
import BriefChat from "./BriefChat";
import ShareDialog from "./ShareDialog";
import { Share2 } from "lucide-react";

type DrillKind =
  | { kind: "snapshot" }
  | { kind: "priority" }
  | { kind: "signals" }
  | { kind: "maturity" }
  | { kind: "initiatives"; index?: number }
  | { kind: "tech" }
  | { kind: "programs" }
  | { kind: "confidence" }
  | { kind: "personas"; index?: number }
  | { kind: "buying" }
  | { kind: "angle" }
  | { kind: "risks" }
  | { kind: "competitive" }
  | { kind: "next" }
  | { kind: "sources" }
  | null;

export default function BriefCanvas({
  brief,
  currentBriefId,
  onBriefUpdate,
  canWrite = true,
  isOwner = true,
}: {
  brief: Brief;
  currentBriefId?: string;
  onBriefUpdate?: (next: Brief) => void;
  canWrite?: boolean;
  isOwner?: boolean;
}) {
  const [drill, setDrill] = useState<DrillKind>(null);
  const [showShare, setShowShare] = useState(false);

  const completeness = briefCompleteness(brief);

  return (
    <div className="max-w-7xl mx-auto px-6 pb-24">
      <Header
        brief={brief}
        currentBriefId={currentBriefId}
        canWrite={canWrite}
        isOwner={isOwner}
        onShareClick={() => setShowShare(true)}
      />

      {currentBriefId && onBriefUpdate && (
        <BriefChat
          briefId={currentBriefId}
          brief={brief}
          onBriefUpdate={onBriefUpdate}
          readOnly={!canWrite}
        />
      )}

      {showShare && currentBriefId && (
        <ShareDialog
          briefId={currentBriefId}
          briefName={brief.account_name}
          onClose={() => setShowShare(false)}
        />
      )}

      {completeness.isLow && (
        <LowQualityBanner brief={brief} completeness={completeness} />
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* Row 1: Snapshot wide + Maturity gauge */}
        <Tile
          className="col-span-12 md:col-span-8"
          onClick={() => setDrill({ kind: "snapshot" })}
        >
          <TileLabel icon={<Building2 className="size-4" />}>Account snapshot</TileLabel>
          <p className="text-lg leading-snug line-clamp-4">{brief.snapshot}</p>
          <Footnote>Click to drill into the priority summary</Footnote>
        </Tile>

        <Tile
          className="col-span-12 md:col-span-4"
          onClick={() => setDrill({ kind: "maturity" })}
        >
          <TileLabel icon={<Cpu className="size-4" />}>AI / tech maturity</TileLabel>
          <MaturityGauge rating={brief.ai_tech_maturity.rating} />
          <p className="text-sm text-muted line-clamp-3 mt-2">
            {brief.ai_tech_maturity.rationale}
          </p>
        </Tile>

        {/* Row 2: Priority + signals timeline */}
        <Tile
          className="col-span-12 md:col-span-5"
          onClick={() => setDrill({ kind: "priority" })}
        >
          <TileLabel icon={<TrendingUp className="size-4" />}>Why this account · why now</TileLabel>
          <p className="text-base leading-snug line-clamp-5">{brief.priority_summary}</p>
        </Tile>

        <Tile
          className="col-span-12 md:col-span-7"
          onClick={() => setDrill({ kind: "signals" })}
        >
          <TileLabel icon={<TrendingUp className="size-4" />}>
            Recent strategic signals
            <span className="ml-auto text-xs text-muted">{brief.recent_signals.length}</span>
          </TileLabel>
          <SignalsTimeline signals={brief.recent_signals.slice(0, 4)} />
        </Tile>

        {/* Row 2.5: Charts — evidence confidence + initiative landscape */}
        <Tile
          className="col-span-12 md:col-span-5"
          onClick={() => setDrill({ kind: "confidence" })}
        >
          <TileLabel icon={<PieChart className="size-4" />}>
            Evidence confidence
          </TileLabel>
          <ConfidenceDonut brief={brief} />
        </Tile>

        <Tile
          className="col-span-12 md:col-span-7 hover:!translate-y-0 hover:!cursor-default hover:!shadow-none"
          onClick={() => {}}
        >
          <TileLabel icon={<BarChart2 className="size-4" />}>
            Initiative landscape
          </TileLabel>
          <InitiativeBars
            initiatives={brief.top_initiatives}
            onPick={(i) => setDrill({ kind: "initiatives", index: i })}
          />
        </Tile>

        {/* Row 3: Initiatives grid */}
        <div className="col-span-12">
          <SectionLabel>Top initiatives</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {brief.top_initiatives.map((it, i) => (
              <InitiativeCard
                key={i}
                init={it}
                onClick={() => setDrill({ kind: "initiatives", index: i })}
              />
            ))}
          </div>
        </div>

        {/* Row 3.5: Technical footprint + Programs & procurement */}
        <Tile
          className="col-span-12 md:col-span-6"
          onClick={() => setDrill({ kind: "tech" })}
        >
          <TileLabel icon={<Server className="size-4" />}>Technical footprint</TileLabel>
          <TechFootprintPreview tf={brief.technical_footprint} />
        </Tile>

        <Tile
          className="col-span-12 md:col-span-6"
          onClick={() => setDrill({ kind: "programs" })}
        >
          <TileLabel icon={<FileSearch className="size-4" />}>
            Programs &amp; procurement
          </TileLabel>
          <ProgramsPreview pp={brief.programs_procurement} />
        </Tile>

        {/* Row 4: Personas */}
        <div className="col-span-12">
          <SectionLabel>Key personas</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {brief.personas.map((p, i) => (
              <PersonaCard
                key={i}
                persona={p}
                onClick={() => setDrill({ kind: "personas", index: i })}
              />
            ))}
          </div>
        </div>

        {/* Row 5: Buying path + first angle */}
        <Tile
          className="col-span-12 md:col-span-6"
          onClick={() => setDrill({ kind: "buying" })}
        >
          <TileLabel icon={<ShoppingCart className="size-4" />}>
            Buying / decision path
          </TileLabel>
          <p className="line-clamp-5 text-sm leading-relaxed">{brief.buying_path}</p>
        </Tile>

        <Tile
          className="col-span-12 md:col-span-6"
          onClick={() => setDrill({ kind: "angle" })}
        >
          <TileLabel icon={<Compass className="size-4" />}>First conversation angle</TileLabel>
          <p className="line-clamp-5 text-sm leading-relaxed">{brief.first_angle}</p>
        </Tile>

        {/* Row 6: Risks + competitive */}
        <Tile
          className="col-span-12 md:col-span-6"
          onClick={() => setDrill({ kind: "risks" })}
        >
          <TileLabel icon={<AlertTriangle className="size-4" />}>
            Risks &amp; watch-outs
            <span className="ml-auto text-xs text-muted">{brief.risks.length}</span>
          </TileLabel>
          <ul className="space-y-1.5">
            {brief.risks.slice(0, 4).map((r, i) => (
              <li key={i} className="text-sm flex gap-2">
                <span className="text-amber-600 shrink-0">▲</span>
                <span className="line-clamp-1">{r}</span>
              </li>
            ))}
          </ul>
        </Tile>

        {brief.competitive_signals.length > 0 ? (
          <Tile
            className="col-span-12 md:col-span-6"
            onClick={() => setDrill({ kind: "competitive" })}
          >
            <TileLabel icon={<Swords className="size-4" />}>
              Competitive / vendor signals
              <span className="ml-auto text-xs text-muted">
                {brief.competitive_signals.length}
              </span>
            </TileLabel>
            <ul className="space-y-1.5">
              {brief.competitive_signals.slice(0, 4).map((c, i) => (
                <li key={i} className="text-sm flex gap-2">
                  <span className="text-muted shrink-0">›</span>
                  <span className="line-clamp-1">{c}</span>
                </li>
              ))}
            </ul>
          </Tile>
        ) : (
          <Tile
            className="col-span-12 md:col-span-6 hover:!translate-y-0 hover:!cursor-default hover:!shadow-none"
            onClick={() => {}}
          >
            <TileLabel icon={<Swords className="size-4" />}>Competitive / vendor signals</TileLabel>
            <p className="text-sm text-muted">Not found in public sources.</p>
          </Tile>
        )}

        {/* Row 7: Next action callout */}
        <Tile
          className="col-span-12 !bg-ink !text-white !border-ink"
          onClick={() => setDrill({ kind: "next" })}
        >
          <div className="flex items-start gap-4">
            <div className="size-10 rounded-xl bg-white/10 grid place-items-center shrink-0">
              <Target className="size-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs uppercase tracking-widest text-white/60 mb-1">
                Recommended next action
              </div>
              <p className="text-lg leading-snug">{brief.next_action}</p>
            </div>
          </div>
        </Tile>

        {/* Sources */}
        <Tile
          className="col-span-12"
          onClick={() => setDrill({ kind: "sources" })}
        >
          <TileLabel icon={<Link2 className="size-4" />}>
            Key sources
            <span className="ml-auto text-xs text-muted">{brief.sources.length}</span>
          </TileLabel>
          <div className="flex flex-wrap gap-2">
            {brief.sources.slice(0, 8).map((s, i) => (
              <span
                key={i}
                className="text-xs px-2.5 py-1 rounded-full bg-[var(--bg)] border border-[var(--line)] line-clamp-1 max-w-[260px]"
              >
                {s.title || s.url}
              </span>
            ))}
            {brief.sources.length > 8 && (
              <span className="text-xs px-2.5 py-1 text-muted">
                +{brief.sources.length - 8} more
              </span>
            )}
          </div>
        </Tile>
      </div>

      <DownloadBar brief={brief} />

      {/* Drill modals */}
      <DrillModal
        open={drill?.kind === "snapshot"}
        onClose={() => setDrill(null)}
        title="Account snapshot"
      >
        <p className="leading-relaxed">{brief.snapshot}</p>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "priority"}
        onClose={() => setDrill(null)}
        title="Why this account · why now"
      >
        <p className="leading-relaxed">{brief.priority_summary}</p>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "maturity"}
        onClose={() => setDrill(null)}
        title="AI / tech maturity"
        subtitle={`Rating ${brief.ai_tech_maturity.rating} of 5`}
      >
        <MaturityGauge rating={brief.ai_tech_maturity.rating} large />
        <p className="leading-relaxed mt-4">{brief.ai_tech_maturity.rationale}</p>
        <MaturityScale />
      </DrillModal>

      <DrillModal
        open={drill?.kind === "signals"}
        onClose={() => setDrill(null)}
        title="Recent strategic signals"
        subtitle={`${brief.recent_signals.length} items`}
      >
        <ul className="space-y-4">
          {brief.recent_signals.map((s, i) => (
            <li key={i} className="border-l-2 border-accent pl-4">
              <p className="leading-snug mb-1">{s.text}</p>
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <ConfidenceChip value={s.confidence} />
                <span className="text-muted">·</span>
                <SourceLink source={s.source} />
              </div>
            </li>
          ))}
        </ul>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "initiatives"}
        onClose={() => setDrill(null)}
        title="Top initiatives"
      >
        <ul className="space-y-5">
          {brief.top_initiatives.map((it, i) => (
            <li key={i}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <h3 className="font-medium text-lg">{it.title}</h3>
                <ConfidenceChip value={it.confidence} />
              </div>
              <p className="text-sm leading-relaxed text-muted mb-1.5">{it.detail}</p>
              <div className="text-xs">
                <SourceLink source={it.source} />
              </div>
            </li>
          ))}
        </ul>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "confidence"}
        onClose={() => setDrill(null)}
        title="Evidence confidence breakdown"
        subtitle="Every cited signal, initiative, and persona, grouped by confidence"
      >
        <ConfidenceDetail brief={brief} />
      </DrillModal>

      <DrillModal
        open={drill?.kind === "tech"}
        onClose={() => setDrill(null)}
        title="Technical footprint"
      >
        <TechFootprintDetail tf={brief.technical_footprint} />
      </DrillModal>

      <DrillModal
        open={drill?.kind === "programs"}
        onClose={() => setDrill(null)}
        title="Programs & procurement signals"
      >
        <ProgramsDetail pp={brief.programs_procurement} />
      </DrillModal>

      <DrillModal
        open={drill?.kind === "personas"}
        onClose={() => setDrill(null)}
        title="Key personas"
      >
        <ul className="space-y-5">
          {brief.personas.map((p, i) => (
            <li key={i} className="card !cursor-default !hover:translate-y-0 p-4">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <div>
                  <h3 className="font-medium">
                    {p.name || <span className="italic text-muted">Role-based</span>}
                  </h3>
                  <p className="text-sm text-muted">{p.title}</p>
                </div>
                <ConfidenceChip value={p.confidence} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 text-sm">
                <div>
                  <Label>Priority</Label>
                  <p>{p.priority}</p>
                </div>
                <div>
                  <Label>Opener</Label>
                  <p>{p.opener}</p>
                </div>
              </div>
              <div className="mt-3 text-xs">
                <Label>Source</Label>
                <SourceLink source={p.source} />
              </div>
            </li>
          ))}
        </ul>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "buying"}
        onClose={() => setDrill(null)}
        title="Buying / decision path"
      >
        <p className="leading-relaxed">{brief.buying_path}</p>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "angle"}
        onClose={() => setDrill(null)}
        title="First conversation angle"
      >
        <p className="leading-relaxed">{brief.first_angle}</p>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "risks"}
        onClose={() => setDrill(null)}
        title="Risks & watch-outs"
      >
        <ul className="space-y-3">
          {brief.risks.map((r, i) => (
            <li key={i} className="flex gap-3">
              <span className="text-amber-600 shrink-0 mt-0.5">▲</span>
              <span className="leading-snug">{r}</span>
            </li>
          ))}
        </ul>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "competitive"}
        onClose={() => setDrill(null)}
        title="Competitive / vendor signals"
      >
        <ul className="space-y-3">
          {brief.competitive_signals.map((c, i) => (
            <li key={i} className="flex gap-3">
              <span className="text-muted shrink-0">›</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "next"}
        onClose={() => setDrill(null)}
        title="Recommended next action"
      >
        <p className="leading-relaxed text-lg">{brief.next_action}</p>
      </DrillModal>

      <DrillModal
        open={drill?.kind === "sources"}
        onClose={() => setDrill(null)}
        title="Key sources"
        subtitle={`${brief.sources.length} sources`}
      >
        <ul className="space-y-3">
          {brief.sources.map((s, i) => (
            <li key={i} className="text-sm">
              <div className="font-medium">{s.title || s.url}</div>
              <div className="text-xs">
                <SourceLink source={s.url} />
                {s.accessed && (
                  <span className="text-muted ml-2">· accessed {s.accessed}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </DrillModal>
    </div>
  );
}

function Header({
  brief,
  currentBriefId,
  canWrite,
  isOwner,
  onShareClick,
}: {
  brief: Brief;
  currentBriefId?: string;
  canWrite: boolean;
  isOwner: boolean;
  onShareClick: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="pt-10 pb-8"
    >
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted">
          <span className="size-1.5 rounded-full bg-accent" /> Account brief
        </div>
        <div className="flex items-center gap-2">
          {currentBriefId && canWrite && isOwner && (
            <button
              type="button"
              onClick={onShareClick}
              className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors px-3 py-1.5 rounded-lg hover:bg-white border border-transparent hover:border-[var(--line)]"
            >
              <Share2 className="size-4" />
              <span className="hidden sm:inline">Share</span>
            </button>
          )}
          {currentBriefId && (
            <BriefSwitcher
              currentBriefId={currentBriefId}
              currentName={brief.account_name}
            />
          )}
        </div>
      </div>
      <h1 className="font-display text-5xl tracking-tight leading-[1.05]">
        {brief.account_name}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
        <span className="px-2 py-0.5 rounded-full bg-white border border-[var(--line)]">
          {brief.segment}
        </span>
        <span>·</span>
        <span>Generated {brief.generated_at}</span>
        <span>·</span>
        <span className="capitalize">{brief.audience}</span>
      </div>
    </motion.div>
  );
}

function Tile({
  children,
  className = "",
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      onClick={onClick}
      className={`card p-5 ${className}`}
    >
      {children}
    </motion.div>
  );
}

function TileLabel({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted mb-3">
      {icon}
      <span className="flex-1 flex items-center gap-2">{children}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-widest text-muted mb-3 mt-2">
      {children}
    </div>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted mt-3">{children}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">
      {children}
    </div>
  );
}

/* ---------- Custom widgets ---------- */

function MaturityGauge({ rating, large = false }: { rating: number; large?: boolean }) {
  const pct = Math.max(0, Math.min(rating, 5)) / 5;
  const size = large ? 180 : 110;
  const stroke = large ? 14 : 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = pct * c;

  const tone =
    rating >= 4
      ? "#16a34a"
      : rating === 3
        ? "#2f6df6"
        : rating === 2
          ? "#f59e0b"
          : "#9ca3af";

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#eef0f3"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={large ? 44 : 28}
          fontWeight={600}
          fill="var(--ink)"
          fontFamily="Fraunces, Georgia, serif"
        >
          {rating}
        </text>
      </svg>
      {!large && (
        <div>
          <div className="text-2xl font-display">{labelFor(rating)}</div>
          <div className="text-xs text-muted">of 5</div>
        </div>
      )}
    </div>
  );
}

function MaturityScale() {
  const items = [
    [1, "No public AI / advanced tech signals"],
    [2, "Adjacent modernization (cloud, data, security, RPA)"],
    [3, "Early pilots, hiring or governance signals"],
    [4, "Multiple active tech / AI / automation initiatives"],
    [5, "Mature program: strategy, production, governance"],
  ] as const;
  return (
    <div className="mt-6 border-t border-[var(--line)] pt-5">
      <div className="text-xs uppercase tracking-wider text-muted mb-2">Scale</div>
      <ul className="space-y-1 text-sm">
        {items.map(([n, label]) => (
          <li key={n} className="flex gap-3">
            <span className="font-mono text-muted w-4 shrink-0">{n}</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function labelFor(r: number) {
  return ["", "Nascent", "Adjacent", "Emerging", "Active", "Mature"][r] || "—";
}

function SignalsTimeline({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) {
    return <p className="text-sm text-muted">No public signals found.</p>;
  }
  return (
    <ol className="relative border-l-2 border-[var(--line)] ml-2 space-y-3">
      {signals.map((s, i) => (
        <li key={i} className="pl-4 relative">
          <span className="absolute -left-[7px] top-1 size-3 rounded-full bg-accent ring-4 ring-[var(--card)]" />
          <p className="text-sm leading-snug line-clamp-2">{s.text}</p>
          <div className="mt-1">
            <ConfidenceChip value={s.confidence} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function InitiativeCard({
  init,
  onClick,
}: {
  init: Initiative;
  onClick: () => void;
}) {
  return (
    <div className="card p-4" onClick={onClick}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <Lightbulb className="size-4 text-amber-600 shrink-0 mt-0.5" />
        <ConfidenceChip value={init.confidence} />
      </div>
      <h3 className="font-medium leading-snug mb-1.5">{init.title}</h3>
      <p className="text-sm text-muted line-clamp-3">{init.detail}</p>
    </div>
  );
}

function PersonaCard({
  persona,
  onClick,
}: {
  persona: Persona;
  onClick: () => void;
}) {
  const initials =
    (persona.name || persona.title || "?")
      .split(/\s+/)
      .map((s) => s[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";
  return (
    <div className="card p-4" onClick={onClick}>
      <div className="flex items-start gap-3">
        <div className="size-10 rounded-full bg-[var(--bg)] border border-[var(--line)] grid place-items-center font-medium text-sm shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">
            {persona.name || <span className="italic text-muted">Role-based</span>}
          </div>
          <div className="text-sm text-muted truncate">{persona.title}</div>
        </div>
        <Users className="size-4 text-muted shrink-0" />
      </div>
      <p className="text-xs text-muted mt-3 line-clamp-2">{persona.opener}</p>
      <div className="mt-2">
        <ConfidenceChip value={persona.confidence} />
      </div>
    </div>
  );
}

/* ---------- Technical footprint ---------- */

function TechFootprintPreview({ tf }: { tf: TechnicalFootprint }) {
  const chips: { icon: React.ReactNode; label: string; value: string }[] = [];
  if (tf.cloud_platforms.length > 0)
    chips.push({
      icon: <Cloud className="size-3.5" />,
      label: "Cloud",
      value: tf.cloud_platforms.join(", "),
    });
  if (tf.data_infrastructure && !isMissing(tf.data_infrastructure))
    chips.push({
      icon: <Database className="size-3.5" />,
      label: "Data",
      value: tf.data_infrastructure,
    });
  if (tf.analytics_bi_stack && !isMissing(tf.analytics_bi_stack))
    chips.push({
      icon: <BarChart3 className="size-3.5" />,
      label: "BI",
      value: tf.analytics_bi_stack,
    });
  if (tf.clinical_platforms && !isMissing(tf.clinical_platforms))
    chips.push({
      icon: <ShieldCheck className="size-3.5" />,
      label: "EHR",
      value: tf.clinical_platforms,
    });

  const ai = tf.ai_in_production[0] || tf.active_pilots[0];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {chips.length === 0 ? (
          <span className="text-sm text-muted">No public footprint signals found.</span>
        ) : (
          chips.map((c, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-[var(--bg)] border border-[var(--line)]"
            >
              {c.icon}
              <span className="text-muted">{c.label}</span>
              <span className="font-medium truncate max-w-[140px]">{c.value}</span>
            </span>
          ))
        )}
      </div>
      {ai && (
        <p className="text-sm leading-snug line-clamp-2">
          <span className="text-muted text-xs uppercase tracking-wider mr-2">
            {tf.ai_in_production.length > 0 ? "In production" : "Pilots"}
          </span>
          {ai}
        </p>
      )}
      {tf.competitive_incumbents.length > 0 && (
        <p className="text-xs text-muted line-clamp-1">
          <Wrench className="size-3 inline mr-1 -mt-0.5" />
          Incumbents: {tf.competitive_incumbents.join(", ")}
        </p>
      )}
    </div>
  );
}

function TechFootprintDetail({ tf }: { tf: TechnicalFootprint }) {
  return (
    <div className="space-y-5">
      <DetailList
        icon={<Cpu className="size-4" />}
        title="AI / automation in production"
        items={tf.ai_in_production}
      />
      <DetailList
        icon={<Lightbulb className="size-4" />}
        title="Active pilots / POCs"
        items={tf.active_pilots}
      />
      <DetailList
        icon={<Cloud className="size-4" />}
        title="Cloud platforms"
        items={tf.cloud_platforms}
        inline
      />
      <DetailField
        icon={<Database className="size-4" />}
        title="Data infrastructure"
        value={tf.data_infrastructure}
      />
      {tf.clinical_platforms && tf.clinical_platforms.trim() && (
        <DetailField
          icon={<ShieldCheck className="size-4" />}
          title="Clinical platforms / EHR"
          value={tf.clinical_platforms}
        />
      )}
      <DetailField
        icon={<BarChart3 className="size-4" />}
        title="Analytics / BI stack"
        value={tf.analytics_bi_stack}
      />
      <DetailField
        icon={<Wrench className="size-4" />}
        title="Build vs. buy posture"
        value={tf.build_vs_buy_posture}
      />
      <DetailList
        icon={<Swords className="size-4" />}
        title="Competitive incumbents / vendors under evaluation"
        items={tf.competitive_incumbents}
      />
    </div>
  );
}

/* ---------- Programs & procurement ---------- */

function ProgramsPreview({ pp }: { pp: ProgramsProcurement }) {
  const counts = [
    { label: "Grants", n: pp.modernization_grants.length },
    { label: "Consortia", n: pp.consortium_purchasing.length },
    { label: "RFPs", n: pp.active_rfps_contracts.length },
    { label: "Use cases", n: pp.public_ai_use_cases.length },
  ];
  const hasGov = pp.ai_governance_policy && !isMissing(pp.ai_governance_policy);
  const total = counts.reduce((acc, c) => acc + c.n, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        {counts.map((c) => (
          <div
            key={c.label}
            className="text-center bg-[var(--bg)] border border-[var(--line)] rounded-lg py-2"
          >
            <div className="text-2xl font-display leading-none">{c.n}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted mt-1">
              {c.label}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-2 text-sm">
        <ScrollText className="size-4 text-muted shrink-0 mt-0.5" />
        <span className={hasGov ? "" : "text-muted"}>
          {hasGov ? pp.ai_governance_policy : "No public AI governance policy found."}
        </span>
      </div>
      {total === 0 && !hasGov && (
        <p className="text-xs text-muted">No public procurement signals found.</p>
      )}
    </div>
  );
}

function ProgramsDetail({ pp }: { pp: ProgramsProcurement }) {
  return (
    <div className="space-y-5">
      <DetailList
        icon={<Award className="size-4" />}
        title="Modernization grants (received / applied)"
        items={pp.modernization_grants}
        emptyHint="IIJA, CHIPS Act, Title IV, ARPA-H, state and foundation grants — none found in public sources."
      />
      <DetailList
        icon={<Users className="size-4" />}
        title="Consortium / cooperative purchasing"
        items={pp.consortium_purchasing}
        emptyHint="NASPO ValuePoint, Sourcewell, OMNIA Partners, GPOs — none found in public sources."
      />
      <DetailList
        icon={<FileSearch className="size-4" />}
        title="Active RFPs / contracts expiring 12–18 months"
        items={pp.active_rfps_contracts}
      />
      <DetailField
        icon={<ScrollText className="size-4" />}
        title="AI governance / responsible AI policy"
        value={pp.ai_governance_policy}
      />
      <DetailList
        icon={<Cpu className="size-4" />}
        title="Publicly stated AI use cases"
        items={pp.public_ai_use_cases}
      />
    </div>
  );
}

/* ---------- Reusable detail blocks ---------- */

function DetailList({
  icon,
  title,
  items,
  inline = false,
  emptyHint,
}: {
  icon: React.ReactNode;
  title: string;
  items: string[];
  inline?: boolean;
  emptyHint?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted mb-2">
        {icon}
        {title}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted">
          {emptyHint || "Not found in public sources."}
        </p>
      ) : inline ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={i}
              className="text-sm px-2.5 py-1 rounded-md bg-[var(--bg)] border border-[var(--line)]"
            >
              {it}
            </span>
          ))}
        </div>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted shrink-0">›</span>
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailField({
  icon,
  title,
  value,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
}) {
  const missing = !value || isMissing(value);
  return (
    <div>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted mb-1.5">
        {icon}
        {title}
      </div>
      <p className={`text-sm leading-snug ${missing ? "text-muted" : ""}`}>
        {missing ? "Not found in public sources." : value}
      </p>
    </div>
  );
}

function isMissing(s: string) {
  const v = (s || "").trim().toLowerCase();
  return v === "" || v.startsWith("not found");
}

/* ---------- Download bar ---------- */

function DownloadBar({ brief }: { brief: Brief }) {
  const [busy, setBusy] = useState<"pdf" | "docx" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: "pdf" | "docx") {
    if (busy) return;
    setBusy(format);
    setError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief, format }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data?.error || `Export failed (${res.status})`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const disp = res.headers.get("content-disposition") || "";
      const m = /filename="([^"]+)"/.exec(disp);
      a.href = url;
      a.download = m?.[1] || `brief.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message ?? "Export failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 flex flex-col items-center gap-3">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => download("pdf")}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-ink text-white text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === "pdf" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Download PDF
        </button>
        <button
          type="button"
          onClick={() => download("docx")}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-ink border border-[var(--line)] text-sm font-medium hover:border-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === "docx" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Download DOCX
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 max-w-md text-center">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------- Charts ---------- */

const CONF_LABELS = ["High", "Medium", "Low", "Not found"] as const;
type ConfLabel = (typeof CONF_LABELS)[number];

function confColor(label: string): string {
  const v = (label || "").toLowerCase();
  if (v === "high") return "#16a34a";
  if (v === "medium") return "#2f6df6";
  if (v === "low") return "#f59e0b";
  return "#9ca3af";
}

function aggregateConfidence(brief: Brief): Record<ConfLabel, number> {
  const counts: Record<ConfLabel, number> = {
    High: 0,
    Medium: 0,
    Low: 0,
    "Not found": 0,
  };
  const bump = (c: string) => {
    const k = (CONF_LABELS as readonly string[]).includes(c)
      ? (c as ConfLabel)
      : "Not found";
    counts[k] += 1;
  };
  brief.recent_signals.forEach((s) => bump(s.confidence));
  brief.top_initiatives.forEach((i) => bump(i.confidence));
  brief.personas.forEach((p) => bump(p.confidence));
  return counts;
}

function ConfidenceDonut({ brief }: { brief: Brief }) {
  const counts = aggregateConfidence(brief);
  const total = CONF_LABELS.reduce((acc, k) => acc + counts[k], 0);
  const size = 130;
  const stroke = 16;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  // build dasharray segments
  let offset = 0;
  const segments = CONF_LABELS.map((label) => {
    const fraction = total > 0 ? counts[label] / total : 0;
    const dash = fraction * c;
    const seg = { label, dash, offset, color: confColor(label), count: counts[label] };
    offset += dash;
    return seg;
  });

  const dominant = CONF_LABELS.reduce<ConfLabel>(
    (best, k) => (counts[k] > counts[best] ? k : best),
    "Not found",
  );

  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#eef0f3"
          strokeWidth={stroke}
        />
        {total > 0 &&
          segments.map((s, i) => (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${s.dash} ${c - s.dash}`}
              strokeDashoffset={-s.offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          ))}
        <text
          x="50%"
          y="46%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={26}
          fontWeight={600}
          fill="var(--ink)"
          fontFamily="Fraunces, Georgia, serif"
        >
          {total}
        </text>
        <text
          x="50%"
          y="62%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={9}
          fill="var(--muted)"
          letterSpacing="0.08em"
        >
          ITEMS
        </text>
      </svg>
      <div className="flex-1 min-w-0 space-y-1.5">
        {CONF_LABELS.map((label) => {
          const n = counts[label];
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          return (
            <div key={label} className="flex items-center gap-2 text-sm">
              <span
                className="inline-block size-2.5 rounded-sm shrink-0"
                style={{ background: confColor(label) }}
              />
              <span className="text-muted text-xs flex-1">{label}</span>
              <span className="font-mono tabular-nums text-xs w-7 text-right">
                {n}
              </span>
              <span className="text-xs text-muted w-9 text-right">{pct}%</span>
            </div>
          );
        })}
        <div className="text-[11px] text-muted pt-1">
          Most: <span className="text-ink font-medium">{dominant}</span>
        </div>
      </div>
    </div>
  );
}

function ConfidenceDetail({ brief }: { brief: Brief }) {
  const buckets: Record<ConfLabel, { kind: string; text: string; source?: string }[]> = {
    High: [],
    Medium: [],
    Low: [],
    "Not found": [],
  };
  const place = (
    label: string,
    kind: string,
    text: string,
    source?: string,
  ) => {
    const k: ConfLabel = (CONF_LABELS as readonly string[]).includes(label)
      ? (label as ConfLabel)
      : "Not found";
    buckets[k].push({ kind, text, source });
  };
  brief.recent_signals.forEach((s) =>
    place(s.confidence, "Signal", s.text, s.source),
  );
  brief.top_initiatives.forEach((i) =>
    place(i.confidence, "Initiative", i.title, i.source),
  );
  brief.personas.forEach((p) =>
    place(p.confidence, "Persona", `${p.name || "Role-based"} — ${p.title}`, p.source),
  );

  return (
    <div className="space-y-6">
      {CONF_LABELS.map((label) => {
        const items = buckets[label];
        if (items.length === 0) return null;
        return (
          <section key={label}>
            <div className="flex items-center gap-2 mb-2">
              <span
                className="size-2.5 rounded-sm"
                style={{ background: confColor(label) }}
              />
              <h3 className="text-sm font-medium">{label}</h3>
              <span className="text-xs text-muted">· {items.length}</span>
            </div>
            <ul className="space-y-2">
              {items.map((it, i) => (
                <li key={i} className="text-sm">
                  <span className="text-[10px] uppercase tracking-wider text-muted mr-2">
                    {it.kind}
                  </span>
                  {it.text}
                  {it.source && (
                    <span className="block text-xs text-muted mt-0.5 ml-12">
                      {it.source}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function InitiativeBars({
  initiatives,
  onPick,
}: {
  initiatives: Initiative[];
  onPick: (index: number) => void;
}) {
  if (initiatives.length === 0) {
    return <p className="text-sm text-muted">No initiatives found.</p>;
  }
  const widthFor = (c: string) => {
    const v = (c || "").toLowerCase();
    if (v === "high") return 100;
    if (v === "medium") return 66;
    if (v === "low") return 33;
    return 12;
  };
  const ordered = [...initiatives]
    .map((it, originalIndex) => ({ it, originalIndex, w: widthFor(it.confidence) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 6);
  return (
    <div className="space-y-2.5">
      {ordered.map(({ it, originalIndex, w }) => {
        const color = confColor(it.confidence);
        return (
          <button
            key={originalIndex}
            type="button"
            onClick={() => onPick(originalIndex)}
            className="w-full text-left group"
          >
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-sm font-medium truncate group-hover:text-accent transition-colors">
                {it.title}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">
                {it.confidence}
              </span>
            </div>
            <div className="h-2 rounded-full bg-[var(--bg)] border border-[var(--line)] overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${w}%`, background: color }}
              />
            </div>
          </button>
        );
      })}
      <p className="text-[11px] text-muted pt-1">
        Bar width tracks confidence. Click any row to drill in.
      </p>
    </div>
  );
}

/* ---------- Low-quality warning ---------- */

function LowQualityBanner({
  brief,
  completeness,
}: {
  brief: Brief;
  completeness: { filled: number; total: number };
}) {
  const params = new URLSearchParams();
  params.set("account", brief.account_name);
  if (brief.segment) params.set("segment", brief.segment);
  params.set("audience", brief.audience);
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3"
    >
      <AlertCircle className="size-5 text-amber-700 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 text-sm text-amber-900">
        <div className="font-medium mb-0.5">
          This brief came back sparse ({completeness.filled} of{" "}
          {completeness.total} core sections populated).
        </div>
        <p className="text-amber-800/90">
          The model may have been cut short during research. Re-running will
          start fresh with a higher token budget.
        </p>
      </div>
      <Link
        href={`/?${params.toString()}`}
        className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-900 text-white hover:bg-ink transition-colors"
      >
        <RefreshCw className="size-3.5" />
        Re-run
      </Link>
    </motion.div>
  );
}
