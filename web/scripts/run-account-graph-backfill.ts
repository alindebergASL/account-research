#!/usr/bin/env tsx
// Phase A.6 — brief_json → account graph backfill runner.
//
// Read-only on saved brief_json. No production writes. No model API calls.
// No web fetches. Default --dry-run is true. Output is markdown + JSON
// artifacts under --out (default `out/account-graph-backfill/<timestamp>/`).
// See docs/plans/2026-05-21-phase-a6-brief-json-graph-backfill-plan.md §11.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

import { fromBriefJson } from "../lib/accountGraph/fromBriefJson";
import { buildParityReport, renderGraphAsBriefLike } from "../lib/accountGraph/briefParity";
import { validateAccountGraph } from "../lib/accountGraph/validation";
import {
  aggregateClassification,
  classifyBrief,
  renderBackfillMarkdown,
  type PerBriefRecord,
} from "../lib/accountGraph/backfillReport";
import { Brief as BriefSchema } from "../lib/schema";

type CliArgs = {
  mode: "fixture" | "local-db";
  limit?: number;
  briefId?: string;
  out: string;
  dryRun: boolean;
  failFast: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { mode: "fixture", dryRun: true, failFast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i] as CliArgs["mode"];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--brief-id") args.briefId = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-dry-run") args.dryRun = false;
    else if (a === "--fail-fast") args.failFast = true;
  }
  if (args.mode !== "fixture" && args.mode !== "local-db") {
    throw new Error(`Unsupported --mode: ${args.mode}`);
  }
  if (!args.out) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    args.out = resolve(
      __dirname,
      "..",
      "..",
      "out",
      "account-graph-backfill",
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

type BriefRow = { brief_id: string; brief_json: unknown };

function loadFixtureBriefs(): BriefRow[] {
  // Use the repo's sample_brief.json + tests/fixtures/*_brief.json as
  // fixture-mode input. These are committed fixtures, not production data.
  const rows: BriefRow[] = [];
  const repoRoot = resolve(__dirname, "..", "..");
  const candidates = [
    join(repoRoot, "tests", "sample_brief.json"),
    join(repoRoot, "tests", "fixtures", "momentum_brief.json"),
    join(repoRoot, "tests", "fixtures", "procurement_brief.json"),
    join(repoRoot, "tests", "fixtures", "stakeholder_brief.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf8");
      const obj = JSON.parse(raw);
      // tests/fixtures/* files may not be valid full Briefs — that's OK; the
      // runner will classify them as `skipped_unsupported_schema_variant` or
      // process them, whichever applies. The whole point of A.6 is to exercise
      // these classifications honestly.
      rows.push({ brief_id: `fixture:${p.split("/").pop()}`, brief_json: obj });
    } catch (err) {
      rows.push({
        brief_id: `fixture:${p.split("/").pop()}`,
        brief_json: `<<malformed: ${err instanceof Error ? err.message : String(err)}>>`,
      });
    }
  }

  // Always include a deliberately malformed fixture so the runner exercises
  // skipped_malformed_json classification on every fixture run.
  rows.push({
    brief_id: "fixture:malformed.json",
    brief_json: "{ not valid json",
  });
  // And a deliberate unsupported-variant fixture.
  rows.push({
    brief_id: "fixture:unsupported_variant.json",
    brief_json: { account_name: "Variant", some_old_field: true },
  });
  return rows;
}

