// Deterministic Hermes recommended action queue.
//
// Pure / React-free / never throws. All account-specific strings are
// pulled verbatim from the saved Brief; no model or provider calls.
// Returns an ordered list of up to 4 rich action items in the shape the
// canvas action_panel schema accepts.

import type { Brief, Persona, Initiative, Signal } from "@/lib/schema";

export type RecommendedAction = {
  recommendation: string;
  rationale: string;
  expected_outcome: string;
  risk?: string;
  evidence: Array<{
    text: string;
    source?: string;
    confidence?: "High" | "Medium" | "Low" | "Not found";
    tag?: string;
  }>;
  approval_state: "suggested";
  owner?: string;
  severity: "low" | "medium" | "high";
};

const MAX_ACTIONS = 4;

const HIGH_SEVERITY_RISK_PATTERN =
  /\b(block|blocker|blocking|delay|complex|complexity|risk|risks|procurement|security|cyber|breach|governance|compliance|regulatory|audit)\b/i;

function nonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function strongestSignal(signals: Signal[] | undefined): Signal | null {
  if (!Array.isArray(signals) || signals.length === 0) return null;
  const rank: Record<string, number> = {
    High: 3,
    Medium: 2,
    Low: 1,
    "Not found": 0,
  };
  let best: Signal | null = null;
  let bestRank = -1;
  for (const s of signals) {
    if (!s || !nonEmpty(s.text)) continue;
    const r = rank[s.confidence ?? "Not found"] ?? 0;
    if (r > bestRank) {
      best = s;
      bestRank = r;
    }
  }
  return best;
}

function topInitiative(brief: Brief): Initiative | null {
  const first = brief.top_initiatives?.[0];
  return first && nonEmpty(first.title) ? first : null;
}

function topPersona(brief: Brief): Persona | null {
  const first = brief.personas?.[0];
  return first && (nonEmpty(first.name) || nonEmpty(first.title))
    ? first
    : null;
}

function topRisk(brief: Brief): string | null {
  const first = brief.risks?.[0];
  return nonEmpty(first) ? first : null;
}

function firstCompetitiveSignal(brief: Brief): string | null {
  const first = brief.competitive_signals?.[0];
  return nonEmpty(first) ? first : null;
}

function personaLabel(p: Persona): string {
  if (nonEmpty(p.name) && nonEmpty(p.title)) return `${p.name} (${p.title})`;
  if (nonEmpty(p.name)) return p.name;
  if (nonEmpty(p.title)) return p.title;
  return "the key stakeholder";
}

// ---- builders -------------------------------------------------------------

function buildPrimaryAction(brief: Brief): RecommendedAction | null {
  if (!nonEmpty(brief.next_action)) return null;

  const evidence: RecommendedAction["evidence"] = [
    {
      text: brief.next_action,
      source: "Primary recommendation from saved brief",
      tag: "primary",
    },
  ];

  const strongest = strongestSignal(brief.recent_signals);
  if (strongest) {
    evidence.push({
      text: strongest.text,
      source: strongest.source,
      confidence: strongest.confidence,
      tag: "signal",
    });
  }

  const initiative = topInitiative(brief);
  if (initiative) {
    evidence.push({
      text: `${initiative.title}: ${initiative.detail}`.trim(),
      source: initiative.source,
      confidence: initiative.confidence,
      tag: "initiative",
    });
  }

  return {
    recommendation: brief.next_action,
    rationale:
      "Surfaces the recommended next move the saved brief already ranks as primary.",
    expected_outcome:
      "Moves the account from research into a concrete first conversation.",
    evidence,
    approval_state: "suggested",
    severity: "high",
  };
}

