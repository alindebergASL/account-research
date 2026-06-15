// Monitor cost work: assert that (1) both monitor loops set prompt caching,
// (2) usage telemetry now records cache reads/writes and per-tier call counts
// separately (not collapsed into one input number), and (3) usage accumulated
// before a mid-scan throw survives — so failed runs are no longer a blind spot.

import test from "node:test";
import assert from "node:assert/strict";

const mod = require("../web/lib/monitor") as typeof import("../web/lib/monitor");

// Minimal brief — the prompt builders only JSON.stringify a subset of fields.
const brief = {
  account_name: "Acme",
  segment: "Tech",
  snapshot: "snap",
  recent_signals: [],
  top_initiatives: [],
  programs_procurement: {},
  competitive_signals: [],
  sources: [],
} as any;
const input = { brief, lastMonitoredAt: Date.UTC(2026, 5, 1) } as any;

function recordTriage(anythingNew: boolean) {
  return {
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        name: "record_triage",
        id: "t",
        input: { anything_new: anythingNew, leads: anythingNew ? ["x"] : [] },
      },
    ],
  };
}

function recordFindings() {
  return {
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        name: "record_monitor_findings",
        id: "f",
        input: { has_updates: false, summary: "", patches: [] },
      },
    ],
  };
}

test("deep scan sets prompt caching and records cache-aware, per-tier usage", async () => {
  const calls: any[] = [];
  const stub = {
    messages: {
      create: async (args: any) => {
        calls.push(args);
        return {
          ...recordFindings(),
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 200,
            output_tokens: 50,
            server_tool_use: { web_search_requests: 2 },
          },
        };
      },
    },
  };
  const usage = mod.emptyMonitorUsage();
  await mod.runMonitorScan(input, stub, usage);

  // (1) caching present on the scan call.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].cache_control, { type: "ephemeral" });

  // (2) cache fields and call count are tracked separately; aggregate input is
  // base + cache_read + cache_creation (back-compat meaning preserved).
  assert.equal(usage.deep_calls, 1);
  assert.equal(usage.deep_cache_read_input_tokens, 5000);
  assert.equal(usage.deep_cache_creation_input_tokens, 200);
  assert.equal(usage.deep_input_tokens, 1000 + 5000 + 200);
  assert.equal(usage.deep_output_tokens, 50);
  assert.equal(usage.web_searches, 2);
  // triage tier untouched by a scan-only run.
  assert.equal(usage.triage_calls, 0);
});

test("triage sets prompt caching too", async () => {
  const calls: any[] = [];
  const stub = {
    messages: {
      create: async (args: any) => {
        calls.push(args);
        return {
          ...recordTriage(false),
          usage: { input_tokens: 100, output_tokens: 10 },
        };
      },
    },
  };
  const usage = mod.emptyMonitorUsage();
  const res = await mod.runMonitorTriage(input, stub, usage);
  assert.equal(res.anythingNew, false);
  assert.deepEqual(calls[0].cache_control, { type: "ephemeral" });
  assert.equal(usage.triage_calls, 1);
  assert.equal(usage.triage_input_tokens, 100);
});

test("partial usage survives a mid-scan throw (failed runs are no longer blind)", async () => {
  let phase = 0;
  const stub = {
    messages: {
      create: async () => {
        phase += 1;
        if (phase === 1) {
          // triage succeeds and escalates to a deep scan
          return {
            ...recordTriage(true),
            usage: { input_tokens: 2000, output_tokens: 20 },
          };
        }
        // deep scan call rejects before any usage is recorded for it
        throw new Error("provider boom on deep scan");
      },
    },
  };
  const usage = mod.emptyMonitorUsage();
  await assert.rejects(() => mod.runMonitorCheck(input, stub, usage));

  // The caller-owned usage object retains the triage spend even though the
  // overall check threw — this is what lets the worker persist it on the
  // failed monitor_runs row.
  assert.equal(usage.triage_calls, 1);
  assert.equal(usage.triage_input_tokens, 2000);
});
