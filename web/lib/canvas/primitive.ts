import { z } from "zod";
import { Confidence } from "./schema";

export const PrimitiveNode: z.ZodType<PrimitiveNode> = z.lazy(() =>
  z.discriminatedUnion("p", [
    z.object({ p: z.literal("stack"), direction: z.enum(["row", "col"]), gap: z.number().int().min(0).max(64).optional(), children: z.array(PrimitiveNode).max(50) }),
    z.object({ p: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), text: z.string().max(500) }),
    z.object({ p: z.literal("text"), text: z.string().max(4000), emphasis: z.enum(["normal", "muted", "bold"]).optional() }),
    z.object({ p: z.literal("kv"), items: z.array(z.object({ key: z.string().max(200), value: z.string().max(1000), confidence: Confidence.optional() })).max(40) }),
    z.object({ p: z.literal("list"), items: z.array(z.string().max(1000)).max(100), ordered: z.boolean().optional() }),
    z.object({ p: z.literal("table"), columns: z.array(z.string().max(100)).max(12), rows: z.array(z.array(z.string().max(500)).max(12)).max(100) }),
    z.object({ p: z.literal("badge"), text: z.string().max(120), tone: z.enum(["neutral", "success", "warning", "danger", "info"]) }),
    z.object({ p: z.literal("link"), href: z.string().max(2048), text: z.string().max(500), rel: z.enum(["evidence", "external"]).optional() }),
    z.object({ p: z.literal("evidence_ref"), source_idx: z.number().int().nonnegative() }),
    z.object({ p: z.literal("metric"), label: z.string().max(200), value: z.string().max(500), delta: z.string().max(200).optional() }),
    z.object({ p: z.literal("spacer"), size: z.enum(["sm", "md", "lg"]).optional() }),
    z.object({ p: z.literal("divider") }),
  ]),
);

export type PrimitiveNode =
  | { p: "stack"; direction: "row" | "col"; gap?: number; children: PrimitiveNode[] }
  | { p: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { p: "text"; text: string; emphasis?: "normal" | "muted" | "bold" }
  | { p: "kv"; items: { key: string; value: string; confidence?: z.infer<typeof Confidence> }[] }
  | { p: "list"; items: string[]; ordered?: boolean }
  | { p: "table"; columns: string[]; rows: string[][] }
  | { p: "badge"; text: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }
  | { p: "link"; href: string; text: string; rel?: "evidence" | "external" }
  | { p: "evidence_ref"; source_idx: number }
  | { p: "metric"; label: string; value: string; delta?: string }
  | { p: "spacer"; size?: "sm" | "md" | "lg" }
  | { p: "divider" };

export const PrimitiveSurfaceSpec = z.object({ root: PrimitiveNode });
export type PrimitiveSurfaceSpec = z.infer<typeof PrimitiveSurfaceSpec>;

export function isSafePrimitiveHref(href: string): boolean {
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  try {
    const u = new URL(href);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}
