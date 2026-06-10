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
            <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs text-muted">
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
  neutral: "border-[var(--line)] bg-[var(--surface-muted)] text-[var(--text-secondary)]",
  assistant: "border-[var(--border-subtle)] bg-[var(--ai-bg)] text-[var(--ai-text)]",
  review: "border-[var(--border-subtle)] bg-[var(--warning-bg)] text-[var(--warning-text)]",
  risk: "border-[var(--border-subtle)] bg-[var(--risk-bg)] text-[var(--risk-text)]",
  accepted: "border-[var(--border-subtle)] bg-[var(--success-bg)] text-[var(--success-text)]",
  source: "border-[var(--border-subtle)] bg-[var(--info-bg)] text-[var(--info-text)]",
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

// Calm, actionable empty state: icon + why-it's-empty + what-to-do, with an
// optional primary action. Replaces the ad-hoc dashed-box one-liners so blank
// surfaces read as a deliberate next step rather than a dead end.
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-white px-6 py-10 text-center ${className}`}
    >
      {icon && (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-muted)]">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
