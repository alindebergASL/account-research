"use client";

import { useEffect, useState } from "react";
import { GenerativeCanvasView } from "@/components/canvas/GenerativeCanvasView";
import type { CanvasDocument } from "@/lib/canvas/document";

type RuntimePayload = {
  document: CanvasDocument;
  proposals: unknown[];
  capability_proposals: unknown[];
};

export function CanvasRuntimeClient({ briefId }: { briefId: string }) {
  const [payload, setPayload] = useState<RuntimePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/briefs/${encodeURIComponent(briefId)}/canvas-runtime`, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return r.json();
      })
      .then(setPayload)
      .catch((e) => setError(String(e?.message ?? e)));
  }, [briefId]);
  if (error) return <div className="rounded border border-red-800 bg-red-950 p-4 text-red-100">{error}</div>;
  if (!payload) return <div className="p-6 text-slate-300">Loading generative canvas…</div>;
  return <div className="space-y-4"><GenerativeCanvasView document={payload.document} /><aside className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-200"><h2 className="font-semibold">Proposal queue</h2><p className="text-sm text-slate-400">{payload.proposals.length} proposal(s), {payload.capability_proposals.length} capability proposal(s)</p><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-3 text-xs">{JSON.stringify(payload.proposals, null, 2)}</pre></aside></div>;
}
