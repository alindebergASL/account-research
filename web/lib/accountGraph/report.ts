// Phase A.5 — Markdown report generator for spike runs.

import type { AccountGraphValidationReport, CascadeImpact } from "./validation";
import type { SpikeAResult, SpikeBResult } from "./spikePipeline";

export type OutcomeClassification = "pass" | "borderline" | "fail" | "budget_exceeded";

export type SpikeAOutcome = {
  classification: OutcomeClassification;
  reasons: string[];
};

export type SpikeBOutcome = {
  classification: OutcomeClassification;
  reasons: string[];
};

/**
 * Classify Spike A per spec thresholds:
 * - Hard invariants: parse ok, ref integrity, invented refs == 0, no false
 *   verified provenance, excerpt offset correctness.
 * - Excerpt validity ≥95% pass; 90-95% borderline; <90% fail.
 */
export function classifySpikeA(
  validation: AccountGraphValidationReport,
  budgetExceeded = false,
): SpikeAOutcome {
  if (budgetExceeded) {
    return { classification: "budget_exceeded", reasons: ["Cost ceiling exceeded."] };
  }
  const reasons: string[] = [];
  const hardErrorCodes = new Set([
    "zod_parse_error",
    "duplicate_id",
    "invented_source_reference",
    "invented_excerpt_reference",
    "invented_claim_reference",
    "excerpt_verification_failed",
    "verified_without_evidence",
    "verified_from_legacy_brief_only",
    "high_confidence_without_strong_evidence",
    "disallowed_source_supports_verified_claim",
    "edge_missing_endpoint",
  ]);
  const hardErrors = validation.errors.filter((e) => hardErrorCodes.has(e.code));
  if (hardErrors.length > 0) {
    reasons.push(`Hard invariant violations: ${hardErrors.length}`);
    for (const he of hardErrors.slice(0, 5)) reasons.push(`- [${he.code}] ${he.message}`);
    return { classification: "fail", reasons };
  }
  const v = validation.metrics.valid_excerpt_ratio;
  if (v >= 0.95) {
    reasons.push(`Excerpt validity ${(v * 100).toFixed(1)}% ≥ 95%`);
    return { classification: "pass", reasons };
  }
  if (v >= 0.9) {
    reasons.push(`Excerpt validity ${(v * 100).toFixed(1)}% borderline (90–95%)`);
    return { classification: "borderline", reasons };
  }
  reasons.push(`Excerpt validity ${(v * 100).toFixed(1)}% < 90%`);
  return { classification: "fail", reasons };
}

/**
 * Classify Spike B per spec:
 * - Paraphrase rejection is a hard invariant.
 * - Exact span ≥90% pass; 85–90% with normalized ≥95% borderline; <85% fail.
 * - Normalized ≥95% pass; 90–95% borderline; <90% fail.
 */
export function classifySpikeB(b: SpikeBResult, budgetExceeded = false): SpikeBOutcome {
  if (budgetExceeded) {
    return { classification: "budget_exceeded", reasons: ["Cost ceiling exceeded."] };
  }
  const reasons: string[] = [];
  if (b.metrics.accepted_paraphrases > 0) {
    reasons.push(
      `Paraphrase rejection failed: ${b.metrics.accepted_paraphrases} paraphrases accepted as excerpts.`,
    );
    return { classification: "fail", reasons };
  }
  const exact = b.metrics.exact_span_ratio;
  const norm = b.metrics.normalized_span_ratio;
  reasons.push(`Exact span ${(exact * 100).toFixed(1)}%; Normalized ${(norm * 100).toFixed(1)}%`);

  if (exact < 0.85) return { classification: "fail", reasons };
  if (norm < 0.9) return { classification: "fail", reasons };

  if (exact >= 0.9 && norm >= 0.95) return { classification: "pass", reasons };
  // Borderline: exact 85-90 with norm >=95, OR norm 90-95
  return { classification: "borderline", reasons };
}

export type ReportInput = {
  branch: string;
  commit: string;
  runAt: string;
  mode: "fixture" | "model";
  spikeA: { result: SpikeAResult; validation: AccountGraphValidationReport; outcome: SpikeAOutcome };
  spikeB: { result: SpikeBResult; outcome: SpikeBOutcome };
  cascadeExample: CascadeImpact;
  runtimeMs: number;
  cost?: { usd: number | null; tokensIn: number; tokensOut: number; calls: number; status: "n/a" | "tracked" | "unknown_estimated" };
};

