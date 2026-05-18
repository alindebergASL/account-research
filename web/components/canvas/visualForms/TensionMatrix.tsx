import type { OpportunityRiskSplitWidget } from "../../../lib/canvas/schema";

// 2x2 opportunity / tension matrix. Quadrant assignment is deterministic
// and bucketed; never continuous math invented from confidence scores.
//
// X axis (initiative density): low (0–1), med (2–3), high (4+)
// Y axis (risk density):       low (0–1), med (2–3), high (4+)
//
// Quadrant labels (matches plan / addendum A2):
//   bottom-left  → "Quick wins"          (low risk, low–med initiative)
//   bottom-right → "Headline bets"       (low risk, high initiative)
//   top-left     → "Watch-outs"          (high risk, low–med initiative)
//   top-right    → "High-stakes plays"   (high risk, high initiative)
//
// Data is sourced from `widget.evidence` with tags "initiative" and
// "risk". The adapter emits initiatives first, then risks, preserving
// brief order.

type RiskBand = "low" | "high";
type InitBand = "low-med" | "high";

function bandRisk(n: number): RiskBand {
  if (n >= 2) return "high";
  return "low";
}
function bandInitiative(n: number, confidence?: string): InitBand {
  if (n >= 4) return "high";
  if (confidence === "High") return "high";
  return "low-med";
}

export type QuadrantKey =
  | "quick-wins"
  | "headline-bets"
  | "watch-outs"
  | "high-stakes-plays";

export const QUADRANT_LABELS: Record<QuadrantKey, string> = {
  "quick-wins": "Quick wins",
  "headline-bets": "Headline bets",
  "watch-outs": "Watch-outs",
  "high-stakes-plays": "High-stakes plays",
};

export function placeInitiative(
  totalInitiatives: number,
  totalRisks: number,
  confidence?: string,
): QuadrantKey {
  const risk = bandRisk(Math.min(totalRisks, 5));
  const init = bandInitiative(Math.min(totalInitiatives, 5), confidence);
  if (risk === "low" && init === "low-med") return "quick-wins";
  if (risk === "low" && init === "high") return "headline-bets";
  if (risk === "high" && init === "low-med") return "watch-outs";
  return "high-stakes-plays";
}

function Quadrant({
  label,
  items,
  risks,
  testid,
}: {
  label: string;
  items: { text: string }[];
  risks: { text: string }[];
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      className="rounded-lg border border-[var(--line)] bg-white p-2 min-w-0 flex flex-col gap-1"
    >
      <div className="text-[10px] uppercase tracking-wider text-muted truncate">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5 min-w-0">
        {items.map((it, i) => (
          <span
            key={`init-${i}`}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] truncate max-w-full"
            title={it.text}
          >
            <span className="size-1.5 rounded-full bg-[var(--accent)]" />
            <span className="truncate">{it.text}</span>
          </span>
        ))}
        {risks.map((r, i) => (
          <span
            key={`risk-${i}`}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--tone-risk)]/15 px-1.5 py-0.5 text-[10px] truncate max-w-full"
            title={r.text}
          >
            <span className="size-1.5 rounded-sm bg-[var(--tone-risk)]" />
            <span className="truncate">{r.text}</span>
          </span>
        ))}
        {items.length === 0 && risks.length === 0 && (
          <span className="text-[10px] text-muted">—</span>
        )}
      </div>
    </div>
  );
}

function distribute(
  widget: import("zod").infer<typeof OpportunityRiskSplitWidget>,
): Record<QuadrantKey, { items: { text: string }[]; risks: { text: string }[] }> {
  const out: Record<QuadrantKey, { items: { text: string }[]; risks: { text: string }[] }> = {
    "quick-wins": { items: [], risks: [] },
    "headline-bets": { items: [], risks: [] },
    "watch-outs": { items: [], risks: [] },
    "high-stakes-plays": { items: [], risks: [] },
  };
  const initiatives = widget.evidence.filter((e) => e.tag === "initiative");
  const risks = widget.evidence.filter((e) => e.tag === "risk");
  const initCount = initiatives.length;
  const riskCount = risks.length;
  for (const i of initiatives) {
    const q = placeInitiative(initCount, riskCount, i.confidence);
    out[q].items.push({ text: i.text });
  }
  const initBand = bandInitiative(Math.min(initCount, 5));
  const topQuadrant: QuadrantKey =
    initBand === "high" ? "high-stakes-plays" : "watch-outs";
  for (const r of risks) {
    out[topQuadrant].risks.push({ text: r.text });
  }
  return out;
}

export function TensionMatrixTile({
  widget,
}: {
  widget: import("zod").infer<typeof OpportunityRiskSplitWidget>;
}) {
  const cells = distribute(widget);
  return (
    <div data-testid="tension-matrix" className="space-y-1 min-w-0">
      <div className="grid grid-cols-2 grid-rows-2 gap-2 min-w-0">
        <Quadrant
          label={QUADRANT_LABELS["watch-outs"]}
          items={cells["watch-outs"].items}
          risks={cells["watch-outs"].risks}
          testid="tension-matrix-watch-outs"
        />
        <Quadrant
          label={QUADRANT_LABELS["high-stakes-plays"]}
          items={cells["high-stakes-plays"].items}
          risks={cells["high-stakes-plays"].risks}
          testid="tension-matrix-high-stakes-plays"
        />
        <Quadrant
          label={QUADRANT_LABELS["quick-wins"]}
          items={cells["quick-wins"].items}
          risks={cells["quick-wins"].risks}
          testid="tension-matrix-quick-wins"
        />
        <Quadrant
          label={QUADRANT_LABELS["headline-bets"]}
          items={cells["headline-bets"].items}
          risks={cells["headline-bets"].risks}
          testid="tension-matrix-headline-bets"
        />
      </div>
      <p className="text-[10px] text-muted">
        Balance: {widget.data.balance.replace("-", " ")} · initiatives vs.
        risks, bucketed.
      </p>
    </div>
  );
}

export function TensionMatrixDetail({
  widget,
}: {
  widget: import("zod").infer<typeof OpportunityRiskSplitWidget>;
}) {
  return (
    <div data-testid="tension-matrix" className="space-y-3 min-w-0">
      <p className="text-xs text-muted">
        Quadrant placement is bucketed: risk density on the vertical axis,
        initiative density on the horizontal axis. Position within a
        quadrant is sequence-based.
      </p>
      <TensionMatrixTile widget={widget} />
      <section className="rounded-lg border border-[var(--line)] p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
          Balance
        </div>
        <p className="text-sm capitalize">{widget.data.balance.replace("-", " ")}</p>
      </section>
    </div>
  );
}
