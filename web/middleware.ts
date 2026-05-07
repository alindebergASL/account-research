import { NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: [
    // Run on everything except Next assets and the public favicon.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)",
  ],
};

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout", "/api/auth/me"];

// Lightweight gate. The cookie's mere presence is enough to let traffic through;
// each route validates the session against the DB. The goal here is just to keep
// unauthenticated browsers from seeing app pages and to give APIs a clean 401.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const hasSession = !!req.cookies.get("abb_session")?.value;
  if (hasSession) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const url = new URL(`${proto}://${host}/login`);
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}
