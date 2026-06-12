import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { AdminModelGateError } from "@/lib/models";
import { runStrategicAnalysis } from "@/lib/strategicAnalysis";

export const runtime = "nodejs";

type BriefJsonRow = { brief_json: string };

// POST /api/admin/strategic — admin-only strategic analysis over a brief,
// routed through ADMIN_STRATEGIC_MODEL (Fable 5).
//
// Two independent guards must pass:
//   1. `requireAdmin` — rejects any non-admin caller at the route boundary.
//   2. the admin model gate inside `runStrategicAnalysis` — additionally
//      requires an explicit per-call data-posture acknowledgement
//      (`acknowledgeDataPosture: true`). An admin who omits it is refused by
//      the gate (403) before any brief data reaches Fable.
export async function POST(req: NextRequest) {
  let user;
  try {
    user = requireAdmin(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json(e.body, { status: e.status });
    }
    throw e;
  }

  let body: {
    briefId?: unknown;
    prompt?: unknown;
    acknowledgeDataPosture?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const briefId = typeof body.briefId === "string" ? body.briefId : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!briefId) {
    return NextResponse.json({ error: "briefId is required" }, { status: 400 });
  }

  const row = db()
    .prepare(`SELECT brief_json FROM briefs WHERE id = ?`)
    .get(briefId) as BriefJsonRow | undefined;
  if (!row) {
    return NextResponse.json({ error: "Brief not found" }, { status: 404 });
  }

  let briefJson: unknown;
  try {
    briefJson = JSON.parse(row.brief_json);
  } catch {
    return NextResponse.json(
      { error: "Brief data is corrupt" },
      { status: 500 },
    );
  }

  // The gate enforces BOTH conditions; we surface the caller's role and the
  // explicit acknowledgement and let `runStrategicAnalysis` decide.
  const ctx = {
    isAdmin: user.role === "admin",
    acknowledgedDataPosture: body.acknowledgeDataPosture === true,
  };

  try {
    const result = await runStrategicAnalysis({ brief_json: briefJson, prompt }, ctx);
    return NextResponse.json({ text: result.text, model: result.model });
  } catch (e) {
    if (e instanceof AdminModelGateError) {
      // Gate refusal — surface the aggregated reasons. 403: the caller is not
      // permitted to route to this model under the supplied context.
      return NextResponse.json(
        { error: e.message, reasons: e.reasons },
        { status: 403 },
      );
    }
    throw e;
  }
}
