import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const s = getSession(req);
  return NextResponse.json({ user: s?.user ?? null });
}
