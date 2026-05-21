#!/usr/bin/env tsx
// Phase A.7 — validation runner.
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
//   - `--mode model` without `--adapter fake` is REFUSED. It exits nonzero
//     with a clear refusal message and does not instantiate any adapter, does
//     not touch the filesystem, does not call the fake adapter.
//   - `--mode model --adapter fake` runs the model-adapter *boundary* with a
//     fully deterministic local fake adapter. No network, no provider SDKs,
//     no env reads. Cost is observed $0. A.7 graph-first writes remain
//     BLOCKED per docs/BLOCKERS.md regardless of this run.
//
// This PR implements Task 4 of
// docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md (model-mode
// adapter boundary without graph-first writes). A.7 graph-first writes
// REMAIN BLOCKED per docs/BLOCKERS.md.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute, sep, relative } from "node:path";

import { fromBriefJson } from "../lib/accountGraph/fromBriefJson";
import { buildParityReport } from "../lib/accountGraph/briefParity";
import { validateAccountGraph } from "../lib/accountGraph/validation";
import { classifyBrief } from "../lib/accountGraph/backfillReport";
import { Brief as BriefSchema } from "../lib/schema";
import {
  buildBudgetReportBlock,
  budgetExceeded,
  createBudgetState,
  validateBudgetConfig,
  type BudgetReportBlock,
} from "../lib/accountGraph/validationPipeline/budget";
import { runAccountThroughAdapter } from "../lib/accountGraph/validationPipeline/systemSteps";
import { FakeDeterministicAdapter } from "../lib/accountGraph/validationPipeline/adapters/fakeDeterministic";
import type {
  HardInvariantKey,
  ModelAdapter as PipelineModelAdapter,
  PerAccountAdapterRun,
} from "../lib/accountGraph/validationPipeline/types";
import type { AccountHierarchyReference, SourceDocument } from "../lib/accountGraph/schema";

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
export type CliAdapter = "fake" | "real" | undefined;

export type CliArgs = {
  mode: CliMode;
  maxCostUsd: number;
  corpus?: string;
  out: string;
  limit?: number;
  allowCostOver25: boolean;
  /** Task 4: optional adapter selector for `--mode model`. */
  adapter?: string;
  /** Task 4: explicit override for --max-cost > 25. */
  allowHighCost: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    mode: "fixture",
    maxCostUsd: 10,
    allowCostOver25: false,
    allowHighCost: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i] as CliMode;
    else if (a === "--max-cost-usd") args.maxCostUsd = Number(argv[++i]);
    else if (a === "--max-cost") args.maxCostUsd = Number(argv[++i]);
    else if (a === "--corpus") args.corpus = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--allow-cost-over-25") args.allowCostOver25 = true;
    else if (a === "--allow-high-cost") args.allowHighCost = true;
    else if (a === "--adapter") args.adapter = argv[++i];
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

// ----------------------- Local-only production-derived corpus -----------------------
//
// Phase A.7 Task 5: provide a SAFE, LOCAL-ONLY path for the operator to run
// the deterministic A.6 paired baseline against the real 3 A.7 gate accounts,
// sourced from a production-backup-derived corpus on their local machine.
//
// HARD SAFETY GUARANTEES (enforced below):
//   - No network. No provider SDK. No env-var reads.
//   - The corpus file must NOT live inside the repo working tree (so an
//     operator cannot accidentally `git add` it).
//   - The output directory must NOT resolve to a path inside the repo
//     working tree (so generated artifacts cannot accidentally be staged).
//   - Input is parsed as JSON (single Brief object) or JSONL (one Brief per
//     line). Each entry is validated against the Brief Zod schema; malformed
//     entries are classified as `skipped_malformed_json` or
//     `skipped_unsupported_schema_variant` and do NOT crash the run.
//   - The committed `paired-baseline.json` mirrors the synthetic shape but
//     uses `corpus_kind: "local_production_backup"`. The artifact lives in an
//     ignored directory; the committed code never carries production-derived
//     brief content.

export const REPO_ROOT = resolve(__dirname, "..", "..");

