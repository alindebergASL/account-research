import { z } from "zod";

const Confidence = z.enum(["High", "Medium", "Low", "Not found"]);

export const Signal = z.object({
  text: z.string(),
  source: z.string(),
  confidence: Confidence,
});

export const Initiative = z.object({
  title: z.string(),
  detail: z.string(),
  confidence: Confidence,
  source: z.string(),
});

export const Persona = z.object({
  name: z.string(),
  title: z.string(),
  priority: z.string(),
  opener: z.string(),
  confidence: Confidence,
  source: z.string(),
});

export const Source = z.object({
  title: z.string(),
  url: z.string(),
  accessed: z.string(),
});

export const Brief = z.object({
  account_name: z.string(),
  segment: z.string(),
  generated_at: z.string(),
  audience: z.enum(["internal", "shareable"]),
  snapshot: z.string(),
  priority_summary: z.string(),
  recent_signals: z.array(Signal),
  ai_tech_maturity: z.object({
    rating: z.number().min(1).max(5),
    rationale: z.string(),
  }),
  top_initiatives: z.array(Initiative),
  personas: z.array(Persona),
  buying_path: z.string(),
  first_angle: z.string(),
  risks: z.array(z.string()),
  competitive_signals: z.array(z.string()),
  next_action: z.string(),
  sources: z.array(Source),
});

export type Brief = z.infer<typeof Brief>;
export type Signal = z.infer<typeof Signal>;
export type Initiative = z.infer<typeof Initiative>;
export type Persona = z.infer<typeof Persona>;
export type Source = z.infer<typeof Source>;

// JSON Schema form for Anthropic structured outputs (no zod helpers needed).
export const briefJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    account_name: { type: "string" },
    segment: { type: "string" },
    generated_at: { type: "string" },
    audience: { type: "string", enum: ["internal", "shareable"] },
    snapshot: { type: "string" },
    priority_summary: { type: "string" },
    recent_signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          source: { type: "string" },
          confidence: { type: "string", enum: ["High", "Medium", "Low", "Not found"] },
        },
        required: ["text", "source", "confidence"],
      },
    },
    ai_tech_maturity: {
      type: "object",
      additionalProperties: false,
      properties: {
        rating: { type: "integer", enum: [1, 2, 3, 4, 5] },
        rationale: { type: "string" },
      },
      required: ["rating", "rationale"],
    },
    top_initiatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          confidence: { type: "string", enum: ["High", "Medium", "Low", "Not found"] },
          source: { type: "string" },
        },
        required: ["title", "detail", "confidence", "source"],
      },
    },
    personas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          priority: { type: "string" },
          opener: { type: "string" },
          confidence: { type: "string", enum: ["High", "Medium", "Low", "Not found"] },
          source: { type: "string" },
        },
        required: ["name", "title", "priority", "opener", "confidence", "source"],
      },
    },
    buying_path: { type: "string" },
    first_angle: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    competitive_signals: { type: "array", items: { type: "string" } },
    next_action: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          accessed: { type: "string" },
        },
        required: ["title", "url", "accessed"],
      },
    },
  },
  required: [
    "account_name", "segment", "generated_at", "audience",
    "snapshot", "priority_summary", "recent_signals", "ai_tech_maturity",
    "top_initiatives", "personas", "buying_path", "first_angle",
    "risks", "competitive_signals", "next_action", "sources",
  ],
} as const;
