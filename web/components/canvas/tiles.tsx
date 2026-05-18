import type {
  CanvasWidget,
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
  ExtensionWidget,
  StrategicSignalRadarWidget,
  OpportunityRiskSplitWidget,
  MomentumStripWidget,
  AITakeawaysWidget,
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
import { extractTiming, extractTarget } from "../../lib/canvas/actionExtract";

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

// Normalises all three ActionItem shapes into a single render shape:
//   - legacy   { label, detail? }
//   - lab      { text, why, owner?, severity }
//   - hermes   { recommendation, rationale, expected_outcome, risk?,
//                evidence?, approval_state, owner?, severity }
export type NormalizedAction = {
  title: string;
  detail: string;
  secondary?: string;
  severity?: "low" | "medium" | "high";
  approvalState?: "suggested" | "approved" | "dismissed";
};

export function normalizeAction(
  a: import("zod").infer<typeof ActionPanelWidget>["data"]["actions"][number],
): NormalizedAction {
  if ("recommendation" in a) {
    return {
      title: a.recommendation,
      detail: a.expected_outcome || a.rationale,
      secondary: a.expected_outcome ? a.rationale : undefined,
      severity: a.severity,
      approvalState: a.approval_state,
    };
  }
  if ("label" in a) {
    return {
      title: a.label,
      detail: a.detail ?? "",
      severity: undefined,
    };
  }
  return { title: a.text, detail: a.why, severity: a.severity };
}

function approvalStateLabel(state?: NormalizedAction["approvalState"]): string {
  switch (state) {
    case "approved":
      return "Approved";
    case "dismissed":
      return "Dismissed";
    default:
      return "Suggested";
  }
}

// Pulls the rich expected_outcome / rationale strings off a raw action so
// the primary tile line can render them fully without clamping. Returns
// empty strings when the action is the legacy {label, detail} shape.
function richPrimaryLines(
  raw: import("zod").infer<typeof ActionPanelWidget>["data"]["actions"][number],
): { expectedOutcome: string; rationale: string; owner?: string; recommendation: string } {
  if ("recommendation" in raw) {
    return {
      expectedOutcome: raw.expected_outcome ?? "",
      rationale: raw.rationale ?? "",
      owner: raw.owner,
      recommendation: raw.recommendation,
    };
  }
  if ("text" in raw && "why" in raw) {
    return {
      expectedOutcome: "",
      rationale: raw.why ?? "",
      owner: raw.owner,
      recommendation: raw.text,
    };
  }
  if ("label" in raw) {
    return {
      expectedOutcome: "",
      rationale: "",
      recommendation: raw.label,
    };
  }
  return { expectedOutcome: "", rationale: "", recommendation: "" };
}

// One row in the Recommended Move dossier. Renders only when value is
// non-empty so heuristics that don't match drop their row entirely.
function MoveRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value.trim().length === 0) return null;
  return (
    <div data-testid="recommended-move-row" className="space-y-0.5">
      <dt className="text-[10px] uppercase tracking-widest opacity-70">
        {label}
      </dt>
      <dd className="text-sm leading-snug break-words">{value}</dd>
    </div>
  );
}

