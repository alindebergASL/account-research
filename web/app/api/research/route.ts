import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Brief } from "@/lib/schema";
import { SYSTEM_PROMPT } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 300;

type Intake = {
  account: string;
  segment?: string;
  region?: string;
  goal?: string;
  notes?: string;
  audience?: "internal" | "shareable";
};

const MAX_CONTINUATIONS = 5;
const MAX_OUTPUT_TOKENS = 64000;

function isTruncationError(msg: string): boolean {
  return /unterminated|unexpected end|EOF/i.test(msg);
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

// Server-side tool loops can stop with `pause_turn` after hitting their
// internal iteration cap. Per the API docs, re-send [user, assistant] and the
// server resumes — do NOT inject another user "continue" message.
async function runResearchLoop(
  client: Anthropic,
  userMessage: string,
): Promise<Anthropic.Messages.Message> {
  let messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const stream = await client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" },
      // Auto-cache the largest stable prefix (tools + system prompt). Saves
      // ~90% on the cached portion across repeat requests within ~5 min.
      cache_control: { type: "ephemeral" } as any,
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20260209" as const, name: "web_search" } as any,
        { type: "web_fetch_20260209" as const, name: "web_fetch" } as any,
      ],
      messages,
    });
    const final = await stream.finalMessage();

    if (final.stop_reason === "pause_turn" && i < MAX_CONTINUATIONS) {
      messages = [
        { role: "user", content: userMessage },
        { role: "assistant", content: final.content as any },
      ];
      continue;
    }
    return final;
  }
  throw new Error(
    `Server-side tool loop did not finish in ${MAX_CONTINUATIONS} continuations`,
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

  const userMessage = `Research this account and return the JSON brief.\n\n${intake}\n\nToday's date: ${new Date().toISOString().slice(0, 10)}.`;

  try {
    let final = await runResearchLoop(client, userMessage);
    let researchAttempts = 1;

    function getText(msg: Anthropic.Messages.Message): string | null {
      const tb = msg.content.find((b: any) => b.type === "text") as
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
      final = await runResearchLoop(client, userMessage);
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
      },
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const status = err?.status ?? 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
