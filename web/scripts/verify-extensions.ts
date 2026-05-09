import { Brief, BriefExtension } from "../lib/schema";
import { applyPatches } from "../lib/briefPatches";

const baseBrief = {
  account_name: "Fixture Account",
  segment: "Healthcare",
  generated_at: "2026-05-09",
  audience: "internal",
  snapshot: "A concise account snapshot.",
  priority_summary: "Priority summary.",
  recent_signals: [],
  ai_tech_maturity: { rating: 3, rationale: "Piloting." },
  top_initiatives: [],
  technical_footprint: {
    ai_in_production: [],
    active_pilots: [],
    cloud_platforms: [],
    data_infrastructure: "Not found in public sources.",
    clinical_platforms: "Epic",
    analytics_bi_stack: "Not found in public sources.",
    build_vs_buy_posture: "Not found in public sources.",
    competitive_incumbents: [],
  },
  programs_procurement: {
    modernization_grants: [],
    consortium_purchasing: [],
    active_rfps_contracts: [],
    ai_governance_policy: "Not found in public sources.",
    public_ai_use_cases: [],
  },
  personas: [],
  buying_path: "Centralized.",
  first_angle: "Lead with modernization.",
  risks: [],
  competitive_signals: [],
  next_action: "Schedule discovery.",
  sources: [],
} as const;

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const legacy = Brief.parse(baseBrief);
assert(Array.isArray(legacy.extensions), "legacy brief should default extensions to []");
assert(legacy.extensions.length === 0, "legacy brief default extensions should be empty");

const kinds = [
  {
    kind: "card",
    id: "competitor-card",
    title: "Competitor card",
    source: "model",
    created_at: "2026-05-09",
    why_included: "The account is evaluating alternatives.",
    confidence: "Medium",
    sources: [{ title: "Annual report", url: "https://example.com/report", accessed: "2026-05-09" }],
    body: "A compact callout.",
  },
  {
    kind: "table",
    id: "competitor-table",
    title: "Competitor table",
    source: "chat",
    created_at: "2026-05-09",
    why_included: "Requested in chat.",
    confidence: "High",
    sources: [],
    columns: ["Competitor", "Why it matters"],
    rows: [["Vendor A", "Existing incumbent"], ["Vendor B", "AI platform"]],
  },
  {
    kind: "list",
    id: "expansion-list",
    title: "Expansion signals",
    source: "model",
    created_at: "2026-05-09",
    why_included: "Supports outreach timing.",
    confidence: "Low",
    sources: [],
    items: ["New EU office", "APAC hiring"],
  },
  {
    kind: "narrative",
    id: "expansion-narrative",
    title: "International expansion",
    source: "chat",
    created_at: "2026-05-09",
    why_included: "Requested in chat.",
    confidence: "Medium",
    sources: [],
    body: "The company is expanding selectively into international markets.",
  },
] as const;

for (const extension of kinds) {
  BriefExtension.parse(extension);
}

const withExtensions = Brief.parse({ ...baseBrief, extensions: kinds });
assert(withExtensions.extensions.length === 4, "brief should parse all extension kinds");
assert(withExtensions.extensions[1].source === "chat", "chat source should parse");

const patched = applyPatches(legacy, [
  {
    op: "append",
    field: "extensions",
    value: {
      kind: "table",
      id: "chat-competitors",
      title: "Chat competitor table",
      created_at: "2026-05-09",
      why_included: "User asked for competitor callout.",
      confidence: "Medium",
      sources: [],
      columns: ["Competitor", "Signal"],
      rows: [["Vendor A", "Incumbent"]],
    },
  },
]);
assert(patched.extensions.length === 1, "append patch should add an extension");
assert(patched.extensions[0].source === "chat", "append patch should stamp source=chat when omitted");

const replaced = applyPatches(legacy, [
  {
    op: "set",
    field: "extensions",
    value: [
      {
        kind: "narrative",
        id: "chat-expansion",
        title: "Chat expansion narrative",
        created_at: "2026-05-09",
        why_included: "User asked for international expansion strategy.",
        confidence: "Low",
        sources: [],
        body: "Expansion narrative from chat.",
      },
    ],
  },
]);
assert(replaced.extensions.length === 1, "set patch should replace extensions");
assert(replaced.extensions[0].source === "chat", "set patch should stamp source=chat when omitted");

console.log("extension schema fixture ok");
