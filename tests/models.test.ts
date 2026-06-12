import { test } from "node:test";
import assert from "node:assert/strict";

const models = require("../web/lib/models") as typeof import("../web/lib/models");
const cost = require("../web/lib/cost") as typeof import("../web/lib/cost");
const budget = require("../web/lib/accountGraph/validationPipeline/budget") as typeof import("../web/lib/accountGraph/validationPipeline/budget");

test("every catalog model has complete, positive pricing", () => {
  for (const id of models.ALL_MODEL_IDS) {
    const p = models.modelPrice(id);
    assert.ok(p, `missing price for ${id}`);
    assert.ok(p!.input_per_mtok > 0 && p!.output_per_mtok > 0, id);
    assert.equal(p!.cache_read_per_mtok, Number((p!.input_per_mtok * 0.1).toFixed(4)), `${id} cache_read`);
    assert.equal(p!.cache_write_per_mtok, Number((p!.input_per_mtok * 1.25).toFixed(4)), `${id} cache_write`);
  }
});

test("verified list prices for the models we run", () => {
  assert.deepEqual(
    { i: models.modelPrice("claude-opus-4-8")!.input_per_mtok, o: models.modelPrice("claude-opus-4-8")!.output_per_mtok },
    { i: 5, o: 25 },
  );
  assert.deepEqual(
    { i: models.modelPrice("claude-sonnet-4-6")!.input_per_mtok, o: models.modelPrice("claude-sonnet-4-6")!.output_per_mtok },
    { i: 3, o: 15 },
  );
  assert.deepEqual(
    { i: models.modelPrice("claude-haiku-4-5")!.input_per_mtok, o: models.modelPrice("claude-haiku-4-5")!.output_per_mtok },
    { i: 1, o: 5 },
  );
  assert.deepEqual(
    { i: models.modelPrice("claude-fable-5")!.input_per_mtok, o: models.modelPrice("claude-fable-5")!.output_per_mtok },
    { i: 10, o: 50 },
  );
});

test("regression: prior stale prices are corrected", () => {
  // cost.ts previously priced opus-4-7 at $15/$75 (3x too high).
  assert.equal(models.modelPrice("claude-opus-4-7")!.input_per_mtok, 5);
  assert.equal(models.modelPrice("claude-opus-4-7")!.output_per_mtok, 25);
  // budget.ts previously priced haiku at $0.8/$4 (understated).
  const haiku = budget.lookupModelPricing("claude-haiku-4-5");
  assert.deepEqual(haiku, { input_usd_per_million: 1, output_usd_per_million: 5 });
  // budget.ts previously priced opus tiers at $15/$75.
  assert.deepEqual(budget.lookupModelPricing("claude-opus-4-8"), {
    input_usd_per_million: 5,
    output_usd_per_million: 25,
  });
});

test("heavy research now targets Opus 4.8, scout + monitor triage moved off Haiku", () => {
  assert.equal(models.RESEARCH_HEAVY_MODEL, "claude-opus-4-8");
  assert.equal(models.SOURCE_SCOUT_MODEL, "claude-sonnet-4-6");
  assert.equal(models.MONITOR_TRIAGE_MODEL, "claude-sonnet-4-6");
  assert.notEqual(models.SOURCE_SCOUT_MODEL, "claude-haiku-4-5");
  assert.notEqual(models.MONITOR_TRIAGE_MODEL, "claude-haiku-4-5");
});

test("every web-search role uses a model that supports the latest web tools", () => {
  // Guards against re-introducing a Haiku + web_search-style mismatch.
  for (const id of models.WEB_SEARCH_ROLE_MODELS) {
    assert.equal(
      models.modelSupportsWebSearchLatest(id),
      true,
      `${id} is used with web_search but does not support the latest web tools`,
    );
  }
  // Haiku must never be a web-search role.
  assert.equal(models.modelSupportsWebSearchLatest("claude-haiku-4-5"), false);
});

test("WEB_SEARCH_ROLE_MODELS covers every role that attaches web_search, incl. Quick", () => {
  // runResearchLoop attaches web_search_* unconditionally, so Quick is a
  // web-search path too — it must be in the invariant list or a future
  // Quick→Haiku regression would slip past the check above.
  for (const role of [
    models.RESEARCH_QUICK_MODEL,
    models.RESEARCH_HEAVY_MODEL,
    models.SOURCE_SCOUT_MODEL,
    models.BRIEF_CHAT_MODEL,
    models.MONITOR_SCAN_MODEL,
    models.MONITOR_TRIAGE_MODEL,
  ]) {
    assert.ok(
      models.WEB_SEARCH_ROLE_MODELS.includes(role),
      `${role} attaches web_search but is missing from WEB_SEARCH_ROLE_MODELS`,
    );
  }
});

