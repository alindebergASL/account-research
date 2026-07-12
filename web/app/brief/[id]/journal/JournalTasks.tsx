"use client";

// Hierarchical to-do checklist for a brief's journal. Self-contained: it owns
// its fetch/CRUD against /api/briefs/[id]/journal/tasks and renders the nested
// tree with toggle / add subtask / inline edit / delete. Reorder + drag are a
// deliberate follow-up; the move API already exists to back them.
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Plus, Trash2, X, ListTodo } from "lucide-react";
import { Card, SectionHeader, EmptyState } from "./ui";
import type { BriefMemberOption } from "./types";
import { recordAnchorIdFromHash } from "@/lib/journalWorkspaceLocation";

type Task = {
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
  priority: "low" | "normal" | "high" | "urgent" | null;
  source_candidate_id: string | null;
  source_entry_id: string | null;
  evidence_snapshot: string | null;
  promoted_by: string | null;
  promoted_at: number | null;
  children: Task[];
};

function flatten(tasks: Task[]): Task[] {
  const out: Task[] = [];
  const walk = (ts: Task[]) => ts.forEach((t) => { out.push(t); walk(t.children); });
  walk(tasks);
  return out;
}

export default function JournalTasks({
  briefId,
  members,
}: {
  briefId: string;
  currentUserId: string;
  members: BriefMemberOption[];
  canWrite: boolean;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTop, setNewTop] = useState("");
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [childText, setChildText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);

  const base = `/api/briefs/${briefId}/journal/tasks`;

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(base, { cache: "no-store" });
      if (!r.ok) throw new Error("Failed to load to-dos");
      const data = await r.json();
      setTasks(data.tasks ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load to-dos");
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tasks === null) return;
    const anchorId = recordAnchorIdFromHash(window.location.hash, "journal-task");
    if (!anchorId) return;
    const frame = window.requestAnimationFrame(() => {
      const anchor = document.getElementById(anchorId);
      if (!anchor) return;
      anchor.scrollIntoView({ block: "center" });
      anchor.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tasks]);

  async function mutate(fn: () => Promise<Response>) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || "Action failed");
      }
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function addTask(parentId: string | null, body: string) {
    const trimmed = body.trim();
    if (!trimmed) return;
    void mutate(() =>
      fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed, parent_id: parentId }),
      }),
    ).then(() => {
      setNewTop("");
      setChildText("");
      setAddingFor(null);
    });
  }

  function toggle(task: Task) {
    void mutate(() =>
      fetch(`${base}/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: !task.done }),
      }),
    );
  }

  function saveEdit(task: Task) {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === task.body) {
      setEditingId(null);
      return;
    }
    void mutate(() =>
      fetch(`${base}/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      }),
    ).then(() => setEditingId(null));
  }

  function remove(task: Task) {
    const n = flatten([task]).length;
    const msg =
      n > 1
        ? `Delete this to-do and its ${n - 1} sub-task${n - 1 === 1 ? "" : "s"}?`
        : "Delete this to-do?";
    if (!window.confirm(msg)) return;
    void mutate(() => fetch(`${base}/${task.id}`, { method: "DELETE" }));
  }

  const all = tasks ? flatten(tasks) : [];
  const doneCount = all.filter((t) => t.done).length;

  function renderTask(task: Task, depth: number) {
    const isEditing = editingId === task.id;
    return (
      <div key={task.id}>
        <div
          id={`journal-task-${task.id}`}
          tabIndex={-1}
          className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-muted)]"
          style={{ marginLeft: depth * 22 }}
        >
          <button
            type="button"
            onClick={() => toggle(task)}
            aria-label={task.done ? "Mark as not done" : "Mark as done"}
            aria-pressed={task.done}
            className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
              task.done
                ? "border-[var(--success-text)] bg-[var(--success-bg)] text-[var(--success-text)]"
                : "border-[var(--line)] bg-white text-transparent hover:border-[var(--text-muted)]"
            }`}
          >
            <Check className="size-3" strokeWidth={3} />
          </button>

          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(task);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="min-w-0 flex-1 rounded-md border border-[var(--line)] px-2 py-1 text-sm"
                />
                <button type="button" onClick={() => saveEdit(task)} className="text-xs font-medium text-[var(--ai-text)]">
                  Save
                </button>
                <button type="button" onClick={() => setEditingId(null)} aria-label="Cancel edit">
                  <X className="size-3.5 text-[var(--text-muted)]" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditingId(task.id);
                  setEditText(task.body);
                }}
                className={`block w-full break-words text-left text-sm ${
                  task.done ? "text-[var(--text-muted)] line-through" : "text-ink"
                }`}
              >
                {task.body}
              </button>
            )}
            {!isEditing && (task.owner_text || task.assignee_user_id || task.due_at || task.priority || task.evidence_snapshot) && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                <span className={`rounded-full px-1.5 py-0.5 ${task.done ? "bg-[var(--success-bg)] text-[var(--success-text)]" : "bg-[var(--surface-muted)]"}`}>{task.done ? "Completed" : "Open"}</span>
                {task.owner_text && <span>Owner: {task.owner_text}</span>}
                {task.assignee_user_id && <span>Assignee: {members.find((member) => member.id === task.assignee_user_id)?.display_name || members.find((member) => member.id === task.assignee_user_id)?.email || task.assignee_user_id}</span>}
                {task.due_at && <span>Due: {new Date(task.due_at).toLocaleDateString()}</span>}
                {task.priority && <span className="capitalize">Priority: {task.priority}</span>}
                {task.evidence_snapshot && <details className="basis-full rounded-md bg-[var(--ai-bg)] p-2 text-[var(--ai-text)]"><summary className="cursor-pointer font-medium">{task.source_candidate_id ? "Frozen evidence" : "Evidence"}</summary><pre className="mt-1 whitespace-pre-wrap font-sans">{task.evidence_snapshot}</pre></details>}
              </div>
            )}
          </div>

          {!isEditing && (
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => {
                  setAddingFor(task.id);
                  setChildText("");
                }}
                aria-label="Add sub-task"
                className="rounded p-1 text-[var(--text-muted)] hover:bg-white hover:text-ink"
              >
                <Plus className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove(task)}
                aria-label="Delete to-do"
                className="rounded p-1 text-[var(--text-muted)] hover:bg-white hover:text-[var(--risk-text)]"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )}
        </div>

        {addingFor === task.id && (
          <div className="flex items-center gap-2 py-1" style={{ marginLeft: (depth + 1) * 22 + 8 }}>
            <ChevronRight className="size-3.5 text-[var(--text-muted)]" />
            <input
              autoFocus
              value={childText}
              onChange={(e) => setChildText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTask(task.id, childText);
                if (e.key === "Escape") setAddingFor(null);
              }}
              placeholder="Sub-task…"
              className="min-w-0 flex-1 rounded-md border border-[var(--line)] px-2 py-1 text-sm"
            />
            <button type="button" onClick={() => addTask(task.id, childText)} className="text-xs font-medium text-[var(--ai-text)]">
              Add
            </button>
            <button type="button" onClick={() => setAddingFor(null)} aria-label="Cancel sub-task">
              <X className="size-3.5 text-[var(--text-muted)]" />
            </button>
          </div>
        )}

        {task.children.map((c) => renderTask(c, depth + 1))}
      </div>
    );
  }

  return (
    <Card className="p-5">
      <SectionHeader
        icon={<ListTodo className="size-4 text-[var(--text-muted)]" />}
        title="To-dos"
        count={all.length}
        description={
          all.length > 0
            ? `${doneCount} of ${all.length} done`
            : "Track action items and checklists for this account. Nest sub-tasks for detail."
        }
      />

      {error && (
        <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--risk-bg)] px-3 py-2 text-sm text-[var(--risk-text)]">
          {error}
        </div>
      )}

      {/* Add top-level task */}
      <div className="mt-4 flex items-center gap-2">
        <Plus className="size-4 shrink-0 text-[var(--text-muted)]" />
        <input
          value={newTop}
          onChange={(e) => setNewTop(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTask(null, newTop);
          }}
          placeholder="Add a to-do and press Enter…"
          className="min-w-0 flex-1 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
        />
        {newTop.trim() && (
          <button
            type="button"
            onClick={() => addTask(null, newTop)}
            disabled={busy}
            className="rounded-lg bg-[var(--active-dark)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Add
          </button>
        )}
      </div>

      <div className="mt-3">
        {tasks === null ? (
          <p className="text-sm text-muted">Loading to-dos…</p>
        ) : all.length === 0 ? (
          <EmptyState
            icon={<ListTodo className="size-5" />}
            title="No to-dos yet"
            description="Capture follow-ups, decisions to confirm, or a prep checklist. Sub-tasks nest under any item."
            className="mt-2"
          />
        ) : (
          <div>{tasks.map((t) => renderTask(t, 0))}</div>
        )}
      </div>
    </Card>
  );
}