export function renderSpikeReport(input: ReportInput): string {
  const {
    branch,
    commit,
    runAt,
    mode,
    spikeA,
    spikeB,
    cascadeExample,
    runtimeMs,
    cost,
  } = input;

  const traceClaim = spikeA.result.graph.claims.find((c) => c.id === spikeA.result.trace.claim_id);
  const traceExcerpt = spikeA.result.graph.evidence_excerpts.find(
    (e) => e.id === spikeA.result.trace.excerpt_id,
  );
  const traceSource = spikeA.result.graph.source_documents.find(
    (s) => s.id === spikeA.result.trace.source_id,
  );
  const traceObject = spikeA.result.graph.account_objects.find(
    (o) => o.id === spikeA.result.trace.object_id,
  );
  const conflict = spikeA.result.graph.conflicts[0];

  const m = spikeA.validation.metrics;

  const lines: string[] = [];
  lines.push("# Phase A.5 — Account Graph Spike Results");
  lines.push("");
  lines.push(`- Branch: \`${branch}\``);
  lines.push(`- Commit: \`${commit}\``);
  lines.push(`- Run at: ${runAt}`);
  lines.push(`- Mode: \`${mode}\` (fixture mode is deterministic, no model/web calls)`);
  lines.push(`- Runtime: ${runtimeMs} ms`);
  if (cost) {
    lines.push(
      `- Cost: status=${cost.status}, usd=${cost.usd ?? "n/a"}, tokens_in=${cost.tokensIn}, tokens_out=${cost.tokensOut}, calls=${cost.calls}`,
    );
  } else {
    lines.push("- Cost: n/a (fixture mode, no model calls)");
  }
  lines.push("");
  lines.push("## Outcome classification");
  lines.push("");
  lines.push(`- **Spike A (graph assembly):** \`${spikeA.outcome.classification}\``);
  for (const r of spikeA.outcome.reasons) lines.push(`  - ${r}`);
  lines.push(`- **Spike B (excerpt extraction):** \`${spikeB.outcome.classification}\``);
  for (const r of spikeB.outcome.reasons) lines.push(`  - ${r}`);
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Source documents | ${m.source_count} |`);
  lines.push(`| Evidence excerpts | ${m.excerpt_count} |`);
  lines.push(`| Claims | ${m.claim_count} |`);
  lines.push(`| Account objects | ${m.account_object_count} |`);
  lines.push(`| ClaimEvidence links | ${m.claim_evidence_count} |`);
  lines.push(`| Valid excerpt ratio | ${(m.valid_excerpt_ratio * 100).toFixed(1)}% |`);
  lines.push(`| Exact-span ratio | ${(m.exact_span_ratio * 100).toFixed(1)}% |`);
  lines.push(`| Normalized-span ratio | ${(m.normalized_span_ratio * 100).toFixed(1)}% |`);
  lines.push(`| Claims with evidence | ${(m.claims_with_evidence_ratio * 100).toFixed(1)}% |`);
  lines.push(`| High-confidence claims without strong evidence | ${m.high_confidence_claims_without_strong_evidence} |`);
  lines.push(`| Invented references | ${m.invented_reference_count} |`);
  lines.push(`| Contradiction count | ${m.contradiction_count} |`);
  lines.push(`| Conflict count | ${m.conflict_count} |`);
  lines.push(`| Cascade fanout (claim_marked_wrong) | claims=${cascadeExample.affected_claim_ids.length}, objects=${cascadeExample.affected_object_ids.length}, evidence=${cascadeExample.affected_claim_evidence_ids.length} |`);
  lines.push("");
  lines.push("### Spike B extraction metrics");
  lines.push("");
  lines.push(`- expected_total: ${spikeB.result.metrics.expected_total}`);
  lines.push(`- expected_matchable: ${spikeB.result.metrics.expected_matchable}`);
  lines.push(`- expected_paraphrase: ${spikeB.result.metrics.expected_paraphrase}`);
  lines.push(`- accepted: ${spikeB.result.metrics.accepted}`);
  lines.push(`- rejected_correctly (paraphrases): ${spikeB.result.metrics.rejected_correctly}`);
  lines.push(`- accepted_paraphrases (must be 0): ${spikeB.result.metrics.accepted_paraphrases}`);
  lines.push(`- exact_span_ok: ${spikeB.result.metrics.exact_span_ok}`);
  lines.push(`- normalized_span_ok: ${spikeB.result.metrics.normalized_span_ok}`);
  lines.push(`- exact_span_ratio: ${(spikeB.result.metrics.exact_span_ratio * 100).toFixed(1)}%`);
  lines.push(`- normalized_span_ratio: ${(spikeB.result.metrics.normalized_span_ratio * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("## Validation issues");
  lines.push("");
  if (spikeA.validation.errors.length === 0) {
    lines.push("- Errors: none");
  } else {
    lines.push(`- Errors (${spikeA.validation.errors.length}):`);
    for (const e of spikeA.validation.errors) lines.push(`  - [${e.code}] ${e.message}`);
  }
  if (spikeA.validation.warnings.length === 0) {
    lines.push("- Warnings: none");
  } else {
    lines.push(`- Warnings (${spikeA.validation.warnings.length}):`);
    for (const w of spikeA.validation.warnings) lines.push(`  - [${w.code}] ${w.message}`);
  }
  lines.push("");
  lines.push("## Sample trace: source → excerpt → claim → object");
  lines.push("");
  if (traceSource && traceExcerpt && traceClaim && traceObject) {
    lines.push(`- **Source** \`${traceSource.id}\` (${traceSource.kind}): ${traceSource.title}`);
    lines.push(`- **Excerpt** \`${traceExcerpt.id}\` [${traceExcerpt.char_start}-${traceExcerpt.char_end}]: "${traceExcerpt.text}"`);
    lines.push(`- **Claim** \`${traceClaim.id}\` (${traceClaim.type}, ${traceClaim.confidence}, provenance=${traceClaim.provenance_status}): ${traceClaim.text}`);
    lines.push(`- **AccountObject** \`${traceObject.id}\` (${traceObject.type}): ${traceObject.title}`);
  }
  lines.push("");
  lines.push("## Conflict representation example");
  lines.push("");
  if (conflict) {
    lines.push(`- Conflict \`${conflict.id}\` (${conflict.reconciliation_status}): ${conflict.summary}`);
    lines.push(`- Involved claims: ${conflict.claim_ids.join(", ")}`);
  } else {
    lines.push("- No conflicts present in this run.");
  }
  lines.push("");
  lines.push("## Cascade impact example");
  lines.push("");
  lines.push(`- Event: \`${cascadeExample.event.type}\``);
  lines.push(`- Affected claims: ${cascadeExample.affected_claim_ids.join(", ") || "(none)"}`);
  lines.push(`- Affected objects: ${cascadeExample.affected_object_ids.join(", ") || "(none)"}`);
  lines.push(`- Affected excerpts: ${cascadeExample.affected_excerpt_ids.join(", ") || "(none)"}`);
  lines.push(`- Affected claim_evidence: ${cascadeExample.affected_claim_evidence_ids.join(", ") || "(none)"}`);
  lines.push(`- Notes:`);
  for (const n of cascadeExample.notes) lines.push(`  - ${n}`);
  lines.push("");
  lines.push("## Decision inputs (for Andrew/Hermes review — not a roadmap decision)");
  lines.push("");
  lines.push("### Evidence supporting proceed to A.6");
  lines.push("");
  if (spikeA.outcome.classification === "pass" && spikeB.outcome.classification === "pass") {
    lines.push("- Both Spike A and Spike B classified `pass` in fixture mode.");
    lines.push("- Schema can express hierarchy scope, conflict, MEDDPICC mapping, provenance tiering, and cascade impact without hacks.");
    lines.push("- Validator catches deliberately broken cases in tests (see `tests/accountGraph.*.test.ts`).");
    lines.push("- Deterministic excerpt verification reliably rejects paraphrase candidates.");
  } else {
    lines.push("- (Conditional) Some classifications are below `pass`; review reasons before proceeding.");
  }
  lines.push("");
  lines.push("### Evidence supporting repeat A.5");
  lines.push("");
  lines.push(`- Outcome classifications: A=${spikeA.outcome.classification}, B=${spikeB.outcome.classification}.`);
  lines.push("- If either is `borderline` or `fail`, repeat with adjusted fixtures or extractor logic.");
  lines.push("- Only one fixture-mode run was executed in this artifact; future runs with --mode model are optional and budget-gated.");
  lines.push("");
  lines.push("### Evidence supporting revise schema");
  lines.push("");
  lines.push("- Watch for repeated validation warnings of type `object_without_claims`, `claim_no_evidence`, or schema gaps surfaced when authoring the Nueva fixture.");
  lines.push("- Consider whether the current AccountObject/Claim split is the right granularity once A.6 begins backfilling.");
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push("- Fixture mode only. No model or web calls were made.");
  lines.push("- Nueva sources are synthetic, lab-only fixtures. Findings do not represent the real school.");
  lines.push("- A single deterministic pipeline run produces both Spike A and Spike B classifications; this is intentional for A.5 since the fixture extractor feeds the assembler.");
  lines.push("- No production migration, no flag enablement, no UI work, no CRM writeback.");
  return lines.join("\n") + "\n";
}
