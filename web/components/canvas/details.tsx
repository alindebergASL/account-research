import type {
  CanvasWidget,
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
  ExtensionWidget,
} from "../../lib/canvas/schema";
import { ConfidenceChip, SourceLink } from "../DrillModal";

function Meta({
  why_included,
  confidence,
  source,
}: {
  why_included?: string;
  confidence?: string;
  source?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
      {confidence && <ConfidenceChip value={confidence} />}
      {source === "chat" && (
        <span className="chip chip-na text-[10px]" title="Added in chat">
          Added in chat
        </span>
      )}
      {why_included && <span>{why_included}</span>}
    </div>
  );
}

function Sources({ sources }: { sources: { title: string; url: string }[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-wider text-muted mb-2">
        Sources
      </div>
      <ul className="space-y-1 text-sm">
        {sources.map((s, i) => (
          <li key={i}>
            {s.url ? <SourceLink source={s.url} /> : <span>{s.title}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- section_ref ----------------------------------------------------------

export function SectionRefDetail({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  return (
    <div>
      <Meta
        why_included={widget.why_included}
        confidence={widget.confidence}
      />
      <div className="rounded-lg bg-[var(--bg)] border border-[var(--line)] px-3 py-2 text-xs text-muted mb-3">
        Derived from standard brief section: <code>{widget.data.section_key}</code>
      </div>
      <p className="text-sm whitespace-pre-line leading-relaxed">
        {widget.data.preview || "—"}
      </p>
      <Sources sources={widget.sources} />
    </div>
  );
}

// ---- evidence_board -------------------------------------------------------

export function EvidenceBoardDetail({
  widget,
}: {
  widget: import("zod").infer<typeof EvidenceBoardWidget>;
}) {
  return (
    <div>
      <Meta why_included={widget.why_included} />
      {widget.data.items.length === 0 ? (
        <p className="text-sm text-muted">No evidence available.</p>
      ) : (
        <ul className="space-y-3">
          {widget.data.items.map((it, i) => (
            <li
              key={i}
              className="rounded-lg border border-[var(--line)] p-3 text-sm"
            >
              <p className="leading-snug">{it.text}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                {it.confidence && <ConfidenceChip value={it.confidence} />}
                {it.tag && (
                  <span className="chip chip-na text-[10px]">{it.tag}</span>
                )}
                {it.source && <SourceLink source={it.source} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- action_panel ---------------------------------------------------------

function normalizeAction(a: import("zod").infer<typeof ActionPanelWidget>["data"]["actions"][number]) {
  if ("label" in a) {
    return {
      title: a.label,
      detail: a.detail,
      severity: undefined as ("low" | "medium" | "high" | undefined),
      owner: undefined as string | undefined,
    };
  }
  return { title: a.text, detail: a.why, severity: a.severity, owner: a.owner };
}

function SeverityChip({ s }: { s?: "low" | "medium" | "high" }) {
  if (!s) return null;
  const cls =
    s === "high" ? "chip-low" : s === "medium" ? "chip-med" : "chip-na";
  return <span className={`chip ${cls} text-[10px]`}>severity: {s}</span>;
}

export function ActionPanelDetail({
  widget,
}: {
  widget: import("zod").infer<typeof ActionPanelWidget>;
}) {
  return (
    <div>
      <Meta why_included={widget.why_included} />
      <ul className="space-y-3">
        {widget.data.actions.map((raw, i) => {
          const a = normalizeAction(raw);
          return (
            <li
              key={i}
              className="rounded-lg border border-[var(--line)] p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="font-medium">{a.title}</div>
                <SeverityChip s={a.severity} />
              </div>
              {a.detail && (
                <p className="mt-1 leading-snug text-muted whitespace-pre-line">
                  {a.detail}
                </p>
              )}
              {a.owner && (
                <p className="mt-1 text-xs text-muted">Owner: {a.owner}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- open_questions -------------------------------------------------------

function questionText(q: import("zod").infer<typeof OpenQuestionsWidget>["data"]["questions"][number]) {
  return typeof q === "string" ? q : q.text;
}

function questionMeta(q: import("zod").infer<typeof OpenQuestionsWidget>["data"]["questions"][number]) {
  if (typeof q === "string") return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
      {q.blocking && (
        <span className="chip chip-low text-[10px]">blocking</span>
      )}
      {q.hypothesis && <span>Hypothesis: {q.hypothesis}</span>}
    </div>
  );
}

export function OpenQuestionsDetail({
  widget,
}: {
  widget: import("zod").infer<typeof OpenQuestionsWidget>;
}) {
  return (
    <div>
      <Meta why_included={widget.why_included} />
      {widget.data.questions.length === 0 ? (
        <p className="text-sm text-muted">No open questions.</p>
      ) : (
        <ul className="space-y-3 text-sm">
          {widget.data.questions.map((q, i) => (
            <li key={i} className="rounded-lg border border-[var(--line)] p-3">
              <p>{questionText(q)}</p>
              {questionMeta(q)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- metric ---------------------------------------------------------------

export function MetricDetail({
  widget,
}: {
  widget: import("zod").infer<typeof MetricWidget>;
}) {
  const d = widget.data;
  return (
    <div>
      <Meta why_included={widget.why_included} />
      <div className="rounded-lg border border-[var(--line)] p-4">
        <div className="font-display text-5xl tracking-tight">{d.value}</div>
        {(d.unit || d.helper) && (
          <div className="text-sm text-muted mt-1">{d.unit ?? d.helper}</div>
        )}
        {d.delta && <div className="text-sm text-muted mt-1">Δ {d.delta}</div>}
        {d.as_of && (
          <div className="text-xs text-muted mt-1">As of {d.as_of}</div>
        )}
        {d.label && (
          <div className="text-xs uppercase tracking-wider text-muted mt-3">
            {d.label}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- extension ------------------------------------------------------------

export function ExtensionDetail({
  widget,
}: {
  widget: import("zod").infer<typeof ExtensionWidget>;
}) {
  const d = widget.data;
  return (
    <div>
      <Meta
        why_included={widget.why_included}
        confidence={widget.confidence}
        source={widget.source}
      />
      <div className="rounded-lg bg-[var(--bg)] border border-[var(--line)] px-3 py-2 text-xs text-muted mb-3">
        Brief extension · {d.ext_kind}
      </div>
      {d.ext_kind === "card" && (
        <p className="text-sm leading-relaxed whitespace-pre-line">
          {d.body || "—"}
        </p>
      )}
      {d.ext_kind === "narrative" && (
        <p className="text-sm leading-relaxed whitespace-pre-line">
          {d.body || "—"}
        </p>
      )}
      {d.ext_kind === "list" && (
        <ul className="list-disc pl-5 text-sm space-y-1">
          {(d.items ?? []).map((it, i) => (
            <li key={i}>{it}</li>
          ))}
          {(d.items ?? []).length === 0 && (
            <li className="text-muted">No items.</li>
          )}
        </ul>
      )}
      {d.ext_kind === "table" && (
        <div className="overflow-auto">
          {(d.columns?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted">Empty table.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted border-b border-[var(--line)]">
                  {d.columns!.map((c, i) => (
                    <th key={i} className="py-2 pr-3 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(d.rows ?? []).map((row, i) => (
                  <tr key={i} className="border-b border-[var(--line)]">
                    {row.map((cell, j) => (
                      <td key={j} className="py-2 pr-3 align-top">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <Sources sources={widget.sources} />
    </div>
  );
}

// ---- fallback -------------------------------------------------------------

export function UnknownDetail({ widget }: { widget: CanvasWidget }) {
  return (
    <p className="text-sm text-muted">Unknown widget kind: {widget.kind}</p>
  );
}
