"use client";

import { useCallback, useEffect, useState } from "react";
import { Gavel, Plus, Trash2 } from "lucide-react";
import { Card, EmptyState, SectionHeader } from "./ui";
import { recordAnchorIdFromHash } from "@/lib/journalWorkspaceLocation";

type Decision = {
  id: string; title: string; decision_statement: string; rationale: string | null;
  owner_text: string | null; decision_at: number; lifecycle: "active" | "superseded" | "revoked";
  evidence_snapshot: string | null; supersedes_id: string | null; superseded_by_id: string | null;
  source_candidate_id: string | null;
};

export default function JournalDecisions({ briefId, canWrite }: { briefId: string; canWrite: boolean }) {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [supersedes, setSupersedes] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [rationale, setRationale] = useState("");
  const [owner, setOwner] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const base = `/api/briefs/${briefId}/journal/decisions`;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load decisions");
      setDecisions(data.decisions ?? []);
      setError(null);
    } catch (caught: any) { setError(caught?.message || "Failed to load decisions"); }
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (decisions === null) return;
    const anchorId = recordAnchorIdFromHash(window.location.hash, "journal-decision");
    if (!anchorId) return;
    const frame = window.requestAnimationFrame(() => {
      const anchor = document.getElementById(anchorId);
      if (!anchor) return;
      anchor.scrollIntoView({ block: "center" });
      anchor.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [decisions]);

  function beginSupersession(decision: Decision) {
    setSupersedes(decision.id); setTitle(decision.title); setStatement("");
    setRationale(""); setOwner(decision.owner_text ?? ""); setOpen(true);
  }

  async function create() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title, decision_statement: statement, rationale: rationale || null,
          owner_text: owner || null, decision_at: new Date(`${date}T12:00:00Z`).getTime(),
          supersedes_id: supersedes,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to record decision");
      setOpen(false); setSupersedes(null); setTitle(""); setStatement(""); setRationale(""); setOwner("");
      await refresh();
      window.location.hash = `journal-decision-${data.decision.id}`;
    } catch (caught: any) { setError(caught?.message || "Failed to record decision"); }
    finally { setBusy(false); }
  }

  async function mutate(id: string, method: "PATCH" | "DELETE", body?: object) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${base}/${id}`, {
        method, headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Decision action failed");
      await refresh();
    } catch (caught: any) { setError(caught?.message || "Decision action failed"); }
    finally { setBusy(false); }
  }

  return <Card className="p-5">
    <SectionHeader icon={<Gavel className="size-4 text-[var(--text-muted)]" />} title="Decisions" count={decisions?.length ?? 0}
      description="Durable decision register with auditable supersession and revocation." />
    {error && <div className="mt-3 rounded-lg bg-[var(--risk-bg)] px-3 py-2 text-sm text-[var(--risk-text)]">{error}</div>}
    {canWrite && <button type="button" onClick={() => { setSupersedes(null); setOpen((value) => !value); }}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--active-dark)] px-3 py-2 text-sm font-medium text-white">
      <Plus className="size-4" /> Record decision
    </button>}
    {open && <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--surface-muted)] p-4">
      <h3 className="text-sm font-semibold text-ink">{supersedes ? "Supersede decision" : "Record decision"}</h3>
      {supersedes && <p className="mt-1 text-xs text-muted">The prior record will become superseded when this replacement is created.</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="rounded-md border px-3 py-2 text-sm" />
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner / decider" className="rounded-md border px-3 py-2 text-sm" />
        <textarea value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Decision statement" className="sm:col-span-2 rounded-md border px-3 py-2 text-sm" />
        <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale" className="sm:col-span-2 rounded-md border px-3 py-2 text-sm" />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-md border px-3 py-2 text-sm" />
      </div>
      <div className="mt-3 flex gap-2"><button type="button" disabled={busy || !title.trim() || !statement.trim()} onClick={create} className="rounded-md bg-[var(--active-dark)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Confirm durable record</button>
        <button type="button" onClick={() => { setOpen(false); setSupersedes(null); }} className="rounded-md border bg-white px-3 py-1.5 text-xs">Cancel</button></div>
    </div>}
    <div className="mt-4 space-y-3">
      {decisions === null ? <p className="text-sm text-muted">Loading decisions…</p> : decisions.length === 0
        ? <EmptyState icon={<Gavel className="size-5" />} title="No decisions recorded" description="Accepted decision candidates can be promoted here, or record one deliberately." />
        : decisions.map((decision) => <article key={decision.id} id={`journal-decision-${decision.id}`} tabIndex={-1} className="scroll-mt-20 rounded-xl border border-[var(--line)] bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs capitalize">{decision.lifecycle}</span><h3 className="mt-2 font-semibold text-ink">{decision.title}</h3></div><time className="text-xs text-muted">{new Date(decision.decision_at).toLocaleDateString()}</time></div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{decision.decision_statement}</p>
          {decision.rationale && <p className="mt-2 text-xs text-[var(--text-secondary)]"><span className="font-semibold">Rationale:</span> {decision.rationale}</p>}
          {decision.owner_text && <p className="mt-1 text-xs text-muted">Owner / decider: {decision.owner_text}</p>}
          {decision.evidence_snapshot && <details className="mt-2 rounded-lg bg-[var(--ai-bg)] p-2 text-xs text-[var(--ai-text)]"><summary className="cursor-pointer font-medium">Frozen evidence</summary><pre className="mt-2 whitespace-pre-wrap font-sans">{decision.evidence_snapshot}</pre></details>}
          {canWrite && <div className="mt-3 flex flex-wrap gap-2">{decision.lifecycle === "active" && <><button type="button" disabled={busy} onClick={() => beginSupersession(decision)} className="rounded-md border px-2 py-1 text-xs">Supersede</button><button type="button" disabled={busy} onClick={() => void mutate(decision.id, "PATCH", { lifecycle: "revoked" })} className="rounded-md border px-2 py-1 text-xs">Revoke</button></>}{!decision.supersedes_id && !decision.superseded_by_id && <button type="button" disabled={busy} onClick={() => void mutate(decision.id, "DELETE")} aria-label="Delete decision" className="rounded-md border px-2 py-1 text-xs text-[var(--risk-text)]"><Trash2 className="size-3.5" /></button>}</div>}
        </article>)}
    </div>
  </Card>;
}
