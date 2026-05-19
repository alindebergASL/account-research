import type { Brief, BriefExtension } from "@/lib/schema";
import type { CanvasWidget, Canvas, Confidence, Source } from "./schema";
import { emptyStateMessage } from "./emptyStates";
import {
  buildAITakeaways,
  buildMomentumStrip,
  buildOpportunityRiskSplit,
  buildStrategicSignalRadar,
} from "./strategicInsights";
import { buildRecommendedActions } from "./recommendedActions";
import { buildCanvasLayoutPlan } from "./layoutPlanner";
import {
  isBarStyleEmittedWidget,
  isEmptyWidgetPayload,
  tierFor,
  TIER_LABELS,
  TIER_ORDER,
  type TierName,
  type VisualForm,
} from "./visualGrammar";
import { VISUAL_GRAMMAR_RULES } from "./visualGrammar";

// One-line rollback flag. When false, the planner-derived `form` is not
// applied to widget data and the pre-PR adapter behavior is restored
// without changing widget IDs / counts / layout. New visual-form
// components remain net-additive — flipping this flag removes their
// emission path without affecting any existing kind.
//
// Exported so tests can drive the on/off branch deterministically. The
// production code path always reads the module-level constant.
export const LAYOUT_PLANNER_ENABLED = true;

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

// Treat string brief values that are empty, "Not found", "—", "n/a", or
// "unknown" as missing. Keeps scaffold placeholders from leaking into
// rendered Canvas copy. Mirrors the predicate used in `layoutPlanner.ts`
// and `visualGrammar.ts`.
function hasMeaningfulValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !/^(not found|—|n\/a|unknown)\.?$/i.test(trimmed);
}

