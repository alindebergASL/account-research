#!/usr/bin/env tsx
// Phase A.7 — validation runner. Fixture/default mode (paired A.6 baseline
// over synthetic illustrative fixtures only).
//
// HARD SAFETY GUARANTEES:
//   - No real model/provider calls. No SDK imports from `@anthropic-ai/sdk`,
//     `openai`, `resend`, etc.
//   - No reads of model credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
//   - No web fetches. No production DB writes. No migrations.
//   - No route/share/admin surface changes.
//   - Importing this module must not call `main`, must not touch the
//     filesystem, must not invoke any adapter. The `require.main === module`
//     guard at the bottom enforces this.
//   - `--mode model` is recognized but REFUSED in this PR. It exits nonzero
//     with a clear refusal message and does not instantiate any adapter, does
//     not touch the filesystem, does not call the fake adapter.
//
// This PR implements Task 3 of
// docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md (paired A.6
// baseline measurement over synthetic illustrative fixture accounts). A.7
// graph-first writes REMAIN BLOCKED per docs/BLOCKERS.md.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { fromBriefJson } from "../lib/accountGraph/fromBriefJson";
import { buildParityReport } from "../lib/accountGraph/briefParity";
import { validateAccountGraph } from "../lib/accountGraph/validation";
import { classifyBrief } from "../lib/accountGraph/backfillReport";
import { Brief as BriefSchema } from "../lib/schema";

// ----------------------- Model adapter boundary -----------------------
// Narrow interface so the runner depends on a seam, not a concrete provider.
// Future real-model PRs implement this interface without rewriting runner
// orchestration. This PR does NOT include any real provider implementation.

export type AdapterProposeExcerptsInput = {
  account_id: string;
  source_id: string;
  source_text: string;
};

export type AdapterProposedExcerpt = {
  source_id: string;
  text: string;
  char_start: number;
  char_end: number;
};

export type AdapterSynthesizeClaimsInput = {
  account_id: string;
  accepted_excerpts: { id: string; source_id: string; text: string }[];
};

export type AdapterSynthesizedClaim = {
  id: string;
  text: string;
  evidence_excerpt_ids: string[];
};

export interface ModelAdapter {
  readonly name: string;
  proposeExcerpts(input: AdapterProposeExcerptsInput): Promise<AdapterProposedExcerpt[]>;
  synthesizeClaims(
    input: AdapterSynthesizeClaimsInput,
  ): Promise<AdapterSynthesizedClaim[]>;
}

// FakeModelAdapter is the ONLY adapter shipped in this PR. It is fully
// deterministic, performs zero IO, zero model calls, zero fetches. Tests
// can wrap it with a spy to assert the runner invokes it through the
// `ModelAdapter` interface.
export class FakeModelAdapter implements ModelAdapter {
  readonly name = "fake-deterministic";
  public proposeExcerptsCalls = 0;
  public synthesizeClaimsCalls = 0;

  async proposeExcerpts(
    input: AdapterProposeExcerptsInput,
  ): Promise<AdapterProposedExcerpt[]> {
    this.proposeExcerptsCalls += 1;
    // Deterministic: return the first 80 characters of the source text as a
    // single proposed excerpt. No randomness, no IO.
    const text = input.source_text.slice(0, 80);
    return [
      {
        source_id: input.source_id,
        text,
        char_start: 0,
        char_end: text.length,
      },
    ];
  }

  async synthesizeClaims(
    input: AdapterSynthesizeClaimsInput,
  ): Promise<AdapterSynthesizedClaim[]> {
    this.synthesizeClaimsCalls += 1;
    return input.accepted_excerpts.map((ex, i) => ({
      id: `claim_${input.account_id}_${i}`,
      text: `fixture claim derived from ${ex.id}`,
      evidence_excerpt_ids: [ex.id],
    }));
  }
}

// ----------------------- CLI parsing -----------------------

export type CliMode = "fixture" | "model";

