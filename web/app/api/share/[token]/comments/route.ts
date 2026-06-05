import { NextRequest, NextResponse } from "next/server";
import { db, type ShareLinkRow } from "@/lib/db";
import { isShareLinkLive } from "@/lib/publicBrief";
import {
  listCommentRowsForBrief,
  rowToPublicDto,
} from "@/lib/briefComments";

export const runtime = "nodejs";

// Public, no auth. Token is the auth. Returns the comment thread for the
// brief behind the token, using the PUBLIC DTO that strips user_id and
// email so anonymous readers only see the author's display_name.
//
// 404s on invalid / expired / revoked tokens — same posture as the
// sibling brief endpoint. No POST/PATCH/DELETE handlers are exported
// from this module, by design: the public share surface is strictly
// read-only and cannot create, edit, or delete comments.
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

  const rows = listCommentRowsForBrief(link.brief_id);
  return NextResponse.json({ comments: rows.map(rowToPublicDto) });
}
