"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import type {
  JournalRadarBuckets,
  JournalRadarChangeItem,
  JournalRadarDestination,
  JournalRadarReviewState,
} from "@/lib/journalRadar";

type RadarResponse = {
  manifest_hash: string;
  manifest_schema_version: number;
  review_state: JournalRadarReviewState;
};

const GROUPS: Array<[keyof JournalRadarBuckets, string]> = [
  ["new_entries", "New evidence and entries"],
  ["edited_entries", "Edited entries"],
  ["removed_entries", "Removed entries"],
  ["source_changes", "Source changes"],
  ["candidates_awaiting_review", "Candidates awaiting review"],
  ["candidate_status_transitions", "Candidate status changes"],
  ["new_tasks", "New to-dos"],
  ["completed_tasks", "Completed or reopened to-dos"],
  ["removed_tasks", "Removed to-dos"],
  ["task_detail_changes", "To-do detail changes"],
  ["new_decisions", "New decisions"],
  ["decision_lifecycle_changes", "Decision record changes"],
  ["brief_version_changes", "Brief versions"],
  ["monitor_updates", "Monitor updates"],
];

export default function JournalRadar({
  briefId,
  onNavigate,
}: {
  briefId: string;
  onNavigate: (destination: JournalRadarDestination) => void;
}) {
  const [radar, setRadar] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/briefs/${briefId}/journal/radar`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load change radar");
      setRadar(data as RadarResponse);
      setError(null);
    } catch (caught: any) {
      setError(caught?.message || "Failed to load change radar");
    } finally {
      setLoading(false);
    }
  }, [briefId]);

  // Opening or refreshing Journal only reads current state. Review state moves
  // exclusively through the explicit button handler below.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function markReviewed() {
    if (!radar || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/briefs/${briefId}/journal/radar/checkpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest_hash: radar.manifest_hash,
          manifest_schema_version: radar.manifest_schema_version,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        setNotice("The Journal changed since this radar loaded. The radar has been refreshed; review the latest state before marking it reviewed.");
        await refresh();
        return;
      }
      if (!response.ok) throw new Error(data.error || "Failed to mark changes reviewed");
      setNotice("Current Journal state marked reviewed for you.");
      await refresh();
    } catch (caught: any) {
      setError(caught?.message || "Failed to mark changes reviewed");
    } finally {
      setSaving(false);
    }
  }

  const state = radar?.review_state;
  const visibleGroups = state ? GROUPS.filter(([key]) => state.buckets[key].count > 0) : [];

  function itemButton(item: JournalRadarChangeItem) {
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => onNavigate(item.destination)}
        className="min-w-0 rounded-lg border border-[var(--line)] bg-white px-2.5 py-2 text-left text-xs text-ink hover:bg-[var(--surface-muted)]"
      >
        <span className="block break-words font-medium">{item.label}</span>
        <span className="mt-0.5 block text-[11px] text-muted">Open destination →</span>
      </button>
    );
  }

  return (
    <section aria-labelledby="journal-radar-heading" className="overflow-hidden rounded-[20px] border border-[var(--line)] bg-white p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Deterministic · personal checkpoint</div>
          <h3 id="journal-radar-heading" className="mt-1 font-editorial text-lg font-semibold text-ink">Changed since your last review</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted">Structural changes from saved Journal records. This panel does not use AI, and opening it never marks anything reviewed.</p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || saving}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-[var(--line)] bg-white px-3 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh radar
          </button>
          <button
            type="button"
            onClick={() => void markReviewed()}
            disabled={!radar || loading || saving}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-[var(--active-dark)] px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Mark reviewed
          </button>
        </div>
      </div>

      <div aria-live="polite" role="status" className="mt-3 min-h-5 text-sm">
        {loading && !radar && <span className="text-muted">Loading change radar…</span>}
        {error && <span className="break-words text-[var(--risk-text)]">{error}</span>}
        {notice && <span className="break-words text-[var(--success-text)]">{notice}</span>}
        {!loading && !error && state?.state === "no_checkpoint" && (
          <span className="font-medium text-ink">No review checkpoint yet. Mark reviewed when you have reviewed the current Journal state.</span>
        )}
        {!loading && !error && state?.state === "unchanged" && (
          <span className="text-[var(--success-text)]">No structural changes since your checkpoint.</span>
        )}
        {!loading && !error && state?.state === "changes" && (
          <span className="font-medium text-ink">{state.total_changes} recorded change{state.total_changes === 1 ? "" : "s"} since your checkpoint.</span>
        )}
      </div>

      {visibleGroups.length > 0 && (
        <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
          {visibleGroups.map(([key, title]) => {
            const group = state!.buckets[key];
            return (
              <div key={key} className="min-w-0 rounded-xl bg-[var(--surface-muted)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="min-w-0 break-words text-sm font-semibold text-ink">{title}</h4>
                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs text-muted">{group.count}</span>
                </div>
                <div className="mt-2 grid min-w-0 gap-2">{group.items.map(itemButton)}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
