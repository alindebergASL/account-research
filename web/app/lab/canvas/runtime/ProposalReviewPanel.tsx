"use client";

import { useMemo, useState } from "react";
import type { CanvasProposalSummary, CapabilityProposalSummary } from "@/lib/hermes/canvasProposalSummary";

type ActionResult = { ok: true } | { ok: false; error: string };

type Props = {
  briefId: string;
  stateVersion: number;
  proposalSummaries: CanvasProposalSummary[];
  capabilitySummaries: CapabilityProposalSummary[];
  rawProposals: unknown[];
  rawCapabilityProposals: unknown[];
  pending: Record<string, boolean>;
  lastResult: Record<string, ActionResult>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRefresh: () => void;
  onSeed: () => void;
  seedPending: boolean;
  seedResult: ActionResult | null;
};

const STATUS_ORDER: CanvasProposalSummary["status"][] = [
  "queued",
  "failed",
  "applied",
  "auto_applied",
  "rejected",
  "undone",
  "retried",
  "timeout",
];

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "queued"
      ? "bg-amber-900 text-amber-100"
      : status === "failed"
        ? "bg-red-900 text-red-100"
        : status === "applied" || status === "auto_applied"
          ? "bg-emerald-900 text-emerald-100"
          : status === "rejected"
            ? "bg-slate-800 text-slate-300"
            : "bg-slate-800 text-slate-200";
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}

function MetaBadge({ children }: { children: React.ReactNode }) {
  return <span className="inline-block rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{children}</span>;
}

function groupByStatus(summaries: CanvasProposalSummary[]): Array<{ status: string; items: CanvasProposalSummary[] }> {
  const map = new Map<string, CanvasProposalSummary[]>();
  for (const s of summaries) {
    if (!map.has(s.status)) map.set(s.status, []);
    map.get(s.status)!.push(s);
  }
  const groups: Array<{ status: string; items: CanvasProposalSummary[] }> = [];
  for (const status of STATUS_ORDER) {
    const items = map.get(status);
    if (items && items.length) groups.push({ status, items });
  }
  // Any unexpected statuses go at the end.
  for (const [status, items] of map) {
    if (!STATUS_ORDER.includes(status as CanvasProposalSummary["status"])) {
      groups.push({ status, items });
    }
  }
  return groups;
}

function ProposalCard({
  summary,
  raw,
  pending,
  result,
  onApprove,
  onReject,
}: {
  summary: CanvasProposalSummary;
  raw: unknown;
  pending: boolean;
  result: ActionResult | undefined;
  onApprove: () => void;
  onReject: () => void;
}) {
  const evidence = (raw as { evidence?: unknown[] } | undefined)?.evidence ?? [];
  const payload = (raw as { payload?: unknown } | undefined)?.payload ?? null;
  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900/60">
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={summary.status} />
          <MetaBadge>layer {summary.action_layer}</MetaBadge>
          <MetaBadge>{summary.action_kind}</MetaBadge>
          <MetaBadge>confidence {summary.confidence}</MetaBadge>
          <MetaBadge>evidence {summary.evidence_count}</MetaBadge>
          <MetaBadge>
            v{summary.canvas_version_before}
            {summary.canvas_version_after !== null ? ` → v${summary.canvas_version_after}` : ""}
          </MetaBadge>
          {summary.is_stale_candidate ? <MetaBadge>stale</MetaBadge> : null}
        </div>
        <div className="mt-2 text-sm font-medium text-slate-100 break-words">{summary.display_title}</div>
        {summary.rationale_preview ? (
          <p className="mt-1 text-xs text-slate-400 whitespace-pre-wrap break-words">{summary.rationale_preview}</p>
        ) : null}
      </summary>
      <div className="space-y-3 border-t border-slate-800 px-4 py-3">
        {summary.rationale && summary.rationale !== summary.rationale_preview ? (
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Full rationale</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-200">{summary.rationale}</p>
          </section>
        ) : null}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Evidence ({summary.evidence_count})</h4>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs text-slate-200">
            {JSON.stringify(evidence, null, 2)}
          </pre>
        </section>
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Action payload</h4>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs text-slate-200">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </section>
        {summary.error ? (
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-red-400">Error</h4>
            <p className="mt-1 break-words text-sm text-red-200">{summary.error}</p>
          </section>
        ) : null}
        {summary.is_approvable ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              disabled={pending}
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Approve proposal
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={pending}
              className="rounded border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              Reject proposal
            </button>
            {summary.is_stale_candidate ? (
              <span className="text-xs text-amber-300">Canvas has changed since this proposal; approve may fail as stale.</span>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            {summary.status === "queued"
              ? "Not approvable (no recorded after-state)."
              : `Status ${summary.status} — not approvable.`}
          </p>
        )}
        {result ? (
          result.ok ? (
            <p className="text-xs text-emerald-300">Action succeeded.</p>
          ) : (
            <p className="text-xs text-red-300 break-words">Action failed: {result.error}</p>
          )
        ) : null}
      </div>
    </details>
  );
}

