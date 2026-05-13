import type { PublicUser } from "../auth";

// Server-side gate for the read-only canvas preview.
//
// This is the ONLY gate that should be trusted in production. Two
// independent conditions must both hold:
//
//   1. CANVAS_PREVIEW_ENABLED === "1" in the server environment
//      (a deployment-controlled opt-in, NOT a NEXT_PUBLIC_* value, so
//      it isn't inlined into the client bundle).
//   2. The authenticated user has the admin role.
//
// Neither condition alone is sufficient. With the env flag absent and
// off, production stays dark for everyone. With the flag on, only
// admins see the preview surface; members and viewers do not.
//
// This helper must never run on / leak through public share routes
// (/s/[token], /api/share/[token]). Those routes have no authenticated
// user and must not call this helper.
export function canPreviewCanvas(user: PublicUser | null | undefined): boolean {
  if (!user) return false;
  if (process.env.CANVAS_PREVIEW_ENABLED !== "1") return false;
  return user.role === "admin";
}
