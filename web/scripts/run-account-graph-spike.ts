#!/usr/bin/env tsx
// Phase A.5 — Account graph spike runner.
// Default --mode fixture is deterministic and makes NO network/model calls.
// --mode model is reserved for future explicit final validation only.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { runSpikeA, runSpikeB } from "../lib/accountGraph/spikePipeline";
import {
  computeCascadeImpact,
  validateAccountGraph,
  type GraphCorrectionEvent,
} from "../lib/accountGraph/validation";
import {
  classifySpikeA,
  classifySpikeB,
  renderSpikeReport,
} from "../lib/accountGraph/report";

type CliArgs = {
  fixture: "nueva";
  mode: "fixture" | "model";
  maxCostUsd: number;
  outPath: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { fixture: "nueva", mode: "fixture", maxCostUsd: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = argv[++i] as CliArgs["fixture"];
    else if (a === "--mode") args.mode = argv[++i] as CliArgs["mode"];
    else if (a === "--max-cost-usd") args.maxCostUsd = Number(argv[++i]);
    else if (a === "--out") args.outPath = argv[++i];
  }
  if (args.fixture !== "nueva") {
    throw new Error(`Unsupported fixture: ${args.fixture}. Only "nueva" supported in A.5.`);
  }
  if (args.mode !== "fixture" && args.mode !== "model") {
    throw new Error(`Unsupported mode: ${args.mode}.`);
  }
  if (!Number.isFinite(args.maxCostUsd!) || args.maxCostUsd! <= 0) {
    throw new Error(`--max-cost-usd must be a positive number.`);
  }
  if (args.maxCostUsd! > 25) {
    throw new Error(`--max-cost-usd=${args.maxCostUsd} exceeds hard ceiling 25. Requires explicit approval.`);
  }
  args.outPath ??= resolve(__dirname, "..", "..", "docs", "spikes", "phase-a5-account-graph-results.md");
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  if (args.mode === "model") {
    // Hard fail-safe: this task does NOT enable model mode. Future sessions
    // may wire a real client; for now we refuse to make network calls.
    console.error(
      "[run-account-graph-spike] --mode model is not enabled in this build. " +
        "Phase A.5 task explicitly runs only fixture mode. Refusing to proceed.",
    );
    process.exit(2);
  }

  // Fixture mode: deterministic, no network.
  const spikeB = runSpikeB();
  const spikeA = runSpikeA(undefined, spikeB);
  const validation = validateAccountGraph(spikeA.graph);

  // Cascade example: mark the network-refresh claim wrong to show fanout.
  const cascadeEvent: GraphCorrectionEvent = {
    type: "claim_marked_wrong",
    claim_id: "claim_initiative_network_refresh",
  };
  const cascade = computeCascadeImpact(spikeA.graph, cascadeEvent);

  const outcomeA = classifySpikeA(validation, /* budgetExceeded */ false);
  const outcomeB = classifySpikeB(spikeB, /* budgetExceeded */ false);

  const runtimeMs = Date.now() - t0;
  const { branch, commit } = gitInfo();

  const report = renderSpikeReport({
    branch,
    commit,
    runAt: new Date().toISOString(),
    mode: args.mode,
    spikeA: { result: spikeA, validation, outcome: outcomeA },
    spikeB: { result: spikeB, outcome: outcomeB },
    cascadeExample: cascade,
    runtimeMs,
  });

  const outPath = resolve(args.outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, "utf8");

  // Brief stdout summary
  console.log(`Spike A: ${outcomeA.classification}`);
  console.log(`Spike B: ${outcomeB.classification}`);
  console.log(
    `Metrics: excerpts=${validation.metrics.excerpt_count}, valid=${(validation.metrics.valid_excerpt_ratio * 100).toFixed(1)}%, ` +
      `claims=${validation.metrics.claim_count}, objects=${validation.metrics.account_object_count}, ` +
      `errors=${validation.errors.length}, warnings=${validation.warnings.length}`,
  );
  console.log(`Report written: ${outPath}`);

  // Hard exit code: fail-mode classifications return non-zero so CI can react.
  if (outcomeA.classification === "fail" || outcomeB.classification === "fail") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[run-account-graph-spike] error:", err);
  process.exit(1);
});
