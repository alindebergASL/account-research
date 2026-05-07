import type { NextRequest, NextResponse } from "next/server";

export const USER_COOKIE = "abb_user";

// Reads the anon user-id cookie. If absent, returns a fresh UUID and
// flags `isNew` so the caller can set the cookie on the response.
export function getUserId(req: NextRequest): { userId: string; isNew: boolean } {
  const existing = req.cookies.get(USER_COOKIE)?.value;
  if (existing && /^[0-9a-fA-F-]{20,}$/.test(existing)) {
    return { userId: existing, isNew: false };
  }
  // Web Crypto is available in both Node and Edge runtimes
  const userId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : require("crypto").randomUUID();
  return { userId, isNew: true };
}

export function setUserCookie(res: NextResponse, userId: string) {
  res.cookies.set(USER_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
}
