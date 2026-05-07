import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Brief } from "@/lib/schema";
import { SOURCE_DISCOVERY_PROMPT, SYSTEM_PROMPT } from "@/lib/prompt";
import { HttpError, requireUser } from "@/lib/auth";

type DiscoveredSource = { url: string; title?: string; type?: string; why?: string };

export const runtime = "nodejs";
export const maxDuration = 300;

export type ResearchMode = "quick" | "standard" | "deep";

type Intake = {
  account: string;
  segment?: string;
  region?: string;
  goal?: string;
  notes?: string;
  audience?: "internal" | "shareable";
  mode?: ResearchMode;
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
  // Short hint injected into the user message so the model knows the breadth target.
  breadthTarget: string;
};

const MODE_CONFIG: Record<ResearchMode, ModeConfig> = {
  quick: {
    runScout: false,
    scoutCap: 0,
    research: {
      model: "claude-sonnet-4-6",
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
      model: "claude-opus-4-7",
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
      model: "claude-opus-4-7",
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

// Map raw Anthropic SDK errors to clean user-facing messages so the UI never
// shows the raw 400 body. Returns {error, status} the caller can JSON.serialize.
function friendlyError(err: any): { error: string; status: number } {
  const msg = String(err?.message ?? err ?? "");
  const status = typeof err?.status === "number" ? err.status : 500;

  // Anthropic billing exhaustion — comes through as a 400 invalid_request_error
  // with a "credit balance" message. Surface as 503 service-unavailable.
  if (/credit balance/i.test(msg) && /too low|insufficient/i.test(msg)) {
    return {
      error:
        "Research is temporarily unavailable — the Anthropic account is out of credits. Top up at https://console.anthropic.com/billing and try again.",
      status: 503,
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      error: "Anthropic rate limit reached — please retry in a moment.",
      status: 429,
    };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      error:
        "Server is misconfigured (invalid Anthropic API key). Contact the operator.",
      status: 500,
    };
  }
  return { error: msg, status };
}

// Score a brief on substantive content. Below ~5/8 indicators it's almost
// certainly the result of truncation+repair-padding rather than real research.
function completenessScore(b: import("@/lib/schema").Brief) {
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

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

// Stage 1 — Haiku source-discovery scout.
// Cheap, broad pass with web_search to surface 15-25 candidate URLs across all
// the categories the brief covers. Returns [] on any failure so the Opus stage
// still runs; missing sources just means Opus rediscovers them itself.
const SOURCE_DISCOVERY_MAX_CONTINUATIONS = 2;

async function findSources(
  client: Anthropic,
  intake: string,
  cap: number,
): Promise<DiscoveredSource[]> {
  let messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: intake },
  ];
  try {
    for (let i = 0; i <= SOURCE_DISCOVERY_MAX_CONTINUATIONS; i++) {
      const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 8000,
        cache_control: { type: "ephemeral" } as any,
        system: SOURCE_DISCOVERY_PROMPT,
        tools: [
          {
            type: "web_search_20260209" as const,
            name: "web_search",
            // Haiku 4.5 does not support programmatic server-tool calling.
            // direct lets the model call web_search from its own turn.
            allowed_callers: ["direct"],
          } as any,
        ],
        messages,
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

// Server-side tool loops can stop with `pause_turn` after hitting their
// internal iteration cap. Per the API docs, re-send [user, assistant] and the
// server resumes — do NOT inject another user "continue" message.
async function runResearchLoop(
  client: Anthropic,
  userMessage: string,
  cfg: ResearchConfig,
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
      // Auto-cache the largest stable prefix (tools + system prompt). Saves
      // ~90% on the cached portion across repeat requests within ~5 min.
      cache_control: { type: "ephemeral" } as any,
      ...(outputConfig ? { output_config: outputConfig } : {}),
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    const final = await stream.finalMessage();

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

// Repair pass: tool-less call that re-uses the system prompt's schema +
// hard-rules, asks the model to complete or fix the partial output without
// running new searches. Returns null on any failure.
async function repairJson(
  client: Anthropic,
  partialText: string,
  parseOrValidationError: string,
): Promise<unknown | null> {
  try {
    const response = await client.messages.create({
      // Repair is mechanical reformatting against a known schema — Haiku 4.5
      // handles it fine at ~5x lower input/output cost than Opus.
      model: "claude-haiku-4-5",
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
    const text = response.content.find((b: any) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    if (!text) return null;
    return JSON.parse(extractJson(text.text));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    requireUser(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  let body: Intake;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.account || typeof body.account !== "string" || !body.account.trim()) {
    return NextResponse.json({ error: "Missing 'account' name" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY" },
      { status: 500 },
    );
  }

  const client = new Anthropic();

  const intake = [
    `Account: ${body.account}`,
    body.segment ? `Industry / segment: ${body.segment}` : "",
    body.region ? `Region: ${body.region}` : "",
    body.goal ? `Goal for the brief: ${body.goal}` : "",
    body.audience ? `Audience: ${body.audience}` : "Audience: internal",
    body.notes ? `Internal notes (do not quote raw):\n${body.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const today = new Date().toISOString().slice(0, 10);

  // Resolve mode + config. Unknown modes fall back to standard.
  const mode: ResearchMode =
    body.mode === "quick" || body.mode === "deep" ? body.mode : "standard";
  const cfg = MODE_CONFIG[mode];

  const sourceDiscoveryIntake = `Find candidate sources for this account.\n\n${intake}\n\nToday's date: ${today}.`;

  try {
    // Stage 1 — Haiku scouts for sources (skipped in Quick mode).
    // Failures are non-blocking; the research stage will rediscover via web_search.
    const discovered = cfg.runScout
      ? await findSources(client, sourceDiscoveryIntake, cfg.scoutCap)
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
    const userMessage = `Research this account and return the JSON brief.\n\n${modeLine}\n\n${intake}${sourcesPreamble}\nToday's date: ${today}.`;

    let final = await runResearchLoop(client, userMessage, cfg.research);
    let researchAttempts = 1;
    const sourceCandidates = discovered.length;

    function getText(msg: Anthropic.Messages.Message): string | null {
      const tb = [...msg.content].reverse().find((b: any) => b.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      return tb?.text ?? null;
    }

    let text = getText(final);

    // 1) Try to parse. If we hit a truncation-style error, do one full research
    //    retry (cheap relative to padding via repair, which loses real data).
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
      // Truncation — repair-padding would silently discard the model's
      // actual research. Re-run the research loop once instead.
      final = await runResearchLoop(client, userMessage, cfg.research);
      researchAttempts = 2;
      text = getText(final);
      ({ parsed, err: parseError } = tryParse(text));
    }

    const errorContext = () => ({
      stop_reason: final.stop_reason,
      stop_sequence: final.stop_sequence,
      usage: final.usage,
      research_attempts: researchAttempts,
    });

    if (!text) {
      return NextResponse.json(
        { error: "Model returned no text block", ...errorContext() },
        { status: 502 },
      );
    }

    // 2) Still bad after retry? Now repair-pad as a last resort.
    let repaired = false;
    if (parseError) {
      const r = await repairJson(client, text, parseError);
      if (r !== null) {
        parsed = r;
        repaired = true;
      } else {
        return NextResponse.json(
          {
            error: "Model output was not valid JSON",
            parse_error: parseError,
            text,
            ...errorContext(),
          },
          { status: 502 },
        );
      }
    }

    // 3) Zod validation. Real shape errors get one repair attempt.
    let result = Brief.safeParse(parsed);
    if (!result.success) {
      const r = await repairJson(
        client,
        JSON.stringify(parsed),
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("\n"),
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
      return NextResponse.json(
        {
          error: "Brief failed schema validation",
          issues: result.error.issues,
          raw: parsed,
          ...errorContext(),
        },
        { status: 502 },
      );
    }

    const quality = completenessScore(result.data);

    return NextResponse.json({
      brief: result.data,
      usage: final.usage,
      quality: {
        ...quality,
        repaired,
        research_attempts: researchAttempts,
        source_candidates: sourceCandidates,
        mode,
      },
    });
  } catch (err: any) {
    const { error, status } = friendlyError(err);
    return NextResponse.json({ error }, { status });
  }
}
