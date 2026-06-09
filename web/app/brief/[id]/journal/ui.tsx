// Shared presentational primitives for the Journal cockpit redesign (PR-B).
// One Card/Panel chrome, one section-header pattern, and one semantic Badge,
// reused across the workspaces so the surface stays visually consistent.
import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "aside";
}) {
  return (
    <Tag
      className={`rounded-2xl border border-[var(--line)] bg-white shadow-sm ${className}`}
    >
      {children}
    </Tag>
  );
}

export function SectionHeader({
  icon,
  title,
  count,
  description,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {count !== undefined && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted">
              {count}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// Semantic badge tones. Color carries meaning only — no decorative use.
export type BadgeTone =
  | "neutral"
  | "assistant"
  | "review"
  | "risk"
  | "accepted"
  | "source";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  assistant: "border-violet-200 bg-violet-50 text-violet-800",
  review: "border-amber-200 bg-amber-50 text-amber-800",
  risk: "border-rose-200 bg-rose-50 text-rose-800",
  accepted: "border-emerald-200 bg-emerald-50 text-emerald-800",
  source: "border-sky-200 bg-sky-50 text-sky-900",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