function buildInitiativeAction(brief: Brief): RecommendedAction | null {
  const initiative = topInitiative(brief);
  if (!initiative) return null;

  const evidence: RecommendedAction["evidence"] = [
    {
      text: `${initiative.title}: ${initiative.detail}`.trim(),
      source: initiative.source,
      confidence: initiative.confidence,
      tag: "initiative",
    },
  ];

  if (nonEmpty(brief.first_angle)) {
    evidence.push({
      text: brief.first_angle,
      source: "brief.first_angle",
      tag: "angle",
    });
  }

  return {
    recommendation: `Align outreach to "${initiative.title}".`,
    rationale: nonEmpty(initiative.detail)
      ? `Saved brief flags this initiative as a top priority: ${initiative.detail}`
      : "Saved brief flags this initiative as a top priority.",
    expected_outcome:
      "Anchors the first conversation in the buyer's own stated priority instead of a generic pitch.",
    evidence,
    approval_state: "suggested",
    severity: "medium",
  };
}

function buildStakeholderAction(brief: Brief): RecommendedAction | null {
  const persona = topPersona(brief);
  const buyingPath = nonEmpty(brief.buying_path) ? brief.buying_path : null;
  if (!persona && !buyingPath) return null;

  const evidence: RecommendedAction["evidence"] = [];
  if (persona) {
    const personaText = [
      nonEmpty(persona.priority) ? `Priority: ${persona.priority}` : "",
      nonEmpty(persona.opener) ? `Opener: ${persona.opener}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    evidence.push({
      text: personaText || personaLabel(persona),
      source: persona.source,
      confidence: persona.confidence,
      tag: "persona",
    });
  }
  if (buyingPath) {
    evidence.push({
      text: buyingPath,
      source: "brief.buying_path",
      tag: "decision_path",
    });
  }

  const target = persona ? personaLabel(persona) : "the buying committee";
  const rationaleBits: string[] = [];
  if (persona && nonEmpty(persona.priority)) {
    rationaleBits.push(`Their stated priority: ${persona.priority}`);
  }
  if (buyingPath) {
    rationaleBits.push(`Decision path: ${buyingPath}`);
  }
  const rationale = rationaleBits.length
    ? rationaleBits.join(" ")
    : "Saved brief identifies them as the most relevant stakeholder to brief first.";

  return {
    recommendation: `Sequence outreach to ${target}.`,
    rationale,
    expected_outcome:
      "Reaches the right entry point first instead of pitching into an unrelated role.",
    evidence,
    approval_state: "suggested",
    owner: persona && nonEmpty(persona.name) ? persona.name : undefined,
    severity: "medium",
  };
}

function buildRiskAction(brief: Brief): RecommendedAction | null {
  const risk = topRisk(brief);
  if (!risk) return null;

  const evidence: RecommendedAction["evidence"] = [
    { text: risk, source: "brief.risks", tag: "risk" },
  ];
  const competitive = firstCompetitiveSignal(brief);
  if (competitive) {
    evidence.push({
      text: competitive,
      source: "brief.competitive_signals",
      tag: "competitive",
    });
  }

  const severity: RecommendedAction["severity"] =
    HIGH_SEVERITY_RISK_PATTERN.test(risk) ? "high" : "medium";

  return {
    recommendation: "Prepare a mitigation note for the leading risk.",
    rationale: `Saved brief surfaces this as the top watch-out: ${risk}`,
    expected_outcome:
      "Equips the account team with a pre-built response so the risk does not stall the first meeting.",
    risk,
    evidence,
    approval_state: "suggested",
    severity,
  };
}

// ---- composer -------------------------------------------------------------

// Builds the Hermes recommended-action queue from a saved brief. Order is
// deterministic and reflects priority (primary → initiative → stakeholder
// → risk). Caller decides how many to render; this caps at MAX_ACTIONS.
export function buildRecommendedActions(brief: Brief): RecommendedAction[] {
  const candidates: Array<RecommendedAction | null> = [
    buildPrimaryAction(brief),
    buildInitiativeAction(brief),
    buildStakeholderAction(brief),
    buildRiskAction(brief),
  ];
  return candidates
    .filter((a): a is RecommendedAction => a !== null)
    .slice(0, MAX_ACTIONS);
}
