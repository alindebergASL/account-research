"use client";

import { useEffect, useState } from "react";
import { Eye, RotateCcw, X, Loader2 } from "lucide-react";
import type { Brief } from "@/lib/schema";

type VersionRow = {
  id: string;
  version_no: number;
  reason: string;
  triggered_by: string;
  refresh_job_id: string | null;
  created_at: number;
};

export default function BriefVersions({
  open,
  briefId,
  onClose,
  onReverted,
}: {
  open: boolean;
  briefId: string;
  onClose: () => void;
  onReverted: (brief: Brief) => void;
}) {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [selected, setSelected] = useState<{ row: VersionRow; brief: Brief } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    fetch(`/api/briefs/${briefId}/versions`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        setVersions(data.versions || []);
      })
      .catch((e: any) => setError(e?.message || "Failed to load versions"));
  }, [open, briefId]);

  if (!open) return null;

  async function view(row: VersionRow) {
    setBusy(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/briefs/${briefId}/versions/${row.id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSelected({ row, brief: data.version.brief });
    } catch (e: any) {
      setError(e?.message || "Failed to load version");
    } finally {
      setBusy(null);
    }
  }

  async function revert(row: VersionRow) {
    if (
      !confirm(
        `Reverting will snapshot the current brief first, then replace it with v${row.version_no}. Continue?`,
      )
    )
      return;
    setBusy(`revert-${row.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/briefs/${briefId}/versions/${row.id}/revert`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      onReverted(data.brief);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Revert failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30">
      <div className="h-full w-full max-w-2xl bg-white shadow-2xl border-l border-[var(--line)] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-[var(--line)] px-6 py-5 flex items-start justify-between">
          <div>
            <h2 className="font-display text-2xl">Brief versions</h2>
            <p className="text-sm text-muted">Snapshots are retained indefinitely.</p>
          </div>
          <button onClick={onClose} className="p-2 -mr-2 rounded-lg hover:bg-[var(--bg)]" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          {versions.length === 0 ? (
            <p className="text-sm text-muted">No previous versions yet.</p>
          ) : (
            <div className="divide-y divide-[var(--line)] border border-[var(--line)] rounded-xl overflow-hidden">
              {versions.map((row) => (
                <div key={row.id} className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">v{row.version_no} · {row.reason}</div>
                    <div className="text-xs text-muted flex flex-wrap items-center gap-2">
                      <span>{new Date(row.created_at).toLocaleString()}</span>
                      <span>·</span>
                      <span>{row.triggered_by}</span>
                      {row.refresh_job_id && (
                        <span
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg)] border border-[var(--line)]"
                          title="Refresh job id"
                        >
                          job {row.refresh_job_id.slice(0, 8)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => view(row)} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border border-[var(--line)]">
                      {busy === row.id ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} View
                    </button>
                    <button onClick={() => revert(row)} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-ink text-white">
                      {busy === `revert-${row.id}` ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Revert
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {selected && (
            <div className="rounded-xl border border-[var(--line)] p-4 bg-[var(--bg)]">
              <div className="text-xs uppercase tracking-wider text-muted mb-2">Snapshot preview</div>
              <h3 className="font-display text-xl">{selected.brief.account_name}</h3>
              <p className="text-sm text-muted mb-3">Generated {selected.brief.generated_at}</p>
              <p className="text-sm leading-relaxed">{selected.brief.snapshot}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
