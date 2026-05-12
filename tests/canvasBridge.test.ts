import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Canvas } from "../web/lib/canvas/schema";
import { Brief, type BriefExtension } from "../web/lib/schema";
import { buildReadOnlyCanvasFromBrief } from "../web/lib/canvas/fromBrief";
import { ALL_WIDGET_KINDS, getDescriptor } from "../web/lib/canvas/registry";

const sampleBriefJson = JSON.parse(
  readFileSync(path.join(__dirname, "sample_brief.json"), "utf8"),
);

test("Canvas schema accepts a read-only section_ref widget", () => {
  const parsed = Canvas.parse({
    account_id: "brief-1",
    account_name: "Example Health",
    version: 1,
    generated_at: "2026-05-11T00:00:00.000Z",
    widgets: [
      {
        id: "section-snapshot",
        kind: "section_ref",
        title: "Account snapshot",
        description: "",
        source: "system",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z",
        confidence: "Medium",
        why_included: "Derived from standard brief section.",
        sources: [],
        layout: { x: 0, y: 0, w: 6, h: 2, pinned: true, collapsed: false },
        controls: {
          can_refresh: false,
          can_remove: false,
          can_edit: false,
          can_export: false,
        },
        status: "fresh",
        evidence: [],
        data: { section_key: "snapshot", preview: "Snapshot preview" },
      },
    ],
    meta: { layout_mode: "grid", pinned_order: ["section-snapshot"] },
  });

  assert.equal(parsed.widgets[0].kind, "section_ref");
  assert.equal(parsed.widgets[0].controls.can_edit, false);
});

test("buildReadOnlyCanvasFromBrief derives deterministic read-only widgets", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });

  assert.equal(canvas.account_id, "sample");
  assert.equal(canvas.account_name, brief.account_name);
  assert.ok(canvas.widgets.length >= 8);
  assert.ok(
    canvas.widgets.some(
      (w) => w.kind === "section_ref" && w.id === "section-snapshot",
    ),
  );
  assert.ok(canvas.widgets.some((w) => w.kind === "evidence_board"));
  assert.ok(canvas.widgets.some((w) => w.kind === "action_panel"));
  assert.ok(canvas.widgets.some((w) => w.kind === "metric"));

  const ids = canvas.widgets.map((w) => w.id);
  assert.deepEqual(ids, Array.from(new Set(ids)), "widget IDs must be unique");

  assert.ok(
    canvas.widgets.every(
      (w) =>
        !w.controls.can_edit &&
        !w.controls.can_remove &&
        !w.controls.can_refresh &&
        !w.controls.can_export,
    ),
    "every widget must have all controls disabled",
  );
});

test("buildReadOnlyCanvasFromBrief omits Insights section when extensions are empty/defaulted", () => {
  const { extensions, ...rest } = sampleBriefJson;
  const brief = Brief.parse(rest);
  assert.equal(brief.extensions.length, 0);

  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "legacy", brief });
  assert.equal(
    canvas.widgets.some((w) => w.id === "section-extensions"),
    false,
    "Insights section_ref must not be present when extensions is empty",
  );
});

test("buildReadOnlyCanvasFromBrief includes Insights section when extensions are present", () => {
  const ext: BriefExtension = {
    kind: "card",
    id: "ext-1",
    title: "Pilot procurement insight",
    body: "Public-sector pilot expected to procure in Q3.",
    source: "model",
    created_at: "2026-05-11",
    why_included: "Surfaced from procurement scan.",
    confidence: "Medium",
    sources: [],
  };
  const brief = Brief.parse({ ...sampleBriefJson, extensions: [ext] });
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "ext", brief });
  assert.ok(
    canvas.widgets.some((w) => w.id === "section-extensions"),
    "Insights section_ref must be present when extensions has entries",
  );
});

test("buildReadOnlyCanvasFromBrief is deterministic across calls", () => {
  const brief = Brief.parse(sampleBriefJson);
  const a = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const b = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  assert.deepEqual(
    a.widgets.map((w) => w.id),
    b.widgets.map((w) => w.id),
  );
});

test("evidence_board contains no more than 8 items", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const board = canvas.widgets.find((w) => w.kind === "evidence_board");
  assert.ok(board);
  if (board && board.kind === "evidence_board") {
    assert.ok(
      board.data.items.length <= 8,
      `evidence_board has ${board.data.items.length} items, expected <= 8`,
    );
  }
});

test("action_panel exposes next_action and no invented account-specific action", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const panel = canvas.widgets.find((w) => w.kind === "action_panel");
  assert.ok(panel);
  if (panel && panel.kind === "action_panel") {
    // Exactly one action: the brief's next_action verbatim. No model invention.
    assert.equal(panel.data.actions.length, 1);
    assert.equal(panel.data.actions[0].detail, brief.next_action);
  }
});

test("production canvas registry covers every widget kind", () => {
  assert.deepEqual(
    [...ALL_WIDGET_KINDS].sort(),
    ["action_panel", "evidence_board", "metric", "open_questions", "section_ref"],
  );
  for (const kind of ALL_WIDGET_KINDS) {
    const descriptor = getDescriptor(kind);
    assert.equal(descriptor.kind, kind);
    assert.equal(typeof descriptor.Tile, "function");
    assert.equal(typeof descriptor.Detail, "function");
  }
});