function CapabilityCard({ summary }: { summary: CapabilityProposalSummary }) {
  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900/60">
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={summary.status} />
          <MetaBadge>{summary.proposed_widget_kind}</MetaBadge>
          <MetaBadge>evidence {summary.evidence_count}</MetaBadge>
          <MetaBadge>source {summary.source_length} chars</MetaBadge>
        </div>
        <div className="mt-2 text-sm font-medium text-slate-100 break-words">{summary.proposed_widget_kind}</div>
        {summary.rationale_preview ? (
          <p className="mt-1 text-xs text-slate-400 whitespace-pre-wrap break-words">{summary.rationale_preview}</p>
        ) : null}
      </summary>
      <div className="space-y-3 border-t border-slate-800 px-4 py-3">
        <p className="text-xs text-amber-300">
          Renderer source is displayed as inert text only. Promotion requires static code review in a later PR.
        </p>
        {summary.rationale ? (
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rationale</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-200">{summary.rationale}</p>
          </section>
        ) : null}
        <a
          href={summary.viewer_href}
          className="inline-block rounded border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Open inert source viewer
        </a>
      </div>
    </details>
  );
}

export function ProposalReviewPanel(props: Props) {
  const { proposalSummaries, capabilitySummaries, rawProposals } = props;
  const rawById = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const r of rawProposals) {
      const id = (r as { id?: string })?.id;
      if (typeof id === "string") map.set(id, r);
    }
    return map;
  }, [rawProposals]);
  const groups = useMemo(() => groupByStatus(proposalSummaries), [proposalSummaries]);
  const [showDebug, setShowDebug] = useState(false);

  return (
    <aside className="space-y-4 rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-200">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Proposal review queue</h2>
          <p className="text-xs text-slate-400">
            {proposalSummaries.length} canvas proposal(s) · {capabilitySummaries.length} capability proposal(s) · canvas v{props.stateVersion}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={props.onSeed}
            disabled={props.seedPending}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            title="Creates deterministic fake proposals for review QA; no provider call."
          >
            {props.seedPending ? "Seeding…" : "Seed review proposals"}
          </button>
          <button
            type="button"
            onClick={props.onRefresh}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            Refresh
          </button>
        </div>
      </header>
      {props.seedResult ? (
        props.seedResult.ok ? (
          <p className="text-xs text-emerald-300">Seed proposals created. No provider call was made.</p>
        ) : (
          <p className="text-xs text-red-300 break-words">Seed failed: {props.seedResult.error}</p>
        )
      ) : (
        <p className="text-xs text-slate-500">Seed creates deterministic fake proposals for review QA; no provider call.</p>
      )}

      {groups.length === 0 ? (
        <p className="text-sm text-slate-400">No canvas proposals yet.</p>
      ) : (
        groups.map(({ status, items }) => (
          <section key={status} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {status} ({items.length})
            </h3>
            <div className="space-y-2">
              {items.map((s) => (
                <ProposalCard
                  key={s.id}
                  summary={s}
                  raw={rawById.get(s.id)}
                  pending={!!props.pending[s.id]}
                  result={props.lastResult[s.id]}
                  onApprove={() => props.onApprove(s.id)}
                  onReject={() => props.onReject(s.id)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Capability proposals ({capabilitySummaries.length})
        </h3>
        {capabilitySummaries.length === 0 ? (
          <p className="text-sm text-slate-400">No capability proposals.</p>
        ) : (
          <div className="space-y-2">
            {capabilitySummaries.map((s) => (
              <CapabilityCard key={s.id} summary={s} />
            ))}
          </div>
        )}
      </section>

      <details className="rounded border border-slate-800">
        <summary
          className="cursor-pointer px-3 py-2 text-xs text-slate-400"
          onClick={(e) => {
            e.preventDefault();
            setShowDebug((v) => !v);
          }}
        >
          {showDebug ? "Hide" : "Show"} raw JSON (debug)
        </summary>
        {showDebug ? (
          <div className="space-y-2 px-3 pb-3">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-3 text-xs">
              {JSON.stringify(props.rawProposals, null, 2)}
            </pre>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-3 text-xs">
              {JSON.stringify(props.rawCapabilityProposals, null, 2)}
            </pre>
          </div>
        ) : null}
      </details>
    </aside>
  );
}
