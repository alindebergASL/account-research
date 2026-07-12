import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { promoteReviewCandidate } from "@/lib/journalPromotion";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; candidateId: string }> },
) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json(error.body, { status: error.status });
    throw error;
  }
  if (!canReadBrief(user, params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Brief write access required for official promotion" }, { status: 403 });
  }
  let input: unknown;
  try {
    input = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const result = promoteReviewCandidate({
      briefId: params.id, candidateId: params.candidateId, actorUserId: user.id, input,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error: any) {
    const message = error?.message || "Promotion failed";
    if (message === "Review candidate not found") return NextResponse.json({ error: "Not found" }, { status: 404 });
    const conflict = /must be accepted|cannot be promoted|task limit|concurrently/.test(message);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 });
  }
}
