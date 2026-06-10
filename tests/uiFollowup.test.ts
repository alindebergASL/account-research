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

  const timelineIndex = html.indexOf("Timeline");
  const teamIndex = html.indexOf("Team Room");
  assert.ok(timelineIndex >= 0, "Timeline tab should render");
  assert.ok(teamIndex >= 0, "Team Room tab should render");
  // PR-C NotebookLM IA: chat-first. Timeline is the default feed tab and renders
  // before Team Room, which is now a sub-tab of the center feed.
  assert.ok(timelineIndex < teamIndex, "Timeline should render before Team Room");
  assert.match(html, /aria-selected="true"[^>]*>Timeline/);
  // Sources panel grounds in the current brief baseline.
  assert.match(html, /California Community Colleges System/);
  assert.match(html, /Current brief priority/);
});
