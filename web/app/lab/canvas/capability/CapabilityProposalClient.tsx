"use client";

import { useEffect, useState } from "react";

type Payload = {
  capability_proposal: {
    id: string;
    proposed_widget_kind: string;
    rationale: string;
    ts_renderer_source: string;
    data_schema: unknown;
    example_data: unknown;
    primitive_fallback: unknown;
    evidence: unknown[];
    status: string;
  };
};

export function CapabilityProposalClient({ briefId, capabilityProposalId }: { briefId: string; capabilityProposalId: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/briefs/${encodeURIComponent(briefId)}/canvas-capability-proposals/${encodeURIComponent(capabilityProposalId)}`, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return r.json();
      })
      .then(setPayload)
      .catch((e) => setError(String(e?.message ?? e)));
  }, [briefId, capabilityProposalId]);
  if (error) return <div className="rounded border border-red-800 bg-red-950 p-4 text-red-100 break-words">{error}</div>;
  if (!payload) return <div className="p-6 text-slate-300">Loading capability proposal…</div>;
  const proposal = payload.capability_proposal;
  const sourceLength = (proposal.ts_renderer_source ?? "").length;
  const evidence = Array.isArray(proposal.evidence) ? proposal.evidence : [];
  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950 p-5 text-slate-100">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">Capability proposal</p>
        <h1 className="text-2xl font-semibold break-words">{proposal.proposed_widget_kind}</h1>
        <p className="mt-2 text-sm text-slate-300 whitespace-pre-wrap break-words">{proposal.rationale}</p>
        <p className="mt-1 text-xs text-slate-500">
          Status: {proposal.status} · Source length: {sourceLength} chars · Evidence: {evidence.length}
        </p>
      </div>
      <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-100">
        <strong>Inert source — source-only — not executed.</strong> This source is not executed by production or lab runtime.
        Promotion requires static code review in a later PR.
      </div>
      <section className="space-y-2">
        <h2 className="font-semibold">Renderer source (inert text only)</h2>
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs text-slate-200">
          <code>{proposal.ts_renderer_source}</code>
        </pre>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Data schema</h2>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs text-slate-200">{JSON.stringify(proposal.data_schema, null, 2)}</pre>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Example data</h2>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs text-slate-200">{JSON.stringify(proposal.example_data, null, 2)}</pre>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Primitive fallback</h2>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs text-slate-200">{JSON.stringify(proposal.primitive_fallback, null, 2)}</pre>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Evidence ({evidence.length})</h2>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs text-slate-200">{JSON.stringify(evidence, null, 2)}</pre>
      </section>
    </div>
  );
}
