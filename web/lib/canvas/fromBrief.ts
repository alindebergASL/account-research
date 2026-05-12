import type { Brief } from "@/lib/schema";
import type { CanvasWidget, Canvas, Confidence } from "./schema";

// Build a read-only, deterministic Canvas from an existing Brief.
//
// Hard rules:
// - Pure function. Does not mutate `brief`.
// - No invented account-specific facts; every string comes from `brief`
//   or from fixed labels/headers.
// - All widget controls are false.
// - Widget IDs are stable slugs so the same input produces the same output.
// - `extensions` section is included only when `brief.extensions.length > 0`.

const EVIDENCE_CAP = 8;

const NO_CONTROLS = {
  can_refresh: false,
  can_remove: false,
  can_edit: false,
  can_export: false,
} as const;

function truncate(s: string, max = 220): string {
  if (!s) return "";
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + "…";
}

function listPreview(items: string[], max = 4): string {
  if (!items || items.length === 0) return "";
  const head = items.slice(0, max).map((s) => `• ${s.trim()}`).join("\n");
  if (items.length > max) return `${head}\n…and ${items.length - max} more`;
  return head;
}

function layoutAt(index: number) {
  // Deterministic two-column grid: alternating x=0/6, y increments every 2.
  const col = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: col === 0 ? 0 : 6,
    y: row * 2,
    w: 6,
    h: 2,
    pinned: false,
    collapsed: false,
  };
}

