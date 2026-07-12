import { db, type JournalTaskRow } from "@/lib/db";
import { createBriefEventStrict } from "@/lib/briefEvents";
import { newId } from "@/lib/password";

// Hierarchical to-do checklists scoped to a brief's journal. Tasks nest via
// parent_id (NULL = top-level), order among siblings via `position`, and carry
// completion state (done / done_by / done_at). Deletes are soft and cascade to
// the whole subtree in this layer.

export const MAX_TASK_BODY_CHARS = 500;
export const MAX_TASK_OWNER_CHARS = 160;
export const MAX_TASK_EVIDENCE_CHARS = 8000;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
// Depth is 0-based: a top-level task is depth 0. Four levels keeps the nested
// checklist UI readable and bounds the recursion.
export const MAX_TASK_DEPTH_LEVELS = 4;
// Guard against runaway growth on a single brief.
export const MAX_TASKS_PER_BRIEF = 500;

export type JournalTaskDto = {
  id: string;
  parent_id: string | null;
  body: string;
  done: boolean;
  done_by: string | null;
  done_at: number | null;
  position: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  owner_text: string | null;
  assignee_user_id: string | null;
  due_at: number | null;
  priority: TaskPriority | null;
  source_candidate_id: string | null;
  source_entry_id: string | null;
  evidence_snapshot: string | null;
  promoted_by: string | null;
  promoted_at: number | null;
  children: JournalTaskDto[];
};

function auditTaskMetadata(args: {
  briefId: string;
  taskId: string;
  actorUserId: string | null;
  operation: "created" | "updated";
  ownerChanged: boolean;
  assigneeUserId: string | null;
  dueAt: number | null;
  priority: TaskPriority | null;
  evidenceUpdated: boolean;
}): void {
  createBriefEventStrict({
    brief_id: args.briefId,
    actor_user_id: args.actorUserId,
    event_type: "journal_task_metadata_updated",
    title: args.operation === "created" ? "Journal task metadata recorded" : "Journal task metadata updated",
    metadata: {
      task_id: args.taskId,
      operation: args.operation,
      owner_changed: args.ownerChanged,
      assignee_user_id: args.assigneeUserId,
      due_at: args.dueAt,
      priority: args.priority,
      evidence_updated: args.evidenceUpdated,
    },
  });
}

export function validateTaskBody(value: unknown): string {
  if (typeof value !== "string") throw new Error("body must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("body is required");
  if (trimmed.length > MAX_TASK_BODY_CHARS) throw new Error("body is too long");
  return trimmed;
}

function nullableText(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new Error(`${field} is too long`);
  return trimmed;
}

export function validateTaskOwner(value: unknown): string | null {
  return nullableText(value, "owner_text", MAX_TASK_OWNER_CHARS);
}

export function validateTaskEvidence(value: unknown): string | null {
  return nullableText(value, "evidence_snapshot", MAX_TASK_EVIDENCE_CHARS);
}

export function validateTaskDueAt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("due_at must be a non-negative integer timestamp or null");
  }
  return value;
}

export function validateTaskPriority(value: unknown): TaskPriority | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !(TASK_PRIORITIES as readonly string[]).includes(value)) {
    throw new Error("priority is invalid");
  }
  return value as TaskPriority;
}

export function validateTaskAssignee(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new Error("assignee_user_id must be a user id or null");
  }
  return value;
}

function rowToDto(row: JournalTaskRow, children: JournalTaskDto[]): JournalTaskDto {
  return {
    id: row.id,
    parent_id: row.parent_id,
    body: row.body,
    done: row.done === 1,
    done_by: row.done_by,
    done_at: row.done_at,
    position: row.position,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owner_text: row.owner_text,
    assignee_user_id: row.assignee_user_id,
    due_at: row.due_at,
    priority: row.priority,
    source_candidate_id: row.source_candidate_id,
    source_entry_id: row.source_entry_id,
    evidence_snapshot: row.evidence_snapshot,
    promoted_by: row.promoted_by,
    promoted_at: row.promoted_at,
    children,
  };
}

function liveRows(briefId: string): JournalTaskRow[] {
  return db()
    .prepare(
      `SELECT * FROM journal_tasks
        WHERE brief_id = ? AND deleted_at IS NULL
        ORDER BY position ASC, created_at ASC`,
    )
    .all(briefId) as JournalTaskRow[];
}

