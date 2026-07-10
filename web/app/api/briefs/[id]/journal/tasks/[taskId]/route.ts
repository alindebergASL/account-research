import { NextRequest, NextResponse } from "next/server";
import { HttpError, canReadBrief, requireUser } from "@/lib/auth";
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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid task patch" }, { status: 400 });
  }

  try {
    const isMove = Object.prototype.hasOwnProperty.call(body, "parent_id");
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
  try {
    const removed = softDeleteTask(params.id, params.taskId);
    return NextResponse.json({ removed });
  } catch (e: any) {
    const message = e?.message || "Not found";
    const status = message === "task not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