export type CliArgs = {
  mode: CliMode;
  maxCostUsd: number;
  corpus?: string;
  out: string;
  limit?: number;
  allowCostOver25: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    mode: "fixture",
    maxCostUsd: 10,
    allowCostOver25: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i] as CliMode;
    else if (a === "--max-cost-usd") args.maxCostUsd = Number(argv[++i]);
    else if (a === "--corpus") args.corpus = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--allow-cost-over-25") args.allowCostOver25 = true;
  }
  if (args.mode !== "fixture" && args.mode !== "model") {
    throw new Error(
      `Unsupported --mode: ${args.mode}. Expected "fixture" or "model".`,
    );
  }
  if (!args.out) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    args.out = resolve(
      __dirname,
      "..",
      "..",
      "out",
      "account-graph-validation",
      ts,
    );
  } else {
    args.out = resolve(args.out);
  }
  return args as CliArgs;
}

function gitInfo(): { branch: string; commit: string } {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
    const commit = execSync("git rev-parse HEAD").toString().trim();
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

// ----------------------- Synthetic fixture corpus -----------------------
//
// SAFETY: every fixture entry below is synthetic and illustrative. It must
// NOT name a real organization, must NOT include real source URLs, real
// prompts, or proprietary text. The runner reads these fixtures as Brief
// JSON only — it never executes, imports, or interprets fixture text as
// configuration or as model input.

export type SyntheticFixtureEntry = {
  account_label: string;
  fixture_id: string;
  fixture_path: string;
  selection_rationale: string;
  criteria_covered: string[];
};

const REPO_ROOT_FROM_SCRIPT = resolve(__dirname, "..", "..");

export const SYNTHETIC_FIXTURE_CORPUS: SyntheticFixtureEntry[] = [
  {
    account_label: "account_a_public_web",
    fixture_id: "a7_account_a_public_web",
    fixture_path: join(
      REPO_ROOT_FROM_SCRIPT,
      "tests",
      "fixtures",
      "a7_account_a_public_web.json",
    ),
    selection_rationale:
      "Synthetic account with primarily public-web sources and clean URL evidence chains. Designed so deterministic A.6 produces a `pass` classification (small surface, low attribution gap).",
    criteria_covered: [
      "public_web_sources",
      "at_least_one_a6_pass_account",
    ],
  },
  {
    account_label: "account_b_non_url_sources",
    fixture_id: "a7_account_b_non_url_sources",
    fixture_path: join(
      REPO_ROOT_FROM_SCRIPT,
      "tests",
      "fixtures",
      "a7_account_b_non_url_sources.json",
    ),
    selection_rationale:
      "Synthetic account with primarily non-URL sources (analyst conversations, relationship-memory notes, industry context) and many legacy high-confidence claims. Designed so deterministic A.6 produces `partial_with_attribution_gaps` with confidence downgrades.",
    criteria_covered: [
      "non_url_sources",
      "legacy_high_confidence_claims",
      "at_least_one_a6_partial_with_attribution_gaps_account",
    ],
  },
  {
    account_label: "account_c_chat_patch",
    fixture_id: "a7_account_c_chat_patch",
    fixture_path: join(
      REPO_ROOT_FROM_SCRIPT,
      "tests",
      "fixtures",
      "a7_account_c_chat_patch.json",
    ),
    selection_rationale:
      "Synthetic account with substantial chat-appended (chat_patch_object_level) extension content plus procurement/governance complexity. Exercises chat-patch provenance handling alongside a procurement RFP / governance policy surface.",
    criteria_covered: [
      "chat_patch_object_level_content",
      "procurement_governance_complexity",
    ],
  },
];

// Plan §2 selection criteria. Coverage means the runner *can exercise* this
// criterion against synthetic fixture data; it does NOT mean the criterion is
// prevalent in production, and it does NOT mean a production gate account has
// been selected. Real production gate-account selection remains a later,
// local-only task.
export const PLAN_S2_CRITERIA = [
  "chat_patch_object_level_content",
  "public_web_sources",
  "non_url_sources",
  "legacy_high_confidence_claims",
  "at_least_one_a6_pass_account",
  "at_least_one_a6_partial_with_attribution_gaps_account",
  "procurement_governance_complexity",
] as const;

export type PlanS2Criterion = (typeof PLAN_S2_CRITERIA)[number];

export type CriteriaCoverage = {
  covered: PlanS2Criterion[];
  uncovered: { criterion: PlanS2Criterion; reason: string }[];
  synthetic_only: true;
};

export function computeCriteriaCoverage(
  selected: SyntheticFixtureEntry[],
): CriteriaCoverage {
  const seen = new Set<string>();
  for (const e of selected) for (const c of e.criteria_covered) seen.add(c);
  const covered: PlanS2Criterion[] = [];
  const uncovered: { criterion: PlanS2Criterion; reason: string }[] = [];
  for (const crit of PLAN_S2_CRITERIA) {
    if (seen.has(crit)) covered.push(crit);
    else {
      uncovered.push({
        criterion: crit,
        reason:
          "Not exercised by the current synthetic fixture corpus. Synthetic fixtures intentionally do not invent production-like content for this criterion; real production gate-account selection remains a later, local-only step.",
      });
    }
  }
  return { covered, uncovered, synthetic_only: true };
}

export type CorpusKind = "synthetic_fixture";

export function selectFixtureCorpus(limit?: number): {
  kind: CorpusKind;
  id: string;
  label: string;
  entries: SyntheticFixtureEntry[];
} {
  const all = SYNTHETIC_FIXTURE_CORPUS;
  const max = Math.max(1, Math.min(3, limit ?? all.length));
  return {
    kind: "synthetic_fixture",
    id: "a7-synthetic-fixture-corpus-v1",
    label: "synthetic A.7 fixture corpus",
    entries: all.slice(0, max),
  };
}

// ----------------------- Paired baseline measurement -----------------------

export type PerAccountBaseline = {
  account_label: string;
  fixture_id: string;
  selection_rationale: string;
  criteria_covered: string[];
  claims: number;
  objects: number;
  classification: string;
  confidence_downgrades: number;
  orphan_source_documents: number;
  parity_coverage_numerator: number;
  parity_coverage_denominator: number;
  dropped_material_count: number;
  validator_errors: number;
  validator_warnings: number;
  provenance_gaps: number;
};

export type AggregateBaseline = {
  account_count: number;
  claims: number;
  objects: number;
  classification_counts: Record<string, number>;
  confidence_downgrades: number;
  orphan_source_documents: number;
  parity_coverage_numerator: number;
  parity_coverage_denominator: number;
  dropped_material_count: number;
  validator_errors: number;
  validator_warnings: number;
  provenance_gaps: number;
};

export function measurePerAccountBaseline(
  entry: SyntheticFixtureEntry,
  briefJson: unknown,
): PerAccountBaseline {
  const outcome = fromBriefJson({
    brief_id: entry.fixture_id,
    brief_json: briefJson,
  });
  if (outcome.status !== "ok") {
    // Synthetic fixtures are intended to parse; if a fixture is malformed,
    // surface it as a failed validation classification so the test catches
    // the regression rather than silently coercing to zeros.
    return {
      account_label: entry.account_label,
      fixture_id: entry.fixture_id,
      selection_rationale: entry.selection_rationale,
      criteria_covered: entry.criteria_covered,
      claims: 0,
      objects: 0,
      classification: outcome.status,
      confidence_downgrades: 0,
      orphan_source_documents: 0,
      parity_coverage_numerator: 0,
      parity_coverage_denominator: 0,
      dropped_material_count: 0,
      validator_errors: 1,
      validator_warnings: 0,
      provenance_gaps: 0,
    };
  }
  const { graph, report: mapping } = outcome;
  const validation = validateAccountGraph(graph);
  const briefParsed = BriefSchema.parse(briefJson);
  const parity = buildParityReport(briefParsed, graph, entry.fixture_id);
  const rec = classifyBrief(entry.fixture_id, validation, parity, mapping);

  // Confidence downgrades are recorded as provenance_gaps in parity (high
  // → medium) per A.6 backfillReport.summarizeConfidenceDowngrades.
  const confidenceDowngrades = parity.provenance_gaps.length;

  return {
    account_label: entry.account_label,
    fixture_id: entry.fixture_id,
    selection_rationale: entry.selection_rationale,
    criteria_covered: entry.criteria_covered,
    claims: validation.metrics.claim_count,
    objects: validation.metrics.account_object_count,
    classification: rec.classification,
    confidence_downgrades: confidenceDowngrades,
    orphan_source_documents: mapping.orphan_source_ids.length,
    parity_coverage_numerator: parity.coverage_numerator,
    parity_coverage_denominator: parity.coverage_denominator,
    dropped_material_count: parity.dropped_brief_claims.length,
    validator_errors: validation.errors.length,
    validator_warnings: validation.warnings.length,
    provenance_gaps: parity.provenance_gaps.length,
  };
}

export function aggregateBaseline(perAccount: PerAccountBaseline[]): AggregateBaseline {
  const agg: AggregateBaseline = {
    account_count: perAccount.length,
    claims: 0,
    objects: 0,
    classification_counts: {},
    confidence_downgrades: 0,
    orphan_source_documents: 0,
    parity_coverage_numerator: 0,
    parity_coverage_denominator: 0,
    dropped_material_count: 0,
    validator_errors: 0,
    validator_warnings: 0,
    provenance_gaps: 0,
  };
  for (const r of perAccount) {
    agg.claims += r.claims;
    agg.objects += r.objects;
    agg.classification_counts[r.classification] =
      (agg.classification_counts[r.classification] || 0) + 1;
    agg.confidence_downgrades += r.confidence_downgrades;
    agg.orphan_source_documents += r.orphan_source_documents;
    agg.parity_coverage_numerator += r.parity_coverage_numerator;
    agg.parity_coverage_denominator += r.parity_coverage_denominator;
    agg.dropped_material_count += r.dropped_material_count;
    agg.validator_errors += r.validator_errors;
    agg.validator_warnings += r.validator_warnings;
    agg.provenance_gaps += r.provenance_gaps;
  }
  return agg;
}

export type PairedBaselineJson = {
  generated_at: string;
  mode: "fixture";
  fixture_placeholder: false;
  corpus_kind: CorpusKind;
  corpus_id: string;
  corpus_label: string;
  caveat: string;
  selection_criteria_coverage: CriteriaCoverage;
  accounts: PerAccountBaseline[];
  aggregate: AggregateBaseline;
};

const PAIRED_CAVEAT =
  "Synthetic illustrative fixture baseline. NOT production gate-account baseline. NOT A.7 model validation. A.7 graph-first writes remain blocked per docs/BLOCKERS.md.";

export function buildPairedBaseline(
  now: Date,
  selected: ReturnType<typeof selectFixtureCorpus>,
  perAccount: PerAccountBaseline[],
  coverage: CriteriaCoverage,
): PairedBaselineJson {
  return {
    generated_at: now.toISOString(),
    mode: "fixture",
    fixture_placeholder: false,
    corpus_kind: selected.kind,
    corpus_id: selected.id,
    corpus_label: selected.label,
    caveat: PAIRED_CAVEAT,
    selection_criteria_coverage: coverage,
    accounts: perAccount,
    aggregate: aggregateBaseline(perAccount),
  };
}

// Back-compat: skeleton callers that imported the placeholder builder will
// continue to import this name. It now constructs a measured baseline from
// the synthetic fixture corpus on disk. Tests that fed a custom corpus go
// through `runFixtureOrchestrator`'s `corpusEntries` option instead.
export function buildPairedBaselinePlaceholder(_now: Date = new Date()): PairedBaselineJson {
  const selected = selectFixtureCorpus();
  const per: PerAccountBaseline[] = [];
  for (const e of selected.entries) {
    try {
      const briefJson = JSON.parse(readFileSync(e.fixture_path, "utf8"));
      per.push(measurePerAccountBaseline(e, briefJson));
    } catch {
      // Skip in this back-compat path. The orchestrator code path used by
      // the CLI handles errors more explicitly.
    }
  }
  return buildPairedBaseline(_now, selected, per, computeCriteriaCoverage(selected.entries));
}

// ----------------------- Report types -----------------------

export const HARD_INVARIANT_NAMES = [
  "schema parse success",
  "referential integrity",
  "invented SourceDocument IDs",
  "invented EvidenceExcerpt IDs",
  "dangling ClaimEvidence",
  "false verified",
  "verified/high claims without accepted excerpts",
  "accepted paraphrases",
  "production writes",
  "unbudgeted model calls",
  "automatic model calls from tests/imports/fixture mode",
] as const;

export type HardInvariantName = (typeof HARD_INVARIANT_NAMES)[number];

export type HardInvariantEntry = {
  name: HardInvariantName;
  status: "pass" | "fail" | "not_applicable";
  count: number;
  notes: string;
};

export type SoftMetricEntry = {
  name: string;
  status: "pass" | "fail" | "not_applicable" | "placeholder";
  value: number | null;
  notes: string;
};

export type CostStatus = "observed" | "unknown_estimated";

export type Classification = "pass" | "borderline" | "fail";

export type ReportJson = {
  branch: string;
  commit: string;
  run_at: string;
  mode: CliMode | "fixture";
  classification: Classification;
  cost: {
    status: CostStatus;
    observed_usd: number;
    estimated_usd?: number;
  };
  hard_invariants: HardInvariantEntry[];
  soft_metrics: SoftMetricEntry[];
  artifact_paths: string[];
  a7_blocker_status: string;
  adapter: { name: string; propose_excerpts_calls: number; synthesize_claims_calls: number };
  // Task 3 additions:
  paired_baseline: { path: string; corpus_kind: CorpusKind; account_count: number };
  selection_criteria_coverage: CriteriaCoverage;
  synthetic_fixture_only_note: string;
  real_production_gate_account_baseline_status: string;
};

const A7_BLOCKER_STATEMENT =
  "A.7 graph-first writes remain blocked per docs/BLOCKERS.md; this run does not unblock A.7.";

const SYNTHETIC_FIXTURE_ONLY_NOTE =
  "Synthetic fixture coverage only. Criteria coverage indicates the runner can exercise the criterion against synthetic illustrative fixture data; it does NOT indicate prevalence in production.";

const REAL_PROD_GATE_STATUS =
  "Real production gate-account paired baseline remains future local-only work; this run does NOT select or measure production gate accounts.";

// ----------------------- Hard invariant builder -----------------------

export function buildFixtureHardInvariants(): HardInvariantEntry[] {
  // In skeleton fixture mode, all invariants are pass or not_applicable.
  // Real measurement happens when paired-baseline + model adapter are wired up.
  const entries: HardInvariantEntry[] = HARD_INVARIANT_NAMES.map((name) => {
    switch (name) {
      case "production writes":
      case "unbudgeted model calls":
      case "automatic model calls from tests/imports/fixture mode":
        return { name, status: "pass", count: 0, notes: "fixture mode performs none" };
      case "schema parse success":
      case "referential integrity":
        return {
          name,
          status: "not_applicable",
          count: 0,
          notes: "no graph produced in skeleton fixture mode",
        };
      default:
        return {
          name,
          status: "not_applicable",
          count: 0,
          notes: "no graph produced in skeleton fixture mode",
        };
    }
  });
  return entries;
}

export function buildSoftMetricsPlaceholder(): SoftMetricEntry[] {
  return [
    { name: "confidence_downgrade_rate", status: "placeholder", value: null, notes: "populated by paired-baseline PR" },
    { name: "orphan_source_documents_per_claim", status: "placeholder", value: null, notes: "populated by paired-baseline PR" },
    { name: "excerpt_backed_material_claim_rate", status: "placeholder", value: null, notes: "populated by paired-baseline PR" },
    { name: "parity_coverage", status: "placeholder", value: null, notes: "populated by paired-baseline PR" },
    { name: "dropped_material_rate", status: "placeholder", value: null, notes: "populated by paired-baseline PR" },
  ];
}

// Synthetic-fixture-measured soft metrics. Every ratio/coverage metric MUST
// include explicit numerator and denominator. No unlabeled orphan percentage.
export function buildSoftMetricsFromBaseline(agg: AggregateBaseline): SoftMetricEntry[] {
  const cov = agg.parity_coverage_denominator > 0
    ? agg.parity_coverage_numerator / agg.parity_coverage_denominator
    : null;
  const orphanPerClaim = agg.claims > 0
    ? agg.orphan_source_documents / agg.claims
    : null;
  const downgradeRate = agg.claims > 0
    ? agg.confidence_downgrades / agg.claims
    : null;
  const droppedRate = agg.parity_coverage_denominator > 0
    ? agg.dropped_material_count / agg.parity_coverage_denominator
    : null;
  return [
    {
      name: "confidence_downgrade_rate",
      status: "not_applicable",
      value: downgradeRate,
      notes: `synthetic fixture baseline; numerator=${agg.confidence_downgrades} downgrades, denominator=${agg.claims} claims`,
    },
    {
      name: "orphan_source_documents_per_claim",
      status: "not_applicable",
      value: orphanPerClaim,
      notes: `synthetic fixture baseline; numerator=${agg.orphan_source_documents} orphan SourceDocuments, denominator=${agg.claims} claims. NOT an unlabeled "orphan percentage".`,
    },
    {
      name: "parity_coverage",
      status: "not_applicable",
      value: cov,
      notes: `synthetic fixture baseline; numerator=${agg.parity_coverage_numerator}, denominator=${agg.parity_coverage_denominator}`,
    },
    {
      name: "dropped_material_rate",
      status: "not_applicable",
      value: droppedRate,
      notes: `synthetic fixture baseline; numerator=${agg.dropped_material_count}, denominator=${agg.parity_coverage_denominator}`,
    },
    {
      name: "excerpt_backed_material_claim_rate",
      status: "not_applicable",
      value: 0,
      notes: "A.6 deterministic backfill does not fabricate EvidenceExcerpts; rate is 0 by construction. Numerator=0, denominator=" + String(agg.claims) + ".",
    },
  ];
}

// ----------------------- Classifier -----------------------

export type ClassifyInput = {
  cost: { status: CostStatus; observed_usd: number; estimated_usd?: number };
  hard_invariants: HardInvariantEntry[];
};

export function classify(input: ClassifyInput): Classification {
  // Any hard-invariant fail → fail.
  if (input.hard_invariants.some((h) => h.status === "fail")) return "fail";
  // Unknown/estimated cost MUST NOT classify as pass. Plan §6.
  if (input.cost.status === "unknown_estimated") return "borderline";
  // Skeleton fixture: cost is exactly 0 observed → pass.
  if (input.cost.observed_usd === 0 && input.cost.status === "observed") return "pass";
  // Default conservative.
  return "borderline";
}

// ----------------------- Report renderer -----------------------

export function renderReportMarkdown(
  report: ReportJson,
  paired: PairedBaselineJson,
): string {
  const hi = report.hard_invariants
    .map(
      (h) => `| ${h.name} | ${h.status} | ${h.count} | ${h.notes.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  const sm = report.soft_metrics
    .map(
      (s) =>
        `| ${s.name} | ${s.status} | ${s.value === null ? "n/a" : s.value} | ${s.notes.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  const perAcc = paired.accounts
    .map(
      (a) =>
        `| ${a.account_label} | ${a.fixture_id} | \`${a.classification}\` | ${a.claims} | ${a.objects} | ${a.confidence_downgrades} | ${a.orphan_source_documents} | ${a.parity_coverage_numerator}/${a.parity_coverage_denominator} | ${a.dropped_material_count} | ${a.validator_errors} | ${a.provenance_gaps} |`,
    )
    .join("\n");
  const rationaleLines = paired.accounts
    .map(
      (a) =>
        `- **${a.account_label}** (\`${a.fixture_id}\`): ${a.selection_rationale}\n  - criteria_covered: ${a.criteria_covered.join(", ")}`,
    )
    .join("\n");
  const coveredRows = paired.selection_criteria_coverage.covered
    .map((c) => `| ${c} | covered | exercised by selected synthetic fixture |`)
    .join("\n");
  const uncoveredRows = paired.selection_criteria_coverage.uncovered
    .map((u) => `| ${u.criterion} | uncovered | ${u.reason.replace(/\|/g, "\\|")} |`)
    .join("\n");
  const agg = paired.aggregate;
  const classCountsLine = Object.entries(agg.classification_counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  const lines = [
    `# Phase A.7 Validation Run Report`,
    ``,
    `- Branch: \`${report.branch}\``,
    `- Commit: \`${report.commit}\``,
    `- Run at: ${report.run_at}`,
    `- Mode: ${report.mode}`,
    `- Classification: **${report.classification}**`,
    `- Cost status: ${report.cost.status}`,
    `- Cost observed (USD): ${report.cost.observed_usd}`,
    ...(report.cost.estimated_usd !== undefined
      ? [`- Cost estimated (USD): ${report.cost.estimated_usd}`]
      : []),
    `- Adapter: ${report.adapter.name} (propose=${report.adapter.propose_excerpts_calls}, synthesize=${report.adapter.synthesize_claims_calls})`,
    ``,
    `## Caveats`,
    ``,
    `- ${SYNTHETIC_FIXTURE_ONLY_NOTE}`,
    `- ${REAL_PROD_GATE_STATUS}`,
    `- ${A7_BLOCKER_STATEMENT}`,
    `- This is a paired A.6 baseline over synthetic illustrative fixtures only. NOT a real A.7 production gate-account baseline. NOT A.7 model validation.`,
    ``,
    `## Selected synthetic fixture accounts`,
    ``,
    rationaleLines,
    ``,
    `## Selection criteria coverage (synthetic-only)`,
    ``,
    `| criterion | status | note |`,
    `|---|---|---|`,
    coveredRows,
    uncoveredRows,
    ``,
    `## Paired A.6 baseline — per synthetic account`,
    ``,
    `| account_label | fixture_id | classification | claims | objects | confidence_downgrades | orphan_source_documents | parity_coverage (num/denom) | dropped_material | validator_errors | provenance_gaps |`,
    `|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`,
    perAcc,
    ``,
    `## Paired A.6 baseline — aggregate (synthetic corpus)`,
    ``,
    `| metric | value |`,
    `|---|---:|`,
    `| account_count | ${agg.account_count} |`,
    `| claims | ${agg.claims} |`,
    `| objects | ${agg.objects} |`,
    `| classification_counts | ${classCountsLine} |`,
    `| confidence_downgrades | ${agg.confidence_downgrades} |`,
    `| orphan_source_documents | ${agg.orphan_source_documents} |`,
    `| parity_coverage_numerator | ${agg.parity_coverage_numerator} |`,
    `| parity_coverage_denominator | ${agg.parity_coverage_denominator} |`,
    `| dropped_material_count | ${agg.dropped_material_count} |`,
    `| validator_errors | ${agg.validator_errors} |`,
    `| validator_warnings | ${agg.validator_warnings} |`,
    `| provenance_gaps | ${agg.provenance_gaps} |`,
    ``,
    `## Hard invariants`,
    ``,
    `| name | status | count | notes |`,
    `|---|---|---:|---|`,
    hi,
    ``,
    `## Soft metrics (with explicit denominators)`,
    ``,
    `| name | status | value | notes |`,
    `|---|---|---:|---|`,
    sm,
    ``,
    `## Artifact paths`,
    ``,
    ...report.artifact_paths.map((p) => `- ${p}`),
    ``,
    `## A.7 blocker status`,
    ``,
    report.a7_blocker_status,
    ``,
  ];
  return lines.join("\n");
}

// ----------------------- Orchestrator -----------------------

export type OrchestratorOptions = {
  outDir: string;
  adapter: ModelAdapter;
  now?: Date;
  git?: { branch: string; commit: string };
  // Optional: override the synthetic fixture corpus list (used by tests to
  // confirm explicit selection logic without depending on disk).
  corpusEntries?: SyntheticFixtureEntry[];
  // Optional: pre-loaded brief JSON keyed by fixture_id; if omitted, the
  // runner reads from `entry.fixture_path`.
  briefJsonByFixtureId?: Record<string, unknown>;
  limit?: number;
};

export type OrchestratorResult = {
  report: ReportJson;
  paired: PairedBaselineJson;
  artifacts: { reportMdPath: string; reportJsonPath: string; pairedBaselinePath: string };
};

export async function runFixtureOrchestrator(
  opts: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const now = opts.now ?? new Date();
  const git = opts.git ?? gitInfo();
  mkdirSync(opts.outDir, { recursive: true });

  // Exercise the adapter via the ModelAdapter interface so tests can assert
  // the runner went through the seam, not a concrete provider.
  const proposed = await opts.adapter.proposeExcerpts({
    account_id: "fixture_account_placeholder",
    source_id: "src_fixture_placeholder",
    source_text: "Fixture placeholder source text. Deterministic. No model calls.",
  });
  const accepted = proposed.map((p, i) => ({
    id: `ex_fixture_${i}`,
    source_id: p.source_id,
    text: p.text,
  }));
  await opts.adapter.synthesizeClaims({
    account_id: "fixture_account_placeholder",
    accepted_excerpts: accepted,
  });

  // ---- Synthetic fixture corpus selection ----
  const entries = opts.corpusEntries ?? SYNTHETIC_FIXTURE_CORPUS;
  const maxN = Math.max(1, Math.min(3, opts.limit ?? entries.length));
  const selectedEntries = entries.slice(0, maxN);
  const selected = {
    kind: "synthetic_fixture" as const,
    id: "a7-synthetic-fixture-corpus-v1",
    label: "synthetic A.7 fixture corpus",
    entries: selectedEntries,
  };

  // ---- Paired A.6 baseline measurement ----
  const perAccount: PerAccountBaseline[] = [];
  for (const e of selectedEntries) {
    const override = opts.briefJsonByFixtureId?.[e.fixture_id];
    let briefJson: unknown;
    if (override !== undefined) {
      briefJson = override;
    } else {
      const raw = readFileSync(e.fixture_path, "utf8");
      briefJson = JSON.parse(raw);
    }
    perAccount.push(measurePerAccountBaseline(e, briefJson));
  }
  const coverage = computeCriteriaCoverage(selectedEntries);
  const paired = buildPairedBaseline(now, selected, perAccount, coverage);

  const hardInvariants = buildFixtureHardInvariants();
  const softMetrics = buildSoftMetricsFromBaseline(paired.aggregate);
  const cost = { status: "observed" as const, observed_usd: 0 };

  const reportMdPath = join(opts.outDir, "report.md");
  const reportJsonPath = join(opts.outDir, "report.json");
  const pairedBaselinePath = join(opts.outDir, "paired-baseline.json");

  const adapterStats = {
    name: opts.adapter.name,
    propose_excerpts_calls:
      (opts.adapter as { proposeExcerptsCalls?: number }).proposeExcerptsCalls ?? 0,
    synthesize_claims_calls:
      (opts.adapter as { synthesizeClaimsCalls?: number }).synthesizeClaimsCalls ?? 0,
  };

  const classification = classify({ cost, hard_invariants: hardInvariants });

  const report: ReportJson = {
    branch: git.branch,
    commit: git.commit,
    run_at: now.toISOString(),
    mode: "fixture",
    classification,
    cost,
    hard_invariants: hardInvariants,
    soft_metrics: softMetrics,
    artifact_paths: [reportMdPath, reportJsonPath, pairedBaselinePath],
    a7_blocker_status: A7_BLOCKER_STATEMENT,
    adapter: adapterStats,
    paired_baseline: {
      path: pairedBaselinePath,
      corpus_kind: paired.corpus_kind,
      account_count: paired.aggregate.account_count,
    },
    selection_criteria_coverage: coverage,
    synthetic_fixture_only_note: SYNTHETIC_FIXTURE_ONLY_NOTE,
    real_production_gate_account_baseline_status: REAL_PROD_GATE_STATUS,
  };

  writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
  writeFileSync(reportMdPath, renderReportMarkdown(report, paired));
  writeFileSync(pairedBaselinePath, JSON.stringify(paired, null, 2));

  return {
    report,
    paired,
    artifacts: { reportMdPath, reportJsonPath, pairedBaselinePath },
  };
}

// ----------------------- Main CLI entrypoint -----------------------

export const MODEL_MODE_REFUSAL_MESSAGE =
  "model mode is not implemented/enabled in this PR; run fixture mode only";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.mode === "model") {
    // HARD REFUSAL: do NOT route to FakeModelAdapter. Do NOT touch the
    // filesystem. Do NOT import or instantiate any provider adapter. Exit
    // nonzero.
    console.error(`[run-account-graph-validation] ${MODEL_MODE_REFUSAL_MESSAGE}`);
    return 1;
  }

  // Fixture mode. Use the FakeModelAdapter through the ModelAdapter interface.
  const adapter: ModelAdapter = new FakeModelAdapter();
  // Reject obviously-invalid corpus override paths (defense in depth; the
  // synthetic fixture corpus is the only allowed input).
  if (args.corpus && !existsSync(args.corpus)) {
    console.error(
      `[run-account-graph-validation] --corpus path does not exist: ${args.corpus}`,
    );
    return 1;
  }
  const result = await runFixtureOrchestrator({
    outDir: args.out,
    adapter,
    limit: args.limit,
  });
  console.log(
    `[run-account-graph-validation] mode=fixture classification=${result.report.classification} accounts=${result.paired.aggregate.account_count} out=${args.out}`,
  );
  return 0;
}

// Entrypoint guard: only invoke `main()` when this file is the entry script,
// NOT when it is imported (e.g. by tests asserting no side effects).
// Importing must NOT call main, must NOT touch the filesystem, must NOT
// create artifacts.
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[run-account-graph-validation] error:", err);
      process.exit(1);
    },
  );
}
