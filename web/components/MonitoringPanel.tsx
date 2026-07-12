"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Radar, RefreshCw, X } from "lucide-react";

type Cadence = "daily" | "every_3_days" | "weekly";

type MonitorRun = {
  id: string;
  ran_at: number;
  outcome: "no_updates" | "candidate_queued" | "updated" | "failed";
  tier: "triage_only" | "deep";
  summary: string | null;
  patches_applied: number;
  touched_fields: string[];
};

type MonitorStatus = {
  enabled: boolean;
  cadence: Cadence;
  last_monitored_at: number | null;
  next_check_at: number | null;
  runs: MonitorRun[];
};

const CADENCE_LABELS: Record<Cadence, string> = {
  daily: "Daily",
  every_3_days: "Every 3 days",
  weekly: "Weekly",
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let label: string;
  if (abs < 60_000) label = "just now";
  else if (abs < 3_600_000) label = fmt(Math.floor(abs / 60_000), "min");
  else if (abs < 86_400_000) label = fmt(Math.floor(abs / 3_600_000), "hour");
  else label = fmt(Math.floor(abs / 86_400_000), "day");
  if (label === "just now") return label;
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

function absTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function MonitoringPanel({
  briefId,
  open,
  canWrite,
  onClose,
  onEnabledChange,
}: {
  briefId: string;
  open: boolean;
  canWrite: boolean;
  onClose: () => void;
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/briefs/${briefId}/monitor`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as MonitorStatus;
      setStatus(data);
      setError(null);
    } catch {
      setError("Couldn’t load monitoring status.");
    }
  }, [briefId]);

  useEffect(() => {
    if (open) {
      setHint(null);
      load();
    }
  }, [open, load]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function patch(body: { enabled?: boolean; cadence?: Cadence }) {
    if (busy || !status) return;
    setBusy(true);
    setHint(null);
    try {
      const r = await fetch(`/api/briefs/${briefId}/monitor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: body.enabled ?? status.enabled, ...body }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (typeof data.enabled === "boolean") onEnabledChange?.(data.enabled);
      if (body.enabled === true && data.queued_job_id) {
        setHint("Monitoring on — first check queued.");
      }
      await load();
    } catch {
      setError("Couldn’t update monitoring. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    if (busy) return;
    setBusy(true);
    setHint(null);
    try {
      const r = await fetch(`/api/briefs/${briefId}/monitor/check`, {
        method: "POST",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setHint(
        data.queued_job_id
          ? "Check queued — results appear here shortly."
          : "A check is already running.",
      );
      await load();
    } catch {
      setError("Couldn’t start a check. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const outcomeBadge = (run: MonitorRun) => {
    if (run.outcome === "candidate_queued") {
      return (
        <span className="shrink-0 rounded-full border border-[var(--border-subtle)] bg-[var(--warning-bg)] px-2 py-0.5 text-xs font-medium text-[var(--warning-text)]">
          Review candidate queued
        </span>
      );
    }
    if (run.outcome === "updated") {
      return (
        <span className="shrink-0 rounded-full border border-[var(--border-subtle)] bg-[var(--success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--success-text)]">
          {run.patches_applied} change{run.patches_applied === 1 ? "" : "s"}
        </span>
      );
    }
    if (run.outcome === "failed") {
      return (
        <span className="shrink-0 rounded-full border border-[var(--border-subtle)] bg-[var(--risk-bg)] px-2 py-0.5 text-xs font-medium text-[var(--risk-text)]">
          Failed
        </span>
      );
    }
    return (
      <span className="shrink-0 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
        No updates
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Monitoring"
    >
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-[var(--line)] bg-[var(--surface)] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-5 py-3">
          <div className="flex items-center gap-2">
            <Radar className="size-4 text-[var(--primary)]" />
            <h2 className="text-base font-semibold text-ink">Monitoring</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-[var(--line)] bg-white p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-muted)]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 p-5">
          <p className="text-sm text-[var(--text-secondary)]">
            An automatic agent checks this account for genuinely new developments. Suggested field changes are queued in Radar for human review and manual incorporation.
          </p>

          {error && (
            <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--risk-bg)] px-3 py-2 text-sm text-[var(--risk-text)]">
              {error}
            </div>
          )}

          {!status ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {/* Status + toggle */}
              <div className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-[var(--line)] bg-white p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">
                    {status.enabled ? "Monitoring is on" : "Monitoring is off"}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                    {status.enabled
                      ? "Runs automatically on your chosen cadence."
                      : "Turn on to start automatic checks."}
                  </div>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => patch({ enabled: !status.enabled })}
                    disabled={busy}
                    aria-pressed={status.enabled}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      status.enabled ? "bg-[var(--primary)]" : "bg-[var(--surface-muted)] border border-[var(--border-subtle)]"
                    }`}
                  >
                    <span
                      className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform ${
                        status.enabled ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                )}
              </div>

              {/* Cadence */}
              <div className="mt-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Cadence
                </div>
                <div className="mt-1.5 inline-flex rounded-lg border border-[var(--line)] bg-white p-0.5 text-sm">
                  {(Object.keys(CADENCE_LABELS) as Cadence[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={busy || !canWrite}
                      onClick={() => patch({ cadence: c })}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${
                        status.cadence === c
                          ? "bg-[var(--active-dark)] text-white"
                          : "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-ink"
                      }`}
                    >
                      {CADENCE_LABELS[c]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Last / next + check now */}
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-[12px] border border-[var(--border-subtle)] bg-white px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    Last checked
                  </div>
                  <div className="mt-0.5 text-ink" title={status.last_monitored_at ? absTime(status.last_monitored_at) : undefined}>
                    {status.last_monitored_at ? relativeTime(status.last_monitored_at) : "Never"}
                  </div>
                </div>
                <div className="rounded-[12px] border border-[var(--border-subtle)] bg-white px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    Next check
                  </div>
                  <div className="mt-0.5 text-ink" title={status.next_check_at ? absTime(status.next_check_at) : undefined}>
                    {status.enabled && status.next_check_at ? absTime(status.next_check_at) : "—"}
                  </div>
                </div>
              </div>

              {canWrite && status.enabled && (
                <button
                  type="button"
                  onClick={checkNow}
                  disabled={busy}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  Check now
                </button>
              )}

              {hint && <div className="mt-2 text-xs text-[var(--text-secondary)]">{hint}</div>}

              {/* Run history */}
              <div className="mt-6">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Recent checks
                </div>
                {status.runs.length === 0 ? (
                  <p className="mt-2 rounded-[12px] border border-dashed border-[var(--border-subtle)] bg-white px-3 py-4 text-center text-xs text-[var(--text-muted)]">
                    No checks yet.
                  </p>
                ) : (
                  <div className="mt-2 overflow-hidden rounded-[14px] border border-[var(--line)] bg-white">
                    {status.runs.map((run) => (
                      <div
                        key={run.id}
                        className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5 last:border-0"
                      >
                        <span
                          className="w-16 shrink-0 pt-0.5 text-xs text-[var(--text-muted)]"
                          title={absTime(run.ran_at)}
                        >
                          {relativeTime(run.ran_at)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-ink">
                            {run.summary ||
                              (run.outcome === "updated"
                                ? "Brief updated"
                                : run.outcome === "failed"
                                  ? "Check failed"
                                  : "No new developments")}
                          </p>
                          {run.touched_fields.length > 0 && (
                            <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                              {run.touched_fields.join(", ")}
                            </p>
                          )}
                        </div>
                        {outcomeBadge(run)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
