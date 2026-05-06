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

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
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
    const stream = await client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20260209" as const, name: "web_search" } as any,
        { type: "web_fetch_20260209" as const, name: "web_fetch" } as any,
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    const final = await stream.finalMessage();

    const textBlock = final.content.find((b: any) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    if (!textBlock) {
      return NextResponse.json(
        { error: "Model returned no text block", raw: final },
        { status: 502 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(textBlock.text));
    } catch (e) {
      return NextResponse.json(
        { error: "Model output was not valid JSON", text: textBlock.text },
        { status: 502 },
      );
    }

    const result = Brief.safeParse(parsed);
    if (!result.success) {
      return NextResponse.json(
        { error: "Brief failed schema validation", issues: result.error.issues, raw: parsed },
        { status: 502 },
      );
    }

    return NextResponse.json({ brief: result.data, usage: final.usage });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const status = err?.status ?? 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
