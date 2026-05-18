"use client";

import {
  Activity,
  AlertTriangle,
  Bot,
  Cpu,
  Globe,
  HelpCircle,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Target,
  TrendingUp,
  User,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  aggregateConfidence,
  confidenceBucket,
  confidenceWeight,
  parseFractionValue,
  sectionKeyTone,
  sourceTypeLabel,
  summarizeLandscapeLabel,
  totalConfidence,
  type AccentTone,
  type ConfidenceBucket,
  type ConfidenceCounts,
} from "../../lib/canvas/visualHelpers";

// Re-export helpers so consumers have one import path for visuals.
// The pure helpers stay in the `.ts` module so tests / Node can import
// them without dragging React in.
export {
  aggregateConfidence,
  confidenceBucket,
  confidenceWeight,
  parseFractionValue,
  sectionKeyTone,
  sourceTypeLabel,
  summarizeLandscapeLabel,
};
export type { AccentTone, ConfidenceBucket, ConfidenceCounts };

// ---- ConfidenceBar --------------------------------------------------------

const CONF_COLOR_VAR: Record<keyof ConfidenceCounts, string> = {
  high: "var(--conf-high)",
  medium: "var(--conf-med)",
  low: "var(--conf-low)",
  na: "var(--conf-na)",
};

const CONF_LABEL: Record<keyof ConfidenceCounts, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  na: "Not found",
};

