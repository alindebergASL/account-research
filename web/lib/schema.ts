import { z } from "zod";

const Confidence = z.enum(["High", "Medium", "Low", "Not found"]);

export const Signal = z.object({
  text: z.string(),
  source: z.string(),
  confidence: Confidence,
  previously_found: z.boolean().optional(),
});

export const Initiative = z.object({
  title: z.string(),
  detail: z.string(),
  confidence: Confidence,
  source: z.string(),
  previously_found: z.boolean().optional(),
});

export const Persona = z.object({
  name: z.string(),
  title: z.string(),
  priority: z.string(),
  opener: z.string(),
  confidence: Confidence,
  source: z.string(),
  previously_found: z.boolean().optional(),
});

export const Source = z.object({
  title: z.string(),
  url: z.string(),
  accessed: z.string(),
});

// Accepts:
//  - "research" — new research-generated extensions (PR-A spec)
//  - "model"    — legacy research-generated extensions (pre-PR-A)
//  - "chat"     — chat-appended extensions
// Legacy "model" stays valid so existing briefs continue to parse without
// migration. New research output should use "research"; chat patches always
// force "chat".
const ExtensionSource = z.enum(["model", "research", "chat"]);

// List items accept both shapes:
//  - string                            (legacy / pre-PR-A)
//  - { heading?: string; text: string } (PR-A spec)
// Renderers normalise to "{heading}: {text}" when heading is present.
export const ExtensionListItem = z.union([
  z.string(),
  z.object({
    heading: z.string().optional(),
    text: z.string(),
  }),
]);
export type ExtensionListItem = z.infer<typeof ExtensionListItem>;

export const ExtensionBase = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  source: ExtensionSource,
  created_at: z.string(),
  why_included: z.string(),
  confidence: Confidence,
  sources: z.array(Source),
  previously_found: z.boolean().optional(),
});

export const CardExtension = ExtensionBase.extend({
  kind: z.literal("card"),
  body: z.string(),
  // PR-A spec: small chips on the card. Defaulted so legacy rows without
  // a badges field still parse.
  badges: z.array(z.string()).default([]),
});

export const TableExtension = ExtensionBase.extend({
  kind: z.literal("table"),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.string())),
});

export const ListExtension = ExtensionBase.extend({
  kind: z.literal("list"),
  items: z.array(ExtensionListItem),
});

export const NarrativeExtension = ExtensionBase.extend({
  kind: z.literal("narrative"),
  body: z.string(),
});

export const BriefExtension = z.discriminatedUnion("kind", [
  CardExtension,
  TableExtension,
  ListExtension,
  NarrativeExtension,
]);

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
  extensions: z.array(BriefExtension).default([]),
  sources: z.array(Source),
});

// Heuristic completeness check for a saved brief.
// Returns a sparse-fields count and an isLow flag the canvas uses to
// surface a warning banner ("research came back thin — re-run").
export function briefCompleteness(b: z.infer<typeof Brief>) {
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
  return { filled, total: checks.length, isLow: filled < 4 };
}

export type Brief = z.infer<typeof Brief>;
export type Signal = z.infer<typeof Signal>;
export type Initiative = z.infer<typeof Initiative>;
export type Persona = z.infer<typeof Persona>;
export type Source = z.infer<typeof Source>;
export type ExtensionBase = z.infer<typeof ExtensionBase>;
export type BriefExtension = z.infer<typeof BriefExtension>;
export type TechnicalFootprint = z.infer<typeof TechnicalFootprint>;
export type ProgramsProcurement = z.infer<typeof ProgramsProcurement>;

// JSON Schema form for Anthropic structured outputs (no zod helpers needed).

const sourceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    url: { type: "string" },
    accessed: { type: "string" },
  },
  required: ["title", "url", "accessed"],
} as const;

const extensionBaseJsonProperties = {
  id: { type: "string" },
  title: { type: "string" },
  // Includes "research" (PR-A spec, preferred for new research output) and
  // "model" (legacy pre-PR-A). Chat patches are stamped "chat" server-side.
  source: { type: "string", enum: ["model", "research", "chat"] },
  created_at: { type: "string" },
  why_included: { type: "string" },
  confidence: { type: "string", enum: ["High", "Medium", "Low", "Not found"] },
  sources: { type: "array", items: sourceJsonSchema },
  previously_found: { type: "boolean" },
} as const;

const extensionBaseRequired = [
  "kind",
  "id",
  "title",
  "source",
  "created_at",
  "why_included",
  "confidence",
  "sources",
] as const;

export const briefExtensionJsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...extensionBaseJsonProperties,
        kind: { type: "string", enum: ["card"] },
        body: { type: "string" },
        badges: { type: "array", items: { type: "string" } },
      },
      required: [...extensionBaseRequired, "body"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...extensionBaseJsonProperties,
        kind: { type: "string", enum: ["table"] },
        columns: { type: "array", items: { type: "string" } },
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: [...extensionBaseRequired, "columns", "rows"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...extensionBaseJsonProperties,
        kind: { type: "string", enum: ["list"] },
        items: {
          type: "array",
          // Accepts either a plain string or an object with optional
          // heading + required text. Anthropic structured outputs treat
          // a `type: ["string", "object"]` items field as a union.
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  heading: { type: "string" },
                  text: { type: "string" },
                },
                required: ["text"],
              },
            ],
          },
        },
      },
      required: [...extensionBaseRequired, "items"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...extensionBaseJsonProperties,
        kind: { type: "string", enum: ["narrative"] },
        body: { type: "string" },
      },
      required: [...extensionBaseRequired, "body"],
    },
  ],
} as const;
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
          previously_found: { type: "boolean" },
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
          previously_found: { type: "boolean" },
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
          previously_found: { type: "boolean" },
        },
        required: ["name", "title", "priority", "opener", "confidence", "source"],
      },
    },
    buying_path: { type: "string" },
    first_angle: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    competitive_signals: { type: "array", items: { type: "string" } },
    next_action: { type: "string" },
    extensions: {
      type: "array",
      items: briefExtensionJsonSchema,
    },
    sources: {
      type: "array",
      items: sourceJsonSchema,
    },
  },
  required: [
    "account_name", "segment", "generated_at", "audience",
    "snapshot", "priority_summary", "recent_signals", "ai_tech_maturity",
    "top_initiatives", "technical_footprint", "programs_procurement",
    "personas", "buying_path", "first_angle",
    "risks", "competitive_signals", "next_action", "extensions", "sources",
  ],
} as const;
