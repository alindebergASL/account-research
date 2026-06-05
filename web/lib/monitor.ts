// Daily-monitor scan. Given a brief and the timestamp of the last check, uses
// Anthropic with the web_search tool to look for developments that are NEW
// since the last check. It reports findings via a single structured tool,
// `record_monitor_findings`, and does NOT mutate anything itself — the worker
// applies the returned patches (reusing applyPatches + Brief validation) so
// persistence, versioning, and notification stay in one place.
//
// If nothing genuinely new is found the model returns has_updates=false with
// no patches, and the caller changes nothing.

import Anthropic from "@anthropic-ai/sdk";
import type { Brief } from "./schema";
import type { BriefPatch } from "./briefPatches";

export const MAX_OUTPUT_TOKENS = 6000;
const MAX_TOOL_ITERATIONS = 6;

export type MonitorFindings = {
  has_updates: boolean;
  summary: string;
  patches: BriefPatch[];
};

export type MonitorScanInput = {
  brief: Brief;
  lastMonitoredAt: number | null;
};

export const MONITOR_SYSTEM_PROMPT = `You are a sales-research monitoring agent. You watch a single account for genuinely NEW developments and keep its research brief current.

You will be given the current brief (as JSON) and the date of the last check. Use the web_search tool to look for material developments about this account that are NEW since the last check: news, funding, leadership changes, product launches, partnerships, regulatory actions, RFPs, earnings, layoffs, M&A, etc.

Then call the tool \`record_monitor_findings\` EXACTLY ONCE:
- If you find nothing materially new since the last check, return { has_updates: false, summary: "", patches: [] }. Do not invent updates. Stale rephrasings of facts already in the brief do NOT count.
- If you find something new, return has_updates: true, a concise plain-text \`summary\` (1-4 sentences) describing what is new and why it matters, and \`patches\` that update the brief. Patches use op "append" to add items (e.g. append to \`recent_signals\`; append a \`card\` extension under \`extensions\` for a noteworthy development) and op "set" to revise an existing field (e.g. \`priority_summary\`, \`next_action\`) when the news changes it. Every new factual item must cite a source. Keep edits minimal and targeted — do not rewrite the whole brief.

Only call web_search and record_monitor_findings. Do not produce other tools or free-form prose as your final answer.`;

const recordFindingsTool = {
  name: "record_monitor_findings",
  description:
    "Report the outcome of the monitoring scan exactly once. Set has_updates=false with empty patches when nothing materially new was found.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      has_updates: { type: "boolean" },
      summary: { type: "string" },
      patches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            op: { type: "string", enum: ["set", "append"] },
            field: { type: "string" },
            value: {},
          },
          required: ["op", "field", "value"],
        },
      },
    },
    required: ["has_updates", "summary", "patches"],
  },
} as const;

function buildSystemPrompt(input: MonitorScanInput): string {
  const last =
    input.lastMonitoredAt != null
      ? new Date(input.lastMonitoredAt).toISOString()
      : "never (this is the first check)";
  return `${MONITOR_SYSTEM_PROMPT}

---
LAST CHECK: ${last}
TODAY: ${new Date().toISOString()}

---
CURRENT BRIEF (JSON):
${JSON.stringify(input.brief, null, 2)}`;
}

// Minimal client shape the scan depends on — lets tests inject a stub without
// a live Anthropic key. Mirrors the chat route's usage of messages.create.
export interface MonitorClient {
  messages: {
    create(args: any): Promise<{
      content: any[];
      stop_reason?: string | null;
      container?: { id?: string } | null;
    }>;
  };
}

let _testClient: MonitorClient | null = null;
export function __setTestMonitorClient(c: MonitorClient | null) {
  _testClient = c;
}

function extractFindings(toolInput: any): MonitorFindings {
  const has_updates = toolInput?.has_updates === true;
  const summary = typeof toolInput?.summary === "string" ? toolInput.summary.trim() : "";
  const patches: BriefPatch[] = Array.isArray(toolInput?.patches)
    ? toolInput.patches
    : [];
  // Guard against a model that flags updates but supplies nothing actionable.
  if (!has_updates || (patches.length === 0 && !summary)) {
    return { has_updates: false, summary: "", patches: [] };
  }
  return { has_updates: true, summary, patches };
}

export async function runMonitorScan(
  input: MonitorScanInput,
  client?: MonitorClient,
): Promise<MonitorFindings> {
  const c: MonitorClient =
    client ?? _testClient ?? (new Anthropic() as unknown as MonitorClient);
  const system = buildSystemPrompt(input);
  let messages: any[] = [
    {
      role: "user",
      content:
        "Check this account for developments new since the last check, then record your findings.",
    },
  ];
  let containerId: string | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await c.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      ...(containerId ? { container: containerId } : {}),
      tools: [
        { type: "web_search_20260209" as const, name: "web_search" } as any,
        recordFindingsTool as any,
      ],
      messages,
    });
    containerId = response.container?.id ?? containerId;

    const findingsUse = (response.content || []).find(
      (b: any) => b.type === "tool_use" && b.name === "record_monitor_findings",
    );
    if (findingsUse) {
      return extractFindings(findingsUse.input);
    }

    messages = [...messages, { role: "assistant", content: response.content }];

    // Server-side web_search may pause the turn to run searches; resume.
    if (response.stop_reason === "pause_turn") {
      if (i < MAX_TOOL_ITERATIONS - 1) continue;
      break;
    }
    // The model ended its turn without recording findings — treat as no-op.
    if (response.stop_reason !== "tool_use") {
      break;
    }
  }

  return { has_updates: false, summary: "", patches: [] };
}
