import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Canvas } from "../web/lib/canvas/schema";
import { Brief, type BriefExtension } from "../web/lib/schema";
import { buildReadOnlyCanvasFromBrief } from "../web/lib/canvas/fromBrief";
import { buildRecommendedActions } from "../web/lib/canvas/recommendedActions";
import { ALL_WIDGET_KINDS, getDescriptor } from "../web/lib/canvas/registry";
import { isSafeExternalUrl } from "../web/components/canvas/details";
import {
  parseFractionValue,
  aggregateConfidence,
  sourceTypeLabel,
  sectionKeyTone,
  confidenceBucket,
  confidenceWeight,
  summarizeLandscapeLabel,
} from "../web/lib/canvas/visualHelpers";

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

test("canvas meta exposes agent-readiness provenance and audit counts", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });

  assert.equal(canvas.meta.agent_readiness.mode, "read_only_preview");
  assert.equal(canvas.meta.agent_readiness.generated_from, "saved_brief");
  assert.equal(canvas.meta.agent_readiness.controls_enabled, false);
  assert.equal(canvas.meta.agent_readiness.source_count, brief.sources.length);
  assert.equal(
    canvas.meta.agent_readiness.evidence_count,
    canvas.widgets.reduce((n, w) => n + w.evidence.length, 0) +
      canvas.widgets.reduce(
        (n, w) => n + (w.kind === "evidence_board" ? w.data.items.length : 0),
        0,
      ),
  );
});

test("canvas modal supports a persistent provenance/action footer", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/DrillModal.tsx"),
    "utf8",
  );
  assert.match(source, /footer\?: React\.ReactNode/);
  assert.match(source, /data-testid="drill-modal-footer"/);
});

test("evidence source links only render safe http(s) URLs as anchors", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/DrillModal.tsx"),
    "utf8",
  );
  assert.doesNotMatch(source, /source\.startsWith\("http"\)/);
  assert.match(source, /isSafeSourceUrl/);
});

test("WidgetTile opens when the card surface is clicked, not only the details link", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/canvas/WidgetTile.tsx"),
    "utf8",
  );
  assert.match(source, /<motion\.article[\s\S]*?onClick=\{onOpen\}/);
  assert.match(source, /role="button"/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /onKeyDown=\{handleCardKeyDown\}/);
  assert.doesNotMatch(
    source,
    />\s*Drill\s*</,
    "Canvas cards should use user-facing details language, not BI jargon",
  );
  // The accessible name still describes the affordance to screen readers;
  // it's not duplicated as visible text on every card.
  assert.match(
    source,
    /aria-label=\{`View details for \$\{widget\.title\}`\}/,
    "WidgetTile must keep an accessible name describing the drill-in target",
  );
});

test("Canvas card footer affordance is a subtle icon, not repeated visible text", () => {
  const widgetTileSource = readFileSync(
    path.join(__dirname, "../web/components/canvas/WidgetTile.tsx"),
    "utf8",
  );
  // Repeated "View details" text on every card was the user-reported noise:
  // it should no longer appear as visible JSX text. The aria-label keeps
  // screen reader semantics intact; the icon pill is the visual cue.
  assert.doesNotMatch(
    widgetTileSource,
    />\s*View details\s*</,
    "Canvas cards must not render 'View details' as visible footer text on every card",
  );
  assert.doesNotMatch(
    widgetTileSource,
    />\s*View details\s+<ChevronRight/,
    "Canvas cards must not pair 'View details' text with the chevron in visible chrome",
  );
});

test("Canvas card titles wrap to two lines instead of single-line truncation", () => {
  const widgetTileSource = readFileSync(
    path.join(__dirname, "../web/components/canvas/WidgetTile.tsx"),
    "utf8",
  );
  // truncate clips to a single line and was the main reason long titles got
  // cut at the 780px tablet breakpoint. The polish PR moves them to a
  // two-line clamp so the right edge doesn't lose meaning.
  assert.doesNotMatch(
    widgetTileSource,
    /titleClass[\s\S]{0,400}\btruncate\b/,
    "Card titles must not use single-line truncate; they should wrap to two lines",
  );
  assert.match(
    widgetTileSource,
    /line-clamp-2/,
    "Card titles must wrap to a two-line clamp",
  );
});

test("Canvas chrome stays free of 0-source rendering and product-y synthesis labels", () => {
  const widgetTileSource = readFileSync(
    path.join(__dirname, "../web/components/canvas/WidgetTile.tsx"),
    "utf8",
  );
  const tilesSource = readFileSync(
    path.join(__dirname, "../web/components/canvas/tiles.tsx"),
    "utf8",
  );
  const cockpitSource = readFileSync(
    path.join(__dirname, "../web/components/canvas/ExecutiveCockpit.tsx"),
    "utf8",
  );
  const readOnlyCanvasSource = readFileSync(
    path.join(__dirname, "../web/components/canvas/ReadOnlyCanvasView.tsx"),
    "utf8",
  );
  assert.match(
    readOnlyCanvasSource,
    /sourceCount > 0 &&/,
    "Canvas detail footer should suppress empty source counts instead of rendering 0 sources",
  );
  assert.match(
    readOnlyCanvasSource,
    /evidenceCount > 0 &&/,
    "Canvas detail footer should suppress empty evidence counts instead of rendering 0 evidence items",
  );
  for (const [name, source] of [
    ["WidgetTile.tsx", widgetTileSource],
    ["tiles.tsx", tilesSource],
    ["ExecutiveCockpit.tsx", cockpitSource],
    ["ReadOnlyCanvasView.tsx", readOnlyCanvasSource],
  ] as const) {
    assert.doesNotMatch(
      source,
      /"0 source[s]?"/,
      `${name} must not render a literal "0 sources" string`,
    );
    assert.doesNotMatch(
      source,
      /Brief[-\s]derived/i,
      `${name} must not render the "Brief-derived" product-y label`,
    );
    assert.doesNotMatch(
      source,
      /Hermes synthesis( from saved brief)?/i,
      `${name} must not render the "Hermes synthesis" product-y label`,
    );
  }
});

test("Canvas widget chrome hides draft scaffolding from normal fresh cards", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/canvas/WidgetTile.tsx"),
    "utf8",
  );
  assert.match(source, /shouldShowStatusChip/, "freshness visibility should be centralized and conditional");
  assert.match(source, /shouldShowStatusChip\(widget\.status\) && <StatusChip status=\{widget\.status\} \/>/, "fresh status should only appear through the conditional helper");
  assert.doesNotMatch(source, /\{widget\.sources\.length\} source/, "zero-source counts should not be rendered mechanically on every card");
  assert.match(source, /provenanceSummary/, "cards should summarize provenance instead of dumping raw source counts");
  assert.match(source, /function sectionLabel/, "section cards should translate brief keys into executive-facing labels");
  assert.match(source, /Account context/);
  assert.match(source, /Decision path/);
});

