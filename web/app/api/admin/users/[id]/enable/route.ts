import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }
  db()
    .prepare(`UPDATE users SET disabled_at = NULL WHERE id = ?`)
    .run(params.id);
  return NextResponse.json({ ok: true });
}
