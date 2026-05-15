import type { Brief, BriefExtension } from "@/lib/schema";
import type { CanvasWidget, Canvas, Confidence, Source } from "./schema";
import {
  buildAITakeaways,
  buildMomentumStrip,
  buildOpportunityRiskSplit,
  buildStrategicSignalRadar,
} from "./strategicInsights";

// Build a read-only, deterministic Canvas from an existing Brief.
//
// Hard rules:
// - Pure function. Does not mutate `brief`.
// - No invented account-specific facts; every string comes from `brief`
//   or from fixed labels/headers.
// - All widget controls are false.
// - Widget IDs are stable slugs so the same input produces the same output.
// - Brief extensions become first-class widgets with id `extension-<ext.id>`.

const EVIDENCE_CAP = 8;
const GRID_COLS = 12;

const NO_CONTROLS = {
  can_refresh: false,
  can_remove: false,
  can_edit: false,
  can_export: false,
} as const;

function truncate(s: string, max = 320): string {
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

function listFullText(items: string[]): string {
  if (!items || items.length === 0) return "";
  return items.map((s) => `• ${s.trim()}`).join("\n");
}

function sourceFromBriefSource(s: { title: string; url: string; accessed?: string }): Source {
  return { title: s.title, url: s.url, accessed: s.accessed };
}

// Greedy 12-col packer: tracks y and x; when next widget overflows
// row, advance y and reset x. Output coordinates are deterministic.
class GridPacker {
  private x = 0;
  private y = 0;
  private rowHeight = 0;
  next(w: number, h: number) {
    const ww = Math.min(Math.max(w, 1), GRID_COLS);
    if (this.x + ww > GRID_COLS) {
      this.y += this.rowHeight || 1;
      this.x = 0;
      this.rowHeight = 0;
    }
    const layout = {
      x: this.x,
      y: this.y,
      w: ww,
      h: Math.min(Math.max(h, 1), 24),
      pinned: false,
      collapsed: false,
    };
    this.x += ww;
    this.rowHeight = Math.max(this.rowHeight, layout.h);
    return layout;
  }
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
  const packer = new GridPacker();

  function baseWidget(
    id: string,
    title: string,
    w: number,
    h: number,
    opts: {
      confidence?: Confidence;
      why_included?: string;
      source?: "system" | "model" | "research" | "chat" | "user" | "refresh" | "hermes";
      sources?: Source[];
    } = {},
  ) {
    return {
      id,
      title,
      description: "",
      source: opts.source ?? ("system" as const),
      created_at: generatedAt,
      updated_at: generatedAt,
      confidence: opts.confidence,
      why_included: opts.why_included ?? "Derived from saved brief.",
      sources: opts.sources ?? [],
      layout: packer.next(w, h),
      controls: { ...NO_CONTROLS },
      status: "fresh" as const,
      evidence: [],
    };
  }

  // Structured items stored on `widget.evidence` for the section_refs
  // that benefit from a landscape/list-style visual (initiatives, recent
  // signals, risks, personas). This stays inside the existing Evidence
  // shape so no schema change is required.
  type StructuredItem = {
    text: string;
    source?: string;
    confidence?: Confidence;
    tag?: string;
  };

  function addSectionRef(
    id: string,
    title: string,
    sectionKey: string,
    preview: string,
    w: number,
    h = 3,
    fullText = preview,
    structured?: StructuredItem[],
  ) {
    const trimmedFullText = fullText.trim();
    const base = baseWidget(id, title, w, h, {
      why_included: "Derived from standard brief section.",
    });
    widgets.push({
      ...base,
      // Populate evidence with structured items when the section has them;
      // renderers detect this and switch to a richer visual (e.g. the
      // initiative landscape) instead of the plain preview string.
      evidence: structured && structured.length > 0
        ? structured.map((s) => ({
            text: s.text,
            source: s.source,
            confidence: s.confidence,
            tag: s.tag,
          }))
        : base.evidence,
      kind: "section_ref",
      data: {
        section_key: sectionKey,
        preview: truncate(preview),
        full_text: trimmedFullText,
      },
    });
  }

  // ---- Header row: snapshot + maturity gauge -----------------------------
  addSectionRef(
    "section-snapshot",
    "Account snapshot",
    "snapshot",
    brief.snapshot,
    8,
    3,
  );
  widgets.push({
    ...baseWidget("metric-ai-maturity", "AI maturity", 4, 3),
    kind: "metric",
    data: {
      label: "AI / tech maturity",
      value: `${brief.ai_tech_maturity.rating}/5`,
      helper: "Rating from the saved brief.",
    },
  });

  // ---- Strategic insight workspace (Canvas v2 Phase 1) -------------------
  // These four Hermes-sourced widgets render at the top of the grid (right
  // below the executive cockpit) so the first viewport reads as a strategic
  // workspace, not a tile catalogue. All derivations are deterministic from
  // the saved brief; no model calls.
  widgets.push({
    ...baseWidget("insight-ai-takeaways", "AI takeaways", 12, 4, {
      source: "hermes",
      why_included:
        "Deterministic synthesis of maturity, top initiative, top risk, buying path, and recommended next action from the saved brief.",
    }),
    kind: "ai_takeaways",
    data: buildAITakeaways(brief),
  });
  widgets.push({
    ...baseWidget("insight-signal-radar", "Strategic signal radar", 6, 4, {
      source: "hermes",
      why_included:
        "Buckets brief.recent_signals + brief.competitive_signals into strategy / tech / procurement / leadership quadrants by deterministic keyword match.",
    }),
    kind: "strategic_signal_radar",
    data: buildStrategicSignalRadar(brief),
  });
  widgets.push({
    ...baseWidget("insight-opportunity-risk", "Opportunity / risk split", 6, 4, {
      source: "hermes",
      why_included:
        "Pairs brief.top_initiatives against brief.risks side-by-side and labels the balance.",
    }),
    kind: "opportunity_risk_split",
    data: buildOpportunityRiskSplit(brief),
  });
  widgets.push({
    ...baseWidget("insight-momentum-strip", "Momentum", 12, 2, {
      source: "hermes",
      why_included:
        "Counts signals, initiatives, active pilots, and active programs from the saved brief; labels overall velocity.",
    }),
    kind: "momentum_strip",
    data: buildMomentumStrip(brief),
  });

  // ---- Priority + signals row -------------------------------------------
  addSectionRef(
    "section-priority",
    "Why this account · why now",
    "priority_summary",
    brief.priority_summary,
    6,
    3,
  );
  addSectionRef(
    "section-recent-signals",
    "Recent strategic signals",
    "recent_signals",
    listPreview(brief.recent_signals.map((s) => s.text)),
    6,
    3,
    listFullText(brief.recent_signals.map((s) => s.text)),
    brief.recent_signals.map((s) => ({
      text: s.text,
      source: s.source,
      confidence: s.confidence,
    })),
  );

  // ---- Evidence board + small metrics row -------------------------------
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
    ...baseWidget("evidence-board", "Evidence board", 8, 4, {
      why_included: "Citation snippets from signals, initiatives, and personas.",
    }),
    kind: "evidence_board",
    data: { items: evidence.slice(0, EVIDENCE_CAP) },
  });
  widgets.push({
    ...baseWidget("metric-sources", "Sources", 4, 2),
    kind: "metric",
    data: {
      label: "Cited sources",
      value: String(brief.sources.length),
      helper: brief.sources.length === 1 ? "source" : "sources",
    },
  });
  widgets.push({
    ...baseWidget("metric-initiatives", "Initiatives", 4, 2),
    kind: "metric",
    data: {
      label: "Top initiatives",
      value: String(brief.top_initiatives.length),
      helper: brief.top_initiatives.length === 1 ? "initiative" : "initiatives",
    },
  });

  // ---- Substance rows ---------------------------------------------------
  addSectionRef(
    "section-ai-maturity",
    "AI / tech maturity",
    "ai_tech_maturity",
    `Rating ${brief.ai_tech_maturity.rating}/5 — ${brief.ai_tech_maturity.rationale}`,
    6,
    3,
  );
  addSectionRef(
    "section-top-initiatives",
    "Top initiatives",
    "top_initiatives",
    listPreview(brief.top_initiatives.map((i) => `${i.title}: ${i.detail}`)),
    12,
    3,
    listFullText(brief.top_initiatives.map((i) => `${i.title}: ${i.detail}`)),
    brief.top_initiatives.map((i) => ({
      text: i.title,
      source: i.source,
      confidence: i.confidence,
      tag: i.detail,
    })),
  );

  const tf = brief.technical_footprint;
  addSectionRef(
    "section-technical-footprint",
    "Technical footprint",
    "technical_footprint",
    [
      tf.ai_in_production.length > 0
        ? `AI in production: ${tf.ai_in_production.join("; ")}`
        : "",
      tf.active_pilots.length > 0
        ? `Active pilots: ${tf.active_pilots.join("; ")}`
        : "",
      tf.cloud_platforms.length > 0
        ? `Cloud: ${tf.cloud_platforms.join(", ")}`
        : "",
      tf.clinical_platforms ? `Clinical: ${tf.clinical_platforms}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    6,
    3,
  );

  const pp = brief.programs_procurement;
  addSectionRef(
    "section-programs-procurement",
    "Programs & procurement",
    "programs_procurement",
    [
      pp.active_rfps_contracts.length > 0
        ? `Active RFPs / contracts: ${pp.active_rfps_contracts.join("; ")}`
        : "",
      pp.modernization_grants.length > 0
        ? `Grants: ${pp.modernization_grants.join("; ")}`
        : "",
      pp.ai_governance_policy ? `Governance: ${pp.ai_governance_policy}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    6,
    3,
  );

  addSectionRef(
    "section-personas",
    "Key personas",
    "personas",
    listPreview(brief.personas.map((p) => `${p.name} — ${p.title}`)),
    6,
    3,
    listFullText(brief.personas.map((p) => `${p.name} — ${p.title}`)),
    brief.personas.map((p) => ({
      text: `${p.name} — ${p.title}`,
      source: p.source,
      confidence: p.confidence,
      tag: p.priority,
    })),
  );
  addSectionRef(
    "section-buying-path",
    "Buying / decision path",
    "buying_path",
    brief.buying_path,
    6,
    2,
  );
  addSectionRef(
    "section-first-angle",
    "First conversation angle",
    "first_angle",
    brief.first_angle,
    6,
    2,
  );
  addSectionRef(
    "section-risks",
    "Risks & watch-outs",
    "risks",
    listPreview(brief.risks),
    6,
    3,
    listFullText(brief.risks),
    brief.risks.map((r) => ({ text: r })),
  );
  addSectionRef(
    "section-competitive-signals",
    "Competitive / vendor signals",
    "competitive_signals",
    listPreview(brief.competitive_signals),
    6,
    3,
    listFullText(brief.competitive_signals),
    brief.competitive_signals.map((c) => ({ text: c })),
  );

  // ---- Action + open questions ------------------------------------------
  widgets.push({
    ...baseWidget("action-next", "Recommended next action", 8, 2, {
      why_included: "From brief.next_action.",
    }),
    kind: "action_panel",
    data: {
      actions: [{ label: "Next action", detail: brief.next_action }],
    },
  });

  const questions: string[] = [];
  if (brief.personas.length === 0) {
    questions.push("Which buyer or executive sponsor should be prioritized?");
  }
  if (brief.competitive_signals.length === 0) {
    questions.push("Which incumbent vendors or competitors are most relevant?");
  }
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
    questions.push("Which public sources would strengthen this account brief?");
  }
  widgets.push({
    ...baseWidget("open-questions", "Open questions", 4, 2, {
      why_included: "Surface gaps without inventing facts.",
    }),
    kind: "open_questions",
    data: { questions },
  });

  // ---- Sources -----------------------------------------------------------
  addSectionRef(
    "section-sources",
    "Key sources",
    "sources",
    listPreview(brief.sources.map((s) => s.title)),
    12,
    2,
    listFullText(brief.sources.map((s) => s.title)),
  );

  // ---- Extensions as first-class widgets --------------------------------
  // Layout per spec: card/list w=6, table/narrative w=12.
  for (const ext of brief.extensions) {
    widgets.push(buildExtensionWidget(ext, packer, generatedAt));
  }

  const evidenceCount = widgets.reduce(
    (n, w) => n + w.evidence.length + (w.kind === "evidence_board" ? w.data.items.length : 0),
    0,
  );

  return {
    account_id: briefId,
    account_name: brief.account_name,
    version: 1,
    generated_at: generatedAt,
    widgets,
    meta: {
      layout_mode: "grid",
      pinned_order: widgets.map((w) => w.id),
      agent_readiness: {
        mode: "read_only_preview",
        generated_from: "saved_brief",
        controls_enabled: widgets.some(
          (w) =>
            w.controls.can_edit ||
            w.controls.can_export ||
            w.controls.can_refresh ||
            w.controls.can_remove,
        ),
        source_count: brief.sources.length,
        evidence_count: evidenceCount,
      },
    },
  };
}

