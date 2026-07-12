import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canCollaborateBrief, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { isActiveBriefMember } from "@/lib/briefAccess";
import { insertTask, listTasksForBrief } from "@/lib/journalTasks";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
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
  return NextResponse.json({ tasks: listTasksForBrief(params.id) });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
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
  if (!canCollaborateBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid task" }, { status: 400 });
  }
  if (body.parent_id != null && typeof body.parent_id !== "string") {
    return NextResponse.json({ error: "parent_id must be a task id or null" }, { status: 400 });
  }
  for (const field of ["source_candidate_id", "source_entry_id", "promoted_by", "promoted_at"]) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return NextResponse.json({ error: `${field} is promotion-managed` }, { status: 400 });
    }
  }
  const changesAssignment =
    Object.prototype.hasOwnProperty.call(body, "owner_text") ||
    Object.prototype.hasOwnProperty.call(body, "assignee_user_id");
  const changesEvidence = Object.prototype.hasOwnProperty.call(body, "evidence_snapshot");
  if ((changesAssignment || changesEvidence) && !canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Brief write access required to change task assignment or evidence" }, { status: 403 });
  }
  if (Object.prototype.hasOwnProperty.call(body, "assignee_user_id") && body.assignee_user_id != null && body.assignee_user_id !== "") {
    if (typeof body.assignee_user_id !== "string" || !isActiveBriefMember(body.assignee_user_id, params.id)) {
      return NextResponse.json({ error: "assignee must be an active member with brief access" }, { status: 400 });
    }
  }

  const parentId =
    typeof body.parent_id === "string" ? body.parent_id : null;
  try {
    const task = insertTask({
      briefId: params.id,
      parentId,
      body: body.body,
      createdBy: user.id,
      ownerText: body.owner_text,
      assigneeUserId: body.assignee_user_id,
      dueAt: body.due_at,
      priority: body.priority,
      evidenceSnapshot: body.evidence_snapshot,
    });
    return NextResponse.json({ task });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Invalid task" },
      { status: 400 },
    );
  }
}
