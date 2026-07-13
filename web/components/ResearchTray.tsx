"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useDismissable } from "./useDismissable";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";

type JobView = {
  id: string;
  account_name: string;
  account_segment: string | null;
  mode: "quick" | "standard" | "deep";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  brief_id: string | null;
  error: string | null;
  cost_usd_cents: number | null;
  queue_position: number | null;
  retry_of_job_id: string | null;
};

type Snapshot = {
  active: JobView[];
  recent: JobView[];
};

type Toast = {
  id: string;
  jobId: string;
  kind: "done" | "failed";
  account: string;
  briefId: string | null;
};

const POLL_OPEN_MS = 4000;
const POLL_CLOSED_MS = 15000;

export default function ResearchTray() {
  const { open, setOpen, ref: wrapRef } = useDismissable<HTMLDivElement>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<Record<string, "cancel" | "retry" | undefined>>(
    {},
  );
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  // Track previous statuses so we can fire a toast on transition.
  const prevStatusesRef = useRef<Map<string, JobView["status"]>>(new Map());
  const initializedRef = useRef(false);

  // Polling. Open: 4s. Closed with active jobs: 15s. Closed and idle: stop.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (!alive) return;
      try {
        const r = await fetch("/api/research-jobs", { cache: "no-store" });
        if (r.ok) {
          const data: Snapshot = await r.json();
          if (alive) handleSnapshot(data);
          if (alive) setRequestError(null);
        } else if (alive) {
          setRequestError(statusMessage(r.status));
        }
      } catch {
        /* network blips ignored */
      }
      if (!alive) return;
      const hasActive = (snapshot?.active.length ?? 0) > 0;
      const interval = open
        ? POLL_OPEN_MS
        : hasActive
          ? POLL_CLOSED_MS
          : 0;
      if (interval > 0) {
        timer = setTimeout(tick, interval);
      }
    }

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snapshot?.active.length]);

  function handleSnapshot(s: Snapshot) {
    if (initializedRef.current) {
      const prev = prevStatusesRef.current;
      const all = [...s.active, ...s.recent];
      const newToasts: Toast[] = [];
      for (const j of all) {
        const prior = prev.get(j.id);
        if (
          prior &&
          prior !== j.status &&
          (j.status === "done" || j.status === "failed")
        ) {
          newToasts.push({
            id: `${j.id}:${j.status}`,
            jobId: j.id,
            kind: j.status,
            account: j.account_name,
            briefId: j.brief_id,
          });
        }
      }
      if (newToasts.length > 0) {
        setToasts((t) => {
          const seen = new Set(t.map((x) => x.id));
          const fresh = newToasts.filter((x) => !seen.has(x.id));
          return [...t, ...fresh];
        });
      }
    }
    const next = new Map<string, JobView["status"]>();
    for (const j of [...s.active, ...s.recent]) next.set(j.id, j.status);
    prevStatusesRef.current = next;
    initializedRef.current = true;
    setSnapshot(s);
  }

  // Auto-dismiss toasts after 8s.
  useEffect(() => {
    if (toasts.length === 0) return;
    const ids = toasts.map((t) => t.id);
    const timer = setTimeout(() => {
      setToasts((cur) => cur.filter((t) => !ids.includes(t.id)));
    }, 8000);
    return () => clearTimeout(timer);
  }, [toasts]);

  async function cancelJob(jobId: string) {
    setBusy((b) => ({ ...b, [jobId]: "cancel" }));
    try {
      const response = await fetch(`/api/research-jobs/${jobId}`, { method: "DELETE" });
      if (!response.ok) {
        setRequestError(statusMessage(response.status));
        return;
      }
      setRequestError(null);
      await refetch();
    } finally {
      setBusy((b) => ({ ...b, [jobId]: undefined }));
    }
  }
  async function retryJob(jobId: string) {
    setBusy((b) => ({ ...b, [jobId]: "retry" }));
    try {
      const response = await fetch(`/api/research-jobs/${jobId}/retry`, { method: "POST" });
      if (!response.ok) {
        setRequestError(statusMessage(response.status));
        return;
      }
      setRequestError(null);
      await refetch();
    } finally {
      setBusy((b) => ({ ...b, [jobId]: undefined }));
    }
  }
  async function refetch() {
    const r = await fetch("/api/research-jobs", { cache: "no-store" });
    if (r.ok) {
      handleSnapshot(await r.json());
      setRequestError(null);
    } else {
      setRequestError(statusMessage(r.status));
    }
  }

  const activeCount = snapshot?.active.length ?? 0;
  const hasContent =
    (snapshot?.active.length ?? 0) > 0 || (snapshot?.recent.length ?? 0) > 0;

  return (
    <>
      <div className="relative" ref={wrapRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors px-2 py-1 rounded-lg hover:bg-white border border-transparent hover:border-[var(--line)]"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Research jobs"
        >
          <Sparkles className="size-4" />
          <span className="hidden text-xs sm:inline">Research</span>
          {activeCount > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-white text-[10px] font-medium">
              {activeCount}
            </span>
          )}
        </button>
        {open && (
          <div
            role="menu"
            className="fixed left-3 right-3 top-12 mt-2 bg-white border border-[var(--line)] rounded-xl shadow-xl overflow-hidden z-30 sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:w-[calc(100vw-24px)] sm:max-w-[360px]"
          >
            <div className="px-4 py-2.5 border-b border-[var(--line)] flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-muted">
                Research jobs
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted hover:text-ink"
                aria-label="Close"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {requestError && (
                <div role="alert" className="px-4 py-2.5 text-xs text-red-700 bg-red-50 border-b border-red-100">
                  {requestError}
                </div>
              )}
              {!hasContent && (
                <div className="px-4 py-6 text-sm text-muted text-center">
                  No research yet. Queue one from the home page.
                </div>
              )}
              {snapshot && snapshot.active.length > 0 && (
                <Section title="In progress">
                  {snapshot.active.map((j) => (
                    <JobRow
                      key={j.id}
                      job={j}
                      busy={busy[j.id]}
                      onCancel={() => cancelJob(j.id)}
                    />
                  ))}
                </Section>
              )}
              {snapshot && snapshot.recent.length > 0 && (
                <Section title="Recent">
                  {snapshot.recent.map((j) => (
                    <JobRow
                      key={j.id}
                      job={j}
                      busy={busy[j.id]}
                      onRetry={
                        j.status === "failed" || j.status === "cancelled"
                          ? () => retryJob(j.id)
                          : undefined
                      }
                    />
                  ))}
                </Section>
              )}
            </div>
          </div>
        )}
      </div>
      <ToastStack
        toasts={toasts}
        onDismiss={(id) =>
          setToasts((cur) => cur.filter((t) => t.id !== id))
        }
      />
    </>
  );
}

