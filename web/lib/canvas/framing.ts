import type { CanvasWidget } from "./schema";

// Hermes-voiced framing for top-level Canvas objects. Pure function — does
// not call any model, does not invent facts. Eyebrow + one-line are derived
// from `widget.kind`, `widget.data`, and the saved brief content already
// encoded in the widget. When data is empty, oneLine is empty (no
// fabrication). Renderers must skip empty fields.

export interface WidgetFraming {
  eyebrow: string;
  oneLine: string;
}

function firstNonEmpty(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

function truncateOneLine(s: string, max = 160): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd().replace(/[,:;—-]+$/, "") + "…";
}

function sectionEyebrow(sectionKey: string): string {
  switch (sectionKey) {
    case "risks":
      return "Caveats before acting";
    case "personas":
      return "Likely buying committee";
    case "programs_procurement":
      return "Procurement context";
    case "top_initiatives":
      return "Where the budget is moving";
    case "recent_signals":
      return "Recent signals";
    case "competitive_signals":
      return "Vendor landscape";
    case "ai_tech_maturity":
      return "AI readiness read";
    case "technical_footprint":
      return "Technical landscape";
    case "buying_path":
      return "Decision path";
    case "first_angle":
      return "Where to start the conversation";
    case "snapshot":
      return "Account context";
    case "priority_summary":
      return "Why this account, why now";
    case "sources":
      return "Source coverage";
    default:
      return "Brief context";
  }
}

function sectionWhyItMatters(sectionKey: string): string {
  switch (sectionKey) {
    case "risks":
      return "Surface caveats before any execution step so the team can preempt blockers.";
    case "personas":
      return "Identifies who is likely to sign, sponsor, or stall the engagement.";
    case "programs_procurement":
      return "Procurement vehicles shape pace and approval path for any move.";
    case "top_initiatives":
      return "Initiatives are where committed budget and executive attention already sit.";
    case "recent_signals":
      return "Signals dictate timing — recent moves indicate where momentum is real.";
    case "competitive_signals":
      return "Maps the incumbent landscape that any approach has to displace or partner around.";
    case "ai_tech_maturity":
      return "Sets the realistic ceiling on what to propose first.";
    case "technical_footprint":
      return "Frames what integrates cleanly versus what creates friction.";
    case "buying_path":
      return "Defines the sequence of approvals the move has to clear.";
    case "first_angle":
      return "Anchors the opening so the first call lands on the strongest ground.";
    case "snapshot":
      return "Grounds every subsequent decision in the saved account context.";
    case "priority_summary":
      return "Connects the moment to the account-level thesis.";
    case "sources":
      return "Provenance check — every claim above ties back here.";
    default:
      return "";
  }
}

function topListItem(items: ReadonlyArray<{ text?: string }> | undefined): string {
  if (!items || items.length === 0) return "";
  const top = items[0];
  return typeof top?.text === "string" ? top.text : "";
}

function sectionOneLine(widget: Extract<CanvasWidget, { kind: "section_ref" }>): string {
  const key = widget.data.section_key;
  const ev = widget.evidence;
  switch (key) {
    case "risks": {
      const top = topListItem(ev);
      if (!top) return "No risks surfaced in the saved brief.";
      return `Top caveat: ${top}`;
    }
    case "personas": {
      const top = topListItem(ev);
      if (!top) return "No personas captured in the saved brief.";
      return `Lead persona: ${top}`;
    }
    case "programs_procurement": {
      const preview = widget.data.preview;
      if (!preview || preview.trim().length === 0) {
        return "Evidence is thin — no active programs or procurement signals in the saved brief.";
      }
      return truncateOneLine(preview);
    }
    case "top_initiatives": {
      const top = topListItem(ev);
      if (!top) return "No top initiatives captured in the saved brief.";
      return `Lead initiative: ${top}`;
    }
    case "recent_signals": {
      const top = topListItem(ev);
      if (!top) return "No recent signals captured in the saved brief.";
      return truncateOneLine(top);
    }
    case "competitive_signals": {
      const top = topListItem(ev);
      if (!top) return "No competitive signals captured in the saved brief.";
      return truncateOneLine(top);
    }
    default: {
      const p = widget.data.preview;
      if (!p || p.trim().length === 0) return "";
      return truncateOneLine(p.split("\n")[0] ?? p);
    }
  }
}

