import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { insertDecision, listDecisions } from "@/lib/journalDecisions";

export const runtime = "nodejs";

function authorize(req: NextRequest, briefId: string) {
  const user = requireUser(req);
  if (!canReadBrief(user, briefId)) throw new HttpError(404, { error: "Not found" });
  return user;
}

function responseFor(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json(error.body, { status: error.status });
  return null;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    authorize(req, id);
    return NextResponse.json({ decisions: listDecisions(id) });
  } catch (error) {
    const response = responseFor(error);
    if (response) return response;
    throw error;
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  let user;
  try {
    user = authorize(req, id);
  } catch (error) {
    const response = responseFor(error);
    if (response) return response;
    throw error;
  }
  if (!canWriteBrief(user, id)) return NextResponse.json({ error: "Brief write access required" }, { status: 403 });
  let body: any;
  try { body = await parseBoundedJson(req); } catch (error) { return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  for (const field of ["source_candidate_id", "source_entry_id", "evidence_snapshot", "created_by", "lifecycle", "superseded_by_id"]) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return NextResponse.json({ error: `${field} is server-managed` }, { status: 400 });
  }
  if (body.supersedes_id != null && typeof body.supersedes_id !== "string") return NextResponse.json({ error: "supersedes_id must be a decision id or null" }, { status: 400 });
  try {
    const decision = insertDecision({
      briefId: id, title: body.title, decisionStatement: body.decision_statement,
      rationale: body.rationale, ownerText: body.owner_text, decisionAt: body.decision_at,
      supersedesId: typeof body.supersedes_id === "string" ? body.supersedes_id : null,
      createdBy: user.id,
    });
    return NextResponse.json({ decision }, { status: 201 });
  } catch (error: any) {
    const message = error?.message || "Invalid decision";
    const status = /not found/.test(message) ? 404 : /active|concurrent|cycle/.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