export function ActionPanelTile({
  widget,
}: {
  widget: import("zod").infer<typeof ActionPanelWidget>;
}) {
  const actions = widget.data.actions;
  const rawFirst = actions[0];
  const first = rawFirst ? normalizeAction(rawFirst) : null;
  const primaryRich = rawFirst ? richPrimaryLines(rawFirst) : null;
  const remaining = Math.max(0, actions.length - 1);

  // Derive scannable substructure from the primary recommendation.
  // Heuristics return null when nothing matches, and `MoveRow` then
  // omits the row — no fabricated content.
  const ask = primaryRich?.recommendation || first?.title || "";
  const timing = primaryRich ? extractTiming(primaryRich.recommendation) : null;
  const target =
    primaryRich && "recommendation" in primaryRich
      ? extractTarget({
          recommendation: primaryRich.recommendation,
          owner: primaryRich.owner,
        })
      : null;
  const whyNow = primaryRich?.rationale ?? "";
  const expected = primaryRich?.expectedOutcome ?? "";

  return (
    <div>
      <TileHeader title={widget.title} kindLabel="Recommended action" />
      {first ? (
        <div className="space-y-2 min-w-0">
          {first.approvalState && (
            <span className="inline-flex items-center rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white/85">
              {approvalStateLabel(first.approvalState)}
            </span>
          )}
          {/*
            Executive dossier substructure. Each row only renders when
            its value is present; this is the "no fabrication" rule.
            The primary recommendation (ASK) is never clamped — it is
            the spine of the workspace.
          */}
          <dl className="space-y-2 min-w-0">
            <MoveRow label="Timing" value={timing} />
            <MoveRow label="Target / route" value={target} />
            <MoveRow label="Ask" value={ask} />
            <MoveRow label="Why now" value={whyNow} />
            <MoveRow label="Expected outcome" value={expected} />
          </dl>
          {(!whyNow && !expected) && first.detail && (
            <p className="text-xs leading-snug opacity-80 break-words">
              {first.detail}
            </p>
          )}
          {remaining > 0 && (
            <p className="text-[11px] opacity-70">
              +{remaining} more recommended move{remaining === 1 ? "" : "s"} · open to view
            </p>
          )}
        </div>
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
        <>
          {d.columns && d.columns.length > 0 ? (
            <>
              {/* Mobile: stacked card-per-row layout */}
              <div
                data-testid="extension-table-stacked"
                className="sm:hidden space-y-2"
              >
                {(d.rows ?? []).slice(0, 2).map((row, i) => {
                  const heading = row[0] ?? "";
                  const restCols = d.columns!.slice(1, 3);
                  const restCells = row.slice(1, 3);
                  return (
                    <div
                      key={i}
                      className="rounded-md border border-[var(--line)] bg-white px-2 py-1.5"
                    >
                      <div className="text-sm font-medium leading-snug break-words">
                        {heading || "—"}
                      </div>
                      {restCols.length > 0 && (
                        <dl className="mt-1 space-y-1">
                          {restCols.map((col, j) => (
                            <div key={j} className="min-w-0">
                              <dt className="text-[10px] uppercase tracking-wider text-muted">
                                {col}
                              </dt>
                              <dd className="text-xs leading-snug break-words">
                                {restCells[j] ?? "—"}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  );
                })}
                {(d.rows?.length ?? 0) === 0 && (
                  <p className="text-sm text-muted">No rows.</p>
                )}
              </div>
              {/* Desktop: table layout */}
              <div
                data-testid="extension-table-desktop"
                className="hidden sm:block text-xs overflow-x-auto -mx-2 px-2"
              >
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
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">Empty table.</p>
          )}
          {(d.rows?.length ?? 0) > 2 && (
            <p className="text-xs text-muted mt-1">
              +{(d.rows?.length ?? 0) - 2} more rows · open to view
            </p>
          )}
        </>
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

// ---- Canvas v2 strategic workspace tiles ----------------------------------

const QUADRANT_COLOR: Record<string, string> = {
  strategy: "var(--tone-signal)",
  tech: "var(--accent)",
  procurement: "var(--tone-opportunity)",
  leadership: "var(--tone-risk)",
};

// 2x2 grid of quadrant tiles: count + sample snippet + confidence chip.
export function StrategicSignalRadarTile({
  widget,
}: {
  widget: import("zod").infer<typeof StrategicSignalRadarWidget>;
}) {
  const quads = widget.data.quadrants;
  return (
    <div className="grid grid-cols-2 gap-2 min-w-0">
      {quads.map((q) => {
        const color = QUADRANT_COLOR[q.key] ?? "var(--muted)";
        return (
          <div
            key={q.key}
            className="rounded-lg border border-[var(--line)] bg-white p-2 min-w-0"
            style={{ borderLeftColor: color, borderLeftWidth: "3px" }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-muted truncate">
                {q.label}
              </span>
              <span
                className="font-display text-lg leading-none tracking-tight"
                style={{ color: q.count > 0 ? color : "var(--muted)" }}
              >
                {q.count}
              </span>
            </div>
            <p
              className="mt-1 text-[11px] text-muted line-clamp-2 min-h-[2em]"
              title={q.sample ?? ""}
            >
              {q.sample ?? "No public signal found — verify in discovery."}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// Opportunity (green) vs Risk (red) side-by-side with the top item.
export function OpportunityRiskSplitTile({
  widget,
}: {
  widget: import("zod").infer<typeof OpportunityRiskSplitWidget>;
}) {
  const d = widget.data;
  return (
    <div className="grid grid-cols-2 gap-2 min-w-0">
      <div
        className="rounded-lg border border-[var(--line)] p-2 min-w-0"
        style={{
          borderLeftColor: "var(--tone-opportunity)",
          borderLeftWidth: "3px",
        }}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">
            Opportunities
          </span>
          <span
            className="font-display text-lg leading-none tracking-tight"
            style={{ color: "var(--tone-opportunity)" }}
          >
            {d.opportunities.count}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-ink line-clamp-3 min-h-[3.2em] leading-snug">
          {d.opportunities.top?.text ?? "No priority opportunity found in the saved brief."}
        </p>
      </div>
      <div
        className="rounded-lg border border-[var(--line)] p-2 min-w-0"
        style={{ borderLeftColor: "var(--tone-risk)", borderLeftWidth: "3px" }}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">
            Risks
          </span>
          <span
            className="font-display text-lg leading-none tracking-tight"
            style={{ color: "var(--tone-risk)" }}
          >
            {d.risks.count}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-ink line-clamp-3 min-h-[3.2em] leading-snug">
          {d.risks.top?.text ?? "No priority risk found in the saved brief."}
        </p>
      </div>
    </div>
  );
}

const MOMENTUM_COLOR: Record<string, string> = {
  signals: "var(--tone-signal)",
  initiatives: "var(--tone-opportunity)",
  pilots: "var(--accent)",
  programs: "var(--muted)",
};

// Compact horizontal strip + velocity label.
export function MomentumStripTile({
  widget,
}: {
  widget: import("zod").infer<typeof MomentumStripWidget>;
}) {
  const d = widget.data;
  const denom = Math.max(d.total, 1);
  return (
    <div className="space-y-2 min-w-0">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--bg)]">
        {d.segments.map((s) => {
          const pct = d.total > 0 ? (s.count / denom) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div
              key={s.key}
              style={{ width: `${pct}%`, background: MOMENTUM_COLOR[s.key] }}
              title={`${s.label}: ${s.count}`}
            />
          );
        })}
      </div>
      <div className="grid grid-cols-4 gap-2 min-w-0">
        {d.segments.map((s) => (
          <div key={s.key} className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted truncate">
              {s.label}
            </div>
            <div
              className="font-display text-base leading-none tracking-tight"
              style={{
                color: s.count > 0 ? MOMENTUM_COLOR[s.key] : "var(--muted)",
              }}
            >
              {s.count}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted">{d.velocity_label}</p>
    </div>
  );
}

// Compact bulleted takeaways list.
export function AITakeawaysTile({
  widget,
}: {
  widget: import("zod").infer<typeof AITakeawaysWidget>;
}) {
  const items = widget.data.takeaways.slice(0, 4);
  if (items.length === 0) {
    return <p className="text-sm text-muted">No takeaways available.</p>;
  }
  return (
    <ul className="space-y-2 min-w-0">
      {items.map((t, i) => (
        <li
          key={`${t.source_field}-${i}`}
          className="rounded-md border border-[var(--line)] bg-white px-2 py-1.5 min-w-0"
        >
          <div className="text-[10px] uppercase tracking-wider text-muted truncate">
            {t.headline}
          </div>
          <p className="text-[12px] leading-snug text-ink line-clamp-2" title={t.detail}>
            {t.detail}
          </p>
        </li>
      ))}
      {widget.data.takeaways.length > items.length && (
        <li className="text-[10px] text-muted">
          +{widget.data.takeaways.length - items.length} more · open to view
        </li>
      )}
    </ul>
  );
}
