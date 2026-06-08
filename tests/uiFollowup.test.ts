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

test("JournalSection default render puts Team Room first and counts brief baseline sources", () => {
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

  const teamIndex = html.indexOf("Team Room");
  const timelineIndex = html.indexOf("Timeline");
  assert.ok(teamIndex >= 0, "Team Room tab should render");
  assert.ok(timelineIndex >= 0, "Timeline tab should render");
  assert.ok(teamIndex < timelineIndex, "Team Room should render before Timeline");
  assert.match(html, /aria-pressed="true"[^>]*><span[^>]*>Team Room/);
  assert.match(html, /Current brief sources/);
  assert.match(html, /2 saved sources/);
  assert.match(html, /Sources<span class="rounded-full px-2 py-0\.5 text-xs bg-slate-100 text-muted">2<\/span>/);
});