test("Canvas header copy presents Hermes as the strategic layout driver", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/canvas/ReadOnlyCanvasView.tsx"),
    "utf8",
  );
  assert.match(source, /Hermes-built strategic canvas/);
  assert.match(source, /Hermes arranges/);
  assert.match(source, /Review mode/);
  assert.doesNotMatch(source, /Controls disabled/);
  assert.doesNotMatch(source, /Widget actions are disabled/);
  assert.doesNotMatch(source, />\s*widgets\s*</i, "header should not expose internal widget terminology");
  assert.match(source, /priority areas|strategic modules|account signals/i, "header stats should use executive-facing labels");
});

test("Canvas registry uses executive-facing labels instead of internal object labels", () => {
  assert.equal(getDescriptor("section_ref").label, "Brief insight");
  assert.equal(getDescriptor("metric").label, "Account signal");
  assert.equal(getDescriptor("action_panel").label, "Recommended move");
});

test("Canvas adapter suppresses empty discovery-gap and sparse count-only metrics", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const ids = canvas.widgets.map((w) => w.id);

  assert.equal(ids.includes("open-questions"), false, "empty open questions should not occupy a full card");
  assert.equal(ids.includes("metric-sources"), false, "source count belongs in the header, not a sparse metric card");
  assert.equal(ids.includes("metric-initiatives"), false, "initiative count belongs in narrative widgets, not a sparse metric card");
});

test("section previews preserve the executive point without raw long-text clipping", () => {
  const longSnapshot = [
    "The executive answer should fit on the card and preserve the complete first point.",
    "Second sentence contains implementation detail that belongs in the drill-in panel rather than the tile preview.",
    "Third sentence adds more context for the full detail view.",
  ].join(" ");
  const brief = Brief.parse({ ...sampleBriefJson, snapshot: longSnapshot });
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const snapshot = canvas.widgets.find((w) => w.id === "section-snapshot");

  assert.ok(snapshot);
  assert.equal(snapshot?.kind, "section_ref");
  if (snapshot?.kind !== "section_ref") return;

  assert.equal(
    snapshot.data.preview,
    "The executive answer should fit on the card and preserve the complete first point.",
  );
  assert.equal((snapshot.data as { full_text?: string }).full_text, longSnapshot);
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
    // PR-N: action_panel now emits the Hermes recommended-action queue,
    // so we may see multiple ranked actions. The primary recommendation
    // must still be brief.next_action verbatim (no fabrication).
    assert.ok(panel.data.actions.length >= 1);
    const first = panel.data.actions[0];
    if ("recommendation" in first) {
      assert.equal(first.recommendation, brief.next_action);
    } else if ("label" in first) {
      assert.equal(first.detail, brief.next_action);
    } else {
      assert.fail("expected legacy {label, detail} or hermes {recommendation, ...} shape");
    }
  }
});

// ---- registry --------------------------------------------------------------

test("production canvas registry covers every widget kind including extension", () => {
  assert.deepEqual(
    [...ALL_WIDGET_KINDS].sort(),
    [
      "action_panel",
      "ai_takeaways",
      "evidence_board",
      "extension",
      "metric",
      "momentum_strip",
      "open_questions",
      "opportunity_risk_split",
      "section_ref",
      "strategic_signal_radar",
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

// ---- visual helpers (PR #14 polish) -----------------------------------------

test("parseFractionValue matches simple N/M strings", () => {
  assert.deepEqual(parseFractionValue("4/5"), { current: 4, max: 5 });
  assert.deepEqual(parseFractionValue("3 / 5"), { current: 3, max: 5 });
  assert.deepEqual(parseFractionValue(" 2/10 "), { current: 2, max: 10 });
});

test("parseFractionValue rejects non-fraction values", () => {
  assert.equal(parseFractionValue("12"), null);
  assert.equal(parseFractionValue("not a number"), null);
  assert.equal(parseFractionValue(""), null);
  assert.equal(parseFractionValue(undefined), null);
  assert.equal(parseFractionValue(null), null);
  assert.equal(parseFractionValue(7 as unknown), null);
});

test("parseFractionValue rejects out-of-range pairs", () => {
  assert.equal(parseFractionValue("6/5"), null, "current must not exceed max");
  assert.equal(parseFractionValue("3/0"), null, "max must be positive");
});

test("confidenceBucket maps known labels and falls back to 'na'", () => {
  assert.equal(confidenceBucket("High"), "high");
  assert.equal(confidenceBucket("MEDIUM"), "medium");
  assert.equal(confidenceBucket("low"), "low");
  assert.equal(confidenceBucket("Not found"), "na");
  assert.equal(confidenceBucket(undefined), "na");
  assert.equal(confidenceBucket(null), "na");
  assert.equal(confidenceBucket(42 as unknown), "na");
  assert.equal(confidenceBucket("garbage"), "na");
});

test("aggregateConfidence counts each bucket and tolerates noise", () => {
  const counts = aggregateConfidence([
    { confidence: "High" },
    { confidence: "high" },
    { confidence: "Medium" },
    { confidence: "Low" },
    { confidence: "Not found" },
    { confidence: undefined },
    null,
    undefined,
  ] as Array<{ confidence?: unknown } | null | undefined>);
  assert.deepEqual(counts, { high: 2, medium: 1, low: 1, na: 4 });
});

test("aggregateConfidence handles empty / non-array input", () => {
  assert.deepEqual(
    aggregateConfidence([]),
    { high: 0, medium: 0, low: 0, na: 0 },
  );
  assert.deepEqual(
    aggregateConfidence(undefined as unknown as []),
    { high: 0, medium: 0, low: 0, na: 0 },
  );
});

test("sourceTypeLabel returns a human label and never throws on unknown input", () => {
  assert.equal(sourceTypeLabel("system"), "System");
  assert.equal(sourceTypeLabel("research"), "Research");
  assert.equal(sourceTypeLabel("HERMES"), "Hermes");
  assert.equal(sourceTypeLabel(""), "Source");
  assert.equal(sourceTypeLabel(undefined), "Source");
  assert.equal(sourceTypeLabel(null), "Source");
  assert.equal(sourceTypeLabel("legacy-unknown"), "Source");
  assert.equal(sourceTypeLabel(123 as unknown), "Source");
});

test("sectionKeyTone maps known section_keys to tones", () => {
  assert.equal(sectionKeyTone("risks"), "risk");
  assert.equal(sectionKeyTone("competitive_signals"), "signal");
  assert.equal(sectionKeyTone("recent_signals"), "signal");
  assert.equal(sectionKeyTone("top_initiatives"), "opportunity");
  assert.equal(sectionKeyTone("snapshot"), "neutral");
  assert.equal(sectionKeyTone(undefined), "neutral");
  assert.equal(sectionKeyTone(42 as unknown), "neutral");
});

test("confidenceWeight maps buckets to bar widths and handles unknowns", () => {
  assert.equal(confidenceWeight("High"), 1);
  assert.equal(confidenceWeight("Medium"), 0.66);
  assert.equal(confidenceWeight("Low"), 0.33);
  assert.equal(confidenceWeight("Not found"), 0.12);
  assert.equal(confidenceWeight(undefined), 0.12);
  assert.equal(confidenceWeight("garbage"), 0.12);
});

test("summarizeLandscapeLabel keeps chart row labels compact and word-safe", () => {
  assert.equal(
    summarizeLandscapeLabel(
      "Furhat Robotics completed a formal second acquisition of Misty Robotics business assets in April/May 2024, deepening integration of Misty into Furhat's global product portfolio.",
      72,
    ),
    "Furhat Robotics completed a formal second acquisition of Misty Robotics…",
  );
  assert.equal(
    summarizeLandscapeLabel(
      "Roadmap risk: multi-timezone parent/subsidiary approvals may slow deal cycles for education partnerships.",
      72,
    ),
    "Roadmap risk",
  );
  assert.equal(summarizeLandscapeLabel("  Short   row label  "), "Short row label");
  assert.equal(summarizeLandscapeLabel(""), "—");
  assert.equal(summarizeLandscapeLabel(undefined), "—");
});

test("Canvas-native modules: structured evidence is seeded on the right section_refs", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });

  const expectations: Array<{ id: string; min: number; tag?: boolean }> = [
    { id: "section-top-initiatives", min: 1, tag: true },
    { id: "section-recent-signals", min: 1 },
    { id: "section-personas", min: 1, tag: true },
    { id: "section-risks", min: 1 },
    { id: "section-competitive-signals", min: 1 },
  ];
  for (const exp of expectations) {
    const w = canvas.widgets.find((x) => x.id === exp.id);
    assert.ok(w, `${exp.id} should exist`);
    if (!w) continue;
    assert.ok(
      w.evidence.length >= exp.min,
      `${exp.id} should carry structured evidence (>= ${exp.min}); got ${w.evidence.length}`,
    );
    assert.ok(
      w.evidence.every((e) => typeof e.text === "string" && e.text.length > 0),
      `${exp.id} evidence rows must carry a non-empty text`,
    );
    if (exp.tag) {
      assert.ok(
        w.evidence.some((e) => typeof e.tag === "string" && e.tag!.length > 0),
        `${exp.id} should populate at least one evidence.tag`,
      );
    }
  }
});

test("section-top-initiatives is paired with section-risks on the same row (6+6)", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const opp = canvas.widgets.find((x) => x.id === "section-top-initiatives");
  const risk = canvas.widgets.find((x) => x.id === "section-risks");
  assert.ok(opp);
  assert.ok(risk);
  assert.equal(opp?.layout.w, 6);
  assert.equal(risk?.layout.w, 6);
  assert.equal(opp?.layout.y, risk?.layout.y);
});

