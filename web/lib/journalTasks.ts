import { db, type JournalTaskRow } from "@/lib/db";
import { newId } from "@/lib/password";

// Hierarchical to-do checklists scoped to a brief's journal. Tasks nest via
// parent_id (NULL = top-level), order among siblings via `position`, and carry
// completion state (done / done_by / done_at). Deletes are soft and cascade to
// the whole subtree in this layer.

export const MAX_TASK_BODY_CHARS = 500;
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
  children: JournalTaskDto[];
};

export function validateTaskBody(value: unknown): string {
  if (typeof value !== "string") throw new Error("body must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("body is required");
  if (trimmed.length > MAX_TASK_BODY_CHARS) throw new Error("body is too long");
  return trimmed;
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
}): JournalTaskDto {
  const body = validateTaskBody(args.body);
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
  db()
    .prepare(
      `INSERT INTO journal_tasks
         (id, brief_id, parent_id, body, done, done_by, done_at, position, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(id, args.briefId, parentId, body, position, args.createdBy, now, now);
  return rowToDto(loadRow(args.briefId, id)!, []);
}

export function updateTask(args: {
  briefId: string;
  taskId: string;
  body?: unknown;
  done?: unknown;
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

  db()
    .prepare(
      `UPDATE journal_tasks
          SET body = ?, done = ?, done_by = ?, done_at = ?, updated_at = ?
        WHERE id = ? AND brief_id = ? AND deleted_at IS NULL`,
    )
    .run(body, done, doneBy, doneAt, now, args.taskId, args.briefId);
  return rowToDto(loadRow(args.briefId, args.taskId)!, []);
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
