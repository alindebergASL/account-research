import { NextRequest, NextResponse } from "next/server";
import { HttpError, canStartResearch, requireUser } from "@/lib/auth";
import { newId } from "@/lib/password";
import { parseBoundedJson, jsonBodyErrorResponse } from "@/lib/httpBodyLimits";
import { enqueueResearchJob, researchQueueErrorResponse } from "@/lib/researchQueueLimits";

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

const INTAKE_LIMITS = {
  account: 200,
  segment: 200,
  region: 200,
  goal: 2_000,
  notes: 8_000,
} as const;

function optionalBounded(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("invalid field");
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") > max) throw new Error("oversized field");
  return trimmed || undefined;
}

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
    body = await parseBoundedJson<IntakeBody>(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.account || typeof body.account !== "string" || !body.account.trim()) {
    return NextResponse.json({ error: "Missing 'account' name" }, { status: 400 });
  }
  const mode =
    body.mode === "quick" || body.mode === "deep" ? body.mode : "standard";
  const audience = body.audience === "shareable" ? "shareable" : "internal";

  let intake;
  try {
    intake = {
      account: optionalBounded(body.account, INTAKE_LIMITS.account)!,
      segment: optionalBounded(body.segment, INTAKE_LIMITS.segment),
      region: optionalBounded(body.region, INTAKE_LIMITS.region),
      goal: optionalBounded(body.goal, INTAKE_LIMITS.goal),
      notes: optionalBounded(body.notes, INTAKE_LIMITS.notes),
      audience,
      mode,
    };
  } catch {
    return NextResponse.json({ error: "Research intake field is too large or invalid" }, { status: 400 });
  }

  let jobId: string;
  try {
    jobId = enqueueResearchJob({
      id: newId(), userId: user.id, accountName: intake.account,
      accountSegment: intake.segment, region: intake.region, goal: intake.goal,
      intakeJson: JSON.stringify(intake), mode, intent: "research",
    });
  } catch (error) {
    const response = researchQueueErrorResponse(error);
    if (response) return response;
    throw error;
  }

  return NextResponse.json(
    { jobId, status: "queued" },
    { status: 202 },
  );
}
