import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, canStartResearch, requireUser } from "@/lib/auth";
import { newId } from "@/lib/password";

export const runtime = "nodejs";

type IntakeBody = {
  account?: string;
  segment?: string;
  region?: string;
  goal?: string;
  notes?: string;
  audience?: "internal" | "shareable";
  mode?: "quick" | "standard" | "deep";
};

// POST /api/research — enqueue a research job. Returns 202 immediately.
// The worker process drains the queue. Status/result is fetched via
// /api/research-jobs.
export async function POST(req: NextRequest) {
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }
  if (!canStartResearch(user)) {
    return NextResponse.json(
      { error: "Read-only users cannot start research" },
      { status: 403 },
    );
  }

  let body: IntakeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.account || typeof body.account !== "string" || !body.account.trim()) {
    return NextResponse.json({ error: "Missing 'account' name" }, { status: 400 });
  }
  const mode =
    body.mode === "quick" || body.mode === "deep" ? body.mode : "standard";
  const audience = body.audience === "shareable" ? "shareable" : "internal";

  const intake = {
    account: body.account.trim(),
    segment: body.segment?.trim() || undefined,
    region: body.region?.trim() || undefined,
    goal: body.goal?.trim() || undefined,
    notes: body.notes || undefined,
    audience,
    mode,
  };

  const jobId = newId();
  db()
    .prepare(
      `INSERT INTO research_jobs
        (id, user_id, account_name, account_segment, region, goal,
         intake_json, mode, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(
      jobId,
      user.id,
      intake.account,
      intake.segment ?? null,
      intake.region ?? null,
      intake.goal ?? null,
      JSON.stringify(intake),
      mode,
      Date.now(),
    );

  return NextResponse.json(
    { jobId, status: "queued" },
    { status: 202 },
  );
}