function loadRow(briefId: string, taskId: string): JournalTaskRow | null {
  const row = db()
    .prepare(
      `SELECT * FROM journal_tasks
        WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
    )
    .get(taskId, briefId) as JournalTaskRow | undefined;
  return row ?? null;
}

// Builds the ordered nested tree of all live tasks for a brief.
export function listTasksForBrief(briefId: string): JournalTaskDto[] {
  const rows = liveRows(briefId);
  const childrenOf = new Map<string | null, JournalTaskRow[]>();
  for (const row of rows) {
    const key = row.parent_id;
    const list = childrenOf.get(key) ?? [];
    list.push(row);
    childrenOf.set(key, list);
  }
  const build = (parentId: string | null): JournalTaskDto[] =>
    (childrenOf.get(parentId) ?? []).map((row) => rowToDto(row, build(row.id)));
  return build(null);
}

// Depth of a task by walking up its ancestors (0 = top-level). The walk is
// bounded by MAX_TASK_DEPTH_LEVELS so a corrupt cycle can never spin forever.
function depthOf(rows: Map<string, JournalTaskRow>, taskId: string): number {
  let depth = 0;
  let cursor = rows.get(taskId)?.parent_id ?? null;
  while (cursor != null) {
    depth += 1;
    if (depth > MAX_TASK_DEPTH_LEVELS) break; // defensive; should never happen
    cursor = rows.get(cursor)?.parent_id ?? null;
  }
  return depth;
}

// Height of a subtree relative to its root (0 = leaf).
function subtreeHeight(
  childrenOf: Map<string | null, JournalTaskRow[]>,
  rootId: string,
): number {
  const kids = childrenOf.get(rootId) ?? [];
  if (kids.length === 0) return 0;
  return 1 + Math.max(...kids.map((k) => subtreeHeight(childrenOf, k.id)));
}

function indexLive(briefId: string): {
  byId: Map<string, JournalTaskRow>;
  childrenOf: Map<string | null, JournalTaskRow[]>;
  rows: JournalTaskRow[];
} {
  const rows = liveRows(briefId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string | null, JournalTaskRow[]>();
  for (const r of rows) {
    const list = childrenOf.get(r.parent_id) ?? [];
    list.push(r);
    childrenOf.set(r.parent_id, list);
  }
  return { byId, childrenOf, rows };
}

export function insertTask(args: {
  briefId: string;
  parentId?: string | null;
  body: unknown;
  createdBy: string | null;
  ownerText?: unknown;
  assigneeUserId?: unknown;
  dueAt?: unknown;
  priority?: unknown;
  evidenceSnapshot?: unknown;
  sourceCandidateId?: string | null;
  sourceEntryId?: string | null;
  promotedBy?: string | null;
  promotedAt?: number | null;
}): JournalTaskDto {
  const body = validateTaskBody(args.body);
  const ownerText = validateTaskOwner(args.ownerText);
  const assigneeUserId = validateTaskAssignee(args.assigneeUserId);
  const dueAt = validateTaskDueAt(args.dueAt);
  const priority = validateTaskPriority(args.priority);
  const evidenceSnapshot = validateTaskEvidence(args.evidenceSnapshot);
  const parentId = args.parentId ?? null;
  const { byId, childrenOf, rows } = indexLive(args.briefId);

  if (rows.length >= MAX_TASKS_PER_BRIEF) {
    throw new Error("task limit reached for this brief");
  }
  if (parentId != null) {
    const parent = byId.get(parentId);
    if (!parent) throw new Error("parent task not found");
    if (depthOf(byId, parentId) + 1 >= MAX_TASK_DEPTH_LEVELS) {
      throw new Error("maximum task nesting depth reached");
    }
  }

  const siblings = childrenOf.get(parentId) ?? [];
  const position =
    siblings.length === 0
      ? 0
      : Math.max(...siblings.map((s) => s.position)) + 1;

  const id = newId();
  const now = Date.now();
  const hasMetadata = [args.ownerText, args.assigneeUserId, args.dueAt, args.priority, args.evidenceSnapshot]
    .some((value) => value !== undefined);
  const create = db().transaction(() => {
    db().prepare(
      `INSERT INTO journal_tasks
         (id, brief_id, parent_id, body, done, done_by, done_at, position, created_by,
          created_at, updated_at, owner_text, assignee_user_id, due_at, priority,
          evidence_snapshot, source_candidate_id, source_entry_id, promoted_by, promoted_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, args.briefId, parentId, body, position, args.createdBy, now, now,
      ownerText, assigneeUserId, dueAt, priority, evidenceSnapshot,
      args.sourceCandidateId ?? null, args.sourceEntryId ?? null,
      args.promotedBy ?? null, args.promotedAt ?? null,
    );
    // Promoted tasks have their own single promotion event in the outer
    // transaction. Manual task metadata uses this consistent sanitized event.
    if (hasMetadata && !args.sourceCandidateId) {
      auditTaskMetadata({
        briefId: args.briefId,
        taskId: id,
        actorUserId: args.createdBy,
        operation: "created",
        ownerChanged: args.ownerText !== undefined,
        assigneeUserId,
        dueAt,
        priority,
        evidenceUpdated: args.evidenceSnapshot !== undefined,
      });
    }
    return rowToDto(loadRow(args.briefId, id)!, []);
  });
  return create();
}