const REPO_TRACKED_TOP_LEVEL_DIRS = ["docs", "scripts", "tests", "web"];

/**
 * Return true if `p` resolves to a path inside the repo working tree's
 * tracked top-level directories. Paths under `out/` or outside the repo are
 * considered safe.
 */
export function isInsideRepoTrackedTree(p: string): boolean {
  const abs = resolve(p);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false; // outside repo
  if (rel === "") return true; // the repo root itself is tracked
  const top = rel.split(sep)[0];
  return REPO_TRACKED_TOP_LEVEL_DIRS.includes(top);
}

export const LOCAL_CORPUS_INSIDE_REPO_ERROR =
  "refusing to read --corpus from inside the repo working tree's tracked directories; place the corpus under /tmp or an operator-controlled directory outside the repo";
export const LOCAL_OUT_INSIDE_REPO_ERROR =
  "refusing to write --out to a path inside the repo working tree's tracked directories; pass an --out under /tmp, out/local-prod-baseline/, or another ignored location";

export type LocalCorpusKind = "local_production_backup";

export type LocalCorpusEntryClassification =
  | "ok"
  | "skipped_malformed_json"
  | "skipped_unsupported_schema_variant";

export type LocalCorpusEntryRecord = {
  source_index: number;
  source_line?: number; // for JSONL
  classification: LocalCorpusEntryClassification;
  error?: string;
  account_label?: string;
  fixture_id?: string; // synthesized stable id for the entry
  selection_rationale: string;
  criteria_covered: string[];
};

export type LocalCorpusReadResult = {
  entries_total: number;
  entries_ok: LocalCorpusEntryRecord[];
  entries_skipped: LocalCorpusEntryRecord[];
  briefs_by_fixture_id: Record<string, unknown>;
  format: "json" | "jsonl";
};

export const LOCAL_DEFAULT_RATIONALE =
  "operator-supplied local production-backup-derived brief; rationale not committed (artifact stays in ignored local path)";

/**
 * Parse a local corpus file (JSON or JSONL). Each line/entry is validated
 * against the Brief Zod schema; malformed entries are classified rather than
 * throwing. The function never opens a database, never makes network calls,
 * never reads env vars.
 */
export function readLocalCorpus(corpusPath: string): LocalCorpusReadResult {
  const raw = readFileSync(corpusPath, "utf8");
  const trimmed = raw.trim();
  const isJsonl = corpusPath.toLowerCase().endsWith(".jsonl") ||
    (trimmed.startsWith("{") && trimmed.includes("\n{"));
  const briefsByFixtureId: Record<string, unknown> = {};
  const ok: LocalCorpusEntryRecord[] = [];
  const skipped: LocalCorpusEntryRecord[] = [];

  function classifyOne(
    candidate: unknown,
    sourceIndex: number,
    sourceLine: number | undefined,
  ): LocalCorpusEntryRecord {
    const fixtureId = `local_prod_${sourceIndex}`;
    const outcome = fromBriefJson({ brief_id: fixtureId, brief_json: candidate });
    if (outcome.status === "ok") {
      const briefName =
        candidate && typeof candidate === "object" &&
        typeof (candidate as { account_name?: unknown }).account_name === "string"
          ? ((candidate as { account_name: string }).account_name)
          : `local_account_${sourceIndex}`;
      briefsByFixtureId[fixtureId] = candidate;
      return {
        source_index: sourceIndex,
        source_line: sourceLine,
        classification: "ok",
        account_label: briefName,
        fixture_id: fixtureId,
        selection_rationale: LOCAL_DEFAULT_RATIONALE,
        criteria_covered: [],
      };
    }
    return {
      source_index: sourceIndex,
      source_line: sourceLine,
      classification: outcome.status,
      error: outcome.error,
      selection_rationale: LOCAL_DEFAULT_RATIONALE,
      criteria_covered: [],
    };
  }

  if (isJsonl) {
    const lines = raw.split(/\r?\n/);
    let idx = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line.trim()) continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch (err) {
        skipped.push({
          source_index: idx,
          source_line: li + 1,
          classification: "skipped_malformed_json",
          error: err instanceof Error ? err.message : String(err),
          selection_rationale: LOCAL_DEFAULT_RATIONALE,
          criteria_covered: [],
        });
        idx += 1;
        continue;
      }
      const rec = classifyOne(candidate, idx, li + 1);
      if (rec.classification === "ok") ok.push(rec);
      else skipped.push(rec);
      idx += 1;
    }
    return {
      entries_total: idx,
      entries_ok: ok,
      entries_skipped: skipped,
      briefs_by_fixture_id: briefsByFixtureId,
      format: "jsonl",
    };
  }

  // Single JSON: object → 1 entry; array → many.
  let candidates: unknown[];
  try {
    const parsed = JSON.parse(raw);
    candidates = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return {
      entries_total: 1,
      entries_ok: [],
      entries_skipped: [
        {
          source_index: 0,
          classification: "skipped_malformed_json",
          error: err instanceof Error ? err.message : String(err),
          selection_rationale: LOCAL_DEFAULT_RATIONALE,
          criteria_covered: [],
        },
      ],
      briefs_by_fixture_id: {},
      format: "json",
    };
  }
  for (let i = 0; i < candidates.length; i++) {
    const rec = classifyOne(candidates[i], i, undefined);
    if (rec.classification === "ok") ok.push(rec);
    else skipped.push(rec);
  }
  return {
    entries_total: candidates.length,
    entries_ok: ok,
    entries_skipped: skipped,
    briefs_by_fixture_id: briefsByFixtureId,
    format: "json",
  };
}

