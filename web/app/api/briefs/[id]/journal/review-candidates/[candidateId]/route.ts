import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import {
  parseReviewCandidateStatus,
  updateReviewCandidateStatus,
} from "@/lib/journalReviewCandidates";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; candidateId: string }> }
) {
  const params = await props.params;
  let user;
  try {
    user = requireUser(req);
  } catch (e) {
    const r = authError(e);
    if (r) return r;
    throw e;
  }
  if (!canReadBrief(user, params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Brief write access required" }, { status: 403 });
  }

  let body: { status?: unknown };
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let status;
  try {
    status = parseReviewCandidateStatus(body.status);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Invalid status" },
      { status: 400 },
    );
  }

  try {
    const candidate = updateReviewCandidateStatus(params.id, params.candidateId, status);
    return NextResponse.json({ candidate });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
