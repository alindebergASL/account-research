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

export const TechnicalFootprint = z.object({
  ai_in_production: z.array(z.string()),
  active_pilots: z.array(z.string()),
  cloud_platforms: z.array(z.string()),
  data_infrastructure: z.string(),
  clinical_platforms: z.string(),
  analytics_bi_stack: z.string(),
  build_vs_buy_posture: z.string(),
  competitive_incumbents: z.array(z.string()),
});

export const ProgramsProcurement = z.object({
  modernization_grants: z.array(z.string()),
  consortium_purchasing: z.array(z.string()),
  active_rfps_contracts: z.array(z.string()),
  ai_governance_policy: z.string(),
  public_ai_use_cases: z.array(z.string()),
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
  technical_footprint: TechnicalFootprint,
  programs_procurement: ProgramsProcurement,
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
export type TechnicalFootprint = z.infer<typeof TechnicalFootprint>;
export type ProgramsProcurement = z.infer<typeof ProgramsProcurement>;

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
    technical_footprint: {
      type: "object",
      additionalProperties: false,
      properties: {
        ai_in_production: { type: "array", items: { type: "string" } },
        active_pilots: { type: "array", items: { type: "string" } },
        cloud_platforms: { type: "array", items: { type: "string" } },
        data_infrastructure: { type: "string" },
        clinical_platforms: { type: "string" },
        analytics_bi_stack: { type: "string" },
        build_vs_buy_posture: { type: "string" },
        competitive_incumbents: { type: "array", items: { type: "string" } },
      },
      required: [
        "ai_in_production",
        "active_pilots",
        "cloud_platforms",
        "data_infrastructure",
        "clinical_platforms",
        "analytics_bi_stack",
        "build_vs_buy_posture",
        "competitive_incumbents",
      ],
    },
    programs_procurement: {
      type: "object",
      additionalProperties: false,
      properties: {
        modernization_grants: { type: "array", items: { type: "string" } },
        consortium_purchasing: { type: "array", items: { type: "string" } },
        active_rfps_contracts: { type: "array", items: { type: "string" } },
        ai_governance_policy: { type: "string" },
        public_ai_use_cases: { type: "array", items: { type: "string" } },
      },
      required: [
        "modernization_grants",
        "consortium_purchasing",
        "active_rfps_contracts",
        "ai_governance_policy",
        "public_ai_use_cases",
      ],
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
    "top_initiatives", "technical_footprint", "programs_procurement",
    "personas", "buying_path", "first_angle",
    "risks", "competitive_signals", "next_action", "sources",
  ],
} as const;
