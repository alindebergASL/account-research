import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Brief } from "@/lib/schema";
import { sanitizeBriefForPublic } from "@/lib/publicBrief";
import {
  getPublicShareAccess,
  publicNotFoundResponse,
} from "@/lib/publicShareAccess";

export const runtime = "nodejs";

// Public, no auth. Returns the sanitized brief if the token is live.
// Always 404s on invalid/expired/revoked — never differentiates the
// reason (no leakage about whether a token ever existed).
export async function GET(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const link = getPublicShareAccess(params.token);
  if (!link) return publicNotFoundResponse();

  const parsed = Brief.safeParse(JSON.parse(link.brief_json));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Stored brief failed validation" },
      { status: 500 },
    );
  }

  // Bump access counters. Best-effort — failure here shouldn't block
  // the read.
  try {
    db()
      .prepare(
        `UPDATE brief_share_links
         SET access_count = access_count + 1,
             last_accessed_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), link.id);
  } catch {
    // ignore
  }

  return NextResponse.json({
    brief: sanitizeBriefForPublic(parsed.data),
    expires_at: link.expires_at,
  });
}
