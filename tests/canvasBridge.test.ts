import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Canvas } from "../web/lib/canvas/schema";
import { Brief, type BriefExtension } from "../web/lib/schema";
import { buildReadOnlyCanvasFromBrief } from "../web/lib/canvas/fromBrief";
import { ALL_WIDGET_KINDS, getDescriptor } from "../web/lib/canvas/registry";
import { isSafeExternalUrl } from "../web/components/canvas/details";

const sampleBriefJson = JSON.parse(
  readFileSync(path.join(__dirname, "sample_brief.json"), "utf8"),
);

// ---- schema parse ----------------------------------------------------------

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

test("Canvas.parse accepts the full output of buildReadOnlyCanvasFromBrief", () => {
  const brief = Brief.parse(sampleBriefJson);
  const built = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const reparsed = Canvas.parse(built);
  assert.equal(reparsed.account_name, brief.account_name);
  assert.ok(reparsed.widgets.length >= 8);
});

// ---- adapter shape + determinism ------------------------------------------

test("section_ref widgets keep full drill-in text separate from tile preview", () => {
  const longSnapshot = `${"Full drill-in sentence. ".repeat(40)}Final full-detail marker.`;
  const brief = Brief.parse({ ...sampleBriefJson, snapshot: longSnapshot });
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const snapshot = canvas.widgets.find((w) => w.id === "section-snapshot");

  assert.ok(snapshot);
  assert.equal(snapshot?.kind, "section_ref");
  if (snapshot?.kind !== "section_ref") return;

  assert.ok(
    snapshot.data.preview.length < longSnapshot.length,
    "tile preview should remain concise",
  );
  assert.equal(
    (snapshot.data as { full_text?: string }).full_text,
    longSnapshot,
    "drill-in detail must preserve the complete section text",
  );
});

test("WidgetTile opens when the card surface is clicked, not only the drill link", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/canvas/WidgetTile.tsx"),
    "utf8",
  );
  assert.match(source, /<motion\.article[\s\S]*?onClick=\{onOpen\}/);
  assert.match(source, /role="button"/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /onKeyDown=\{handleCardKeyDown\}/);
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

test("buildReadOnlyCanvasFromBrief is deterministic across calls", () => {
  const brief = Brief.parse(sampleBriefJson);
  const a = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const b = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  assert.deepEqual(
    a.widgets.map((w) => w.id),
    b.widgets.map((w) => w.id),
  );
});

test("every adapter-built widget has status fresh and stable, in-bounds layout", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  for (const w of canvas.widgets) {
    assert.equal(w.status, "fresh");
    assert.ok(w.layout.x >= 0);
    assert.ok(w.layout.y >= 0);
    assert.ok(w.layout.w >= 1 && w.layout.w <= 12);
    assert.ok(w.layout.h >= 1 && w.layout.h <= 24);
  }
});

// ---- extensions ------------------------------------------------------------

test("legacy brief without extensions produces no extension widgets", () => {
  const { extensions, ...rest } = sampleBriefJson;
  const brief = Brief.parse(rest);
  assert.equal(brief.extensions.length, 0);

  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "legacy", brief });
  assert.equal(
    canvas.widgets.some((w) => w.kind === "extension"),
    false,
    "no extension widgets when brief.extensions is empty",
  );
  assert.equal(
    canvas.widgets.some((w) => w.id === "section-extensions"),
    false,
    "no Insights section_ref when extensions is empty",
  );
});