test("non-landscape section_refs (e.g. snapshot) keep evidence empty", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const snapshot = canvas.widgets.find((x) => x.id === "section-snapshot");
  assert.ok(snapshot);
  assert.equal(snapshot?.evidence.length, 0);
});

// ---- Executive Cockpit selectors (PR: canvas-executive-cockpit-row) --------

import {
  buildExecutiveCockpit,
  selectMaturity,
  selectTopOpportunity,
  selectTopRisk,
  selectEvidenceSummary,
  selectNextAction,
} from "../web/lib/canvas/cockpit";

test("buildExecutiveCockpit derives every cell from the sample brief", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const cockpit = buildExecutiveCockpit(canvas);
  assert.ok(cockpit.maturity, "maturity cell should be derived");
  assert.ok(cockpit.topOpportunity, "top opportunity cell should be derived");
  assert.ok(cockpit.topRisk, "top risk cell should be derived");
  assert.ok(cockpit.evidence, "evidence summary cell should be derived");
  assert.ok(cockpit.nextAction, "next action cell should be derived");
});

test("selectMaturity parses metric-ai-maturity fraction values", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const m = selectMaturity(canvas);
  assert.ok(m);
  assert.equal(m?.current, brief.ai_tech_maturity.rating);
  assert.equal(m?.max, 5);
  assert.equal(typeof m?.rationale, "string");
});

test("selectTopOpportunity returns the first initiative title from structured evidence", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const op = selectTopOpportunity(canvas);
  assert.ok(op);
  assert.equal(op?.text, brief.top_initiatives[0]?.title);
});

test("selectTopRisk returns the first risk from structured evidence", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const r = selectTopRisk(canvas);
  assert.ok(r);
  assert.equal(r?.text, brief.risks[0]);
});

test("selectEvidenceSummary total matches the evidence-board item count", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const board = canvas.widgets.find((w) => w.id === "evidence-board");
  assert.ok(board);
  if (!board || board.kind !== "evidence_board") return;
  const summary = selectEvidenceSummary(canvas);
  assert.ok(summary);
  assert.equal(summary?.total, board.data.items.length);
  const bucketSum =
    (summary?.counts.high ?? 0) +
    (summary?.counts.medium ?? 0) +
    (summary?.counts.low ?? 0) +
    (summary?.counts.na ?? 0);
  assert.equal(bucketSum, board.data.items.length);
});

test("selectNextAction surfaces brief.next_action verbatim", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const a = selectNextAction(canvas);
  assert.ok(a);
  assert.equal(a?.detail, brief.next_action);
});

test("buildExecutiveCockpit on a zero-widget canvas returns all null and does not throw", () => {
  const empty: Parameters<typeof buildExecutiveCockpit>[0] = {
    account_id: "x",
    account_name: "Empty",
    version: 1,
    generated_at: "2026-05-13T00:00:00.000Z",
    widgets: [],
    meta: {
      layout_mode: "grid",
      pinned_order: [],
      agent_readiness: {
        mode: "read_only_preview",
        generated_from: "saved_brief",
        controls_enabled: false,
        source_count: 0,
        evidence_count: 0,
      },
    },
  };
  const cockpit = buildExecutiveCockpit(empty);
  assert.equal(cockpit.maturity, null);
  assert.equal(cockpit.topOpportunity, null);
  assert.equal(cockpit.topRisk, null);
  assert.equal(cockpit.evidence, null);
  assert.equal(cockpit.nextAction, null);
});

