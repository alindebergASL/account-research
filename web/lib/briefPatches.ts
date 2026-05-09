import { Brief, BriefExtension, type Brief as BriefT } from "./schema";

export type BriefPatch = {
  op: "set" | "append";
  field: string;
  value: any;
};

export const ALLOWED_BRIEF_PATCH_FIELDS = new Set([
  "snapshot",
  "priority_summary",
  "recent_signals",
  "ai_tech_maturity",
  "top_initiatives",
  "technical_footprint",
  "programs_procurement",
  "personas",
  "buying_path",
  "first_angle",
  "risks",
  "competitive_signals",
  "next_action",
  "sources",
  "extensions",
]);

function stampChatExtension(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value, source: value.source ?? "chat" };
}

function parseChatExtension(value: any) {
  return BriefExtension.parse(stampChatExtension(value));
}

export function applyPatches(brief: BriefT, patches: BriefPatch[]): BriefT {
  const out: any = { ...brief };
  for (const p of patches) {
    if (!ALLOWED_BRIEF_PATCH_FIELDS.has(p.field)) {
      throw new Error(`field not allowed: ${p.field}`);
    }
    let value = p.value;
    if (p.field === "extensions") {
      if (p.op === "append") {
        value = parseChatExtension(value);
      } else if (p.op === "set") {
        if (!Array.isArray(value)) {
          throw new Error("extensions set value must be an array");
        }
        value = value.map(parseChatExtension);
      }
    }
    if (p.op === "set") {
      out[p.field] = value;
    } else if (p.op === "append") {
      const cur = out[p.field];
      if (!Array.isArray(cur)) {
        throw new Error(`cannot append to non-array field: ${p.field}`);
      }
      out[p.field] = [...cur, value];
    } else {
      throw new Error(`unknown op: ${(p as any).op}`);
    }
  }
  return Brief.parse(out);
}