export function buildReadOnlyCanvasFromBrief({
  briefId,
  brief,
}: {
  briefId: string;
  brief: Brief;
}): Canvas {
  const generatedAt = brief.generated_at || new Date(0).toISOString();
  const widgets: CanvasWidget[] = [];

  function baseWidget(
    id: string,
    title: string,
    indexHint: number,
    opts: { confidence?: Confidence; why_included?: string } = {},
  ) {
    return {
      id,
      title,
      description: "",
      source: "system" as const,
      created_at: generatedAt,
      updated_at: generatedAt,
      confidence: opts.confidence,
      why_included: opts.why_included ?? "Derived from saved brief.",
      sources: [],
      layout: layoutAt(indexHint),
      controls: { ...NO_CONTROLS },
      status: "fresh" as const,
      evidence: [],
    };
  }

  function addSectionRef(
    id: string,
    title: string,
    sectionKey: string,
    preview: string,
  ) {
    widgets.push({
      ...baseWidget(id, title, widgets.length, {
        why_included: "Derived from standard brief section.",
      }),
      kind: "section_ref",
      data: { section_key: sectionKey, preview: truncate(preview, 320) },
    });
  }

  // 1) Section references — fixed deterministic order.
  addSectionRef("section-snapshot", "Account snapshot", "snapshot", brief.snapshot);
  addSectionRef(
    "section-priority",
    "Why this account · why now",
    "priority_summary",
    brief.priority_summary,
  );
  addSectionRef(
    "section-recent-signals",
    "Recent strategic signals",
    "recent_signals",
    listPreview(brief.recent_signals.map((s) => s.text)),
  );
  addSectionRef(
    "section-ai-maturity",
    "AI / tech maturity",
    "ai_tech_maturity",
    `Rating ${brief.ai_tech_maturity.rating}/5 — ${brief.ai_tech_maturity.rationale}`,
  );
  addSectionRef(
    "section-top-initiatives",
    "Top initiatives",
    "top_initiatives",
    listPreview(brief.top_initiatives.map((i) => `${i.title}: ${i.detail}`)),
  );

  const tf = brief.technical_footprint;
  addSectionRef(
    "section-technical-footprint",
    "Technical footprint",
    "technical_footprint",
    [
      tf.ai_in_production.length > 0
        ? `AI in production: ${tf.ai_in_production.slice(0, 2).join("; ")}`
        : "",
      tf.active_pilots.length > 0
        ? `Active pilots: ${tf.active_pilots.slice(0, 2).join("; ")}`
        : "",
      tf.cloud_platforms.length > 0
        ? `Cloud: ${tf.cloud_platforms.join(", ")}`
        : "",
      tf.clinical_platforms ? `Clinical: ${tf.clinical_platforms}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const pp = brief.programs_procurement;
  addSectionRef(
    "section-programs-procurement",
    "Programs & procurement",
    "programs_procurement",
    [
      pp.active_rfps_contracts.length > 0
        ? `Active RFPs / contracts: ${pp.active_rfps_contracts.slice(0, 3).join("; ")}`
        : "",
      pp.modernization_grants.length > 0
        ? `Grants: ${pp.modernization_grants.slice(0, 2).join("; ")}`
        : "",
      pp.ai_governance_policy
        ? `Governance: ${pp.ai_governance_policy}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  addSectionRef(
    "section-personas",
    "Key personas",
    "personas",
    listPreview(brief.personas.map((p) => `${p.name} — ${p.title}`)),
  );
  addSectionRef(
    "section-buying-path",
    "Buying / decision path",
    "buying_path",
    brief.buying_path,
  );
  addSectionRef(
    "section-first-angle",
    "First conversation angle",
    "first_angle",
    brief.first_angle,
  );
  addSectionRef(
    "section-risks",
    "Risks & watch-outs",
    "risks",
    listPreview(brief.risks),
  );
  addSectionRef(
    "section-competitive-signals",
    "Competitive / vendor signals",
    "competitive_signals",
    listPreview(brief.competitive_signals),
  );
  if (brief.extensions.length > 0) {
    addSectionRef(
      "section-extensions",
      "Insights",
      "extensions",
      listPreview(brief.extensions.map((e) => e.title)),
    );
  }
  addSectionRef(
    "section-sources",
    "Key sources",
    "sources",
    listPreview(brief.sources.map((s) => s.title)),
  );

  // 2) Evidence board — capped at 8, drawn from explicit brief fields.
  const evidence: { text: string; source?: string; confidence?: Confidence }[] = [];
  for (const s of brief.recent_signals) {
    evidence.push({ text: s.text, source: s.source, confidence: s.confidence });
    if (evidence.length >= EVIDENCE_CAP) break;
  }
  for (const i of brief.top_initiatives) {
    if (evidence.length >= EVIDENCE_CAP) break;
    evidence.push({
      text: `${i.title}: ${i.detail}`,
      source: i.source,
      confidence: i.confidence,
    });
  }
  for (const p of brief.personas) {
    if (evidence.length >= EVIDENCE_CAP) break;
    evidence.push({
      text: `${p.name} (${p.title}) — ${p.opener}`,
      source: p.source,
      confidence: p.confidence,
    });
  }
  for (const ext of brief.extensions) {
    if (evidence.length >= EVIDENCE_CAP) break;
    const src = ext.sources[0];
    evidence.push({
      text: ext.title,
      source: src ? src.url || src.title : undefined,
      confidence: ext.confidence,
    });
  }

  widgets.push({
    ...baseWidget("evidence-board", "Evidence board", widgets.length, {
      why_included: "Citation snippets from signals, initiatives, and personas.",
    }),
    kind: "evidence_board",
    data: { items: evidence.slice(0, EVIDENCE_CAP) },
  });

  // 3) Action panel — exactly one action, verbatim from brief.next_action.
  widgets.push({
    ...baseWidget("action-next", "Recommended next action", widgets.length, {
      why_included: "From brief.next_action.",
    }),
    kind: "action_panel",
    data: {
      actions: [{ label: "Next action", detail: brief.next_action }],
    },
  });

  // 4) Open questions — deterministic heuristics from missing/thin fields.
  const questions: string[] = [];
  if (brief.personas.length === 0) {
    questions.push("Which buyer or executive sponsor should be prioritized?");
  }
  if (brief.competitive_signals.length === 0) {
    questions.push(
      "Which incumbent vendors or competitors are most relevant?",
    );
  }
  // Low-completeness signal mirrors the canvas LowQualityBanner heuristic.
  const filled = [
    brief.snapshot,
    brief.priority_summary,
    brief.buying_path,
    brief.first_angle,
    brief.next_action,
  ].filter((s) => s && !s.toLowerCase().startsWith("not found")).length;
  const arrayFilled = [
    brief.recent_signals.length > 0,
    brief.top_initiatives.length > 0,
    brief.personas.length > 0,
  ].filter(Boolean).length;
  if (filled + arrayFilled < 4) {
    questions.push(
      "Which public sources would strengthen this account brief?",
    );
  }
  widgets.push({
    ...baseWidget("open-questions", "Open questions", widgets.length, {
      why_included: "Surface gaps without inventing facts.",
    }),
    kind: "open_questions",
    data: { questions },
  });

  // 5) Metrics — 3 cards from brief metadata.
  widgets.push({
    ...baseWidget("metric-ai-maturity", "AI maturity", widgets.length),
    kind: "metric",
    data: {
      label: "AI / tech maturity",
      value: `${brief.ai_tech_maturity.rating}/5`,
      helper: "Rating from the saved brief.",
    },
  });
  widgets.push({
    ...baseWidget("metric-sources", "Sources", widgets.length),
    kind: "metric",
    data: {
      label: "Cited sources",
      value: String(brief.sources.length),
      helper: brief.sources.length === 1 ? "source" : "sources",
    },
  });
  widgets.push({
    ...baseWidget("metric-initiatives", "Initiatives", widgets.length),
    kind: "metric",
    data: {
      label: "Top initiatives",
      value: String(brief.top_initiatives.length),
      helper: brief.top_initiatives.length === 1 ? "initiative" : "initiatives",
    },
  });

  return {
    account_id: briefId,
    account_name: brief.account_name,
    version: 1,
    generated_at: generatedAt,
    widgets,
    meta: {
      layout_mode: "grid",
      pinned_order: widgets.map((w) => w.id),
    },
  };
}