test("non-fraction maturity value returns null without breaking other selectors", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  // Surgically replace the maturity metric value with a non-fraction string.
  const mutated = {
    ...canvas,
    widgets: canvas.widgets.map((w) =>
      w.id === "metric-ai-maturity" && w.kind === "metric"
        ? { ...w, data: { ...w.data, value: "?" } }
        : w,
    ),
  } as typeof canvas;
  assert.equal(selectMaturity(mutated), null);
  // Other selectors continue to derive their cells.
  assert.ok(selectTopOpportunity(mutated));
  assert.ok(selectTopRisk(mutated));
  assert.ok(selectEvidenceSummary(mutated));
  assert.ok(selectNextAction(mutated));
});

test("ReadOnlyCanvasView mounts ExecutiveCockpit before the widget grid", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/canvas/ReadOnlyCanvasView.tsx"),
    "utf8",
  );
  const cockpitIndex = source.indexOf("<ExecutiveCockpit");
  const gridIndex = source.indexOf('data-testid="widget-grid"');
  assert.ok(cockpitIndex >= 0, "ReadOnlyCanvasView must import / render ExecutiveCockpit");
  assert.ok(gridIndex >= 0, "ReadOnlyCanvasView must keep the widget-grid testid");
  assert.ok(
    cockpitIndex < gridIndex,
    "ExecutiveCockpit must be mounted before the widget grid",
  );
});

// ---- Canvas v2 strategic workspace (Phase 1) -------------------------------

import {
  buildStrategicSignalRadar,
  buildOpportunityRiskSplit,
  buildMomentumStrip,
  buildAITakeaways,
} from "../web/lib/canvas/strategicInsights";

test("Strategic Signal Radar buckets signals into four quadrants without throwing", () => {
  const brief = Brief.parse(sampleBriefJson);
  const radar = buildStrategicSignalRadar(brief);
  assert.equal(radar.quadrants.length, 4);
  const keys = radar.quadrants.map((q) => q.key);
  assert.deepEqual(
    [...keys].sort(),
    ["leadership", "procurement", "strategy", "tech"],
    "radar must always expose all four quadrants",
  );
  for (const q of radar.quadrants) {
    assert.equal(typeof q.count, "number");
    assert.ok(q.count >= 0);
    assert.equal(typeof q.label, "string");
    assert.ok(q.label.length > 0);
  }
});

test("Strategic Signal Radar tolerates empty signals (no throw, all-zero quadrants)", () => {
  const brief = Brief.parse({
    ...sampleBriefJson,
    recent_signals: [],
    competitive_signals: [],
  });
  const radar = buildStrategicSignalRadar(brief);
  assert.equal(radar.quadrants.length, 4);
  for (const q of radar.quadrants) {
    assert.equal(q.count, 0);
    assert.equal(q.sample, undefined);
    assert.equal(q.confidence, undefined);
  }
});

test("Strategic Signal Radar attributes a known signal to its quadrant", () => {
  const brief = Brief.parse({
    ...sampleBriefJson,
    recent_signals: [
      {
        text: "Selected new CISO from a top academic medical center.",
        source: "Becker's Hospital Review",
        confidence: "High",
      },
    ],
    competitive_signals: [],
  });
  const radar = buildStrategicSignalRadar(brief);
  const leadership = radar.quadrants.find((q) => q.key === "leadership");
  assert.ok(leadership);
  assert.equal(leadership?.count, 1);
  assert.equal(leadership?.confidence, "High");
  assert.ok(leadership?.sample && leadership.sample.includes("CISO"));
});

test("Opportunity / Risk Split surfaces top initiative + top risk and computes balance", () => {
  const brief = Brief.parse(sampleBriefJson);
  const split = buildOpportunityRiskSplit(brief);
  assert.equal(split.opportunities.count, brief.top_initiatives.length);
  assert.equal(split.risks.count, brief.risks.length);
  assert.ok(split.opportunities.top);
  assert.equal(
    split.opportunities.top?.text,
    brief.top_initiatives[0]?.title,
  );
  assert.equal(split.risks.top?.text, brief.risks[0]);
  assert.ok(["opportunity-heavy", "risk-heavy", "balanced"].includes(split.balance));
});

test("Opportunity / Risk Split handles empty arrays gracefully", () => {
  const brief = Brief.parse({
    ...sampleBriefJson,
    top_initiatives: [],
    risks: [],
  });
  const split = buildOpportunityRiskSplit(brief);
  assert.equal(split.opportunities.count, 0);
  assert.equal(split.risks.count, 0);
  assert.equal(split.opportunities.top, null);
  assert.equal(split.risks.top, null);
  assert.equal(split.balance, "balanced");
});

test("Momentum Strip computes four segments and a velocity label from brief metadata", () => {
  const brief = Brief.parse(sampleBriefJson);
  const strip = buildMomentumStrip(brief);
  assert.equal(strip.segments.length, 4);
  const segKeys = strip.segments.map((s) => s.key);
  assert.deepEqual(
    [...segKeys].sort(),
    ["initiatives", "pilots", "programs", "signals"],
  );
  const totalCalc = strip.segments.reduce((n, s) => n + s.count, 0);
  assert.equal(strip.total, totalCalc);
  assert.ok(
    ["High momentum", "Steady", "Low momentum", "Quiet"].includes(
      strip.velocity_label,
    ),
  );
});

test("Momentum Strip returns Quiet on a brief with no signals/initiatives/pilots/programs", () => {
  const brief = Brief.parse({
    ...sampleBriefJson,
    recent_signals: [],
    top_initiatives: [],
    technical_footprint: {
      ...sampleBriefJson.technical_footprint,
      active_pilots: [],
    },
    programs_procurement: {
      ...sampleBriefJson.programs_procurement,
      active_rfps_contracts: [],
    },
  });
  const strip = buildMomentumStrip(brief);
  assert.equal(strip.total, 0);
  assert.equal(strip.velocity_label, "Quiet");
});

test("AI Takeaways panel produces 3-5 deterministic takeaways with provenance", () => {
  const brief = Brief.parse(sampleBriefJson);
  const tk = buildAITakeaways(brief);
  assert.ok(tk.takeaways.length >= 3);
  assert.ok(tk.takeaways.length <= 5);
  for (const t of tk.takeaways) {
    assert.equal(typeof t.headline, "string");
    assert.ok(t.headline.length > 0);
    assert.equal(typeof t.detail, "string");
    assert.ok(t.detail.length > 0);
    assert.equal(typeof t.source_field, "string");
    assert.ok(t.source_field.length > 0);
  }
  // must reference brief.next_action verbatim in the action takeaway
  assert.ok(
    tk.takeaways.some(
      (t) =>
        t.source_field === "next_action" && t.detail === brief.next_action,
    ),
    "next_action takeaway should quote brief.next_action verbatim",
  );
});

