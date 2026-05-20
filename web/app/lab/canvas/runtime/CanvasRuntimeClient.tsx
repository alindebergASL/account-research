"use client";

import { useCallback, useEffect, useState } from "react";
import { GenerativeCanvasView } from "@/components/canvas/GenerativeCanvasView";
import type { CanvasDocument } from "@/lib/canvas/document";
import type { CanvasProposalSummary, CapabilityProposalSummary } from "@/lib/hermes/canvasProposalSummary";
import { ProposalReviewPanel } from "./ProposalReviewPanel";

type RuntimePayload = {
  document: CanvasDocument;
  state_version: number;
  proposals: unknown[];
  capability_proposals: unknown[];
  proposal_summaries: CanvasProposalSummary[];
  capability_proposal_summaries: CapabilityProposalSummary[];
};

type ActionResult = { ok: true } | { ok: false; error: string };

export function CanvasRuntimeClient({ briefId }: { briefId: string }) {
  const [payload, setPayload] = useState<RuntimePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [lastResult, setLastResult] = useState<Record<string, ActionResult>>({});
  const [seedPending, setSeedPending] = useState(false);
  const [seedResult, setSeedResult] = useState<ActionResult | null>(null);

  const fetchRuntime = useCallback(async () => {
    const r = await fetch(`/api/briefs/${encodeURIComponent(briefId)}/canvas-runtime`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return (await r.json()) as RuntimePayload;
  }, [briefId]);

  const refresh = useCallback(() => {
    fetchRuntime()
      .then((p) => {
        setPayload(p);
        setError(null);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, [fetchRuntime]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const approve = useCallback(
    async (pid: string) => {
      setPending((m) => ({ ...m, [pid]: true }));
      try {
        const r = await fetch(`/api/briefs/${encodeURIComponent(briefId)}/canvas-proposals/${encodeURIComponent(pid)}/approve`, {
          method: "POST",
          credentials: "same-origin",
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(String((body as { error?: string }).error ?? `${r.status}`));
        }
        setLastResult((m) => ({ ...m, [pid]: { ok: true } }));
        refresh();
      } catch (e) {
        setLastResult((m) => ({ ...m, [pid]: { ok: false, error: String((e as Error)?.message ?? e) } }));
      } finally {
        setPending((m) => ({ ...m, [pid]: false }));
      }
    },
    [briefId, refresh],
  );

  const reject = useCallback(
    async (pid: string) => {
      setPending((m) => ({ ...m, [pid]: true }));
      try {
        const r = await fetch(`/api/briefs/${encodeURIComponent(briefId)}/canvas-proposals/${encodeURIComponent(pid)}/reject`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Rejected from Phase B review lab" }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(String((body as { error?: string }).error ?? `${r.status}`));
        }
        setLastResult((m) => ({ ...m, [pid]: { ok: true } }));
        refresh();
      } catch (e) {
        setLastResult((m) => ({ ...m, [pid]: { ok: false, error: String((e as Error)?.message ?? e) } }));
      } finally {
        setPending((m) => ({ ...m, [pid]: false }));
      }
    },
    [briefId, refresh],
  );

  const seed = useCallback(async () => {
    setSeedPending(true);
    try {
      const r = await fetch(`/api/briefs/${encodeURIComponent(briefId)}/canvas-proposals/seed`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(String((body as { error?: string }).error ?? `${r.status}`));
      }
      setSeedResult({ ok: true });
      refresh();
    } catch (e) {
      setSeedResult({ ok: false, error: String((e as Error)?.message ?? e) });
    } finally {
      setSeedPending(false);
    }
  }, [briefId, refresh]);

  if (error) return <div className="rounded border border-red-800 bg-red-950 p-4 text-red-100 break-words">{error}</div>;
  if (!payload) return <div className="p-6 text-slate-300">Loading generative canvas…</div>;

  return (
    <div className="space-y-4">
      <header className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-200">
        <h1 className="text-xl font-semibold">Generative Canvas Review Lab</h1>
        <p className="text-xs text-slate-400">
          Source proposals are inert unless approved. Capability renderer source is never executed.
        </p>
      </header>
      <GenerativeCanvasView document={payload.document} />
      <ProposalReviewPanel
        briefId={briefId}
        stateVersion={payload.state_version}
        proposalSummaries={payload.proposal_summaries}
        capabilitySummaries={payload.capability_proposal_summaries}
        rawProposals={payload.proposals}
        rawCapabilityProposals={payload.capability_proposals}
        pending={pending}
        lastResult={lastResult}
        onApprove={approve}
        onReject={reject}
        onRefresh={refresh}
        onSeed={seed}
        seedPending={seedPending}
        seedResult={seedResult}
      />
    </div>
  );
}
