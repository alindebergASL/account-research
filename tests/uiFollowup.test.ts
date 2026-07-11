import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const webRequire = createRequire(path.join(__dirname, "../web/package.json"));
const React = webRequire("react") as any;
(globalThis as any).React = React;
const { renderToStaticMarkup } = webRequire("react-dom/server") as any;
const { SourceLink } = webRequire("../web/components/DrillModal") as any;
const JournalSection = webRequire("../web/app/brief/[id]/JournalSection").default as any;

test("ShareDialog loads shares through stable callbacks included in the initial-load effect", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/components/ShareDialog.tsx"),
    "utf8",
  );

  assert.match(source, /import \{ useCallback, useEffect, useState \} from "react";/);
  assert.match(source, /const load = useCallback\(async function load\(\)/);
  assert.match(source, /const loadLinks = useCallback\(async function loadLinks\(\)/);
  assert.match(source, /\}, \[briefId, load, loadLinks\]\);/);
});

test("SourceLink renders only plain http and https URLs as anchors", () => {
  const safeHtml = renderToStaticMarkup(
    React.createElement(SourceLink, { source: "https://trusted.example/report" }),
  );
  assert.match(safeHtml, /<a\b/);
  assert.match(safeHtml, /href="https:\/\/trusted\.example\/report"/);
  assert.match(safeHtml, /rel="noreferrer noopener"/);

  for (const source of [
    "https://trusted.example@evil.example/report",
    "https://user:pass@example.com/report",
    "javascript:alert(1)",
  ]) {
    const html = renderToStaticMarkup(React.createElement(SourceLink, { source }));
    assert.match(html, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(html, /<a\b/);
    assert.doesNotMatch(html, /href=/);
  }
});

test("JournalSection default render is Timeline-first with Team Room as a sub-tab", () => {
  const html = renderToStaticMarkup(
    React.createElement(JournalSection, {
      briefId: "brief-ui",
      currentUserId: "user-ui",
      isAdmin: false,
      canManage: true,
      briefContext: {
        account_name: "California Community Colleges System",
        priority_summary: "Brief baseline summary",
        next_action: "Schedule follow-up",
        sources_count: 2,
        sources: [
          { title: "Baseline A", url: "https://example.com/a", accessed: "2026-06-01" },
          { title: "Baseline B", url: "https://example.com/b", accessed: "2026-06-02" },
        ],
      },
    }),
  );

  // The default Journal view leads with the account header and truthful baseline;
  // Journal and Team Room are the only persistent view tabs.
  const journalIndex = html.indexOf("Journal");
  const teamIndex = html.indexOf("Team Room");
  assert.ok(journalIndex >= 0, "Journal mode tab should render");
  assert.ok(teamIndex >= 0, "Team Room tab should render");
  assert.match(html, /aria-selected="true"[^>]*>Journal/);
  assert.match(html, /Current brief baseline/);
  assert.doesNotMatch(html, /Current understanding/);
  assert.match(html, /Brief next action/);
  assert.doesNotMatch(html, /Recommended next move/);
  assert.match(html, /role="group" aria-label="Journal tools"/);
  assert.match(html, /aria-label="Journal tools"[\s\S]*>To-dos</);
  assert.match(html, /aria-label="Journal tools"[\s\S]*>Sources</);
  assert.match(html, /aria-label="Journal tools"[\s\S]*>Review Queue</);
  assert.doesNotMatch(html, /role="tab"[^>]*>To-dos/);
  assert.doesNotMatch(html, /role="tab"[^>]*>Sources/);
  assert.doesNotMatch(html, /role="tab"[^>]*>Review Queue/);
  // Editorial header grounds in the account + brief baseline.
  assert.match(html, /California Community Colleges System/);
  assert.match(html, /Brief baseline summary/);
});

test("JournalSection source encodes timeline-only composition and navigable global search", () => {
  const source = readFileSync(
    path.join(__dirname, "../web/app/brief/[id]/JournalSection.tsx"),
    "utf8",
  );

  assert.match(source, /Search spans Journal, Sources, and Review Queue\./);
  assert.match(source, /const active = centerTab === id;/);
  assert.doesNotMatch(source, /const active = !activeFullView && centerTab === id;/);
  assert.match(
    source,
    /if \(centerTab !== "timeline" \|\| activeFullView !== null\) \{[\s\S]*setCenterTab\("timeline"\);[\s\S]*setSearchOpen\(true\);[\s\S]*return;/,
  );
  assert.match(source, /onClick=\{\(\) => setActiveFullView\("sources"\)\}/);
  assert.match(source, /onClick=\{\(\) => setActiveFullView\("review"\)\}/);
  assert.match(source, /!activeFullView && centerTab === "timeline" \? \(/);
  assert.match(source, /activeFullView === "tasks"[\s\S]*\? "To-dos"/);
  assert.match(source, />Automated checks</);
});