export type LocalBaselineSelectionRecord = {
  account_label: string;
  account_id: string;
  fixture_id: string;
  selection_rationale: string;
  criteria_covered: string[];
  local_artifact: true;
  committed: false;
  caveat: string;
};

export type LocalBaselineSelectionJson = {
  generated_at: string;
  corpus_kind: LocalCorpusKind;
  corpus_path: string;
  format: "json" | "jsonl";
  entries_total: number;
  entries_ok: number;
  entries_skipped: number;
  skipped: LocalCorpusEntryRecord[];
  selections: LocalBaselineSelectionRecord[];
  local_artifact: true;
  committed: false;
  caveat: string;
};

export const LOCAL_SELECTION_CAVEAT =
  "local production-derived artifact, ignored, not committed";

export const LOCAL_PAIRED_CAVEAT =
  "Local production-backup-derived paired baseline. Artifact lives in an ignored output directory; not committed. NOT A.7 model validation. A.7 graph-first writes remain blocked per docs/BLOCKERS.md.";

export type LocalPairedBaselineJson = {
  generated_at: string;
  mode: "fixture";
  fixture_placeholder: false;
  corpus_kind: LocalCorpusKind;
  corpus_id: string;
  corpus_label: string;
  caveat: string;
  selection_criteria_coverage: CriteriaCoverage;
  accounts: PerAccountBaseline[];
  aggregate: AggregateBaseline;
};

export type LocalCorpusOrchestratorOptions = {
  corpusPath: string;
  outDir: string;
  adapter: ModelAdapter;
  now?: Date;
  git?: { branch: string; commit: string };
  limit?: number;
};

export type LocalCorpusOrchestratorResult = {
  paired: LocalPairedBaselineJson;
  selection: LocalBaselineSelectionJson;
  artifacts: {
    reportJsonPath: string;
    pairedBaselinePath: string;
    selectionPath: string;
  };
};