test("AI Takeaways skips takeaways whose source field is empty", () => {
  const brief = Brief.parse({
    ...sampleBriefJson,
    next_action: "",
    buying_path: "",
    risks: [],
  });
  const tk = buildAITakeaways(brief);
  for (const t of tk.takeaways) {
    assert.notEqual(t.source_field, "next_action");
    assert.notEqual(t.source_field, "buying_path");
    assert.notEqual(t.source_field, "risks");
  }
});

test("Canvas.parse accepts the four new strategic widget kinds", () => {
  const baseEnvelope = {
    description: "",
    source: "hermes",
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    why_included: "Deterministic strategic insight.",
    sources: [],
    controls: {
      can_refresh: false,
      can_remove: false,
      can_edit: false,
      can_export: false,
    },
    status: "fresh",
    evidence: [],
  };
  const parsed = Canvas.parse({
    account_id: "x",
    account_name: "Strategic Workspace",
    version: 1,
    generated_at: "2026-05-15T00:00:00.000Z",
    widgets: [
      {
        ...baseEnvelope,
        id: "insight-signal-radar",
        kind: "strategic_signal_radar",
        title: "Strategic signal radar",
        layout: { x: 0, y: 0, w: 6, h: 4, pinned: false, collapsed: false },
        data: {
          quadrants: [
            { key: "strategy", label: "Strategy", count: 2, confidence: "High" },
            { key: "tech", label: "Tech & AI", count: 1 },
            { key: "procurement", label: "Procurement", count: 0 },
            { key: "leadership", label: "Leadership", count: 0 },
          ],
        },
      },
      {
        ...baseEnvelope,
        id: "insight-opportunity-risk",
        kind: "opportunity_risk_split",
        title: "Opportunity / risk split",
        layout: { x: 6, y: 0, w: 6, h: 4, pinned: false, collapsed: false },
        data: {
          opportunities: {
            count: 3,
            top: { text: "Cloud", confidence: "High", tag: "Lakehouse" },
          },
          risks: { count: 2, top: { text: "Security" } },
          balance: "opportunity-heavy",
        },
      },
      {
        ...baseEnvelope,
        id: "insight-momentum-strip",
        kind: "momentum_strip",
        title: "Momentum",
        layout: { x: 0, y: 4, w: 12, h: 2, pinned: false, collapsed: false },
        data: {
          segments: [
            { key: "signals", label: "Signals", count: 3 },
            { key: "initiatives", label: "Initiatives", count: 4 },
            { key: "pilots", label: "Pilots", count: 1 },
            { key: "programs", label: "Programs", count: 2 },
          ],
          total: 10,
          velocity_label: "High momentum",
        },
      },
      {
        ...baseEnvelope,
        id: "insight-ai-takeaways",
        kind: "ai_takeaways",
        title: "AI takeaways",
        layout: { x: 0, y: 6, w: 12, h: 4, pinned: false, collapsed: false },
        data: {
          takeaways: [
            {
              headline: "Maturity 4/5",
              detail: "Deploying at scale",
              source_field: "ai_tech_maturity",
            },
          ],
        },
      },
    ],
    meta: {
      layout_mode: "grid",
      pinned_order: [],
      agent_readiness: {
        mode: "read_only_preview",
        generated_from: "saved_brief",
        controls_enabled: false,
        source_count: 0,
        evidence_count: 0,
      },
    },
  });
  assert.equal(parsed.widgets.length, 4);
  assert.equal(parsed.widgets[0].kind, "strategic_signal_radar");
  assert.equal(parsed.widgets[1].kind, "opportunity_risk_split");
  assert.equal(parsed.widgets[2].kind, "momentum_strip");
  assert.equal(parsed.widgets[3].kind, "ai_takeaways");
});

test("buildReadOnlyCanvasFromBrief emits the four strategic Hermes widgets with controls disabled", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const ids = [
    "insight-ai-takeaways",
    "insight-signal-radar",
    "insight-opportunity-risk",
    "insight-momentum-strip",
  ];
  for (const id of ids) {
    const w = canvas.widgets.find((x) => x.id === id);
    assert.ok(w, `widget ${id} should be emitted`);
    if (!w) continue;
    assert.equal(w.source, "hermes");
    assert.equal(w.status, "fresh");
    assert.equal(w.controls.can_edit, false);
    assert.equal(w.controls.can_remove, false);
    assert.equal(w.controls.can_refresh, false);
    assert.equal(w.controls.can_export, false);
    assert.ok(w.why_included && w.why_included.length > 0);
  }
  // pre-existing surfaces are preserved
  assert.ok(canvas.widgets.some((w) => w.id === "evidence-board"));
  assert.ok(canvas.widgets.some((w) => w.id === "section-top-initiatives"));
  assert.ok(canvas.widgets.some((w) => w.id === "action-next"));
});

test("registry covers the four new strategic widget kinds", () => {
  const required = [
    "strategic_signal_radar",
    "opportunity_risk_split",
    "momentum_strip",
    "ai_takeaways",
  ];
  for (const kind of required) {
    assert.ok(
      ALL_WIDGET_KINDS.includes(kind as never),
      `${kind} should be in ALL_WIDGET_KINDS`,
    );
    const d = getDescriptor(kind as never);
    assert.equal(d.kind, kind);
    assert.equal(typeof d.Tile, "function");
    assert.equal(typeof d.Detail, "function");
  }
});

// ---- Hermes recommended action queue --------------------------------------

test("Canvas schema accepts the Hermes recommended-action shape", () => {
  const parsed = Canvas.parse({
    account_id: "rec-1",
    account_name: "Rec",
    version: 1,
    generated_at: "2026-05-14T00:00:00.000Z",
    widgets: [
      {
        id: "action-next",
        kind: "action_panel",
        title: "Recommended next moves",
        description: "",
        source: "hermes",
        created_at: "2026-05-14T00:00:00.000Z",
        updated_at: "2026-05-14T00:00:00.000Z",
        sources: [],
        layout: { x: 0, y: 0, w: 12, h: 4, pinned: false, collapsed: false },
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
            {
              recommendation: "Request a 30-minute meeting with the CMIO.",
              rationale: "Saved brief ranks this as primary.",
              expected_outcome: "First conversation booked.",
              evidence: [
                { text: "brief.next_action", source: "brief.next_action", tag: "primary" },
              ],
              approval_state: "suggested",
              severity: "high",
            },
          ],
        },
      },
    ],
    meta: { layout_mode: "grid", pinned_order: ["action-next"] },
  });
  const w = parsed.widgets[0];
  assert.equal(w.kind, "action_panel");
  if (w.kind === "action_panel") {
    const a = w.data.actions[0];
    assert.ok("recommendation" in a);
    if ("recommendation" in a) {
      assert.equal(a.approval_state, "suggested");
      assert.equal(a.severity, "high");
    }
  }
});

