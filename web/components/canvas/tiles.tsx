import type {
  CanvasWidget,
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
  ExtensionWidget,
} from "../../lib/canvas/schema";
import {
  ConfidenceBar,
  ConfidenceCountsInline,
  InitiativeLandscape,
  MiniGauge,
  aggregateConfidence,
  parseFractionValue,
  sectionKeyTone,
} from "./visuals";

function TileHeader(_props: { title: string; kindLabel: string }) {
  // Header chrome lives in WidgetTile so all widget kinds share the same
  // title/drill affordances and confidence/status placement.
  return null;
}

// ---- section_ref ----------------------------------------------------------

export function SectionRefTile({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  const tone = sectionKeyTone(widget.data.section_key);
  const evidence = widget.evidence;
  const hasStructured = evidence.length > 0;
  // Sections seeded with structured evidence get the landscape treatment
  // so the Canvas reads like a dashboard, not a duplicate of Brief view.
  const landscapeKeys = new Set([
    "top_initiatives",
    "recent_signals",
    "personas",
    "risks",
    "competitive_signals",
  ]);
  const useLandscape =
    hasStructured && landscapeKeys.has(widget.data.section_key);

  if (useLandscape) {
    return (
      <div className="space-y-2">
        <TileHeader title={widget.title} kindLabel="Section" />
        <InitiativeLandscape items={evidence} max={4} tone={tone} />
      </div>
    );
  }

  return (
    <div>
      <TileHeader title={widget.title} kindLabel="Section" />
      <p className="text-sm text-ink whitespace-pre-line line-clamp-6 leading-snug">
        {widget.data.preview || "—"}
      </p>
    </div>
  );
}

// ---- evidence_board -------------------------------------------------------

export function EvidenceBoardTile({
  widget,
}: {
  widget: import("zod").infer<typeof EvidenceBoardWidget>;
}) {
  const items = widget.data.items.slice(0, 3);
  const counts = aggregateConfidence(widget.data.items);
  return (
    <div className="space-y-3">
      <TileHeader title={widget.title} kindLabel="Evidence" />
      {widget.data.items.length > 0 && (
        <div className="space-y-1.5">
          <ConfidenceBar counts={counts} />
          <ConfidenceCountsInline counts={counts} />
        </div>
      )}
      <ul className="space-y-2 text-sm">
        {items.map((it, i) => (
          <li key={i} className="pl-3 border-l-2 border-[var(--line)]">
            <span className="line-clamp-2">{it.text}</span>
          </li>
        ))}
        {widget.data.items.length === 0 && (
          <li className="text-muted">No evidence available.</li>
        )}
      </ul>
      {widget.data.items.length > items.length && (
        <p className="text-xs text-muted">
          +{widget.data.items.length - items.length} more · open to view
        </p>
      )}
    </div>
  );
}

// ---- action_panel ---------------------------------------------------------

// Normalises both ActionItem shapes (legacy {label, detail?} and richer
// {text, why, owner?, severity}) into a single render shape.
function normalizeAction(a: import("zod").infer<typeof ActionPanelWidget>["data"]["actions"][number]) {
  if ("label" in a) {
    return { title: a.label, detail: a.detail ?? "", severity: undefined as ("low" | "medium" | "high" | undefined) };
  }
  return { title: a.text, detail: a.why, severity: a.severity };
}

export function ActionPanelTile({
  widget,
}: {
  widget: import("zod").infer<typeof ActionPanelWidget>;
}) {
  const first = widget.data.actions[0]
    ? normalizeAction(widget.data.actions[0])
    : null;
  return (
    <div>
      <TileHeader title={widget.title} kindLabel="Recommended action" />
      {first ? (
        <p className="text-sm leading-snug line-clamp-5">
          {first.detail || first.title}
        </p>
      ) : (
        <p className="text-sm text-muted">No actions.</p>
      )}
    </div>
  );
}

// ---- open_questions -------------------------------------------------------

function questionText(q: import("zod").infer<typeof OpenQuestionsWidget>["data"]["questions"][number]) {
  return typeof q === "string" ? q : q.text;
}

export function OpenQuestionsTile({
  widget,
}: {
  widget: import("zod").infer<typeof OpenQuestionsWidget>;
}) {
  return (
    <div>
      <TileHeader title={widget.title} kindLabel="Open questions" />
      {widget.data.questions.length === 0 ? (
        <p className="text-sm text-muted">No open questions.</p>
      ) : (
        <ul className="space-y-1 text-sm list-disc pl-5">
          {widget.data.questions.slice(0, 3).map((q, i) => (
            <li key={i} className="line-clamp-2">
              {questionText(q)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- metric ---------------------------------------------------------------

export function MetricTile({
  widget,
}: {
  widget: import("zod").infer<typeof MetricWidget>;
}) {
  const d = widget.data;
  const helper = d.helper ?? d.unit;
  // Detect "N/M" style metric values (e.g. AI maturity emits "4/5") and
  // render a small gauge alongside the number. Plain numeric / string
  // metrics fall back to the existing big-number treatment.
  const fraction = parseFractionValue(d.value);
  return (
    <div>
      <TileHeader title={widget.title} kindLabel="Metric" />
      <div className="flex items-center gap-3">
        {fraction && (
          <MiniGauge current={fraction.current} max={fraction.max} size={56} />
        )}
        <div className="min-w-0">
          {!fraction && (
            <div className="flex items-baseline gap-2">
              <span className="font-display text-4xl tracking-tight">
                {d.value}
              </span>
              {helper && <span className="text-xs text-muted">{helper}</span>}
            </div>
          )}
          {fraction && helper && (
            <span className="text-xs text-muted">{helper}</span>
          )}
          {d.label && (
            <p className="text-xs text-muted mt-1 truncate" title={d.label}>
              {d.label}
            </p>
          )}
          {d.delta && (
            <p className="text-xs text-muted mt-0.5">Δ {d.delta}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- extension ------------------------------------------------------------

function extensionListItemText(item: string | { heading?: string; text: string }): string {
  return typeof item === "string" ? item : item.heading ? `${item.heading}: ${item.text}` : item.text;
}

export function ExtensionTile({
  widget,
}: {
  widget: import("zod").infer<typeof ExtensionWidget>;
}) {
  const d = widget.data;
  return (
    <div>
      {d.ext_kind === "card" && (
        <p className="text-sm leading-snug line-clamp-5">{d.body || "—"}</p>
      )}
      {d.ext_kind === "narrative" && (
        <p className="text-sm leading-snug line-clamp-6 whitespace-pre-line">
          {d.body || "—"}
        </p>
      )}
      {d.ext_kind === "list" && (
        <ul className="space-y-1 text-sm list-disc pl-5">
          {(d.items ?? []).slice(0, 4).map((item, i) => (
            <li key={i} className="line-clamp-2">
              {extensionListItemText(item)}
            </li>
          ))}
          {(d.items ?? []).length === 0 && (
            <li className="text-muted">No items.</li>
          )}
        </ul>
      )}
      {d.ext_kind === "table" && (
        <div className="text-xs overflow-hidden">
          {d.columns && d.columns.length > 0 ? (
            <table className="w-full">
              <thead>
                <tr className="text-muted text-left">
                  {d.columns.slice(0, 3).map((c, i) => (
                    <th key={i} className="font-medium py-1 pr-2">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(d.rows ?? []).slice(0, 2).map((row, i) => (
                  <tr key={i} className="border-t border-[var(--line)]">
                    {row.slice(0, 3).map((cell, j) => (
                      <td key={j} className="py-1 pr-2 truncate max-w-[120px]">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">Empty table.</p>
          )}
          {(d.rows?.length ?? 0) > 2 && (
            <p className="text-xs text-muted mt-1">
              +{(d.rows?.length ?? 0) - 2} more rows · open to view
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---- fallback -------------------------------------------------------------

export function UnknownTile({ widget }: { widget: CanvasWidget }) {
  return (
    <div>
      <TileHeader title={widget.title} kindLabel="Widget" />
      <p className="text-sm text-muted">Unknown widget kind: {widget.kind}</p>
    </div>
  );
}