// Small horizontal stacked bar for confidence distribution.
export function ConfidenceBar({
  counts,
  size = "sm",
}: {
  counts: ConfidenceCounts;
  size?: "sm" | "md";
}) {
  const total = totalConfidence(counts);
  const height = size === "md" ? "h-2.5" : "h-1.5";
  if (total === 0) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-muted">
        <div className={`flex-1 rounded-full bg-[var(--bg)] ${height}`} />
        <span>0 items</span>
      </div>
    );
  }
  const order: Array<keyof ConfidenceCounts> = ["high", "medium", "low", "na"];
  return (
    <div className="space-y-1">
      <div
        className={`flex w-full overflow-hidden rounded-full bg-[var(--bg)] ${height}`}
        role="img"
        aria-label={`Confidence distribution: ${order
          .filter((k) => counts[k] > 0)
          .map((k) => `${counts[k]} ${CONF_LABEL[k]}`)
          .join(", ")}`}
      >
        {order.map((k) => {
          const pct = (counts[k] / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={k}
              style={{ width: `${pct}%`, background: CONF_COLOR_VAR[k] }}
              title={`${CONF_LABEL[k]}: ${counts[k]}`}
            />
          );
        })}
      </div>
      {size === "md" && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
          {order.map((k) =>
            counts[k] > 0 ? (
              <span key={k} className="inline-flex items-center gap-1">
                <span
                  className="size-2 rounded-full"
                  style={{ background: CONF_COLOR_VAR[k] }}
                  aria-hidden="true"
                />
                {CONF_LABEL[k]} · {counts[k]}
              </span>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

// ---- MiniGauge ------------------------------------------------------------

// Small SVG ring (default 48px) showing current/max as a filled arc.
export function MiniGauge({
  current,
  max,
  label,
  size = 48,
}: {
  current: number;
  max: number;
  label?: string;
  size?: number;
}) {
  const safeMax = Math.max(max, 1);
  const safeCurrent = Math.max(0, Math.min(current, safeMax));
  const pct = safeCurrent / safeMax;
  const stroke = Math.max(4, Math.round(size * 0.12));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * pct;
  const color =
    pct >= 0.8
      ? "var(--conf-high)"
      : pct >= 0.6
        ? "var(--conf-med)"
        : pct >= 0.4
          ? "var(--conf-low)"
          : "var(--conf-na)";
  return (
    <div className="inline-flex items-center gap-2">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={
          label
            ? `${label}: ${safeCurrent} of ${safeMax}`
            : `${safeCurrent} of ${safeMax}`
        }
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontFamily="Fraunces, serif"
          fontSize={Math.round(size * 0.36)}
          fill="var(--ink)"
        >
          {safeCurrent}
        </text>
      </svg>
      {label && (
        <span className="text-xs text-muted">
          / {safeMax} {label}
        </span>
      )}
    </div>
  );
}

// ---- SourceTypeBadge ------------------------------------------------------

const SOURCE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  system: Globe,
  research: Sparkles,
  chat: MessageSquare,
  model: Cpu,
  refresh: RefreshCw,
  hermes: Bot,
  user: User,
};

// Icon + label chip for a widget's source provenance. Unknown / null
// source values fall back to a neutral "Source" chip with a generic
// help-circle icon — never throws.
export function SourceTypeBadge({
  source,
  className = "",
}: {
  source: unknown;
  className?: string;
}) {
  const key =
    typeof source === "string" ? source.trim().toLowerCase() : "";
  const Icon = SOURCE_ICONS[key] ?? HelpCircle;
  const label = sourceTypeLabel(source);
  return (
    <span
      className={`inline-flex items-center gap-1 chip chip-na text-[10px] ${className}`}
      title={`Source: ${label}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

// ---- SemanticAccent --------------------------------------------------------

// Class + style helper for a colored left border on a tile.
export function semanticAccentClass(tone: AccentTone): string {
  if (tone === "neutral") return "";
  return "border-l-4";
}

export function semanticAccentStyle(
  tone: AccentTone,
): { borderLeftColor: string } | undefined {
  switch (tone) {
    case "risk":
      return { borderLeftColor: "var(--tone-risk)" };
    case "opportunity":
      return { borderLeftColor: "var(--tone-opportunity)" };
    case "signal":
      return { borderLeftColor: "var(--tone-signal)" };
    default:
      return undefined;
  }
}

// ---- SeverityChip ----------------------------------------------------------

// Severity uses its own palette, distinct from confidence chips:
// high = red (urgent), medium = amber (attention), low = gray
// (informational). Driven by --sev-* CSS variables so contrast is
// readable on the card surface and the meaning isn't confused with
// confidence-low (which is amber).
export function SeverityChip({ s }: { s?: "low" | "medium" | "high" }) {
  if (!s) return null;
  const label = s === "high" ? "High" : s === "medium" ? "Medium" : "Low";
  const style: React.CSSProperties =
    s === "high"
      ? {
          backgroundColor: "var(--sev-high-bg)",
          color: "var(--sev-high-text)",
          borderColor: "var(--sev-high-border)",
        }
      : s === "medium"
        ? {
            backgroundColor: "var(--sev-med-bg)",
            color: "var(--sev-med-text)",
            borderColor: "var(--sev-med-border)",
          }
        : {
            backgroundColor: "var(--sev-low-bg)",
            color: "var(--sev-low-text)",
            borderColor: "var(--sev-low-border)",
          };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
      style={style}
    >
      Priority: {label}
    </span>
  );
}

// ---- ToneIcon --------------------------------------------------------------

// Small icon paired with a tone left-accent. Risk = warning triangle,
// opportunity = upward trend, signal = activity pulse. Neutral renders
// nothing so callers can spread it freely.
export function ToneIcon({
  tone,
  className = "size-4",
}: {
  tone: AccentTone;
  className?: string;
}) {
  switch (tone) {
    case "risk":
      return (
        <AlertTriangle
          className={className}
          style={{ color: "var(--tone-risk)" }}
          aria-hidden="true"
        />
      );
    case "opportunity":
      return (
        <TrendingUp
          className={className}
          style={{ color: "var(--tone-opportunity)" }}
          aria-hidden="true"
        />
      );
    case "signal":
      return (
        <Activity
          className={className}
          style={{ color: "var(--tone-signal)" }}
          aria-hidden="true"
        />
      );
    default:
      return null;
  }
}

// Inline "12H · 5M · 3L · 1NF" style confidence counts. Strong-typography
// quick-read companion to ConfidenceBar.
export function ConfidenceCountsInline({ counts }: { counts: ConfidenceCounts }) {
  const order: Array<{ key: keyof ConfidenceCounts; short: string }> = [
    { key: "high", short: "H" },
    { key: "medium", short: "M" },
    { key: "low", short: "L" },
    { key: "na", short: "NF" },
  ];
  const parts = order.filter((p) => counts[p.key] > 0);
  if (parts.length === 0) {
    return <span className="text-[10px] text-muted">No items</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted">
      {parts.map(({ key, short }) => (
        <span key={key} className="inline-flex items-center gap-1">
          <span
            className="size-1.5 rounded-full"
            style={{ background: CONF_COLOR_VAR[key] }}
            aria-hidden="true"
          />
          <span className="font-display text-[12px] text-ink leading-none">
            {counts[key]}
          </span>
          <span>{short}</span>
        </span>
      ))}
    </div>
  );
}

// ---- InitiativeLandscape ---------------------------------------------------

// Horizontal stacked-bar treatment mirroring Brief view's InitiativeBars.
// Reads from a list of structured items (text + confidence) which the
// Canvas adapter populates on the section-top-initiatives / risks /
// signals widgets via the existing `widget.evidence` field.
//
// Each row: a confidence-weighted bar in the appropriate semantic color,
// the item label, and an optional small confidence chip on the right.
export function InitiativeLandscape({
  items,
  max = 6,
  tone = "opportunity",
}: {
  items: ReadonlyArray<{
    text: string;
    confidence?: unknown;
    source?: string;
  }>;
  max?: number;
  tone?: AccentTone;
}) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-muted">No items.</p>;
  }
  const rows = items.slice(0, max);
  const overflow = items.length - rows.length;
  // Tone is used for the "neutral" fallback row color; otherwise rows are
  // confidence-colored individually so the dominant signal is visible.
  const fallbackColor =
    tone === "risk"
      ? "var(--tone-risk)"
      : tone === "signal"
        ? "var(--tone-signal)"
        : "var(--tone-opportunity)";

  return (
    <ul className="space-y-2">
      {rows.map((it, i) => {
        const bucket = confidenceBucket(it.confidence);
        const weight = confidenceWeight(it.confidence);
        const pct = Math.max(8, Math.round(weight * 100));
        const color =
          bucket === "high"
            ? "var(--conf-high)"
            : bucket === "medium"
              ? "var(--conf-med)"
              : bucket === "low"
                ? "var(--conf-low)"
                : fallbackColor;
        const label = summarizeLandscapeLabel(it.text);
        return (
          <li key={i} className="space-y-1">
            <div className="flex items-start justify-between gap-3 text-xs">
              <span className="min-w-0 text-ink leading-snug" title={it.text}>
                {label}
              </span>
              {typeof it.confidence === "string" && (
                <span
                  className="shrink-0 text-[10px] uppercase tracking-wider"
                  style={{ color }}
                >
                  {it.confidence}
                </span>
              )}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg)]">
              <div
                style={{ width: `${pct}%`, background: color }}
                className="h-full"
              />
            </div>
          </li>
        );
      })}
      {overflow > 0 && (
        <li className="text-[10px] text-muted">+{overflow} more · open to view</li>
      )}
    </ul>
  );
}

// Re-exported "Recommended action" icon for the inverted action panel
// chrome — kept in this module so the tile import surface stays tight.
export { Target };
