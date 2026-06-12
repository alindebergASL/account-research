// Extracted, side-effect-free research pipeline. This module is the unit of
// expensive work (Anthropic calls + Zod validation) that the worker drives.
// No DB writes, no HTTP — just intake in, brief + per-stage usage out.

import Anthropic from "@anthropic-ai/sdk";
import { Brief } from "./schema";
import { SOURCE_DISCOVERY_PROMPT, SYSTEM_PROMPT } from "./prompt";
import type { StageUsage } from "./cost";
import {
  RESEARCH_QUICK_MODEL,
  RESEARCH_HEAVY_MODEL,
  SOURCE_SCOUT_MODEL,
  JSON_REPAIR_MODEL,
} from "./models";

export type ResearchMode = "quick" | "standard" | "deep";

export type Intake = {
  account: string;
  segment?: string;
  region?: string;
  goal?: string;
  notes?: string;
  audience?: "internal" | "shareable";
  mode?: ResearchMode;
};

export type PipelineResult = {
  brief: Brief;
  stages: StageUsage[];
  quality: {
    filled: number;
    total: number;
    low: boolean;
    repaired: boolean;
    research_attempts: number;
    source_candidates: number;
    mode: ResearchMode;
  };
};

export class PipelineError extends Error {
  constructor(public friendly: string, public original?: unknown) {
    super(friendly);
  }
}

type DiscoveredSource = {
  url: string;
  title?: string;
  type?: string;
  why?: string;
};

type ResearchConfig = {
  model: string;
  maxOutputTokens: number;
  thinking: { type: "adaptive" } | { type: "disabled" };
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxContinuations: number;
  useWebFetch: boolean;
};

type ModeConfig = {
  runScout: boolean;
  scoutCap: number;
  research: ResearchConfig;
  breadthTarget: string;
};

const MODE_CONFIG: Record<ResearchMode, ModeConfig> = {
  quick: {
    runScout: false,
    scoutCap: 0,
    research: {
      model: RESEARCH_QUICK_MODEL,
      maxOutputTokens: 16_000,
      thinking: { type: "disabled" },
      maxContinuations: 2,
      useWebFetch: false,
    },
    breadthTarget:
      "Quick mode — single-pass snapshot. Issue at most ~3 web_search queries. Aim for 4-6 sources. Keep prose tight.",
  },
  standard: {
    runScout: true,
    scoutCap: 12,
    research: {
      model: RESEARCH_HEAVY_MODEL,
      maxOutputTokens: 32_000,
      thinking: { type: "adaptive" },
      maxContinuations: 5,
      useWebFetch: true,
    },
    breadthTarget:
      "Standard mode — balanced depth. Aim for 10-15 sources spread across categories.",
  },
  deep: {
    runScout: true,
    scoutCap: 25,
    research: {
      model: RESEARCH_HEAVY_MODEL,
      maxOutputTokens: 64_000,
      thinking: { type: "adaptive" },
      effort: "xhigh",
      maxContinuations: 8,
      useWebFetch: true,
    },
    breadthTarget:
      "Deep mode — exhaustive research. Aim for 18-25 sources. Drill into every category, including niche ones (modernization grants, consortium purchasing, AI governance, leadership bios).",
  },
};

