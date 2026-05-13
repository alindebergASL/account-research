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

// Force source="chat" on a single chat-appended extension regardless of what
// the model sent. Newly-appended extensions are by definition chat-authored,
// so we never let the model claim source="research" or "model" here.
function forceChatExtension(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value, source: "chat" };
}

function parseAppendedChatExtension(value: any) {
  return BriefExtension.parse(forceChatExtension(value));
}

// op=set replaces the whole extensions array. Items may include legacy
// research-generated entries (source "model" or "research") that the user
// is intentionally preserving — do NOT force "chat" here. We still parse
// each item against BriefExtension so malformed entries are rejected.
function parseSetExtension(value: any) {
  return BriefExtension.parse(value);
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
        value = parseAppendedChatExtension(value);
      } else if (p.op === "set") {
        if (!Array.isArray(value)) {
          throw new Error("extensions set value must be an array");
        }
        value = value.map(parseSetExtension);
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