function buildExtensionWidget(
  ext: BriefExtension,
  packer: GridPacker,
  generatedAtFallback: string,
): CanvasWidget {
  const w = ext.kind === "table" || ext.kind === "narrative" ? 12 : 6;
  const h = ext.kind === "table" ? 4 : ext.kind === "narrative" ? 3 : 3;
  const layout = packer.next(w, h);
  const created = ext.created_at || generatedAtFallback;
  // Preserve the brief's own extension source verbatim so renderers can
  // show chat additions and operators see PR-A research/model provenance.
  const source = ext.source;
  const sources = ext.sources.map(sourceFromBriefSource);

  const base = {
    id: `extension-${ext.id}`,
    title: ext.title,
    description: "",
    source,
    created_at: created,
    updated_at: created,
    confidence: ext.confidence,
    why_included: ext.why_included || "From brief extensions.",
    sources,
    layout,
    controls: { ...NO_CONTROLS },
    status: "fresh" as const,
    evidence: [],
  };

  switch (ext.kind) {
    case "card":
      return {
        ...base,
        kind: "extension",
        data: { ext_kind: "card", body: ext.body },
      };
    case "narrative":
      return {
        ...base,
        kind: "extension",
        data: { ext_kind: "narrative", body: ext.body },
      };
    case "list":
      return {
        ...base,
        kind: "extension",
        data: { ext_kind: "list", items: ext.items },
      };
    case "table":
      return {
        ...base,
        kind: "extension",
        data: { ext_kind: "table", columns: ext.columns, rows: ext.rows },
      };
  }
}
