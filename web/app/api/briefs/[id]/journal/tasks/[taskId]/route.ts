import { NextRequest, NextResponse } from "next/server";
import { jsonBodyErrorResponse, parseBoundedJson } from "@/lib/httpBodyLimits";
import { HttpError, canCollaborateBrief, canReadBrief, canWriteBrief, requireUser } from "@/lib/auth";
import { isActiveBriefMember } from "@/lib/briefAccess";
import { moveTask, softDeleteTask, updateTask } from "@/lib/journalTasks";

export const runtime = "nodejs";

function authError(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json(e.body, { status: e.status });
  }
  return null;
}

// PATCH supports two distinct operations, chosen by payload:
//   - move/reorder: body carries `parent_id` (string or null) and optional `position`
//   - edit:         body carries `body` and/or `done`
export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; taskId: string }> }
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
  if (!canCollaborateBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: any;
  try {
    body = await parseBoundedJson(req);
  } catch (error) {
    return jsonBodyErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid task patch" }, { status: 400 });
  }
  for (const field of ["source_candidate_id", "source_entry_id", "promoted_by", "promoted_at"]) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return NextResponse.json({ error: `${field} is promotion-managed` }, { status: 400 });
    }
  }
  const isMove = Object.prototype.hasOwnProperty.call(body, "parent_id");
  const editFields = ["body", "done", "owner_text", "assignee_user_id", "due_at", "priority", "evidence_snapshot"];
  if (isMove && editFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    return NextResponse.json({ error: "Move/reorder fields cannot be mixed with edit or metadata fields" }, { status: 400 });
  }
  const changesOwner = Object.prototype.hasOwnProperty.call(body, "owner_text");
  const changesAssignee = Object.prototype.hasOwnProperty.call(body, "assignee_user_id");
  const changesAssignment = changesOwner || changesAssignee;
  const changesEvidence = Object.prototype.hasOwnProperty.call(body, "evidence_snapshot");
  if ((changesAssignment || changesEvidence) && !canWriteBrief(user, params.id)) {
    return NextResponse.json({ error: "Brief write access required to change task assignment or evidence" }, { status: 403 });
  }
  if (changesAssignee && body.assignee_user_id != null && body.assignee_user_id !== "") {
    if (typeof body.assignee_user_id !== "string" || !isActiveBriefMember(body.assignee_user_id, params.id)) {
      return NextResponse.json({ error: "assignee must be an active member with brief access" }, { status: 400 });
    }
  }

  try {
    const task = isMove
      ? moveTask({
          briefId: params.id,
          taskId: params.taskId,
          parentId: typeof body.parent_id === "string" ? body.parent_id : null,
          position: typeof body.position === "number" ? body.position : undefined,
        })
      : updateTask({
          briefId: params.id,
          taskId: params.taskId,
          body: Object.prototype.hasOwnProperty.call(body, "body") ? body.body : undefined,
          done: Object.prototype.hasOwnProperty.call(body, "done") ? body.done : undefined,
          ownerText: Object.prototype.hasOwnProperty.call(body, "owner_text") ? body.owner_text : undefined,
          assigneeUserId: changesAssignee ? body.assignee_user_id : undefined,
          dueAt: Object.prototype.hasOwnProperty.call(body, "due_at") ? body.due_at : undefined,
          priority: Object.prototype.hasOwnProperty.call(body, "priority") ? body.priority : undefined,
          evidenceSnapshot: Object.prototype.hasOwnProperty.call(body, "evidence_snapshot") ? body.evidence_snapshot : undefined,
          actorUserId: user.id,
        });
    return NextResponse.json({ task });
  } catch (e: any) {
    const message = e?.message || "Invalid task patch";
    // A missing task is a 404; everything else is a client validation error.
    const status = message === "task not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string; taskId: string }> }
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
  if (!canCollaborateBrief(user, params.id)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  try {
    const removed = softDeleteTask(params.id, params.taskId);
    return NextResponse.json({ removed });
  } catch (e: any) {
    const message = e?.message || "Not found";
    const status = message === "task not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
