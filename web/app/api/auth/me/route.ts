import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const s = getSession(req);
  if (!s) {
    const res = NextResponse.json({ user: null });
    // If the browser still has a stale/invalid abb_session cookie, clear it so
    // the middleware sends the next protected-page request to /login instead
    // of letting the app shell render with user:null.
    clearSessionCookie(res);
    return res;
  }
  return NextResponse.json({ user: s.user });
}
