import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { softDeleteDecision, updateDecision } from "@/lib/journalDecisions";

export const runtime = "nodejs";

async function userFor(req: NextRequest, briefId: string) {
  const user = requireUser(req);
  if (!canReadBrief(user, briefId)) throw new HttpError(404, { error: "Not found" });
  if (!canWriteBrief(user, briefId)) throw new HttpError(403, { error: "Brief write access required" });
  return user;
}

function errorResponse(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json(error.body, { status: error.status });
  const message = (error as any)?.message || "Invalid decision";
  return NextResponse.json({ error: message }, { status: message === "decision not found" ? 404 : /immutable|only an active|cycle/.test(message) ? 409 : 400 });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string; decisionId: string }> }) {
  const params = await props.params;
  let user;
  try { user = await userFor(req, params.id); } catch (error) { return errorResponse(error); }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid decision patch" }, { status: 400 });
  for (const field of ["source_candidate_id", "source_entry_id", "evidence_snapshot", "created_by", "supersedes_id", "superseded_by_id"]) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return NextResponse.json({ error: `${field} is immutable` }, { status: 400 });
  }
  const patchFields = ["title", "decision_statement", "rationale", "owner_text", "decision_at", "lifecycle"];
  if (!patchFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    return NextResponse.json({ error: "Decision patch is empty" }, { status: 400 });
  }
  try {
    const decision = updateDecision({
      briefId: params.id, decisionId: params.decisionId,
      title: Object.prototype.hasOwnProperty.call(body, "title") ? body.title : undefined,
      decisionStatement: Object.prototype.hasOwnProperty.call(body, "decision_statement") ? body.decision_statement : undefined,
      rationale: Object.prototype.hasOwnProperty.call(body, "rationale") ? body.rationale : undefined,
      ownerText: Object.prototype.hasOwnProperty.call(body, "owner_text") ? body.owner_text : undefined,
      decisionAt: Object.prototype.hasOwnProperty.call(body, "decision_at") ? body.decision_at : undefined,
      lifecycle: Object.prototype.hasOwnProperty.call(body, "lifecycle") ? body.lifecycle : undefined,
      actorUserId: user.id,
    });
    return NextResponse.json({ decision });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string; decisionId: string }> }) {
  const params = await props.params;
  let user;
  try { user = await userFor(req, params.id); } catch (error) { return errorResponse(error); }
  try {
    softDeleteDecision(params.id, params.decisionId, user.id);
    return NextResponse.json({ deleted: true });
  } catch (error) { return errorResponse(error); }
}
