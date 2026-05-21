// Phase A.6 — Graph → Brief-like parity renderer + comparator.
// Pure, no network. Produces normalized comparison output and a diff between
// the legacy Brief and the shadow graph's content. Implementation-only — not
// exposed via any route. See plan §7, §12.

import type { Brief } from "../schema";
import type { AccountGraphDocument, Claim } from "./schema";

export type SectionBucket = {
  section: string;
  brief_items: string[];
  graph_items: string[];
};

export type ParitySectionDiff = {
  section: string;
  brief_only: string[];
  graph_only: string[];
  shared: string[];
};

export type ParityReport = {
  account_name: string;
  brief_id: string;
  sections: ParitySectionDiff[];
  dropped_brief_claims: { section: string; text: string }[];
  provenance_gaps: {
    claim_id: string;
    section: string;
    tier: string;
    note: string;
  }[];
  material_differences: string[];
  // Heuristic "claim coverage" — count of brief items represented in the
  // graph divided by total brief items. Reported with explicit denominator.
  coverage_numerator: number;
  coverage_denominator: number;
};

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: string, b: string): number {
  const as = new Set(norm(a).split(" ").filter(Boolean));
  const bs = new Set(norm(b).split(" ").filter(Boolean));
  if (as.size === 0 && bs.size === 0) return 1;
  let inter = 0;
  for (const t of as) if (bs.has(t)) inter += 1;
  const union = new Set([...as, ...bs]).size;
  return union === 0 ? 0 : inter / union;
}

// Collect Brief items keyed by section.
function collectBriefBuckets(brief: Brief): SectionBucket[] {
  const buckets: SectionBucket[] = [];
  const add = (section: string, items: string[]) =>
    buckets.push({ section, brief_items: items.filter(Boolean), graph_items: [] });

  add(
    "recent_signals",
    brief.recent_signals.map((s) => s.text),
  );
  add(
    "top_initiatives",
    brief.top_initiatives.map((i) => i.detail),
  );
  add("technical_footprint.ai_in_production", brief.technical_footprint.ai_in_production);
  add("technical_footprint.active_pilots", brief.technical_footprint.active_pilots);
  add("technical_footprint.cloud_platforms", brief.technical_footprint.cloud_platforms);
  add("technical_footprint.competitive_incumbents", brief.technical_footprint.competitive_incumbents);
  add("programs_procurement.modernization_grants", brief.programs_procurement.modernization_grants);
  add("programs_procurement.consortium_purchasing", brief.programs_procurement.consortium_purchasing);
  add("programs_procurement.active_rfps_contracts", brief.programs_procurement.active_rfps_contracts);
  add("programs_procurement.public_ai_use_cases", brief.programs_procurement.public_ai_use_cases);
  add(
    "personas",
    brief.personas.map((p) => p.opener),
  );
  add("risks", brief.risks);
  add("competitive_signals", brief.competitive_signals);
  return buckets;
}

// Collect graph items grouped by Claim.metadata.section.
function collectGraphBuckets(graph: AccountGraphDocument): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of graph.claims) {
    const section =
      ((c.metadata as Record<string, unknown> | undefined)?.section as string) ||
      "(unknown)";
    if (!out.has(section)) out.set(section, []);
    out.get(section)!.push(c.text);
  }
  return out;
}

export function buildParityReport(
  brief: Brief,
  graph: AccountGraphDocument,
  brief_id: string,
): ParityReport {
  const briefBuckets = collectBriefBuckets(brief);
  const graphBySection = collectGraphBuckets(graph);

  const sections: ParitySectionDiff[] = [];
  const dropped: ParityReport["dropped_brief_claims"] = [];
  let numerator = 0;
  let denominator = 0;

  for (const b of briefBuckets) {
    const graphItems = graphBySection.get(b.section) || [];
    const shared: string[] = [];
    const briefOnly: string[] = [];
    const graphOnly: string[] = [...graphItems];

    for (const bi of b.brief_items) {
      denominator += 1;
      const idx = graphOnly.findIndex((gi) => jaccard(gi, bi) >= 0.7);
      if (idx >= 0) {
        shared.push(bi);
        graphOnly.splice(idx, 1);
        numerator += 1;
      } else {
        briefOnly.push(bi);
        dropped.push({ section: b.section, text: bi });
      }
    }
    sections.push({ section: b.section, brief_only: briefOnly, graph_only: graphOnly, shared });
  }

  // Provenance gaps: any high-confidence Claim whose tier is weaker than
  // verified. Plan §12: list every Claim whose tier is weaker than its
  // position in the Brief implies. We use `metadata.original_confidence`
  // because the mapper downgrades high → medium in the graph (the brief's
  // `high` rating cannot be backed by an excerpt in A.6).
  const provenanceGaps: ParityReport["provenance_gaps"] = [];
  for (const c of graph.claims) {
    const md = (c.metadata as Record<string, unknown> | undefined) ?? {};
    const section = (md.section as string) || "(unknown)";
    const originalConfidence = (md.original_confidence as string) || c.confidence;
    if (originalConfidence === "high" && c.provenance_status !== "verified") {
      provenanceGaps.push({
        claim_id: c.id,
        section,
        tier: c.provenance_status,
        note: "Brief presented this as High confidence; graph tier is weaker than verified and confidence was downgraded (expected in A.6).",
      });
    }
  }

  const materialDifferences: string[] = [];
  if (dropped.length > 0) {
    materialDifferences.push(`${dropped.length} brief items have no near-match in the graph.`);
  }
  if (provenanceGaps.length > 0) {
    materialDifferences.push(
      `${provenanceGaps.length} high-confidence brief claims downgraded to non-verified tier (A.6 has no excerpt verification path against legacy text — expected).`,
    );
  }
  if (
    brief.snapshot &&
    !graph.account_objects.some((o) => o.type === "account_snapshot" && (o.body || "").trim().length > 0)
  ) {
    materialDifferences.push("snapshot prose is not represented on the root account_snapshot object body.");
  }

  return {
    account_name: brief.account_name,
    brief_id,
    sections,
    dropped_brief_claims: dropped,
    provenance_gaps: provenanceGaps,
    material_differences: materialDifferences,
    coverage_numerator: numerator,
    coverage_denominator: denominator,
  };
}

// Graph → Brief-like normalized text (markdown) for human side-by-side
// review. Reads grouped claims from the graph.
export function renderGraphAsBriefLike(graph: AccountGraphDocument): string {
  const grouped = collectGraphBuckets(graph);
  const lines: string[] = [];
  lines.push(`# Shadow-graph rendered Brief — ${graph.account_ref.account_name}`);
  lines.push("");
  lines.push("_Generated from graph traversal. Implementation-only; not a production Brief surface._");
  lines.push("");
  const sortedSections = Array.from(grouped.keys()).sort();
  for (const section of sortedSections) {
    lines.push(`## ${section}`);
    for (const t of grouped.get(section)!) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Helper: list Claims by provenance tier for the report.
export function claimsByTier(graph: AccountGraphDocument): Record<string, Claim[]> {
  const out: Record<string, Claim[]> = {};
  for (const c of graph.claims) {
    if (!out[c.provenance_status]) out[c.provenance_status] = [];
    out[c.provenance_status].push(c);
  }
  return out;
}
