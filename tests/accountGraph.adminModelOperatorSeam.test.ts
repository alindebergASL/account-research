// Operator-seam parity: the CLI real-adapter path must enforce the SAME
// admin-only data-posture acknowledgement as the product admin gate
// (web/lib/models.ts). These tests assert the two seams cannot drift: the
// runner delegates the admin-only decision to the shared gate, so a model that
// the gate marks admin-only (e.g. ADMIN_STRATEGIC_MODEL / Fable) is refused on
// the real-adapter path unless the operator passes --acknowledge-data-posture.

import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUNNER_PATH = "../web/scripts/run-account-graph-validation";
function loadRunner(): typeof import("../web/scripts/run-account-graph-validation") {
  return require(RUNNER_PATH);
}
const models = require("../web/lib/models") as typeof import("../web/lib/models");

// A fully-valid real-adapter context (every required flag present and valid),
// so each test can isolate the admin-acknowledgement requirement by varying
// only `model` and `acknowledgedDataPosture`. corpus/out are absolute paths
// OUTSIDE the repo, which the path classifier accepts; the refusal path does
// no fs access, so the paths need not exist.
function baseCtx(
  overrides: Partial<
    import("../web/scripts/run-account-graph-validation").RealAdapterRefusalContext
  > = {},
): import("../web/scripts/run-account-graph-validation").RealAdapterRefusalContext {
  return {
    adapter: "real",
    allowRealModel: true,
    maxCostExplicit: true,
    maxCostUsd: 10,
    allowHighCost: false,
    provider: "anthropic",
    model: "claude-opus-4-8",
    corpus: join(tmpdir(), "operator-seam-corpus.jsonl"),
    out: join(tmpdir(), "operator-seam-out"),
    outExplicit: true,
    acknowledgedDataPosture: false,
    ...overrides,
  };
}

test("baseline: a fully-valid non-admin real-adapter context is accepted", () => {
  const mod = loadRunner();
  // Sanity: opus is not admin-only, so no acknowledgement is required.
  assert.equal(models.modelRequiresAdmin("claude-opus-4-8"), false);
  assert.equal(mod.collectRealAdapterRefusals(baseCtx()), null);
});

test("admin-only model WITHOUT --acknowledge-data-posture is refused", () => {
  const mod = loadRunner();
  const adminModel = models.ADMIN_STRATEGIC_MODEL; // claude-fable-5
  assert.equal(models.modelRequiresAdmin(adminModel), true);

  const refusal = mod.collectRealAdapterRefusals(
    baseCtx({ model: adminModel, acknowledgedDataPosture: false }),
  );
  assert.ok(refusal, "expected a refusal for an unacknowledged admin model");
  const ackReason = refusal!.reasons.find((r) =>
    r.includes("--acknowledge-data-posture"),
  );
  assert.ok(ackReason, `expected an ack reason; got: ${refusal!.reasons.join(" | ")}`);
  assert.match(ackReason!, new RegExp(adminModel));
  // The shared data-posture warning is surfaced verbatim.
  assert.ok(ackReason!.includes(models.ADMIN_MODEL_DATA_POSTURE_WARNING));
});

test("admin-only model WITH --acknowledge-data-posture is accepted", () => {
  const mod = loadRunner();
  const refusal = mod.collectRealAdapterRefusals(
    baseCtx({
      model: models.ADMIN_STRATEGIC_MODEL,
      acknowledgedDataPosture: true,
    }),
  );
  assert.equal(refusal, null);
});

test("acknowledgement is NOT required for ordinary (non-admin) models", () => {
  const mod = loadRunner();
  for (const model of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
    assert.equal(
      mod.collectRealAdapterRefusals(baseCtx({ model, acknowledgedDataPosture: false })),
      null,
      `${model} should not require --acknowledge-data-posture`,
    );
  }
});

test("the runner agrees with the shared product gate (no drift)", () => {
  const mod = loadRunner();
  const adminModel = models.ADMIN_STRATEGIC_MODEL;
  // For every (ack) combination, the runner refuses iff the shared gate refuses
  // the operator (admin) context — proving a single source of truth.
  for (const ack of [false, true]) {
    const gateRefuses =
      models.collectAdminModelRefusals(adminModel, {
        isAdmin: true,
        acknowledgedDataPosture: ack,
      }) !== null;
    const runnerRefuses =
      mod.collectRealAdapterRefusals(
        baseCtx({ model: adminModel, acknowledgedDataPosture: ack }),
      ) !== null;
    assert.equal(runnerRefuses, gateRefuses, `ack=${ack}`);
  }
});

test("--acknowledge-data-posture flag parses (default false)", () => {
  const mod = loadRunner();
  assert.equal(mod.parseArgs([]).acknowledgedDataPosture, false);
  assert.equal(
    mod.parseArgs(["--acknowledge-data-posture"]).acknowledgedDataPosture,
    true,
  );
});
