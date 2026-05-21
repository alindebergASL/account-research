#!/usr/bin/env tsx
// Phase A.7 — model-mode validation runner SKELETON (fixture mode only).
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
// This PR implements Task 2 of
// docs/plans/2026-05-21-phase-a7-model-mode-validation-plan.md only. A.7
// graph-first writes REMAIN BLOCKED per docs/BLOCKERS.md.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

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
};

const A7_BLOCKER_STATEMENT =
  "A.7 graph-first writes remain blocked per docs/BLOCKERS.md; this run does not unblock A.7.";

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

// ----------------------- Paired baseline placeholder -----------------------

export type PairedBaselinePlaceholder = {
  fixture_placeholder: true;
  generated_at: string;
  mode: "fixture";
  accounts: never[];
  metrics: { per_account: never[]; aggregate: { count: 0 } };
  notes: string;
};

export function buildPairedBaselinePlaceholder(now: Date = new Date()): PairedBaselinePlaceholder {
  return {
    fixture_placeholder: true,
    generated_at: now.toISOString(),
    mode: "fixture",
    accounts: [],
    metrics: { per_account: [], aggregate: { count: 0 } },
    notes:
      "Placeholder shape only; populated by a later paired-baseline PR with real A.6 per-account metrics.",
  };
}

// ----------------------- Report renderer -----------------------

export function renderReportMarkdown(report: ReportJson): string {
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
    `## Hard invariants`,
    ``,
    `| name | status | count | notes |`,
    `|---|---|---:|---|`,
    hi,
    ``,
    `## Soft metrics`,
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
};

export type OrchestratorResult = {
  report: ReportJson;
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

  const hardInvariants = buildFixtureHardInvariants();
  const softMetrics = buildSoftMetricsPlaceholder();
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
  };

  const paired = buildPairedBaselinePlaceholder(now);

  writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
  writeFileSync(reportMdPath, renderReportMarkdown(report));
  writeFileSync(pairedBaselinePath, JSON.stringify(paired, null, 2));

  return {
    report,
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
  const result = await runFixtureOrchestrator({ outDir: args.out, adapter });
  console.log(
    `[run-account-graph-validation] mode=fixture classification=${result.report.classification} out=${args.out}`,
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