export async function runLocalCorpusOrchestrator(
  opts: LocalCorpusOrchestratorOptions,
): Promise<LocalCorpusOrchestratorResult> {
  // Guardrails: refuse to read corpus from inside repo tracked tree; refuse
  // to write artifacts to a path inside the repo tracked tree.
  const corpusAbs = resolve(opts.corpusPath);
  if (isInsideRepoTrackedTree(corpusAbs)) {
    throw new Error(LOCAL_CORPUS_INSIDE_REPO_ERROR);
  }
  const outAbs = resolve(opts.outDir);
  if (isInsideRepoTrackedTree(outAbs)) {
    throw new Error(LOCAL_OUT_INSIDE_REPO_ERROR);
  }
  if (!existsSync(corpusAbs)) {
    throw new Error(`--corpus path does not exist: ${corpusAbs}`);
  }

  const now = opts.now ?? new Date();
  const git = opts.git ?? gitInfo();
  mkdirSync(outAbs, { recursive: true });

  // Exercise the adapter (deterministic, $0) to keep the seam wired.
  await opts.adapter.proposeExcerpts({
    account_id: "local_corpus_placeholder",
    source_id: "src_local_corpus_placeholder",
    source_text: "Local-corpus orchestrator placeholder source text. Deterministic. No model calls.",
  });
  await opts.adapter.synthesizeClaims({
    account_id: "local_corpus_placeholder",
    accepted_excerpts: [],
  });

  const read = readLocalCorpus(corpusAbs);
  const maxN = Math.max(1, opts.limit ?? read.entries_ok.length);
  const selectedOk = read.entries_ok.slice(0, maxN);

  // Build synthetic entries that the existing paired-baseline measurement
  // expects. fixture_path is unused because we supply briefJsonByFixtureId.
  const corpusEntries: SyntheticFixtureEntry[] = selectedOk.map((e) => ({
    account_label: e.account_label ?? `local_account_${e.source_index}`,
    fixture_id: e.fixture_id ?? `local_prod_${e.source_index}`,
    fixture_path: "<unused: brief supplied in-memory>",
    selection_rationale: e.selection_rationale,
    criteria_covered: e.criteria_covered,
  }));

  const perAccount: PerAccountBaseline[] = [];
  for (const e of corpusEntries) {
    const briefJson = read.briefs_by_fixture_id[e.fixture_id];
    perAccount.push(measurePerAccountBaseline(e, briefJson));
  }
  const coverage = computeCriteriaCoverage(corpusEntries);

  const paired: LocalPairedBaselineJson = {
    generated_at: now.toISOString(),
    mode: "fixture",
    fixture_placeholder: false,
    corpus_kind: "local_production_backup",
    corpus_id: `local-prod-${createHash("sha256").update(corpusAbs).digest("hex").slice(0, 16)}`,
    corpus_label: "local production-backup-derived corpus",
    caveat: LOCAL_PAIRED_CAVEAT,
    selection_criteria_coverage: coverage,
    accounts: perAccount,
    aggregate: aggregateBaseline(perAccount),
  };

  const selections: LocalBaselineSelectionRecord[] = selectedOk.map((e) => ({
    account_label: e.account_label ?? `local_account_${e.source_index}`,
    account_id: e.fixture_id ?? `local_prod_${e.source_index}`,
    fixture_id: e.fixture_id ?? `local_prod_${e.source_index}`,
    selection_rationale: e.selection_rationale,
    criteria_covered: e.criteria_covered,
    local_artifact: true,
    committed: false,
    caveat: LOCAL_SELECTION_CAVEAT,
  }));

  const selection: LocalBaselineSelectionJson = {
    generated_at: now.toISOString(),
    corpus_kind: "local_production_backup",
    corpus_path: corpusAbs,
    format: read.format,
    entries_total: read.entries_total,
    entries_ok: read.entries_ok.length,
    entries_skipped: read.entries_skipped.length,
    skipped: read.entries_skipped,
    selections,
    local_artifact: true,
    committed: false,
    caveat: LOCAL_SELECTION_CAVEAT,
  };

  const pairedBaselinePath = join(outAbs, "paired-baseline.json");
  const selectionPath = join(outAbs, "local-baseline-selection.json");
  const reportJsonPath = join(outAbs, "report.json");

  const reportJson = {
    branch: git.branch,
    commit: git.commit,
    run_at: now.toISOString(),
    mode: "fixture" as const,
    corpus_kind: "local_production_backup" as LocalCorpusKind,
    classification: "pass" as const,
    cost: { status: "observed" as const, observed_usd: 0 },
    a7_blocker_status: A7_BLOCKER_STATEMENT,
    local_artifact: true,
    committed: false,
    caveat: LOCAL_PAIRED_CAVEAT,
    paired_baseline: {
      path: pairedBaselinePath,
      corpus_kind: "local_production_backup" as LocalCorpusKind,
      account_count: paired.aggregate.account_count,
    },
    selection: {
      path: selectionPath,
      entries_total: read.entries_total,
      entries_ok: read.entries_ok.length,
      entries_skipped: read.entries_skipped.length,
    },
    adapter: { name: opts.adapter.name },
  };

  writeFileSync(pairedBaselinePath, JSON.stringify(paired, null, 2));
  writeFileSync(selectionPath, JSON.stringify(selection, null, 2));
  writeFileSync(reportJsonPath, JSON.stringify(reportJson, null, 2));

  return {
    paired,
    selection,
    artifacts: { reportJsonPath, pairedBaselinePath, selectionPath },
  };
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

// ----------------------- Model-mode (fake adapter) orchestrator -----------------------
//
// Task 4: run the model-adapter *boundary* against synthetic A.7 fixtures
// using the local fake deterministic adapter. No provider SDKs, no env
// reads, no network. Cost is observed $0.

export type ModelModeReportJson = {
  branch: string;
  commit: string;
  run_at: string;
  mode: "model";
  adapter_selected: "fake";
  classification: "pass" | "borderline" | "fail" | "budget_exceeded";
  cost: BudgetReportBlock;
  hard_invariants: { key: HardInvariantKey; status: "pass" | "fail"; count: number; details: string[] }[];
  per_account: PerAccountAdapterRun[];
  artifact_paths: string[];
  a7_blocker_status: string;
  non_production_notice: string;
};

const NON_PRODUCTION_NOTICE =
  "MODEL ADAPTER IS NON-PRODUCTION FAKE DETERMINISTIC. NO PROVIDER SDKs IMPORTED. NO ENV READS. NO NETWORK. A.7 graph-first writes remain BLOCKED per docs/BLOCKERS.md.";

const ALL_HARD_INVARIANT_KEYS: HardInvariantKey[] = [
  "schema_parse",
  "referential_integrity",
  "invented_source_document_ids",
  "invented_evidence_excerpt_ids",
  "dangling_claim_evidence",
  "false_verified",
  "verified_high_claims_without_accepted_excerpts",
  "accepted_paraphrases",
  "production_writes",
  "unbudgeted_model_calls",
  "automatic_model_calls_from_tests_imports_fixture_mode",
];

/**
 * Build synthetic SourceDocuments per fixture account. These are constructed
 * from the synthetic brief JSON's snapshot/signals; they never reference real
 * URLs or fetched data. Content text is large enough for excerpt verification
 * (>= 20 chars per excerpt) and is fully deterministic.
 */
export function buildSyntheticSourceDocumentsForFixture(
  fixtureId: string,
  briefJson: unknown,
  now: Date,
): { sources: SourceDocument[]; accountRef: AccountHierarchyReference } {
  const b = (briefJson as Record<string, unknown>) ?? {};
  const accountName =
    typeof b.account_name === "string" ? b.account_name : fixtureId;
  const snapshot = typeof b.snapshot === "string" ? b.snapshot : "synthetic snapshot text for fixture-only validation";
  const prioritySummary =
    typeof b.priority_summary === "string" ? b.priority_summary : "synthetic priority summary";
  const accountRef: AccountHierarchyReference = {
    account_id: fixtureId,
    account_name: accountName,
    scope: "enterprise",
  };
  // Build 1-3 deterministic source bodies. Each is composed entirely of
  // synthetic fixture text already present in the brief JSON (which is in
  // the repo and contains no real organization references).
  const bodies = [
    `Synthetic source body 1 for ${accountName}. ${snapshot} ${prioritySummary}`,
    `Synthetic source body 2 for ${accountName}. ${snapshot}`,
  ].map((s) => s.padEnd(120, " ").slice(0, 4000));
  const sources: SourceDocument[] = bodies.map((text, i) => ({
    id: `src_${fixtureId}_${i}`,
    kind: "public_web",
    title: `Synthetic fixture source ${i + 1} for ${fixtureId}`,
    url: null,
    publisher: null,
    captured_at: now.toISOString(),
    published_at: null,
    fetched_at: null,
    content_sha256: createHash("sha256").update(text).digest("hex"),
    content_text: text,
    allowed: true,
    allowlist_rule: "synthetic_fixture",
    pii_risk: "none",
    retention: "store_full_text_lab",
    metadata: { synthetic: true, fixture_id: fixtureId },
  }));
  return { sources, accountRef };
}

export type ModelModeOrchestratorOptions = {
  outDir: string;
  adapter: PipelineModelAdapter;
  maxCostUsd: number;
  allowHighCost: boolean;
  now?: Date;
  git?: { branch: string; commit: string };
  corpusEntries?: SyntheticFixtureEntry[];
  briefJsonByFixtureId?: Record<string, unknown>;
  limit?: number;
};

export type ModelModeOrchestratorResult = {
  report: ModelModeReportJson;
  artifacts: { reportMdPath: string; reportJsonPath: string; pairedBaselinePath: string };
};

export async function runModelModeOrchestrator(
  opts: ModelModeOrchestratorOptions,
): Promise<ModelModeOrchestratorResult> {
  const now = opts.now ?? new Date();
  const git = opts.git ?? gitInfo();
  mkdirSync(opts.outDir, { recursive: true });

  const budget = createBudgetState({
    max_cost_usd: opts.maxCostUsd,
    allow_high_cost: opts.allowHighCost,
  });

  const entries = opts.corpusEntries ?? SYNTHETIC_FIXTURE_CORPUS;
  const maxN = Math.max(1, Math.min(3, opts.limit ?? entries.length));
  const selectedEntries = entries.slice(0, maxN);

  const perAccount: PerAccountAdapterRun[] = [];
  const violationsByKey = new Map<HardInvariantKey, string[]>();

  // Also compute paired-baseline (system-owned, no adapter). Reused for the
  // paired-baseline.json artifact so model-mode runs produce all three
  // artifacts the plan requires.
  const perAccountBaseline: PerAccountBaseline[] = [];

  for (const entry of selectedEntries) {
    const override = opts.briefJsonByFixtureId?.[entry.fixture_id];
    let briefJson: unknown;
    if (override !== undefined) {
      briefJson = override;
    } else {
      const raw = readFileSync(entry.fixture_path, "utf8");
      briefJson = JSON.parse(raw);
    }
    perAccountBaseline.push(measurePerAccountBaseline(entry, briefJson));

    const { sources, accountRef } = buildSyntheticSourceDocumentsForFixture(
      entry.fixture_id,
      briefJson,
      now,
    );

    const result = await runAccountThroughAdapter(
      {
        account_id: entry.fixture_id,
        account_ref: accountRef,
        source_documents: sources,
      },
      opts.adapter,
      budget,
      now,
    );
    perAccount.push(result.per_account);
    for (const v of result.per_account.hard_invariant_violations) {
      const list = violationsByKey.get(v.key) ?? [];
      list.push(v.detail);
      violationsByKey.set(v.key, list);
    }
    if (result.budget_stopped) {
      // Mark remaining accounts as skipped_budget_exceeded.
      const idx = selectedEntries.indexOf(entry);
      for (let j = idx + 1; j < selectedEntries.length; j++) {
        perAccount.push({
          account_id: selectedEntries[j].fixture_id,
          classification: "skipped_budget_exceeded",
          hard_invariant_violations: [],
          excerpt_proposals: 0,
          accepted_excerpts: 0,
          claim_proposals: 0,
          object_proposals: 0,
          observed_usd: 0,
          notes: ["budget exhausted before this account started"],
        });
      }
      break;
    }
  }

  const cost = buildBudgetReportBlock(budget);

  // Hard invariants table for the model-mode report.
  const hardInvariants = ALL_HARD_INVARIANT_KEYS.map((key) => {
    const details = violationsByKey.get(key) ?? [];
    return {
      key,
      status: (details.length > 0 ? "fail" : "pass") as "pass" | "fail",
      count: details.length,
      details,
    };
  });

  // Classification.
  let classification: ModelModeReportJson["classification"] = "pass";
  if (budgetExceeded(budget)) classification = "budget_exceeded";
  else if (hardInvariants.some((h) => h.status === "fail")) classification = "fail";
  else if (cost.status === "unknown_estimated") classification = "borderline";
  else if (perAccount.some((a) => a.classification === "budget_exceeded" || a.classification === "skipped_budget_exceeded")) {
    classification = "budget_exceeded";
  } else classification = "pass";

  const reportJsonPath = join(opts.outDir, "report.json");
  const reportMdPath = join(opts.outDir, "report.md");
  const pairedBaselinePath = join(opts.outDir, "paired-baseline.json");

  const report: ModelModeReportJson = {
    branch: git.branch,
    commit: git.commit,
    run_at: now.toISOString(),
    mode: "model",
    adapter_selected: "fake",
    classification,
    cost,
    hard_invariants: hardInvariants,
    per_account: perAccount,
    artifact_paths: [reportMdPath, reportJsonPath, pairedBaselinePath],
    a7_blocker_status: A7_BLOCKER_STATEMENT,
    non_production_notice: NON_PRODUCTION_NOTICE,
  };

  // Paired baseline artifact (reuse Task 3 builder for selected accounts).
  const selected = {
    kind: "synthetic_fixture" as const,
    id: "a7-synthetic-fixture-corpus-v1",
    label: "synthetic A.7 fixture corpus",
    entries: selectedEntries,
  };
  const paired = buildPairedBaseline(
    now,
    selected,
    perAccountBaseline,
    computeCriteriaCoverage(selectedEntries),
  );

  writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
  writeFileSync(reportMdPath, renderModelModeReportMarkdown(report));
  writeFileSync(pairedBaselinePath, JSON.stringify(paired, null, 2));

  return {
    report,
    artifacts: { reportMdPath, reportJsonPath, pairedBaselinePath },
  };
}

function renderModelModeReportMarkdown(r: ModelModeReportJson): string {
  const hi = r.hard_invariants
    .map((h) => `| ${h.key} | ${h.status} | ${h.count} |`)
    .join("\n");
  const acct = r.per_account
    .map(
      (a) =>
        `| ${a.account_id} | \`${a.classification}\` | ${a.excerpt_proposals} | ${a.accepted_excerpts} | ${a.claim_proposals} | ${a.object_proposals} | ${a.observed_usd} |`,
    )
    .join("\n");
  const adapterRows = r.cost.by_adapter
    .map(
      (b) =>
        `| ${b.adapter_name} | ${b.provider} | ${b.model} | ${b.calls} | ${b.input_tokens} | ${b.output_tokens} | ${b.observed_usd} |`,
    )
    .join("\n");
  return [
    `# Phase A.7 Model-Mode (Fake Adapter) Validation Run`,
    ``,
    `- Branch: \`${r.branch}\``,
    `- Commit: \`${r.commit}\``,
    `- Run at: ${r.run_at}`,
    `- Mode: ${r.mode}`,
    `- Adapter: ${r.adapter_selected}`,
    `- Classification: **${r.classification}**`,
    ``,
    `## Non-production notice`,
    ``,
    `- ${r.non_production_notice}`,
    `- ${r.a7_blocker_status}`,
    ``,
    `## Cost`,
    ``,
    `- status: ${r.cost.status}`,
    `- observed_usd: ${r.cost.observed_usd}`,
    `- estimated_usd: ${r.cost.estimated_usd ?? "null"}`,
    `- max_cost_usd: ${r.cost.max_cost_usd}`,
    `- allow_high_cost: ${r.cost.allow_high_cost}`,
    ``,
    `| adapter_name | provider | model | calls | input_tokens | output_tokens | observed_usd |`,
    `|---|---|---|---:|---:|---:|---:|`,
    adapterRows,
    ``,
    `## Hard invariants`,
    ``,
    `| key | status | count |`,
    `|---|---|---:|`,
    hi,
    ``,
    `## Per-account`,
    ``,
    `| account_id | classification | excerpt_proposals | accepted_excerpts | claim_proposals | object_proposals | observed_usd |`,
    `|---|---|---:|---:|---:|---:|---:|`,
    acct,
    ``,
  ].join("\n");
}

// ----------------------- Main CLI entrypoint -----------------------

export const MODEL_MODE_REFUSAL_MESSAGE =
  "model mode is not implemented/enabled in this PR; run fixture mode only";

export const MODEL_MODE_REAL_ADAPTER_REFUSAL =
  "model mode requires --adapter fake in this PR; real model adapter is not enabled and A.7 remains BLOCKED per docs/BLOCKERS.md";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.mode === "model") {
    // Budget config validation BEFORE any adapter is touched. Plan §6: any
    // --max-cost > 25 requires explicit override.
    const budgetErr = validateBudgetConfig({
      max_cost_usd: args.maxCostUsd,
      allow_high_cost: args.allowHighCost,
    });
    if (budgetErr) {
      console.error(`[run-account-graph-validation] ${budgetErr}`);
      return 1;
    }

    if (args.adapter !== "fake") {
      // HARD REFUSAL: do NOT route to any adapter. Do NOT touch the
      // filesystem. Do NOT import or instantiate any provider adapter.
      // Print both the legacy and the explicit refusal messages so any
      // automation that grepped the legacy one still matches.
      console.error(`[run-account-graph-validation] ${MODEL_MODE_REFUSAL_MESSAGE}`);
      console.error(`[run-account-graph-validation] ${MODEL_MODE_REAL_ADAPTER_REFUSAL}`);
      return 1;
    }

    // Model mode with explicit fake adapter. Print non-production banner.
    console.log(
      `[run-account-graph-validation] mode=model adapter=fake (NON-PRODUCTION) — ${NON_PRODUCTION_NOTICE}`,
    );
    const fake = new FakeDeterministicAdapter();
    const result = await runModelModeOrchestrator({
      outDir: args.out,
      adapter: fake,
      maxCostUsd: args.maxCostUsd,
      allowHighCost: args.allowHighCost,
      limit: args.limit,
    });
    console.log(
      `[run-account-graph-validation] mode=model adapter=fake classification=${result.report.classification} cost_usd=${result.report.cost.observed_usd} out=${args.out}`,
    );
    return result.report.classification === "fail" ? 2 : 0;
  }

  // Fixture mode. Use the FakeModelAdapter through the local ModelAdapter interface.
  const adapter: ModelAdapter = new FakeModelAdapter();
  // Reject obviously-invalid corpus override paths (defense in depth; the
  // synthetic fixture corpus is the only allowed input).
  if (args.corpus && !existsSync(args.corpus)) {
    console.error(
      `[run-account-graph-validation] --corpus path does not exist: ${args.corpus}`,
    );
    return 1;
  }

  // Phase A.7 Task 5: when `--corpus` is supplied, route to the local-only
  // production-backup-derived path. Both the corpus and out directory must
  // live OUTSIDE the repo working tree's tracked directories so the operator
  // cannot accidentally `git add` production-derived content.
  if (args.corpus) {
    if (isInsideRepoTrackedTree(args.corpus)) {
      console.error(`[run-account-graph-validation] ${LOCAL_CORPUS_INSIDE_REPO_ERROR}`);
      return 1;
    }
    if (isInsideRepoTrackedTree(args.out)) {
      console.error(`[run-account-graph-validation] ${LOCAL_OUT_INSIDE_REPO_ERROR}`);
      return 1;
    }
    try {
      const result = await runLocalCorpusOrchestrator({
        corpusPath: args.corpus,
        outDir: args.out,
        adapter,
        limit: args.limit,
      });
      console.log(
        `[run-account-graph-validation] mode=fixture corpus_kind=local_production_backup ok=${result.selection.entries_ok} skipped=${result.selection.entries_skipped} out=${args.out}`,
      );
      return 0;
    } catch (err) {
      console.error(
        `[run-account-graph-validation] local-corpus run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  // Default fixture mode (synthetic fixture corpus path, unchanged from PR #44).
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