function isTruncationError(msg: string): boolean {
  return /unterminated|unexpected end|EOF/i.test(msg);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function completenessScore(b: Brief) {
  const isMissing = (s: string) =>
    !s || s.trim().toLowerCase().startsWith("not found");
  const checks = [
    !isMissing(b.snapshot),
    !isMissing(b.priority_summary),
    !isMissing(b.buying_path),
    !isMissing(b.first_angle),
    !isMissing(b.next_action),
    b.recent_signals.length > 0,
    b.top_initiatives.length > 0,
    b.personas.length > 0,
  ];
  const filled = checks.filter(Boolean).length;
  return { filled, total: checks.length, low: filled < 4 };
}

const SOURCE_DISCOVERY_MAX_CONTINUATIONS = 2;

async function findSources(
  client: Anthropic,
  intake: string,
  cap: number,
  stages: StageUsage[],
): Promise<DiscoveredSource[]> {
  let messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: intake },
  ];
  try {
    for (let i = 0; i <= SOURCE_DISCOVERY_MAX_CONTINUATIONS; i++) {
      const response = await client.messages.create({
        model: SOURCE_SCOUT_MODEL,
        max_tokens: 8000,
        cache_control: { type: "ephemeral" } as any,
        system: SOURCE_DISCOVERY_PROMPT,
        tools: [
          {
            type: "web_search_20260209" as const,
            name: "web_search",
            allowed_callers: ["direct"],
          } as any,
        ],
        messages,
      });
      stages.push({
        name: i === 0 ? "source_scout" : `source_scout_continue_${i}`,
        model: SOURCE_SCOUT_MODEL,
        usage: response.usage as any,
      });
      if (
        response.stop_reason === "pause_turn" &&
        i < SOURCE_DISCOVERY_MAX_CONTINUATIONS
      ) {
        messages = [
          { role: "user", content: intake },
          { role: "assistant", content: response.content as any },
        ];
        continue;
      }
      const text = (
        [...response.content].reverse().find((b: any) => b.type === "text") as
          | { text: string }
          | undefined
      )?.text;
      if (!text) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(text));
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      const seen = new Set<string>();
      return parsed
        .filter(
          (s: any) =>
            s &&
            typeof s.url === "string" &&
            /^https?:\/\//i.test(s.url) &&
            !seen.has(s.url) &&
            (seen.add(s.url) || true),
        )
        .slice(0, Math.max(1, cap)) as DiscoveredSource[];
    }
    return [];
  } catch {
    return [];
  }
}