export function widgetFraming(widget: CanvasWidget): WidgetFraming {
  switch (widget.kind) {
    case "section_ref": {
      const eyebrow = sectionEyebrow(widget.data.section_key);
      const oneLine = sectionOneLine(widget);
      return { eyebrow, oneLine };
    }
    case "metric": {
      if (widget.id === "metric-ai-maturity") {
        const value = firstNonEmpty(widget.data.value);
        return {
          eyebrow: "AI maturity read",
          oneLine: value ? `Maturity rating ${value} based on the saved account brief.` : "",
        };
      }
      return {
        eyebrow: "Account signal",
        oneLine: firstNonEmpty(widget.data.label),
      };
    }
    case "momentum_strip": {
      const d = widget.data;
      const oneLine = d.total > 0
        ? `${d.velocity_label} — ${d.total} item${d.total === 1 ? "" : "s"} across signals, initiatives, pilots, and programs.`
        : "Quiet — no live signals, initiatives, pilots, or programs in the saved brief.";
      return { eyebrow: "Timing signal", oneLine };
    }
    case "evidence_board": {
      const n = widget.data.items.length;
      const oneLine = n > 0
        ? `${n} citation${n === 1 ? "" : "s"} stitched together from signals, initiatives, and personas.`
        : "No evidence yet — the move is currently unsupported by saved citations.";
      return { eyebrow: "Evidence backing the move", oneLine };
    }
    case "strategic_signal_radar": {
      const quads = widget.data.quadrants;
      const top = [...quads].sort((a, b) => b.count - a.count)[0];
      const oneLine = top && top.count > 0
        ? `${top.label} is the loudest quadrant (${top.count} signal${top.count === 1 ? "" : "s"}).`
        : "No quadrant lights up yet — verify in discovery.";
      return { eyebrow: "Signal posture", oneLine };
    }
    case "opportunity_risk_split": {
      const d = widget.data;
      const label = d.balance.replace(/-/g, " ");
      return {
        eyebrow: "Opportunity vs caveat balance",
        oneLine: `Balance reads ${label} (${d.opportunities.count} opportunity, ${d.risks.count} risk).`,
      };
    }
    case "ai_takeaways": {
      const n = widget.data.takeaways.length;
      return {
        eyebrow: "Key takeaways",
        oneLine: n > 0 ? `${n} takeaway${n === 1 ? "" : "s"} synthesized from the saved brief.` : "",
      };
    }
    case "action_panel": {
      const n = widget.data.actions.length;
      return {
        eyebrow: "Recommended move",
        oneLine: n > 0
          ? `Ranked queue of ${n} move${n === 1 ? "" : "s"} drawn from the saved brief.`
          : "",
      };
    }
    case "open_questions": {
      const n = widget.data.questions.length;
      return {
        eyebrow: "What to validate",
        oneLine: n > 0 ? `${n} open question${n === 1 ? "" : "s"} to confirm in discovery.` : "",
      };
    }
    case "extension": {
      const ek = widget.data.ext_kind;
      const eyebrow =
        ek === "card"
          ? "Insight"
          : ek === "table"
            ? "Reference table"
            : ek === "list"
              ? "Reference list"
              : "Note";
      let oneLine = "";
      if (ek === "card" || ek === "narrative") {
        oneLine = truncateOneLine(widget.data.body ?? "");
      } else if (ek === "list") {
        const items = widget.data.items ?? [];
        oneLine = items.length > 0
          ? `${items.length} item${items.length === 1 ? "" : "s"} captured for reference.`
          : "";
      } else if (ek === "table") {
        const rows = widget.data.rows ?? [];
        const cols = widget.data.columns ?? [];
        oneLine = rows.length > 0
          ? `${rows.length} row${rows.length === 1 ? "" : "s"} × ${cols.length} column${cols.length === 1 ? "" : "s"}.`
          : "";
      }
      return { eyebrow, oneLine };
    }
    default:
      return { eyebrow: "", oneLine: "" };
  }
}

// Generic "Why this matters" line for section_ref details. Deterministic,
// no fabricated account-specific facts.
export function sectionWhyItMattersText(sectionKey: string): string {
  return sectionWhyItMatters(sectionKey);
}
