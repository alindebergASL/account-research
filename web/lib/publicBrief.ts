import type { Brief } from "./schema";

// Strip fields that should NEVER appear on a public share link.
//
// Today: the "Recommended next action" tile reads as internal sales
// strategy and is hidden from outsiders. Any future internal-only
// surfaces (notes, comments, internal_notes, etc.) MUST be stripped
// here so they're absent from every public view (web, PDF, DOCX).
export function sanitizeBriefForPublic(brief: Brief): Brief {
  return {
    ...brief,
    next_action: "",
  };
}

// Stable list of TTL options surfaced in the share dialog. The API
// validates against this set; the client uses the labels for display.
export const SHARE_LINK_TTL_OPTIONS = [
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "never", label: "Never", ms: null as number | null },
] as const;

export type ShareLinkTtl = (typeof SHARE_LINK_TTL_OPTIONS)[number]["id"];

export function ttlToExpiresAt(ttl: ShareLinkTtl, now: number): number | null {
  const opt = SHARE_LINK_TTL_OPTIONS.find((o) => o.id === ttl);
  if (!opt || opt.ms === null) return null;
  return now + opt.ms;
}

export function isShareLinkLive(row: {
  revoked_at: number | null;
  expires_at: number | null;
}): boolean {
  if (row.revoked_at !== null) return false;
  if (row.expires_at !== null && row.expires_at <= Date.now()) return false;
  return true;
}