async function runResearchLoop(
  client: Anthropic,
  userMessage: string,
  cfg: ResearchConfig,
  stages: StageUsage[],
  stageBaseName: string,
): Promise<Anthropic.Messages.Message> {
  let messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const tools: any[] = [
    { type: "web_search_20260209" as const, name: "web_search" } as any,
  ];
  if (cfg.useWebFetch) {
    tools.push(
      { type: "web_fetch_20260209" as const, name: "web_fetch" } as any,
    );
  }

  const outputConfig =
    cfg.effort !== undefined ? ({ effort: cfg.effort } as any) : undefined;

  for (let i = 0; i <= cfg.maxContinuations; i++) {
    const stream = await client.messages.stream({
      model: cfg.model,
      max_tokens: cfg.maxOutputTokens,
      thinking: cfg.thinking as any,
      cache_control: { type: "ephemeral" } as any,
      ...(outputConfig ? { output_config: outputConfig } : {}),
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    const final = await stream.finalMessage();
    stages.push({
      name: i === 0 ? stageBaseName : `${stageBaseName}_continue_${i}`,
      model: cfg.model,
      usage: final.usage as any,
    });

    if (final.stop_reason === "pause_turn" && i < cfg.maxContinuations) {
      messages = [
        { role: "user", content: userMessage },
        { role: "assistant", content: final.content as any },
      ];
      continue;
    }
    return final;
  }
  throw new Error(
    `Server-side tool loop did not finish in ${cfg.maxContinuations} continuations`,
  );
}

async function repairJson(
  client: Anthropic,
  partialText: string,
  parseOrValidationError: string,
  stages: StageUsage[],
): Promise<unknown | null> {
  try {
    const response = await client.messages.create({
      model: JSON_REPAIR_MODEL,
      max_tokens: 16000,
      cache_control: { type: "ephemeral" } as any,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Repair task — no new research. The previous response failed validation. ` +
            `Return ONE complete valid JSON object that matches the OUTPUT FORMAT schema in the system prompt. ` +
            `Recover whatever you can from the partial output and fill the rest with "Not found in public sources." or [] as appropriate. ` +
            `Do not search the web. Do not add prose. Return only the JSON.\n\n` +
            `Validation error:\n${parseOrValidationError}\n\n` +
            `Partial / invalid output:\n${partialText}`,
        },
      ],
    });
    stages.push({
      name: "repair",
      model: JSON_REPAIR_MODEL,
      usage: response.usage as any,
    });
    const text = response.content.find((b: any) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    if (!text) return null;
    return JSON.parse(extractJson(text.text));
  } catch {
    return null;
  }
}

// Map raw Anthropic SDK errors to clean user-facing messages so the worker
// never persists the raw 400 body. Sanitized + truncated to 4 KB.
function friendlyMessage(err: any): string {
  const raw = String(err?.message ?? err ?? "unknown error");
  if (/credit balance/i.test(raw) && /too low|insufficient/i.test(raw)) {
    return "Anthropic account out of credits — top up at https://console.anthropic.com/billing.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Anthropic rate limit — try again shortly.";
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return "Server is misconfigured (invalid Anthropic API key).";
  }
  // Strip anything that looks like a header/key/secret block, then truncate.
  const cleaned = raw
    .replace(/x-api-key[^\s]*/gi, "x-api-key=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]");
  return cleaned.slice(0, 4096);
}

function buildIntakeText(intake: Intake, mode: ResearchMode): string {
  return [
    `Account: ${intake.account}`,
    intake.segment ? `Industry / segment: ${intake.segment}` : "",
    intake.region ? `Region: ${intake.region}` : "",
    intake.goal ? `Goal for the brief: ${intake.goal}` : "",
    intake.audience ? `Audience: ${intake.audience}` : "Audience: internal",
    intake.notes ? `Internal notes (do not quote raw):\n${intake.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function fakeBrief(intake: Intake, mode: ResearchMode): Brief {
  const today = new Date().toISOString().slice(0, 10);
  return {
    account_name: intake.account,
    segment: intake.segment || "Test segment",
    generated_at: today,
    audience: intake.audience === "shareable" ? "shareable" : "internal",
    snapshot: `[FAKE PROVIDER] Synthetic ${mode}-mode brief for ${intake.account}.`,
    priority_summary: "Synthetic priority summary for end-to-end testing.",
    recent_signals: [
      {
        text: "Synthetic signal",
        source: "https://example.com/fake",
        confidence: "Low",
      },
    ],
    ai_tech_maturity: { rating: 3, rationale: "Synthetic rationale." },
    top_initiatives: [
      {
        title: "Synthetic initiative",
        detail: "Used only when RESEARCH_WORKER_FAKE_PROVIDER is set.",
        confidence: "Low",
        source: "https://example.com/fake",
      },
    ],
    technical_footprint: {
      ai_in_production: [],
      active_pilots: [],
      cloud_platforms: [],
      data_infrastructure: "Not found in public sources.",
      clinical_platforms: "Not found in public sources.",
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
    personas: [
      {
        name: "Synthetic Persona",
        title: "VP of Test",
        priority: "Synthetic priority",
        opener: "Synthetic opener.",
        confidence: "Low",
        source: "https://example.com/fake",
      },
    ],
    buying_path: "Synthetic buying path.",
    first_angle: "Synthetic first angle.",
    risks: ["Synthetic risk"],
    competitive_signals: [],
    next_action: "Synthetic next action.",
    extensions: [
      {
        kind: "card",
        id: "synthetic-card",
        title: "Synthetic callout",
        source: "research",
        created_at: today,
        why_included: "Exercises the dynamic card renderer in fake-provider mode.",
        confidence: "Low",
        sources: [{ title: "Fake source", url: "https://example.com/fake", accessed: today }],
        body: "A compact fake-provider callout for local canvas and export checks.",
        badges: ["fake", "demo"],
      },
      {
        kind: "table",
        id: "synthetic-competitor-table",
        title: "Synthetic competitor matrix",
        source: "research",
        created_at: today,
        why_included: "Exercises the dynamic table renderer in fake-provider mode.",
        confidence: "Low",
        sources: [{ title: "Fake source", url: "https://example.com/fake", accessed: today }],
        columns: ["Competitor", "Signal", "Implication"],
        rows: [
          ["Vendor A", "Incumbent", "Position around integration risk"],
          ["Vendor B", "AI platform", "Differentiate on governed deployment"],
        ],
      },
      {
        kind: "list",
        id: "synthetic-expansion-list",
        title: "Synthetic expansion signals",
        source: "research",
        created_at: today,
        why_included: "Exercises the dynamic list renderer in fake-provider mode.",
        confidence: "Low",
        sources: [{ title: "Fake source", url: "https://example.com/fake", accessed: today }],
        // Mixes legacy string items and PR-A {heading, text} objects to
        // exercise both shapes through the same render/export path.
        items: [
          "International hiring",
          { heading: "Partners", text: "Regional partner motion" },
          { heading: "Compliance", text: "Localized compliance needs" },
        ],
      },
      {
        kind: "narrative",
        id: "synthetic-expansion-narrative",
        title: "Synthetic international expansion narrative",
        source: "research",
        created_at: today,
        why_included: "Exercises the dynamic narrative renderer in fake-provider mode.",
        confidence: "Low",
        sources: [{ title: "Fake source", url: "https://example.com/fake", accessed: today }],
        body: "The fake-provider account is framed as expanding internationally so the narrative extension can be validated without provider spend.",
      },
    ],
    sources: [
      {
        title: "Fake source",
        url: "https://example.com/fake",
        accessed: today,
      },
    ],
  };
}

// Optional dispatcher context. The public signature remains
// `runResearchPipeline(intake)` for legacy callers; the worker can
// additionally pass `{user_id, brief_id}` so the Hermes adapter can
// attribute the `hermes_jobs` row when `HERMES_RESEARCH_ENABLED=1`.
export type ResearchPipelineContext = {
  user_id?: string | null;
  brief_id?: string | null;
};

export async function runResearchPipeline(
  intake: Intake,
  ctx?: ResearchPipelineContext,
): Promise<PipelineResult> {
  if (!intake.account || !intake.account.trim()) {
    throw new PipelineError("Missing 'account' name");
  }

  // Dispatcher: route through Hermes runtime when the per-feature flag
  // is on. Fake-provider verification stays on the direct path so the
  // existing RESEARCH_WORKER_FAKE_PROVIDER contract is unchanged.
  //
  // Failure policy (matches plan PR-2): in fake mode, surface the error
  // (it's a bug, not a fallback opportunity). In real Hermes mode, log
  // a sanitized fallback marker and run the direct Anthropic path, so
  // a runtime hiccup never blocks a research job.
  if (
    !process.env.RESEARCH_WORKER_FAKE_PROVIDER &&
    process.env.HERMES_RESEARCH_ENABLED === "1"
  ) {
    // Lazy import to avoid pulling the hermes adapter (and its DB
    // dependencies) into bundles that never read the flag.
    const { runResearchViaHermes, HermesResearchAdapterError } = await import(
      "./hermes/researchAdapter"
    );
    const { hermesRuntimeFake } = await import("./hermes/config");
    const { redactSensitiveString } = await import("./hermes/sanitize");
    try {
      return await runResearchViaHermes(intake, {
        user_id: ctx?.user_id ?? "anonymous",
        brief_id: ctx?.brief_id ?? null,
      });
    } catch (err) {
      if (hermesRuntimeFake()) {
        // In fake mode, a thrown error is a real bug — do not paper
        // over it with a fallback.
        throw err;
      }
      const message =
        err instanceof HermesResearchAdapterError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[hermes.research.fallback] ${redactSensitiveString(message)}`,
      );
      // Fall through to the direct Anthropic path below.
    }
  }

  return runDirectAnthropicResearch(intake);
}

async function runDirectAnthropicResearch(
  intake: Intake,
): Promise<PipelineResult> {
  const mode: ResearchMode =
    intake.mode === "quick" || intake.mode === "deep"
      ? intake.mode
      : "standard";

  if (process.env.RESEARCH_WORKER_FAKE_PROVIDER) {
    const brief = fakeBrief(intake, mode);
    return {
      brief,
      stages: [],
      quality: {
        ...completenessScore(brief),
        repaired: false,
        research_attempts: 1,
        source_candidates: 0,
        mode,
      },
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new PipelineError("Server is missing ANTHROPIC_API_KEY");
  }

  const cfg = MODE_CONFIG[mode];
  const client = new Anthropic();
  const stages: StageUsage[] = [];
  const intakeText = buildIntakeText(intake, mode);
  const today = new Date().toISOString().slice(0, 10);
  const sourceDiscoveryIntake = `Find candidate sources for this account.\n\n${intakeText}\n\nToday's date: ${today}.`;

  try {
    const discovered = cfg.runScout
      ? await findSources(client, sourceDiscoveryIntake, cfg.scoutCap, stages)
      : [];

    const sourcesPreamble =
      discovered.length > 0
        ? `\n\nStarter sources from initial scan (${discovered.length} candidate URLs across categories — verify, web_fetch the most relevant, supplement with your own web_search to fill gaps):\n${discovered
            .map(
              (s) =>
                `- [${s.type || "other"}] ${s.title || s.url} — ${s.url}${
                  s.why ? `\n  ${s.why}` : ""
                }`,
            )
            .join("\n")}\n`
        : "";

    const modeLine = `Research mode: ${mode}. ${cfg.breadthTarget}`;
    const userMessage = `Research this account and return the JSON brief.\n\n${modeLine}\n\n${intakeText}${sourcesPreamble}\nToday's date: ${today}.`;

    let final = await runResearchLoop(
      client,
      userMessage,
      cfg.research,
      stages,
      "research",
    );
    let researchAttempts = 1;

    function getText(msg: Anthropic.Messages.Message): string | null {
      const tb = [...msg.content]
        .reverse()
        .find((b: any) => b.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      return tb?.text ?? null;
    }

    let text = getText(final);

    function tryParse(t: string | null): { parsed?: unknown; err?: string } {
      if (!t) return { err: "no text block" };
      try {
        return { parsed: JSON.parse(extractJson(t)) };
      } catch (e: any) {
        return { err: e?.message ?? String(e) };
      }
    }

    let { parsed, err: parseError } = tryParse(text);

    if (parseError && isTruncationError(parseError)) {
      final = await runResearchLoop(
        client,
        userMessage,
        cfg.research,
        stages,
        "research_retry",
      );
      researchAttempts = 2;
      text = getText(final);
      ({ parsed, err: parseError } = tryParse(text));
    }

    if (!text) {
      throw new PipelineError("Model returned no text block");
    }

    let repaired = false;
    if (parseError) {
      const r = await repairJson(client, text, parseError, stages);
      if (r !== null) {
        parsed = r;
        repaired = true;
      } else {
        throw new PipelineError("Model output was not valid JSON");
      }
    }

    let result = Brief.safeParse(parsed);
    if (!result.success) {
      const r = await repairJson(
        client,
        JSON.stringify(parsed),
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("\n"),
        stages,
      );
      if (r !== null) {
        const second = Brief.safeParse(r);
        if (second.success) {
          result = second;
          repaired = true;
        }
      }
    }
    if (!result.success) {
      throw new PipelineError("Brief failed schema validation");
    }

    const quality = completenessScore(result.data);

    return {
      brief: result.data,
      stages,
      quality: {
        ...quality,
        repaired,
        research_attempts: researchAttempts,
        source_candidates: discovered.length,
        mode,
      },
    };
  } catch (err: any) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(friendlyMessage(err), err);
  }
}
