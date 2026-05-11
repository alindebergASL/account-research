import { NextRequest, NextResponse } from "next/server";
import { db, type ResearchJobRow } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

function trimError(err: string | null): string | null {
  if (!err) return null;
  const firstLine = err.split(/\r?\n/)[0].trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;
}

type AdminJobRow = ResearchJobRow & { user_email: string | null };

// GET /api/admin/jobs?limit=25 — admin-only. Latest jobs across all users.
export async function GET(req: NextRequest) {
  try {
    requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  const url = new URL(req.url);
  const raw = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 25;

  const rows = db()
    .prepare(
      `SELECT j.*, u.email AS user_email
       FROM research_jobs j
       LEFT JOIN users u ON u.id = j.user_id
       ORDER BY j.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as AdminJobRow[];

  return NextResponse.json({
    jobs: rows.map((r) => ({
      id: r.id,
      account_name: r.account_name,
      mode: r.mode,
      intent: r.intent ?? "create",
      status: r.status,
      cost_usd_cents: r.cost_usd_cents,
      created_at: r.created_at,
      finished_at: r.finished_at,
      brief_id: r.brief_id,
      target_brief_id: r.target_brief_id ?? null,
      error: trimError(r.error),
      user_email: r.user_email,
    })),
  });
}
