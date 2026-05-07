import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  deleteSession,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const id = req.cookies.get(SESSION_COOKIE)?.value;
  if (id) deleteSession(id);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