function loadLocalDbBriefs(limit: number | undefined, briefId: string | undefined): BriefRow[] {
  const repoRoot = resolve(__dirname, "..", "..");
  const candidates = [
    join(repoRoot, "web", "data", "app.db"),
    join(repoRoot, "web", "data", "dev.db"),
    join(repoRoot, "data", "app.db"),
    join(repoRoot, "dev.db"),
  ];
  const dbPath = candidates.find((p) => existsSync(p));
  if (!dbPath) {
    throw new Error(
      `local-db mode: no local development SQLite found. Looked in: ${candidates.join(", ")}. ` +
        `A.6 requires a local dev DB; production access is forbidden. Use --mode fixture or set up a local dev DB.`,
    );
  }
  // Lazy import so fixture mode doesn't load better-sqlite3 unnecessarily.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let sql = "SELECT id as brief_id, brief_json FROM briefs";
  const params: unknown[] = [];
  if (briefId) {
    sql += " WHERE id = ?";
    params.push(briefId);
  }
  if (limit && Number.isFinite(limit)) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const rows = db.prepare(sql).all(...params) as { brief_id: string; brief_json: string }[];
  db.close();
  return rows.map((r) => ({ brief_id: r.brief_id, brief_json: r.brief_json }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const { branch, commit } = gitInfo();
  mkdirSync(args.out, { recursive: true });

  // Hard write-safety: dry-run must default true. We never write to brief_json.
  if (!args.dryRun) {
    console.error("[run-account-graph-backfill] WARNING: --no-dry-run set. This runner still does NOT write to any production storage. The flag exists only for future symmetry per plan §11.");
  }

  let rows: BriefRow[];
  let localDbSkipReason: string | null = null;
  if (args.mode === "fixture") {
    rows = loadFixtureBriefs();
  } else {
    try {
      rows = loadLocalDbBriefs(args.limit, args.briefId);
    } catch (err) {
      localDbSkipReason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[run-account-graph-backfill] local-db unavailable: ${localDbSkipReason}. Falling back to fixture mode for safety.`,
      );
      rows = loadFixtureBriefs();
    }
  }

  if (args.limit && args.mode === "fixture") rows = rows.slice(0, args.limit);

  const records: PerBriefRecord[] = [];
  for (const row of rows) {
    const outcome = fromBriefJson({ brief_id: row.brief_id, brief_json: row.brief_json });
    if (outcome.status === "skipped_malformed_json") {
      records.push({
        brief_id: row.brief_id,
        classification: "skipped_malformed_json",
        reasons: [outcome.error],
        validation: null,
        parity: null,
        mapping: null,
        error: outcome.error,
      });
      continue;
    }
    if (outcome.status === "skipped_unsupported_schema_variant") {
      records.push({
        brief_id: row.brief_id,
        classification: "skipped_unsupported_schema_variant",
        reasons: [outcome.error],
        validation: null,
        parity: null,
        mapping: null,
        error: outcome.error,
      });
      continue;
    }
    const { graph, report } = outcome;
    const validation = validateAccountGraph(graph);
    // Re-parse brief for parity (we know it parsed inside fromBriefJson).
    const briefParsed = BriefSchema.parse(row.brief_json);
    const parity = buildParityReport(briefParsed, graph, row.brief_id);
    const rec = classifyBrief(row.brief_id, validation, parity, report);
    records.push(rec);

    // Per-brief artifacts.
    const briefSlug = row.brief_id.replace(/[^a-zA-Z0-9._-]/g, "_");
    writeFileSync(join(args.out, `${briefSlug}.graph.json`), JSON.stringify(graph, null, 2));
    writeFileSync(join(args.out, `${briefSlug}.parity.json`), JSON.stringify(parity, null, 2));
    writeFileSync(join(args.out, `${briefSlug}.shadow.md`), renderGraphAsBriefLike(graph));

    if (
      args.failFast &&
      (rec.classification === "failed_false_verified_provenance" ||
        rec.classification === "failed_invented_evidence" ||
        rec.classification === "failed_validation")
    ) {
      console.error(`[run-account-graph-backfill] --fail-fast: aborting after ${row.brief_id} (${rec.classification}).`);
      break;
    }
  }

  const aggregate = aggregateClassification(records);
  const runtimeMs = Date.now() - t0;
  const md = renderBackfillMarkdown({
    branch,
    commit,
    runAt: new Date().toISOString(),
    mode: args.mode,
    records,
    aggregate,
    runtimeMs,
  });

  writeFileSync(join(args.out, "report.md"), md);
  writeFileSync(
    join(args.out, "report.json"),
    JSON.stringify(
      {
        branch,
        commit,
        runAt: new Date().toISOString(),
        mode: args.mode,
        local_db_skip_reason: localDbSkipReason,
        aggregate,
        records: records.map((r) => ({
          brief_id: r.brief_id,
          account_name: r.account_name,
          classification: r.classification,
          reasons: r.reasons,
          validation_summary: r.validation
            ? {
                ok: r.validation.ok,
                errors: r.validation.errors.length,
                warnings: r.validation.warnings.length,
                metrics: r.validation.metrics,
              }
            : null,
          mapping_summary: r.mapping
            ? {
                ambiguous: r.mapping.ambiguous,
                unmapped_claims: r.mapping.unmapped_claims.length,
                per_tier_counts: r.mapping.per_tier_counts,
                orphan_sources: r.mapping.orphan_source_ids.length,
              }
            : null,
          parity_summary: r.parity
            ? {
                coverage_numerator: r.parity.coverage_numerator,
                coverage_denominator: r.parity.coverage_denominator,
                dropped: r.parity.dropped_brief_claims.length,
                provenance_gaps: r.parity.provenance_gaps.length,
                material_differences: r.parity.material_differences,
              }
            : null,
        })),
      },
      null,
      2,
    ),
  );

  console.log(
    `[run-account-graph-backfill] mode=${args.mode} briefs=${records.length} aggregate=${aggregate.classification}`,
  );
  console.log(`[run-account-graph-backfill] artifacts: ${args.out}`);
  if (localDbSkipReason) {
    console.log(`[run-account-graph-backfill] local-db skip reason: ${localDbSkipReason}`);
  }

  if (aggregate.classification === "fail") process.exit(1);
}

main().catch((err) => {
  console.error("[run-account-graph-backfill] error:", err);
  process.exit(1);
});
