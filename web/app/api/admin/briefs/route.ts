import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

type AdminBriefRow = {
  id: string;
  account_name: string;
  segment: string | null;
  audience: string;
  generated_at: string;
  created_at: number;
  user_id: string;
  owner_email: string;
};

export async function GET(req: NextRequest) {
  try {
    requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }
  const rows = db()
    .prepare(
      `SELECT b.id, b.account_name, b.segment, b.audience, b.generated_at,
              b.created_at, b.user_id, u.email AS owner_email
       FROM briefs b
       JOIN users u ON u.id = b.user_id
       ORDER BY b.created_at DESC
       LIMIT 500`,
    )
    .all() as AdminBriefRow[];
  return NextResponse.json({ briefs: rows });
}