function statusMessage(status: number): string {
  if (status === 413) return "That request is too large. Reduce its text and try again.";
  if (status === 429) return "Research is at capacity. Wait for an active job to finish, then retry.";
  if (status === 503) return "Research providers are currently disabled. Try again after an operator enables them.";
  return "Research jobs could not be updated. Please try again.";
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-muted">
        {title}
      </div>
      <ul>{children}</ul>
    </div>
  );
}

function JobRow({
  job,
  busy,
  onCancel,
  onRetry,
}: {
  job: JobView;
  busy: "cancel" | "retry" | undefined;
  onCancel?: () => void;
  onRetry?: () => void;
}) {
  const elapsed = useElapsed(
    job.status === "running" ? job.started_at : null,
  );
  const Icon = statusIcon(job.status);
  const tone = statusTone(job.status);

  const body = (
    <div className="flex items-start gap-2.5 flex-1 min-w-0">
      <Icon className={`size-4 mt-0.5 shrink-0 ${tone}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{job.account_name}</div>
        <div className="text-[11px] text-muted truncate flex items-center gap-1.5">
          <span>{job.mode}</span>
          <span>·</span>
          <span>{statusLabel(job, elapsed)}</span>
          {job.status === "done" && job.cost_usd_cents !== null && (
            <>
              <span>·</span>
              <span>est. {formatCost(job.cost_usd_cents)}</span>
            </>
          )}
          {job.status === "done" && job.cost_usd_cents === null && (
            <>
              <span>·</span>
              <span>—</span>
            </>
          )}
        </div>
        {job.status === "failed" && job.error && (
          <div className="text-[11px] text-red-700 mt-0.5 line-clamp-2">
            {job.error}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <li className="px-4 py-2.5 border-t border-[var(--line)] first:border-t-0 hover:bg-[var(--bg)]">
      <div className="flex items-center gap-2">
        {job.status === "done" && job.brief_id ? (
          <Link href={`/brief/${job.brief_id}`} className="flex-1 min-w-0">
            {body}
          </Link>
        ) : (
          <div className="flex-1 min-w-0">{body}</div>
        )}
        <div className="flex items-center gap-1 shrink-0">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={!!busy}
              className="p-1 rounded text-muted/60 hover:text-red-600 disabled:opacity-50"
              aria-label="Cancel"
              title="Cancel"
            >
              {busy === "cancel" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <X className="size-3.5" />
              )}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={!!busy}
              className="p-1 rounded text-muted/60 hover:text-ink disabled:opacity-50"
              aria-label="Retry"
              title="Retry"
            >
              {busy === "retry" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function statusIcon(s: JobView["status"]) {
  switch (s) {
    case "queued":
    case "running":
      return Loader2;
    case "done":
      return CheckCircle2;
    case "failed":
      return AlertCircle;
    case "cancelled":
      return XCircle;
  }
}
function statusTone(s: JobView["status"]): string {
  switch (s) {
    case "queued":
      return "text-muted";
    case "running":
      return "text-accent animate-spin";
    case "done":
      return "text-emerald-600";
    case "failed":
      return "text-red-600";
    case "cancelled":
      return "text-muted";
  }
}
function statusLabel(job: JobView, elapsed: string): string {
  switch (job.status) {
    case "queued":
      return job.queue_position && job.queue_position > 1
        ? `Queued · position ${job.queue_position}`
        : "Queued";
    case "running":
      return `Researching · ${elapsed}`;
    case "done":
      return `Done · ${formatRelative(job.finished_at ?? job.created_at)}`;
    case "failed":
      return `Failed · ${formatRelative(job.finished_at ?? job.created_at)}`;
    case "cancelled":
      return `Cancelled · ${formatRelative(job.finished_at ?? job.created_at)}`;
  }
}

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (startedAt === null) return "0s";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`min-w-[260px] max-w-[360px] px-4 py-3 rounded-xl shadow-lg border bg-white text-sm flex items-start gap-2.5 ${
            t.kind === "done"
              ? "border-emerald-200"
              : "border-red-200"
          }`}
        >
          {t.kind === "done" ? (
            <CheckCircle2 className="size-4 text-emerald-600 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="size-4 text-red-600 mt-0.5 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-medium">
              {t.kind === "done" ? "Brief ready" : "Brief failed"}
            </div>
            <div className="text-muted truncate">{t.account}</div>
            {t.kind === "done" && t.briefId && (
              <Link
                href={`/brief/${t.briefId}`}
                className="text-xs text-accent hover:underline"
                onClick={() => onDismiss(t.id)}
              >
                Open brief
              </Link>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="text-muted hover:text-ink"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
