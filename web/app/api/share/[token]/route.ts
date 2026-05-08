import { NextRequest, NextResponse } from "next/server";
import { db, type BriefRow, type ShareLinkRow } from "@/lib/db";
import { Brief } from "@/lib/schema";
import { sanitizeBriefForPublic, isShareLinkLive } from "@/lib/publicBrief";

export const runtime = "nodejs";

// Public, no auth. Returns the sanitized brief if the token is live.
// Always 404s on invalid/expired/revoked — never differentiates the
// reason (no leakage about whether a token ever existed).
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } },
) {
  const link = db()
    .prepare(`SELECT * FROM brief_share_links WHERE token = ?`)
    .get(params.token) as ShareLinkRow | undefined;

  if (!link || !isShareLinkLive(link)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const briefRow = db()
    .prepare(`SELECT * FROM briefs WHERE id = ?`)
    .get(link.brief_id) as BriefRow | undefined;
  if (!briefRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = Brief.safeParse(JSON.parse(briefRow.brief_json));
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
