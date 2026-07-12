import { NextResponse } from "next/server";
import { db, type ShareLinkRow } from "./db";

export type PublicShareAccess = ShareLinkRow & {
  brief_json: string;
};

/**
 * Resolve a public capability in one query against current persisted state.
 * A token has authority only while its link is unrevoked, unexpired, and its
 * owning brief is currently customer-shareable.
 */
export function getPublicShareAccess(
  token: string,
  now = Date.now(),
): PublicShareAccess | undefined {
  return db()
    .prepare(
      `SELECT l.*, b.brief_json
       FROM brief_share_links l
       JOIN briefs b ON b.id = l.brief_id
       WHERE l.token = ?
         AND l.revoked_at IS NULL
         AND (l.expires_at IS NULL OR l.expires_at > ?)
         AND b.audience = 'shareable'`,
    )
    .get(token, now) as PublicShareAccess | undefined;
}

export function publicNotFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
