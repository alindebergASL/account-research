// Phase A.6 — Backfill report writer.
// Produces per-brief classifications and aggregate roll-up per plan §9.
// Pure / no network. The runner writes the artifacts (markdown + JSON) to
// the output directory.

import type { AccountGraphValidationReport } from "./validation";
import type { ParityReport } from "./briefParity";
import type { BackfillMappingReport } from "./fromBriefJson";

export type PerBriefClassification =
  | "pass"
  | "skipped_malformed_json"
  | "skipped_unsupported_schema_variant"
  | "partial_with_attribution_gaps"
  | "failed_validation"
  | "failed_false_verified_provenance"
  | "failed_invented_evidence"
  | "failed_render_parity";

export type AggregateClassification = "pass" | "borderline" | "fail";

export type PerBriefRecord = {
  brief_id: string;
  account_name?: string;
  classification: PerBriefClassification;
  reasons: string[];
  validation?: AccountGraphValidationReport | null;
  parity?: ParityReport | null;
  mapping?: BackfillMappingReport | null;
  error?: string;
};

const HARD_INVENTED_CODES = new Set([
  "invented_source_reference",
  "invented_excerpt_reference",
  "invented_claim_reference",
  "edge_missing_endpoint",
]);

const HARD_PROVENANCE_CODES = new Set([
  "verified_without_evidence",
  "verified_from_legacy_brief_only",
  "disallowed_source_supports_verified_claim",
]);

const HARD_VALIDATION_CODES = new Set([
  ...HARD_INVENTED_CODES,
  ...HARD_PROVENANCE_CODES,
  "zod_parse_error",
  "duplicate_id",
  "excerpt_verification_failed",
  "high_confidence_without_strong_evidence",
]);

export function classifyBrief(
  brief_id: string,
  validation: AccountGraphValidationReport | null,
  parity: ParityReport | null,
  mapping: BackfillMappingReport | null,
): PerBriefRecord {
  const reasons: string[] = [];

  if (!validation || !mapping) {
    return {
      brief_id,
      classification: "failed_validation",
      reasons: ["no validation or mapping produced"],
      validation,
      parity,
      mapping,
    };
  }

  // HARD failures first.
  const provErr = validation.errors.find((e) => HARD_PROVENANCE_CODES.has(e.code));
  if (provErr) {
    reasons.push(`provenance hard failure: [${provErr.code}] ${provErr.message}`);
    return {
      brief_id,
      account_name: mapping.account_name,
      classification: "failed_false_verified_provenance",
      reasons,
      validation,
      parity,
      mapping,
    };
  }
  const inventedErr = validation.errors.find((e) => HARD_INVENTED_CODES.has(e.code));
  if (inventedErr) {
    reasons.push(`invented reference: [${inventedErr.code}] ${inventedErr.message}`);
    return {
      brief_id,
      account_name: mapping.account_name,
      classification: "failed_invented_evidence",
      reasons,
      validation,
      parity,
      mapping,
    };
  }

  const otherHard = validation.errors.find((e) => HARD_VALIDATION_CODES.has(e.code));
  if (otherHard) {
    reasons.push(`hard validation failure: [${otherHard.code}] ${otherHard.message}`);
    return {
      brief_id,
      account_name: mapping.account_name,
      classification: "failed_validation",
      reasons,
      validation,
      parity,
      mapping,
    };
  }

  if (validation.errors.length > 0) {
    reasons.push(`${validation.errors.length} soft validator errors`);
    return {
      brief_id,
      account_name: mapping.account_name,
      classification: "failed_validation",
      reasons,
      validation,
      parity,
      mapping,
    };
  }

  // Render parity check (heuristic, plan §7B): if any populated brief
  // section is *entirely* unrepresented in the graph, classify as
  // failed_render_parity.
  if (parity) {
    const entirelyDropped = parity.sections.filter(
      (s) => s.brief_only.length > 0 && s.shared.length === 0,
    );
    if (entirelyDropped.length >= 3) {
      reasons.push(
        `${entirelyDropped.length} brief sections entirely absent from graph (e.g. ${entirelyDropped.slice(0, 3).map((s) => s.section).join(", ")})`,
      );
      return {
        brief_id,
        account_name: mapping.account_name,
        classification: "failed_render_parity",
        reasons,
        validation,
        parity,
        mapping,
      };
    }
  }

  // Attribution gaps: many legacy_brief_json claims where a source string
  // exists but provenance is still legacy_brief_json (parse failure of source).
  const gapCount =
    (mapping.legacy_brief_only_count || 0) + (mapping.inferred_count || 0);
  if (gapCount >= 30) {
    reasons.push(`${gapCount} claims tiered legacy/inferred (large attribution gap)`);
    return {
      brief_id,
      account_name: mapping.account_name,
      classification: "partial_with_attribution_gaps",
      reasons,
      validation,
      parity,
      mapping,
    };
  }

  reasons.push("validators ok; mapping ok; parity within tolerance");
  return {
    brief_id,
    account_name: mapping.account_name,
    classification: "pass",
    reasons,
    validation,
    parity,
    mapping,
  };
}