test("one extension of each kind produces dedicated extension widgets", () => {
  const exts: BriefExtension[] = [
    {
      kind: "card",
      id: "card-1",
      title: "Pilot procurement insight",
      body: "Public-sector pilot expected to procure in Q3.",
      source: "research",
      created_at: "2026-05-11",
      why_included: "Surfaced from procurement scan.",
      confidence: "Medium",
      sources: [],
    },
    {
      kind: "table",
      id: "table-1",
      title: "Active RFPs",
      columns: ["RFP", "Stage", "Close"],
      rows: [
        ["EHR analytics", "Open", "2026-Q3"],
        ["Identity", "Awarded", "2026-Q1"],
      ],
      source: "model",
      created_at: "2026-05-11",
      why_included: "Procurement scan.",
      confidence: "High",
      sources: [],
    },
    {
      kind: "list",
      id: "list-1",
      title: "Watch-list initiatives",
      items: ["Ambient AI", "Patient outreach", "Revenue cycle"],
      source: "model",
      created_at: "2026-05-11",
      why_included: "From initiatives scan.",
      confidence: "Medium",
      sources: [],
    },
    {
      kind: "narrative",
      id: "narr-1",
      title: "Buying climate, late 2026",
      body: "Strong board pressure on margin, ambient AI adoption broadens, identity refresh in flight.",
      source: "chat",
      created_at: "2026-05-11",
      why_included: "From chat conversation.",
      confidence: "Low",
      sources: [],
    },
  ];
  const brief = Brief.parse({ ...sampleBriefJson, extensions: exts });
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "ext", brief });

  const extWidgets = canvas.widgets.filter((w) => w.kind === "extension");
  assert.equal(extWidgets.length, 4);
  assert.ok(canvas.widgets.some((w) => w.id === "extension-card-1"));
  assert.ok(canvas.widgets.some((w) => w.id === "extension-table-1"));
  assert.ok(canvas.widgets.some((w) => w.id === "extension-list-1"));
  assert.ok(canvas.widgets.some((w) => w.id === "extension-narr-1"));

  const cardW = canvas.widgets.find((w) => w.id === "extension-card-1");
  if (cardW && cardW.kind === "extension") {
    assert.equal(cardW.data.ext_kind, "card");
    assert.equal(cardW.data.body, "Public-sector pilot expected to procure in Q3.");
    assert.equal(cardW.source, "research", "research-sourced extension preserves source=research");
    assert.equal(cardW.layout.w, 6);
  }
  const tableW = canvas.widgets.find((w) => w.id === "extension-table-1");
  if (tableW && tableW.kind === "extension") {
    assert.equal(tableW.data.ext_kind, "table");
    assert.deepEqual(tableW.data.columns, ["RFP", "Stage", "Close"]);
    assert.deepEqual(tableW.data.rows, [
      ["EHR analytics", "Open", "2026-Q3"],
      ["Identity", "Awarded", "2026-Q1"],
    ]);
    assert.equal(tableW.layout.w, 12);
  }
  const listW = canvas.widgets.find((w) => w.id === "extension-list-1");
  if (listW && listW.kind === "extension") {
    assert.equal(listW.data.ext_kind, "list");
    assert.deepEqual(listW.data.items, [
      "Ambient AI",
      "Patient outreach",
      "Revenue cycle",
    ]);
    assert.equal(listW.layout.w, 6);
  }
  const narrW = canvas.widgets.find((w) => w.id === "extension-narr-1");
  if (narrW && narrW.kind === "extension") {
    assert.equal(narrW.data.ext_kind, "narrative");
    assert.equal(narrW.source, "chat", "chat-sourced extension carries source=chat");
    assert.equal(narrW.layout.w, 12);
  }
});

// ---- evidence cap + action panel ------------------------------------------

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
    assert.equal(panel.data.actions.length, 1);
    const first = panel.data.actions[0];
    if ("label" in first) {
      assert.equal(first.detail, brief.next_action);
    } else {
      assert.fail("expected legacy {label, detail} action shape");
    }
  }
});

// ---- registry --------------------------------------------------------------

test("production canvas registry covers every widget kind including extension", () => {
  assert.deepEqual(
    [...ALL_WIDGET_KINDS].sort(),
    [
      "action_panel",
      "evidence_board",
      "extension",
      "metric",
      "open_questions",
      "section_ref",
    ],
  );
  for (const kind of ALL_WIDGET_KINDS) {
    const descriptor = getDescriptor(kind);
    assert.equal(descriptor.kind, kind);
    assert.equal(typeof descriptor.Tile, "function");
    assert.equal(typeof descriptor.Detail, "function");
  }
});

// ---- schema width: rich shapes still parse ---------------------------------

