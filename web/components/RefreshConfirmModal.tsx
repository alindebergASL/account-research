"use client";

import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";

export default function RefreshConfirmModal({
  open,
  defaultMode,
  onClose,
  onSubmitted,
  briefId,
}: {
  open: boolean;
  defaultMode: "quick" | "standard" | "deep";
  onClose: () => void;
  onSubmitted?: (jobId: string) => void;
  briefId: string;
}) {
  const [mode, setMode] = useState(defaultMode);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/briefs/${briefId}/refresh`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (data.defaultMode === "quick" || data.defaultMode === "standard" || data.defaultMode === "deep") {
          setMode(data.defaultMode);
        }
      })
      .catch(() => {});
  }, [open, briefId]);

  if (!open) return null;

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/briefs/${briefId}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, notes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Refresh failed (${res.status})`);
      onSubmitted?.(data.jobId);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Refresh failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-[var(--line)]">
        <div className="flex items-start justify-between px-6 py-5 border-b border-[var(--line)]">
          <div>
            <h2 className="font-display text-2xl">Refresh brief</h2>
            <p className="text-sm text-muted mt-1">Run fresh research, then merge it into this brief.</p>
          </div>
          <button onClick={onClose} className="p-2 -mr-2 rounded-lg hover:bg-[var(--bg)]" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            We will snapshot the current brief before refreshing. New findings update matching items; older unmatched findings are kept as “previously found” so they do not disappear unexpectedly. Chat-added extensions are always retained.
          </div>
          <label className="block text-sm">
            <span className="block text-xs uppercase tracking-wider text-muted mb-1">Mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as any)} className="w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2">
              <option value="quick">Quick</option>
              <option value="standard">Standard</option>
              <option value="deep">Deep</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="block text-xs uppercase tracking-wider text-muted mb-1">Optional notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2" placeholder="Focus areas for this refresh…" />
          </label>
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        </div>
        <div className="px-6 py-4 border-t border-[var(--line)] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-[var(--line)] text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-ink text-white text-sm disabled:opacity-50">
            {busy && <Loader2 className="size-4 animate-spin" />} Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