export function aggregateClassification(
  records: PerBriefRecord[],
): { classification: AggregateClassification; reasons: string[] } {
  const reasons: string[] = [];
  const counts: Record<PerBriefClassification, number> = {
    pass: 0,
    skipped_malformed_json: 0,
    skipped_unsupported_schema_variant: 0,
    partial_with_attribution_gaps: 0,
    failed_validation: 0,
    failed_false_verified_provenance: 0,
    failed_invented_evidence: 0,
    failed_render_parity: 0,
  };
  for (const r of records) counts[r.classification] += 1;

  if (counts.failed_false_verified_provenance > 0) {
    reasons.push(
      `HARD FAIL: ${counts.failed_false_verified_provenance} briefs with false-verified provenance.`,
    );
    return { classification: "fail", reasons };
  }
  if (counts.failed_invented_evidence > 0) {
    reasons.push(
      `HARD FAIL: ${counts.failed_invented_evidence} briefs with invented evidence/source IDs.`,
    );
    return { classification: "fail", reasons };
  }
  if (counts.failed_validation > 0) {
    reasons.push(
      `HARD FAIL: ${counts.failed_validation} briefs failed validator hard invariants.`,
    );
    return { classification: "fail", reasons };
  }
  // Systematic whole-section loss: >25% of briefs in failed_render_parity.
  const total = records.length || 1;
  if (counts.failed_render_parity / total > 0.25) {
    reasons.push(
      `HARD FAIL: ${counts.failed_render_parity}/${total} briefs failed render parity (systematic section loss).`,
    );
    return { classification: "fail", reasons };
  }
  if (
    counts.partial_with_attribution_gaps / total > 0.5 ||
    counts.failed_render_parity > 0
  ) {
    reasons.push(
      `borderline: ${counts.partial_with_attribution_gaps} attribution-gap briefs, ${counts.failed_render_parity} render-parity failures.`,
    );
    return { classification: "borderline", reasons };
  }
  reasons.push(
    `pass: ${counts.pass} pass, ${counts.skipped_malformed_json} malformed, ${counts.skipped_unsupported_schema_variant} unsupported variant, ${counts.partial_with_attribution_gaps} attribution gaps.`,
  );
  return { classification: "pass", reasons };
}

// ---------- Markdown renderer ----------

export type RenderInput = {
  branch: string;
  commit: string;
  runAt: string;
  mode: "fixture" | "local-db";
  records: PerBriefRecord[];
  aggregate: { classification: AggregateClassification; reasons: string[] };
  runtimeMs: number;
};