function executivePreview(s: string, max = 220): string {
  if (!s) return "";
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;

  const firstSentence = trimmed.match(/^.+?[.!?](?:\s|$)/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= max) return firstSentence;

  const boundary = Math.max(
    trimmed.lastIndexOf(". ", max),
    trimmed.lastIndexOf("; ", max),
    trimmed.lastIndexOf(": ", max),
    trimmed.lastIndexOf(" — ", max),
    trimmed.lastIndexOf(" ", max),
  );
  const cut = boundary > 80 ? boundary : max - 1;
  return trimmed.slice(0, cut).trimEnd().replace(/[,:;—-]+$/, "") + "…";
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
  plannerEnabled,
}: {
  briefId: string;
  brief: Brief;
  // Test-only override. Defaults to the module constant so production
  // callers see exactly the constant's value.
  plannerEnabled?: boolean;
}): Canvas {
  const generatedAt = brief.generated_at || new Date(0).toISOString();
  const widgets: CanvasWidget[] = [];
  const packer = new GridPacker();
  const plannerOn = plannerEnabled ?? LAYOUT_PLANNER_ENABLED;

  // Planner output: drives the `form` discriminator on
  // section_refs (personas / recent_signals) and on the
  // opportunity_risk_split widget. Coordinates remain assigned by the
  // existing GridPacker so widget IDs / ordering stay stable when the
  // planner's chosen form is "default".
  const layoutPlan = plannerOn
    ? buildCanvasLayoutPlan(brief)
    : null;
  function plannedForm(id: string): VisualForm | undefined {
    if (!layoutPlan) return undefined;
    const f = layoutPlan.forms[id];
    return f && f !== "default" ? f : undefined;
  }

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
    const form = plannedForm(id);
    // When the planner picks a non-default form, the widget's evidence
    // array is augmented with the tagged items that form's renderer
    // expects. Tags act as a discriminator the new visual-form
    // components read from (no schema change needed).
    type EvItem = {
      text: string;
      source?: string;
      confidence?: Confidence;
      tag?: string;
    };
    let evidence: EvItem[] = structured && structured.length > 0
      ? structured.map((s) => ({
          text: s.text,
          source: s.source,
          confidence: s.confidence,
          tag: s.tag,
        }))
      : base.evidence;
    if (form === "timeline") {
      evidence = [
        ...brief.recent_signals.map<EvItem>((s) => ({
          text: s.text,
          source: s.source,
          confidence: s.confidence,
          tag: "signal",
        })),
        ...brief.top_initiatives.map<EvItem>((i) => ({
          text: i.title,
          source: i.source,
          confidence: i.confidence,
          tag: "initiative",
        })),
        ...brief.programs_procurement.active_rfps_contracts.map<EvItem>((p) => ({
          text: p,
          tag: "procurement",
        })),
      ];
    } else if (form === "persona-map") {
      const personaEvidence = brief.personas.map<EvItem>((p) => ({
        text: `${p.name} — ${p.title}`,
        source: p.source,
        confidence: p.confidence,
        tag: "persona",
      }));
      const buyingPathEvidence: EvItem[] = hasMeaningfulValue(brief.buying_path)
        ? [{ text: brief.buying_path, tag: "buying_path" }]
        : [];
      evidence = [...personaEvidence, ...buyingPathEvidence];
    }
    widgets.push({
      ...base,
      evidence,
      kind: "section_ref",
      data: {
        section_key: sectionKey,
        preview: executivePreview(preview),
        full_text: trimmedFullText,
        ...(form ? { form } : {}),
      },
    });
  }

  // ---- Row 1: Recommended next moves (organizing spine) -----------------
  // The recommended-action queue is now the first widget after the
  // executive cockpit so the account workspace opens on the move it is
  // organizing around, not a mosaic of secondary tiles. Height is sized
  // to accommodate the full primary line (timing + recommendation +
  // rationale + expected outcome + risk) without clamping.
  const recommendedActions = buildRecommendedActions(brief);
  widgets.push({
    ...baseWidget("action-next", "Recommended next moves", 12, 5, {
      source: "hermes",
      why_included:
        "Prioritized from brief evidence, account signals, risks, and personas.",
    }),
    kind: "action_panel",
    data: {
      actions:
        recommendedActions.length > 0
          ? recommendedActions
          : [{ label: "Next action", detail: brief.next_action }],
    },
  });

  // ---- Row 2: Top opportunity + Top risk (paired) -----------------------
  addSectionRef(
    "section-top-initiatives",
    "Top initiatives",
    "top_initiatives",
    listPreview(brief.top_initiatives.map((i) => `${i.title}: ${i.detail}`)),
    6,
    4,
    listFullText(brief.top_initiatives.map((i) => `${i.title}: ${i.detail}`)),
    brief.top_initiatives.map((i) => ({
      text: i.title,
      source: i.source,
      confidence: i.confidence,
      tag: i.detail,
    })),
  );
  addSectionRef(
    "section-risks",
    "Risks & watch-outs",
    "risks",
    listPreview(brief.risks),
    6,
    4,
    listFullText(brief.risks),
    brief.risks.map((r) => ({ text: r })),
  );

  // ---- Row 3: Evidence confidence (full row) ----------------------------
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
    ...baseWidget("evidence-board", "Evidence board", 12, 4, {
      why_included: "Citation snippets from signals, initiatives, and personas.",
    }),
    kind: "evidence_board",
    data: { items: evidence.slice(0, EVIDENCE_CAP) },
  });

  // ---- Row 4: Signal radar + Opportunity/Risk split + Momentum ----------
  widgets.push({
    ...baseWidget("insight-signal-radar", "Strategic signal radar", 4, 4, {
      source: "hermes",
      why_included:
        "Buckets brief.recent_signals + brief.competitive_signals into strategy / tech / procurement / leadership quadrants by deterministic keyword match.",
    }),
    kind: "strategic_signal_radar",
    data: buildStrategicSignalRadar(brief),
  });
  {
    const orsForm = plannedForm("insight-opportunity-risk");
    const orsBase = baseWidget("insight-opportunity-risk", "Opportunity / risk split", 4, 4, {
      source: "hermes",
      why_included:
        "Pairs brief.top_initiatives against brief.risks side-by-side and labels the balance.",
    });
    type EvItem = {
      text: string;
      source?: string;
      confidence?: Confidence;
      tag?: string;
    };
    const orsEvidence: EvItem[] =
      orsForm === "tension-matrix"
        ? [
            ...brief.top_initiatives.map<EvItem>((i) => ({
              text: i.title,
              source: i.source,
              confidence: i.confidence,
              tag: "initiative",
            })),
            ...brief.risks.map<EvItem>((r) => ({ text: r, tag: "risk" })),
          ]
        : orsBase.evidence;
    widgets.push({
      ...orsBase,
      evidence: orsEvidence,
      kind: "opportunity_risk_split",
      data: {
        ...buildOpportunityRiskSplit(brief),
        ...(orsForm ? { form: orsForm } : {}),
      },
    });
  }
  widgets.push({
    ...baseWidget("insight-momentum-strip", "Momentum", 4, 4, {
      source: "hermes",
      why_included:
        "Counts signals, initiatives, active pilots, and active programs from the saved brief; labels overall velocity.",
    }),
    kind: "momentum_strip",
    data: buildMomentumStrip(brief),
  });

  // ---- Row 5: Personas, Buying Path, First Angle, AI Takeaways ----------
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
    hasMeaningfulValue(brief.buying_path) ? brief.buying_path : "",
    6,
    3,
  );
  addSectionRef(
    "section-first-angle",
    "First conversation angle",
    "first_angle",
    brief.first_angle,
    6,
    3,
  );
  widgets.push({
    ...baseWidget("insight-ai-takeaways", "AI takeaways", 6, 3, {
      source: "hermes",
      why_included:
        "Deterministic synthesis of maturity, top initiative, top risk, buying path, and recommended next action from the saved brief.",
    }),
    kind: "ai_takeaways",
    data: buildAITakeaways(brief),
  });

  // ---- Row 6: Footprint, Programs/Procurement, Open Questions -----------
  const tf = brief.technical_footprint;
  const tfLines = [
    tf.ai_in_production.length > 0
      ? `AI in production: ${tf.ai_in_production.join("; ")}`
      : "",
    tf.active_pilots.length > 0
      ? `Active pilots: ${tf.active_pilots.join("; ")}`
      : "",
    tf.cloud_platforms.length > 0
      ? `Cloud: ${tf.cloud_platforms.join(", ")}`
      : "",
    hasMeaningfulValue(tf.clinical_platforms)
      ? `Clinical: ${tf.clinical_platforms}`
      : "",
  ].filter(Boolean);
  addSectionRef(
    "section-technical-footprint",
    "Technical footprint",
    "technical_footprint",
    tfLines.length > 0
      ? tfLines.join("\n")
      : emptyStateMessage("technical_footprint"),
    6,
    3,
  );

  const pp = brief.programs_procurement;
  const ppLines = [
    pp.active_rfps_contracts.length > 0
      ? `Active RFPs / contracts: ${pp.active_rfps_contracts.join("; ")}`
      : "",
    pp.modernization_grants.length > 0
      ? `Grants: ${pp.modernization_grants.join("; ")}`
      : "",
    hasMeaningfulValue(pp.ai_governance_policy)
      ? `Governance: ${pp.ai_governance_policy}`
      : "",
  ].filter(Boolean);
  addSectionRef(
    "section-programs-procurement",
    "Programs & procurement",
    "programs_procurement",
    ppLines.length > 0
      ? ppLines.join("\n")
      : emptyStateMessage("programs_procurement"),
    6,
    3,
  );

  // Recent + competitive signals retain their landscape view but slot
  // beneath the strategic insight row so the spine stays clean above.
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
  if (questions.length > 0) {
    widgets.push({
      ...baseWidget("open-questions", "Discovery gaps", 6, 3, {
        why_included: "Surface gaps without inventing facts.",
      }),
      kind: "open_questions",
      data: { questions },
    });
  }

  // ---- Row 7: Extensions ------------------------------------------------
  for (const ext of brief.extensions) {
    widgets.push(buildExtensionWidget(ext, packer, generatedAt));
  }

  // ---- Row 8: Snapshot, Priority summary, AI maturity, Sources ----------
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
      helper: "Based on the saved account brief.",
    },
  });
  addSectionRef(
    "section-priority",
    "Why this account · why now",
    "priority_summary",
    brief.priority_summary,
    6,
    3,
  );
  addSectionRef(
    "section-ai-maturity",
    "AI / tech maturity",
    "ai_tech_maturity",
    `Rating ${brief.ai_tech_maturity.rating}/5 — ${brief.ai_tech_maturity.rationale}`,
    6,
    3,
  );
  addSectionRef(
    "section-sources",
    "Key sources",
    "sources",
    listPreview(brief.sources.map((s) => s.title)),
    12,
    2,
    listFullText(brief.sources.map((s) => s.title)),
  );

  // When the planner is on, reorder + re-pack so the emitted-widget
  // hierarchy honors the top-cluster bar-style cap and the planner's
  // promotion of non-bar forms. When the planner is off, the widget
  // list keeps the layout the original GridPacker assigned during
  // emission (rollback parity).
  const planned = plannerOn
    ? applyPlannerLayout(widgets, layoutPlan)
    : widgets;
  const finalWidgets = plannerOn
    ? applyTierCollapse(planned, generatedAt)
    : planned;

  const evidenceCount = finalWidgets.reduce(
    (n, w) => n + w.evidence.length + (w.kind === "evidence_board" ? w.data.items.length : 0),
    0,
  );

  return {
    account_id: briefId,
    account_name: brief.account_name,
    version: 1,
    generated_at: generatedAt,
    widgets: finalWidgets,
    meta: {
      layout_mode: "grid",
      pinned_order: finalWidgets.map((w) => w.id),
      agent_readiness: {
        mode: "read_only_preview",
        generated_from: "saved_brief",
        controls_enabled: finalWidgets.some(
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

// Reorder + re-pack the emitted widget list so:
//   1. `action-next` keeps the top row (y=0, x=0, w=12).
//   2. The next 5 post-action slots contain at most
//      `VISUAL_GRAMMAR_RULES.maxBarStyleInTopCluster` bar-style widgets
//      (predicate: `isBarStyleEmittedWidget`).
//   3. Planner-promoted non-bar widgets (timeline, persona-map,
//      tension-matrix) are surfaced into the top cluster ahead of bars
//      following the planner's `topClusterOrder`.
//   4. Excess bar-style widgets are demoted BELOW the top cluster but
//      otherwise keep their relative emission order.
// The grid packer is then re-run from scratch over the reordered list
// so coordinates stay deterministic, non-overlapping, and 12-col bound.
// Widget IDs are not changed.
function applyPlannerLayout(
  widgets: CanvasWidget[],
  plan: ReturnType<typeof buildCanvasLayoutPlan> | null,
): CanvasWidget[] {
  if (widgets.length === 0) return widgets;
  const action = widgets.find((w) => w.id === "action-next");
  const rest = widgets.filter((w) => w.id !== "action-next");
  if (!action) return widgets;

  // Promote planner-controlled non-bar widgets into the front of `rest`
  // while preserving the relative order of everything else. The planner
  // only tracks promoted-form widgets (form !== "default"), so this is
  // the set we surface into the top cluster first.
  const plannerPromotedIds = plan
    ? plan.topClusterOrder.filter((id) =>
        rest.some((w) => w.id === id && !isBarStyleEmittedWidget(w)),
      )
    : [];
  const promoted: CanvasWidget[] = [];
  const remainder: CanvasWidget[] = [];
  for (const w of rest) {
    if (plannerPromotedIds.includes(w.id)) promoted.push(w);
    else remainder.push(w);
  }
  // Maintain planner-declared ordering among promoted widgets.
  promoted.sort(
    (a, b) => plannerPromotedIds.indexOf(a.id) - plannerPromotedIds.indexOf(b.id),
  );
  const ordered = [...promoted, ...remainder];

  // Enforce the top-cluster bar cap: walk the (post-action) order,
  // admitting bar-style widgets up to the cap; spill the rest into
  // `demoted` to be appended after the rest of the canvas.
  const topClusterSize = VISUAL_GRAMMAR_RULES.topClusterSize;
  const barCap = VISUAL_GRAMMAR_RULES.maxBarStyleInTopCluster;
  const topCluster: CanvasWidget[] = [];
  const tail: CanvasWidget[] = [];
  const demoted: CanvasWidget[] = [];
  let barsInTop = 0;
  for (const w of ordered) {
    if (topCluster.length < topClusterSize) {
      const isBar = isBarStyleEmittedWidget(w);
      if (isBar && barsInTop >= barCap) {
        demoted.push(w);
      } else {
        topCluster.push(w);
        if (isBar) barsInTop += 1;
      }
    } else {
      tail.push(w);
    }
  }
  const finalOrdered = [action, ...topCluster, ...tail, ...demoted];

  // Re-pack the entire list deterministically. action-next occupies
  // (0,0,12,5) by design, so the rest flows beneath it.
  const packer = new GridPacker();
  return finalOrdered.map((w) => ({
    ...w,
    layout: {
      ...packer.next(w.layout.w, w.layout.h),
      pinned: w.layout.pinned,
      collapsed: w.layout.collapsed,
    },
  }));
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

// Title cased for the gap widget per tier.
function gapTitleForTier(tier: TierName): string {
  return `Missing intelligence — ${TIER_LABELS[tier].toLowerCase()}`;
}

// Build a short "validate next" hypothesis for an empty widget so the
// collapsed gap card lists concrete validation suggestions, not just a
// dead "this is empty" line.
function validateNextFor(widget: CanvasWidget): string {
  switch (widget.id) {
    case "section-personas":
      return "Confirm the buying committee (CMIO / CIO / procurement).";
    case "section-buying-path":
      return "Map the decision path with the account team before outreach.";
    case "section-risks":
      return "Surface a material risk before the next executive touch.";
    case "section-competitive-signals":
      return "Check incumbents in the saved evidence.";
    case "section-recent-signals":
      return "Pull a recent public signal to anchor outreach.";
    case "section-top-initiatives":
      return "Validate the account's stated priority initiatives.";
    case "section-programs-procurement":
      return "Confirm active RFPs / contracts or grants.";
    case "section-technical-footprint":
      return "Validate cloud / clinical / AI footprint with the account team.";
    case "evidence-board":
      return "Add cited evidence before recommending a move.";
    case "insight-signal-radar":
      return "No public signal yet — verify in discovery.";
    case "insight-opportunity-risk":
      return "No opportunity / risk surfaced — confirm before action.";
    case "insight-momentum-strip":
      return "No momentum captured — refresh the brief.";
    case "insight-ai-takeaways":
      return "No takeaways yet — capture the next executive read.";
    case "metric-ai-maturity":
      return "Confirm the account's AI maturity rating.";
    default:
      if (widget.id.startsWith("extension-"))
        return "Add a citation or note to this extension.";
      return "Validate before action.";
  }
}

// Collapse ≥ 2 empty widgets in a tier into one synthetic gap widget.
// Reuses the existing `open_questions` kind so no new widget kind is
// introduced. The synthetic widget's id is `gaps-<tier-slug>`. Single
// empty widgets are left in place — the threshold is ≥ 2 so the collapse
// only kicks in for real visual clutter.
function applyTierCollapse(
  widgets: CanvasWidget[],
  generatedAt: string,
): CanvasWidget[] {
  if (widgets.length === 0) return widgets;
  // Bucket empties per tier without re-ordering the emitted list. The
  // planner already chose a top-cluster ordering that satisfies the
  // bar-style cap; we must preserve it.
  const emptyIdsByTier: Map<TierName, Set<string>> = new Map();
  const emptyWidgetsByTier: Map<TierName, CanvasWidget[]> = new Map();
  for (const w of widgets) {
    if (!isEmptyWidgetPayload(w)) continue;
    const t = tierFor(w);
    if (!emptyIdsByTier.has(t)) emptyIdsByTier.set(t, new Set());
    if (!emptyWidgetsByTier.has(t)) emptyWidgetsByTier.set(t, []);
    emptyIdsByTier.get(t)!.add(w.id);
    emptyWidgetsByTier.get(t)!.push(w);
  }

  const collapsingTiers = new Set<TierName>();
  for (const [tier, ids] of emptyIdsByTier) {
    if (ids.size >= 2) collapsingTiers.add(tier);
  }

  // Build the rebuilt list: drop empty widgets in collapsing tiers, and
  // insert one synthetic gap widget at the position of the FIRST empty
  // for each collapsing tier. Preserves the original ordering.
  const rebuilt: CanvasWidget[] = [];
  const seenCollapse = new Set<TierName>();
  for (const w of widgets) {
    const t = tierFor(w);
    const isEmpty = isEmptyWidgetPayload(w);
    if (collapsingTiers.has(t) && isEmpty) {
      if (!seenCollapse.has(t)) {
        seenCollapse.add(t);
        const empties = emptyWidgetsByTier.get(t) ?? [];
        const questions = empties.map((e) => ({
          text: `${e.title}: not yet captured.`,
          blocking: false,
          hypothesis: validateNextFor(e),
        }));
        const gap: CanvasWidget = {
          id: `gaps-${t}`,
          title: gapTitleForTier(t),
          description: "",
          source: "system" as const,
          created_at: generatedAt,
          updated_at: generatedAt,
          why_included:
            "Consolidates widgets with thin or missing data so the canvas stays scannable.",
          sources: [],
          layout: {
            x: 0,
            y: 0,
            w: 6,
            h: Math.min(Math.max(3, questions.length), 6),
            pinned: false,
            collapsed: false,
          },
          controls: { ...NO_CONTROLS },
          status: "fresh" as const,
          evidence: [],
          kind: "open_questions",
          data: { questions },
        };
        rebuilt.push(gap);
      }
      // else: skip this empty widget (already collapsed).
    } else {
      rebuilt.push(w);
    }
  }

  // Re-pack the grid deterministically so coordinates stay non-overlapping.
  const packer = new GridPacker();
  return rebuilt.map((w) => ({
    ...w,
    layout: {
      ...packer.next(w.layout.w, w.layout.h),
      pinned: w.layout.pinned,
      collapsed: w.layout.collapsed,
    },
  }));
}

// Re-export for callers (ReadOnlyCanvasView) that group widgets by tier.
export { tierFor, TIER_LABELS, TIER_ORDER };
export type { TierName };