test("buildRecommendedActions emits 2-4 rich actions for the sample brief", () => {
  const brief = Brief.parse(sampleBriefJson);
  const actions = buildRecommendedActions(brief);
  assert.ok(actions.length >= 2, `expected >= 2 actions, got ${actions.length}`);
  assert.ok(actions.length <= 4, `expected <= 4 actions, got ${actions.length}`);
  for (const a of actions) {
    assert.equal(typeof a.recommendation, "string");
    assert.ok(a.recommendation.length > 0);
    assert.equal(typeof a.rationale, "string");
    assert.ok(a.rationale.length > 0);
    assert.equal(typeof a.expected_outcome, "string");
    assert.ok(a.expected_outcome.length > 0);
    assert.equal(a.approval_state, "suggested");
    assert.ok(["low", "medium", "high"].includes(a.severity));
    assert.ok(Array.isArray(a.evidence));
  }
});

test("buildRecommendedActions first action equals brief.next_action verbatim", () => {
  const brief = Brief.parse(sampleBriefJson);
  const actions = buildRecommendedActions(brief);
  assert.ok(actions.length >= 1);
  assert.equal(actions[0].recommendation, brief.next_action);
  assert.equal(actions[0].severity, "high");
});

test("buildRecommendedActions evidence is drawn from saved brief fields verbatim", () => {
  const brief = Brief.parse(sampleBriefJson);
  const actions = buildRecommendedActions(brief);
  const primary = actions[0];
  // Primary evidence references brief.next_action verbatim
  const primaryEv = primary.evidence.find((e) => e.tag === "primary");
  assert.ok(primaryEv);
  assert.equal(primaryEv!.text, brief.next_action);

  // Risk action (if present) cites the brief.risks[0] string verbatim
  const riskAction = actions.find((a) => a.risk !== undefined);
  if (riskAction) {
    assert.equal(riskAction.risk, brief.risks[0]);
    const riskEv = riskAction.evidence.find((e) => e.tag === "risk");
    assert.ok(riskEv);
    assert.equal(riskEv!.text, brief.risks[0]);
  }
});

test("buildRecommendedActions returns [] for a sparse brief; fromBrief falls back to legacy shape", () => {
  const sparse = Brief.parse({
    ...sampleBriefJson,
    next_action: "",
    top_initiatives: [],
    personas: [],
    buying_path: "",
    risks: [],
    competitive_signals: [],
    recent_signals: [],
    first_angle: "",
  });
  const actions = buildRecommendedActions(sparse);
  assert.equal(actions.length, 0);

  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sparse", brief: sparse });
  const panel = canvas.widgets.find((w) => w.id === "action-next");
  assert.ok(panel);
  if (panel && panel.kind === "action_panel") {
    assert.ok(panel.data.actions.length >= 1);
    const first = panel.data.actions[0];
    assert.ok("label" in first, "sparse brief should fall back to legacy {label, detail}");
    if ("label" in first) {
      assert.equal(first.detail, "");
    }
  }
});

test("action_panel widget keeps all controls disabled", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const panel = canvas.widgets.find((w) => w.id === "action-next");
  assert.ok(panel);
  assert.equal(panel!.controls.can_refresh, false);
  assert.equal(panel!.controls.can_remove, false);
  assert.equal(panel!.controls.can_edit, false);
  assert.equal(panel!.controls.can_export, false);
});

test("canvas action tiles + details expose no Run/Execute/Approve/Dismiss button labels", () => {
  const tilesSrc = readFileSync(
    path.join(__dirname, "..", "web", "components", "canvas", "tiles.tsx"),
    "utf8",
  );
  const detailsSrc = readFileSync(
    path.join(__dirname, "..", "web", "components", "canvas", "details.tsx"),
    "utf8",
  );
  for (const src of [tilesSrc, detailsSrc]) {
    assert.ok(!/>\s*Run\s*</.test(src), "found >Run< button label");
    assert.ok(!/>\s*Execute\s*</.test(src), "found >Execute< button label");
    assert.ok(!/>\s*Approve\s*</.test(src), "found >Approve< button label");
    assert.ok(!/>\s*Dismiss\s*</.test(src), "found >Dismiss< button label");
  }
});

// ---- Canvas generative workspace polish (PR: canvas-generative-workspace-polish)

import { widgetFraming } from "../web/lib/canvas/framing";

function makeBaseEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    description: "",
    source: "system",
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    sources: [],
    layout: { x: 0, y: 0, w: 6, h: 3, pinned: false, collapsed: false },
    controls: {
      can_refresh: false,
      can_remove: false,
      can_edit: false,
      can_export: false,
    },
    status: "fresh",
    evidence: [],
    ...overrides,
  };
}

test("widgetFraming returns 'Recommended move' eyebrow for action_panel", () => {
  const w = {
    ...makeBaseEnvelope(),
    id: "action-next",
    kind: "action_panel",
    title: "Recommended next moves",
    data: { actions: [] },
  } as never;
  const f = widgetFraming(w);
  assert.equal(f.eyebrow, "Recommended move");
});

test("widgetFraming returns configured eyebrows for section_key risks / personas / programs_procurement", () => {
  const risks = widgetFraming({
    ...makeBaseEnvelope(),
    id: "section-risks",
    kind: "section_ref",
    title: "Risks",
    data: { section_key: "risks", preview: "" },
  } as never);
  assert.equal(risks.eyebrow, "Caveats before acting");

  const personas = widgetFraming({
    ...makeBaseEnvelope(),
    id: "section-personas",
    kind: "section_ref",
    title: "Personas",
    data: { section_key: "personas", preview: "" },
  } as never);
  assert.equal(personas.eyebrow, "Likely buying committee");

  const pp = widgetFraming({
    ...makeBaseEnvelope(),
    id: "section-pp",
    kind: "section_ref",
    title: "Programs & procurement",
    data: { section_key: "programs_procurement", preview: "" },
  } as never);
  assert.equal(pp.eyebrow, "Procurement context");
});