export function renderBackfillMarkdown(input: RenderInput): string {
  const { branch, commit, runAt, mode, records, aggregate, runtimeMs } = input;
  const lines: string[] = [];
  lines.push("# Phase A.6 — brief_json → account graph backfill report");
  lines.push("");
  lines.push(`- Branch: \`${branch}\``);
  lines.push(`- Commit: \`${commit}\``);
  lines.push(`- Run at: ${runAt}`);
  lines.push(`- Mode: \`${mode}\` (read-only on brief_json; no production writes; no model calls; no web fetches)`);
  lines.push(`- Runtime: ${runtimeMs} ms`);
  lines.push(`- Briefs processed: ${records.length}`);
  lines.push("");
  lines.push("## Aggregate classification");
  lines.push("");
  lines.push(`**${aggregate.classification.toUpperCase()}**`);
  for (const r of aggregate.reasons) lines.push(`- ${r}`);
  lines.push("");
  lines.push("## Per-brief results");
  lines.push("");
  lines.push("| Brief | Account | Classification | Claims | Objects | Tier mix |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of records) {
    const m = r.mapping;
    const v = r.validation;
    const tierMix = m
      ? `legacy=${m.legacy_brief_only_count}, inferred=${m.inferred_count}, srcdoc=${m.source_document_only_count}, chat=${m.chat_patch_count}, verified=${m.verified_count}`
      : "(n/a)";
    lines.push(
      `| \`${r.brief_id}\` | ${r.account_name || "(n/a)"} | \`${r.classification}\` | ${v?.metrics.claim_count ?? "—"} | ${v?.metrics.account_object_count ?? "—"} | ${tierMix} |`,
    );
  }
  lines.push("");

  // Per-brief detail
  for (const r of records) {
    lines.push(`### ${r.brief_id} — ${r.account_name ?? ""} — \`${r.classification}\``);
    for (const reason of r.reasons) lines.push(`- ${reason}`);
    if (r.error) lines.push(`- error: ${r.error}`);
    if (r.validation) {
      lines.push(`- validator errors: ${r.validation.errors.length}; warnings: ${r.validation.warnings.length}`);
    }
    if (r.parity) {
      lines.push(
        `- parity coverage (heuristic): ${r.parity.coverage_numerator}/${r.parity.coverage_denominator} brief items represented in graph (Jaccard≥0.7)`,
      );
      if (r.parity.dropped_brief_claims.length > 0) {
        lines.push(`- dropped brief items (${r.parity.dropped_brief_claims.length}):`);
        for (const d of r.parity.dropped_brief_claims.slice(0, 5)) {
          lines.push(`  - [${d.section}] ${d.text.slice(0, 140)}`);
        }
        if (r.parity.dropped_brief_claims.length > 5)
          lines.push(`  - ...and ${r.parity.dropped_brief_claims.length - 5} more`);
      }
      if (r.parity.provenance_gaps.length > 0) {
        lines.push(`- provenance gaps (${r.parity.provenance_gaps.length}):`);
        for (const g of r.parity.provenance_gaps.slice(0, 5)) {
          lines.push(`  - claim ${g.claim_id} (${g.section}): tier=${g.tier} — ${g.note}`);
        }
      }
      if (r.parity.material_differences.length > 0) {
        lines.push(`- material differences:`);
        for (const m of r.parity.material_differences) lines.push(`  - ${m}`);
      }
    }
    if (r.mapping) {
      if (r.mapping.ambiguous.length > 0) {
        lines.push(`- ambiguous / deferred sections (${r.mapping.ambiguous.length}):`);
        for (const a of r.mapping.ambiguous) lines.push(`  - [${a.section}] ${a.reason}`);
      }
      if (r.mapping.unmapped_claims.length > 0) {
        lines.push(`- unmapped prose (${r.mapping.unmapped_claims.length}):`);
        for (const u of r.mapping.unmapped_claims.slice(0, 5))
          lines.push(`  - [${u.section}] ${u.reason}`);
      }
      if (r.mapping.orphan_source_ids.length > 0) {
        lines.push(`- orphan SourceDocuments (cited but no referencing excerpt — expected in A.6 since we do not fabricate excerpts): ${r.mapping.orphan_source_ids.length}`);
      }
      if (r.mapping.notes.length > 0) {
        for (const n of r.mapping.notes.slice(0, 5)) lines.push(`- note: ${n}`);
      }
    }
    lines.push("");
  }

  lines.push("## A.6 safety statement");
  lines.push("");
  lines.push("- `brief_json` remains canonical. This runner does not write to canonical storage.");
  lines.push("- No production migration. No deploy. No user-visible surfaces.");
  lines.push("- No model API calls. No web fetches.");
  lines.push("- A.7 remains BLOCKED per `docs/BLOCKERS.md`.");
  lines.push("");
  return lines.join("\n");
}
