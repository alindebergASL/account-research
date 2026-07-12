// Small helper that mirrors the existing brief access semantics in
// `web/lib/auth.ts` (owner OR row in `brief_shares` OR admin) but takes a
// plain user id rather than a full `PublicUser`. Used by the comments routes
// so call sites don't need to re-derive the existing auth helpers' inputs.
//
// Why not just call `canReadBrief`? `canReadBrief` takes a `PublicUser` and
// uses the user's role to short-circuit for admins. The comments routes
// already call `requireUser`, which returns a `PublicUser`, so they use
// `canReadBrief` directly. This helper exists for places (e.g. tests, future
// non-route call sites) that only have a user id.
//
// Both code paths converge on the same SQL — there is exactly one definition
// of "can this user access this brief" between this file and `auth.ts`.

import { db } from "./db";

export function canUserAccessBrief(userId: string, briefId: string): boolean {
  const row = db()
    .prepare(
      `SELECT u.role AS role,
              b.user_id AS owner_id,
              (SELECT 1 FROM brief_shares s
                 WHERE s.brief_id = b.id AND s.user_id = ?) AS shared
         FROM briefs b
         JOIN users u ON u.id = ?
        WHERE b.id = ?`,
    )
    .get(userId, userId, briefId) as
    | { role: string; owner_id: string; shared: number | null }
    | undefined;
  if (!row) return false;
  if (row.owner_id === userId) return true;
  if (row.role === "admin") return true;
  return !!row.shared;
}

// Assignment targets must still be active and must be a real member of the
// brief (owner/admin/shared). This intentionally checks disabled_at, unlike a
// historical share row by itself.
export function isActiveBriefMember(userId: string, briefId: string): boolean {
  const row = db()
    .prepare(
      `SELECT 1 AS allowed
         FROM users u
         JOIN briefs b ON b.id = ?
        WHERE u.id = ?
          AND u.disabled_at IS NULL
          AND (u.role = 'admin' OR b.user_id = u.id OR EXISTS (
            SELECT 1 FROM brief_shares s WHERE s.brief_id = b.id AND s.user_id = u.id
          ))`,
    )
    .get(briefId, userId) as { allowed: number } | undefined;
  return !!row;
}