test("widgetFraming returns empty oneLine when underlying data is empty (no fabrication)", () => {
  const empty = widgetFraming({
    ...makeBaseEnvelope(),
    id: "x",
    kind: "ai_takeaways",
    title: "AI takeaways",
    data: { takeaways: [] },
  } as never);
  assert.equal(empty.oneLine, "");

  const emptyAction = widgetFraming({
    ...makeBaseEnvelope(),
    id: "x",
    kind: "action_panel",
    title: "Recommended next moves",
    data: { actions: [] },
  } as never);
  assert.equal(emptyAction.oneLine, "");

  const emptyOQ = widgetFraming({
    ...makeBaseEnvelope(),
    id: "x",
    kind: "open_questions",
    title: "Open questions",
    data: { questions: [] },
  } as never);
  assert.equal(emptyOQ.oneLine, "");
});

test("buildReadOnlyCanvasFromBrief places action-next first in the grid (y=0, w=12)", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  const action = canvas.widgets.find((w) => w.id === "action-next");
  assert.ok(action);
  assert.equal(action?.layout.y, 0);
  assert.equal(action?.layout.x, 0);
  assert.equal(action?.layout.w, 12);
  // No other widget should sit on row 0 above-or-equal-to action-next.
  const sameRow = canvas.widgets.filter((w) => w.layout.y === 0 && w.id !== "action-next");
  assert.equal(sameRow.length, 0, "action-next must be the only widget on row y=0");
});

test("buildReadOnlyCanvasFromBrief widgets are non-overlapping on the 12-col grid", () => {
  const brief = Brief.parse(sampleBriefJson);
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: "sample", brief });
  // Inflate every widget into the (x,y) cells it occupies, then assert
  // no two widgets claim the same cell.
  const occupied = new Map<string, string>(); // key "x,y" -> widget id
  for (const w of canvas.widgets) {
    for (let dy = 0; dy < w.layout.h; dy++) {
      for (let dx = 0; dx < w.layout.w; dx++) {
        const k = `${w.layout.x + dx},${w.layout.y + dy}`;
        const prev = occupied.get(k);
        assert.equal(
          prev,
          undefined,
          `cell ${k} is claimed by both ${prev} and ${w.id}`,
        );
        occupied.set(k, w.id);
      }
    }
  }
});

test("WidgetTile renders the framing eyebrow + oneLine as a synthesized sentence", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/WidgetTile.tsx"),
    "utf8",
  );
  assert.match(src, /widgetFraming/);
  assert.match(src, /data-testid="widget-framing"/);
  assert.match(src, /min-w-0/);
  assert.match(src, /break-words/);
});

test("ActionPanelTile primary line is unclamped and renders expected_outcome + rationale", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/tiles.tsx"),
    "utf8",
  );
  // The primary line block should not carry a CSS clamp on the title.
  const startIdx = src.indexOf("function ActionPanelTile");
  const endIdx = src.indexOf("\nexport function OpenQuestionsTile");
  const actionTile = src.slice(startIdx, endIdx);
  assert.ok(
    !/text-sm font-semibold leading-snug line-clamp-3/.test(actionTile),
    "primary recommendation must not use line-clamp-3",
  );
  assert.match(actionTile, /Expected outcome/);
  assert.match(actionTile, /\bWhy\b/);
});

test("ExtensionTile table renderer wraps the table in a horizontally scrollable container", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/tiles.tsx"),
    "utf8",
  );
  assert.match(src, /overflow-x-auto/);
});

test("ReadOnlyCanvasView header uses flex-wrap so narrow viewports do not overflow", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/ReadOnlyCanvasView.tsx"),
    "utf8",
  );
  assert.match(src, /flex-wrap/);
});

test("globals.css clamps horizontal overflow to prevent narrow-viewport runaway", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/app/globals.css"),
    "utf8",
  );
  assert.match(src, /overflow-x:\s*hidden/);
});

// ---- PR #25 polish: copy sweep, pointer, dossier, mobile table -----------

import {
  extractTiming,
  extractTarget,
  truncateForPointer,
} from "../web/lib/canvas/actionExtract";

test("extractTiming: 'today' is detected", () => {
  assert.equal(extractTiming("Send a follow-up note today."), "Today");
});

test("extractTiming: 'Before end of quarter' is detected", () => {
  const t = extractTiming(
    "Before end of quarter, sequence the buying committee.",
  );
  assert.ok(t !== null);
  assert.match(t!.toLowerCase(), /quarter/);
});

test("extractTiming: returns null when no timing phrase matches", () => {
  assert.equal(extractTiming("Generic ask without timing."), null);
});

test("extractTiming: handles empty / undefined", () => {
  assert.equal(extractTiming(""), null);
  assert.equal(extractTiming(undefined), null);
});

test("extractTarget: CMIO via warm intro is captured", () => {
  const t = extractTarget({
    recommendation:
      "Request a 30-minute meeting with the CMIO via warm intro from the regional advisory board.",
  });
  assert.ok(t !== null);
  // Must contain CMIO and/or warm intro pathway
  assert.match(t!, /CMIO|warm intro/);
});

test("extractTarget: returns null for generic ask without target", () => {
  assert.equal(
    extractTarget({ recommendation: "Generic ask with no target." }),
    null,
  );
});

test("extractTarget: owner takes priority when set", () => {
  assert.equal(
    extractTarget({ owner: "Jane Doe", recommendation: "anything" }),
    "Jane Doe",
  );
});

test("truncateForPointer: respects max length and appends ellipsis", () => {
  const long = "x".repeat(200);
  const out = truncateForPointer(long, 80);
  assert.ok(out.length <= 80);
  assert.ok(out.endsWith("…"));
});

test("ExecutiveCockpit renders compact pointer (data-testid + truncation helper)", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/ExecutiveCockpit.tsx"),
    "utf8",
  );
  assert.match(src, /data-testid="cockpit-pointer"/);
  // It must use a truncation helper for the cell body and a line-clamp-1
  // so the dark cell never renders the full multi-paragraph next_action.
  assert.match(src, /truncateForPointer/);
  assert.match(src, /line-clamp-1/);
  // It must surface a pointer to the Recommended Move card.
  assert.match(src, /See Recommended Move below/);
});

test("ActionPanelTile renders dossier substructure (TIMING / TARGET / ASK / WHY NOW / EXPECTED OUTCOME)", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/tiles.tsx"),
    "utf8",
  );
  // Pull out the ActionPanelTile region including its MoveRow helper
  // (declared above the component).
  const start = src.indexOf("function MoveRow");
  const end = src.indexOf("\n// ---- open_questions");
  const region = src.slice(start, end);
  assert.match(region, /data-testid="recommended-move-row"/);
  // Section labels (normalized casing).
  assert.match(region, /Timing/);
  assert.match(region, /Target \/ route/);
  assert.match(region, /Ask/);
  assert.match(region, /Why now/);
  assert.match(region, /Expected outcome/);
});