test("cost estimator resolves catalog prices (incl. opus-4-8) and fails closed on unknown", () => {
  const cents = cost.estimateAnthropicCostCents([
    { name: "research", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ]);
  // 1M input @ $5 + 1M output @ $25 = $30.00 = 3000 cents.
  assert.equal(cents, 3000);
  assert.equal(
    cost.estimateAnthropicCostCents([
      { name: "x", model: "model-that-does-not-exist", usage: { input_tokens: 10 } },
    ]),
    null,
  );
});

test("Fable 5 is catalogued but not wired to any non-admin product role", () => {
  assert.equal(models.ADMIN_STRATEGIC_MODEL, "claude-fable-5");
  const productRoles = [
    models.RESEARCH_QUICK_MODEL,
    models.RESEARCH_HEAVY_MODEL,
    models.SOURCE_SCOUT_MODEL,
    models.JSON_REPAIR_MODEL,
    models.BRIEF_CHAT_MODEL,
    models.JOURNAL_MODEL,
    models.COMMENT_MODEL,
    models.MONITOR_SCAN_MODEL,
    models.MONITOR_TRIAGE_MODEL,
  ];
  assert.equal(productRoles.includes("claude-fable-5"), false);
});

test("admin gate: only ADMIN_STRATEGIC_MODEL (Fable) requires admin", () => {
  // The admin-only set must be exactly the strategic model and must never
  // overlap with a product role.
  assert.deepEqual(models.ADMIN_ONLY_MODELS, ["claude-fable-5"]);
  assert.equal(models.modelRequiresAdmin("claude-fable-5"), true);
  for (const id of [
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "model-that-does-not-exist",
  ]) {
    assert.equal(models.modelRequiresAdmin(id), false, id);
  }
});

test("admin gate: ordinary product models bypass the gate regardless of context", () => {
  const noCtx = { isAdmin: false, acknowledgedDataPosture: false };
  assert.equal(models.collectAdminModelRefusals("claude-opus-4-8", noCtx), null);
  // assert* must not throw for a non-admin model even with an empty context.
  models.assertAdminModelAllowed("claude-opus-4-8", noCtx);
  models.assertAdminModelAllowed("claude-sonnet-4-6", noCtx);
});

test("admin gate: Fable refused when caller is not admin", () => {
  const refusal = models.collectAdminModelRefusals("claude-fable-5", {
    isAdmin: false,
    acknowledgedDataPosture: true,
  });
  assert.ok(refusal);
  assert.equal(refusal!.reasons.length, 1);
  assert.match(refusal!.reasons[0], /not an authenticated admin/);
  assert.match(refusal!.message, /Refusing to route to admin-only model claude-fable-5/);
  assert.match(refusal!.message, /30-day retention/);
});

test("admin gate: Fable refused when admin has not acknowledged data posture", () => {
  const refusal = models.collectAdminModelRefusals("claude-fable-5", {
    isAdmin: true,
    acknowledgedDataPosture: false,
  });
  assert.ok(refusal);
  assert.equal(refusal!.reasons.length, 1);
  assert.match(refusal!.reasons[0], /acknowledgement of its data posture/);
});

test("admin gate: aggregates BOTH unmet requirements for Fable", () => {
  const refusal = models.collectAdminModelRefusals("claude-fable-5", {
    isAdmin: false,
    acknowledgedDataPosture: false,
  });
  assert.ok(refusal);
  assert.equal(refusal!.reasons.length, 2);
});

test("admin gate: Fable allowed only for an acknowledged admin (fail-closed assert)", () => {
  const ok = { isAdmin: true, acknowledgedDataPosture: true };
  assert.equal(models.collectAdminModelRefusals("claude-fable-5", ok), null);
  // Permitted: must not throw.
  models.assertAdminModelAllowed("claude-fable-5", ok);
  // Every other context throws AdminModelGateError carrying the reasons.
  for (const ctx of [
    { isAdmin: false, acknowledgedDataPosture: false },
    { isAdmin: false, acknowledgedDataPosture: true },
    { isAdmin: true, acknowledgedDataPosture: false },
  ]) {
    assert.throws(
      () => models.assertAdminModelAllowed("claude-fable-5", ctx),
      (err: unknown) => {
        assert.ok(err instanceof models.AdminModelGateError);
        assert.ok((err as InstanceType<typeof models.AdminModelGateError>).reasons.length > 0);
        return true;
      },
    );
  }
});