test("schema accepts richer metric / open-question / action / evidence shapes", () => {
  const parsed = Canvas.parse({
    account_id: "brief-rich",
    account_name: "Rich",
    version: 1,
    generated_at: "2026-05-13T00:00:00.000Z",
    widgets: [
      {
        id: "metric-rich",
        kind: "metric",
        title: "Pipeline value",
        description: "",
        source: "research",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:00.000Z",
        sources: [],
        layout: { x: 0, y: 0, w: 4, h: 3, pinned: false, collapsed: false },
        controls: {
          can_refresh: false,
          can_remove: false,
          can_edit: false,
          can_export: false,
        },
        status: "watching",
        evidence: [],
        data: {
          label: "ARR potential",
          value: "$2.4M",
          unit: "USD",
          as_of: "2026-05-13",
          delta: "+12% MoM",
        },
      },
      {
        id: "questions-rich",
        kind: "open_questions",
        title: "Open questions",
        description: "",
        source: "refresh",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:00.000Z",
        sources: [],
        layout: { x: 4, y: 0, w: 4, h: 3, pinned: false, collapsed: false },
        controls: {
          can_refresh: false,
          can_remove: false,
          can_edit: false,
          can_export: false,
        },
        status: "fresh",
        evidence: [],
        data: {
          questions: [
            "Plain question",
            {
              text: "Does Acme have a CISO sponsor?",
              blocking: true,
              hypothesis: "Likely yes after the Feb hire.",
            },
          ],
        },
      },
      {
        id: "action-rich",
        kind: "action_panel",
        title: "Actions",
        description: "",
        source: "system",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:00.000Z",
        sources: [],
        layout: { x: 8, y: 0, w: 4, h: 3, pinned: false, collapsed: false },
        controls: {
          can_refresh: false,
          can_remove: false,
          can_edit: false,
          can_export: false,
        },
        status: "fresh",
        evidence: [],
        data: {
          actions: [
            { label: "Schedule intro", detail: "Reach out to the CISO." },
            {
              text: "Brief account team",
              why: "Avoid duplicate outreach into procurement.",
              owner: "AE",
              severity: "high",
            },
          ],
        },
      },
      {
        id: "evidence-rich",
        kind: "evidence_board",
        title: "Evidence",
        description: "",
        source: "system",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:00.000Z",
        sources: [],
        layout: { x: 0, y: 3, w: 12, h: 3, pinned: false, collapsed: false },
        controls: {
          can_refresh: false,
          can_remove: false,
          can_edit: false,
          can_export: false,
        },
        status: "fresh",
        evidence: [],
        data: {
          items: [
            {
              text: "Mar 2026 strategy note",
              source: "press release",
              confidence: "High",
              tag: "signal",
            },
          ],
        },
      },
    ],
    meta: {
      layout_mode: "grid",
      pinned_order: ["metric-rich", "questions-rich", "action-rich", "evidence-rich"],
    },
  });

  const metric = parsed.widgets[0];
  if (metric.kind === "metric") {
    assert.equal(metric.data.unit, "USD");
    assert.equal(metric.data.delta, "+12% MoM");
    assert.equal(metric.source, "research");
    assert.equal(metric.status, "watching");
  }
  const questions = parsed.widgets[1];
  if (questions.kind === "open_questions") {
    assert.equal(questions.data.questions.length, 2);
    const second = questions.data.questions[1];
    assert.ok(typeof second === "object" && "blocking" in second);
    if (typeof second === "object") {
      assert.equal(second.blocking, true);
    }
  }
  const action = parsed.widgets[2];
  if (action.kind === "action_panel") {
    assert.equal(action.data.actions.length, 2);
    const rich = action.data.actions[1];
    assert.ok("severity" in rich);
    if ("severity" in rich) {
      assert.equal(rich.severity, "high");
      assert.equal(rich.owner, "AE");
    }
  }
  const evidence = parsed.widgets[3];
  if (evidence.kind === "evidence_board") {
    const item = evidence.data.items[0];
    assert.equal(item.tag, "signal");
  }
});

// ---- schema layout bounds enforced ----------------------------------------

test("schema rejects out-of-bounds widget layout", () => {
  const bad = () =>
    Canvas.parse({
      account_id: "x",
      account_name: "x",
      version: 1,
      generated_at: "2026-05-13",
      widgets: [
        {
          id: "x",
          kind: "section_ref",
          title: "x",
          description: "",
          source: "system",
          created_at: "2026-05-13",
          updated_at: "2026-05-13",
          sources: [],
          layout: { x: -1, y: 0, w: 13, h: 2, pinned: false, collapsed: false },
          controls: {
            can_refresh: false,
            can_remove: false,
            can_edit: false,
            can_export: false,
          },
          status: "fresh",
          evidence: [],
          data: { section_key: "snapshot", preview: "x" },
        },
      ],
      meta: { layout_mode: "grid", pinned_order: ["x"] },
    });
  assert.throws(bad);
});

test("canvas detail source links only allow http and https URLs", () => {
  assert.equal(isSafeExternalUrl("https://example.com/source"), true);
  assert.equal(isSafeExternalUrl("http://example.com/source"), true);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeExternalUrl("not a url"), false);
});