test("tiles.tsx contains both stacked and desktop testids for the extension table", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/tiles.tsx"),
    "utf8",
  );
  assert.match(src, /data-testid="extension-table-stacked"/);
  assert.match(src, /data-testid="extension-table-desktop"/);
});

test("Canvas source files no longer surface internal field names or preview/execution copy", () => {
  const files = [
    "web/components/canvas/tiles.tsx",
    "web/components/canvas/details.tsx",
    "web/components/canvas/WidgetTile.tsx",
    "web/components/canvas/ReadOnlyCanvasView.tsx",
    "web/components/canvas/ExecutiveCockpit.tsx",
  ];
  for (const rel of files) {
    const raw = readFileSync(path.join(__dirname, "..", rel), "utf8");
    // Strip JSX expression containers `{…}` (non-greedy, balanced enough
    // for these files) so we only scan literal JSX text content.
    const src = raw.replace(/\{[^{}]*\}/g, "{}");
    // `next_action` and `next action` as JSX text content (between `>` and
    // `<` on a single line; multi-line spans get picked up by the source
    // sweep instead).
    assert.ok(
      !/>[^<\n]*\bnext_action\b[^<\n]*</.test(src),
      `${rel} should not surface "next_action" as visible text`,
    );
    assert.ok(
      !/>[^<\n]*\bnext action\b[^<\n]*</i.test(src),
      `${rel} should not surface "next action" as visible text`,
    );
    // `preview` should not appear as user-visible JSX text in those files.
    assert.ok(
      !/>[^<\n]*\bpreview\b[^<\n]*</i.test(src),
      `${rel} should not surface "preview" as visible text`,
    );
    // Literal banned phrases (anywhere in source).
    assert.ok(
      !/Execution is not enabled/.test(raw),
      `${rel} should not contain "Execution is not enabled"`,
    );
    assert.ok(
      !/approval\/execution/.test(raw),
      `${rel} should not contain "approval/execution"`,
    );
    assert.ok(
      !/approval and execution/.test(raw),
      `${rel} should not contain "approval and execution"`,
    );
    // `severity:` literal in JSX text content (not as object key in JS).
    assert.ok(
      !/>[^<\n]*severity:/i.test(src),
      `${rel} should not surface "severity:" as visible text`,
    );
    // Action button labels remain hidden.
    for (const w of ["Run", "Execute", "Approve", "Dismiss"]) {
      const re = new RegExp(`>\\s*${w}\\s*<`);
      assert.ok(!re.test(raw), `${rel} should not contain >${w}< button label`);
    }
  }
});

test("framing eyebrows are de-branded (no literal HERMES prefix)", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/lib/canvas/framing.ts"),
    "utf8",
  );
  // The eyebrow strings themselves should not begin with the HERMES brand.
  assert.ok(
    !/eyebrow:\s*"HERMES/i.test(src),
    "framing eyebrows must not be prefixed with HERMES",
  );
  assert.ok(
    !/"Hermes insight"/.test(src),
    "framing should not emit 'Hermes insight' eyebrow",
  );
  assert.ok(
    !/"Hermes note"/.test(src),
    "framing should not emit 'Hermes note' eyebrow",
  );
  assert.ok(
    !/"Hermes takeaways"/.test(src),
    "framing should not emit 'Hermes takeaways' eyebrow",
  );
  assert.ok(
    !/"Hermes read on AI maturity"/.test(src),
    "framing should not emit 'Hermes read on AI maturity' eyebrow",
  );
});

test("framing oneLine for action_panel no longer mentions next_action verbatim", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/lib/canvas/framing.ts"),
    "utf8",
  );
  assert.ok(
    !/primary line drawn from next_action verbatim/.test(src),
    "framing must not surface 'primary line drawn from next_action verbatim'",
  );
});

test("ActionPanelDetail includes review-only intro line and dossier section headings", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/details.tsx"),
    "utf8",
  );
  // Intro line.
  assert.match(
    src,
    /Synthesized from saved account evidence — review-only recommendation\./,
  );
  // Dossier sections (each heading appears in the source).
  assert.match(src, /Recommended move/);
  assert.match(src, /Why this matters/);
  assert.match(src, /Expected outcome/);
  assert.match(src, /Evidence backing/);
  assert.match(src, /Caveat \/ risk/);
  assert.match(src, /Priority \/ status/);
  // Priority labels replace severity wording.
  assert.match(src, /Priority: High/);
});

test("SeverityChip renders 'Priority: <Level>' rather than 'severity: <level>'", () => {
  const src = readFileSync(
    path.join(__dirname, "../web/components/canvas/visuals.tsx"),
    "utf8",
  );
  // The chip body should now be 'Priority:' not 'severity:'.
  assert.match(src, /Priority:\s*\{label\}/);
  // And the older lowercase form should be gone.
  assert.ok(
    !/severity:\s*\{s\}/.test(src),
    "old `severity: {s}` chip body must be gone",
  );
});

test("Canvas chrome no longer surfaces de-internalized strings", () => {
  const files = [
    "web/components/canvas/tiles.tsx",
    "web/components/canvas/details.tsx",
    "web/components/canvas/WidgetTile.tsx",
    "web/components/canvas/ReadOnlyCanvasView.tsx",
    "web/app/globals.css",
  ];
  const forbidden: Array<[string, RegExp]> = [
    ["READ-ONLY MODE", /READ-ONLY MODE/],
    ["Provenance: hermes", /Provenance:\s*\{?\s*widget\.source/],
    ["INSIGHT · TABLE", /INSIGHT · TABLE/i],
    ["Hermes-ranked", /Hermes-ranked/],
    ["Rating from the saved brief", /Rating from the saved brief/],
    [
      "approval and execution are not enabled",
      /approval and execution are not enabled/,
    ],
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(__dirname, "..", rel), "utf8");
    for (const [label, re] of forbidden) {
      assert.ok(
        !re.test(src),
        `${rel} should not contain forbidden string "${label}"`,
      );
    }
    // Action button labels should not appear as visible JSX content.
    for (const word of ["Run", "Execute", "Approve", "Dismiss"]) {
      const re = new RegExp(`>\\s*${word}\\s*<`);
      assert.ok(
        !re.test(src),
        `${rel} should not contain >${word}< button label`,
      );
    }
  }
});