export function updateTask(args: {
  briefId: string;
  taskId: string;
  body?: unknown;
  done?: unknown;
  ownerText?: unknown;
  assigneeUserId?: unknown;
  dueAt?: unknown;
  priority?: unknown;
  evidenceSnapshot?: unknown;
  actorUserId: string | null;
}): JournalTaskDto {
  const row = loadRow(args.briefId, args.taskId);
  if (!row) throw new Error("task not found");

  const now = Date.now();
  let body = row.body;
  if (args.body !== undefined) body = validateTaskBody(args.body);

  let done = row.done;
  let doneBy = row.done_by;
  let doneAt = row.done_at;
  if (args.done !== undefined) {
    if (typeof args.done !== "boolean") throw new Error("done must be a boolean");
    if (args.done) {
      done = 1;
      // Preserve the original completion stamp on a no-op re-check.
      doneAt = row.done === 1 ? row.done_at : now;
      doneBy = row.done === 1 ? row.done_by : args.actorUserId;
    } else {
      done = 0;
      doneAt = null;
      doneBy = null;
    }
  }

  const ownerText = args.ownerText === undefined ? row.owner_text : validateTaskOwner(args.ownerText);
  const assigneeUserId = args.assigneeUserId === undefined
    ? row.assignee_user_id
    : validateTaskAssignee(args.assigneeUserId);
  const dueAt = args.dueAt === undefined ? row.due_at : validateTaskDueAt(args.dueAt);
  const priority = args.priority === undefined ? row.priority : validateTaskPriority(args.priority);
  if (row.source_candidate_id && args.evidenceSnapshot !== undefined) {
    throw new Error("promoted task evidence is immutable");
  }
  const evidenceSnapshot = args.evidenceSnapshot === undefined
    ? row.evidence_snapshot
    : validateTaskEvidence(args.evidenceSnapshot);

  const updatesMetadata = [args.ownerText, args.assigneeUserId, args.dueAt, args.priority, args.evidenceSnapshot]
    .some((value) => value !== undefined);
  const update = db().transaction(() => {
    db().prepare(
      `UPDATE journal_tasks
          SET body = ?, done = ?, done_by = ?, done_at = ?, owner_text = ?,
              assignee_user_id = ?, due_at = ?, priority = ?, evidence_snapshot = ?, updated_at = ?
        WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
    ).run(
      body, done, doneBy, doneAt, ownerText, assigneeUserId, dueAt, priority,
      evidenceSnapshot, now, args.taskId, args.briefId,
    );
    if (updatesMetadata) {
      auditTaskMetadata({
        briefId: args.briefId,
        taskId: args.taskId,
        actorUserId: args.actorUserId,
        operation: "updated",
        ownerChanged: args.ownerText !== undefined,
        assigneeUserId,
        dueAt,
        priority,
        evidenceUpdated: args.evidenceSnapshot !== undefined,
      });
    }
    return rowToDto(loadRow(args.briefId, args.taskId)!, []);
  });
  return update();
}

// Reparent and/or reorder a task. Rejects cycles (moving a task under its own
// descendant) and moves that would push the subtree past the depth limit.
export function moveTask(args: {
  briefId: string;
  taskId: string;
  parentId: string | null;
  position?: number;
}): JournalTaskDto {
  const { byId, childrenOf } = indexLive(args.briefId);
  const row = byId.get(args.taskId);
  if (!row) throw new Error("task not found");
  const newParentId = args.parentId;

  if (newParentId != null) {
    if (newParentId === args.taskId) throw new Error("a task cannot be its own parent");
    const parent = byId.get(newParentId);
    if (!parent) throw new Error("parent task not found");
    // Cycle check: walking up from the new parent must not reach this task.
    let cursor: string | null = newParentId;
    let guard = 0;
    while (cursor != null) {
      if (cursor === args.taskId) throw new Error("cannot move a task under its own descendant");
      cursor = byId.get(cursor)?.parent_id ?? null;
      if (++guard > MAX_TASK_DEPTH_LEVELS + 1) break;
    }
  }

  const newBaseDepth = newParentId == null ? 0 : depthOf(byId, newParentId) + 1;
  if (newBaseDepth + subtreeHeight(childrenOf, args.taskId) >= MAX_TASK_DEPTH_LEVELS) {
    throw new Error("move would exceed maximum task nesting depth");
  }

  const siblings = (childrenOf.get(newParentId) ?? []).filter(
    (s) => s.id !== args.taskId,
  );
  const position =
    typeof args.position === "number" && Number.isFinite(args.position)
      ? args.position
      : siblings.length === 0
        ? 0
        : Math.max(...siblings.map((s) => s.position)) + 1;

  db()
    .prepare(
      `UPDATE journal_tasks
          SET parent_id = ?, position = ?, updated_at = ?
        WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
    )
    .run(newParentId, position, Date.now(), args.taskId, args.briefId);
  return rowToDto(loadRow(args.briefId, args.taskId)!, []);
}

// Soft-delete a task and its entire subtree. Returns the number of tasks
// removed (the root plus descendants).
export function softDeleteTask(briefId: string, taskId: string): number {
  const { byId, childrenOf } = indexLive(briefId);
  if (!byId.has(taskId)) throw new Error("task not found");

  const toDelete: string[] = [];
  const stack = [taskId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    toDelete.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
  }

  const now = Date.now();
  const stmt = db().prepare(
    `UPDATE journal_tasks SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
  );
  const tx = db().transaction((ids: string[]) => {
    for (const id of ids) stmt.run(now, now, id, briefId);
  });
  tx(toDelete);
  return toDelete.length;
}
