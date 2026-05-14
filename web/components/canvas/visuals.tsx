"use client";

import {
  Bot,
  Cpu,
  Globe,
  MessageSquare,
  RefreshCw,
  Sparkles,
  User,
  HelpCircle,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  aggregateConfidence,
  parseFractionValue,
  sourceTypeLabel,
  sectionKeyTone,
  totalConfidence,
  type ConfidenceCounts,
  type AccentTone,
} from "../../lib/canvas/visualHelpers";

// Re-export helpers so consumers have one import path for visuals.
// The pure helpers stay in the `.ts` module so tests / Node can import
// them without dragging React in.
export {
  aggregateConfidence,
  parseFractionValue,
  sourceTypeLabel,
  sectionKeyTone,
};
export type { ConfidenceCounts, AccentTone };

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
      severity: {s}
    </span>
  );
}
