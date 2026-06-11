"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  MessageSquare,
  Reply,
  Sparkles,
  Trash2,
  Pencil,
} from "lucide-react";

type Author = {
  id: string;
  display_name: string | null;
  email: string;
};

type Comment = {
  id: string;
  parent_id: string | null;
  body: string | null;
  ai_assisted: boolean;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  author: Author;
};

type AssistMode =
  | "draft_reply"
  | "summarize_thread"
  | "extract_actions"
  | "suggest_followups";

const EDIT_WINDOW_MS = 15 * 60 * 1000;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function authorName(a: Author): string {
  return a.display_name || a.email || "Unknown";
}

export default function CommentsSection({
  briefId,
  currentUserId,
  isAdmin,
  collapseLongBodies = false,
}: {
  briefId: string;
  currentUserId: string;
  isAdmin: boolean;
  collapseLongBodies?: boolean;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [aiAssistedDraft, setAiAssistedDraft] = useState(false);
  const [posting, setPosting] = useState(false);
  const [assistBusy, setAssistBusy] = useState<AssistMode | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [expandedBodies, setExpandedBodies] = useState<string[]>([]);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/comments`, {
        cache: "no-store",
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setComments(data.comments ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load comments");
    } finally {
      setLoading(false);
    }
  }, [briefId]);

  useEffect(() => {
    load();
  }, [load]);

  const { roots, childrenByParent } = useMemo(() => {
    const map = new Map<string, Comment[]>();
    const top: Comment[] = [];
    for (const c of comments ?? []) {
      if (c.parent_id) {
        const arr = map.get(c.parent_id) ?? [];
        arr.push(c);
        map.set(c.parent_id, arr);
      } else {
        top.push(c);
      }
    }
    return { roots: top, childrenByParent: map };
  }, [comments]);

  const focusCompose = useCallback((pid: string | null) => {
    setParentId(pid);
    setTimeout(() => composeRef.current?.focus(), 0);
  }, []);

  async function submit() {
    const text = composeText.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: text,
          parent_id: parentId ?? undefined,
          ai_assisted: aiAssistedDraft,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      setComposeText("");
      setParentId(null);
      setAiAssistedDraft(false);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to post comment");
    } finally {
      setPosting(false);
    }
  }

  async function runAssist(mode: AssistMode) {
    if (assistBusy) return;
    setAssistBusy(mode);
    try {
      const r = await fetch(`/api/briefs/${briefId}/comments/ai-assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          parent_id: parentId ?? undefined,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setComposeText(data.text || "");
      setAiAssistedDraft(true);
      setTimeout(() => composeRef.current?.focus(), 0);
    } catch (e: any) {
      setError(e?.message || "AI assist failed");
    } finally {
      setAssistBusy(null);
    }
  }

  async function saveEdit(commentId: string) {
    const text = editText.trim();
    if (!text) return;
    try {
      const r = await fetch(
        `/api/briefs/${briefId}/comments/${commentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: text }),
        },
      );
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      setEditingId(null);
      setEditText("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to edit comment");
    }
  }

  async function softDelete(commentId: string) {
    if (!confirm("Delete this comment?")) return;
    try {
      const r = await fetch(
        `/api/briefs/${briefId}/comments/${commentId}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to delete comment");
    }
  }

  function renderComment(c: Comment, depth: number) {
    const deleted = c.deleted_at !== null;
    const isOwn = c.author.id === currentUserId && !deleted;
    const withinEditWindow = Date.now() - c.created_at <= EDIT_WINDOW_MS;
    const canEdit = isOwn && withinEditWindow;
    const canDelete = !deleted && (isOwn || isAdmin);
    const editing = editingId === c.id;
    return (
      <div
        key={c.id}
        className={depth > 0 ? "ml-8 mt-3" : "mt-4"}
      >
        <div className="rounded-xl border border-[var(--line)] bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-ink">
                {deleted ? "(deleted)" : authorName(c.author)}
              </span>
              <span className="text-muted">·</span>
              <span className="text-muted" title={new Date(c.created_at).toISOString()}>
                {relativeTime(c.created_at)}
                {c.edited_at && !deleted ? " · edited" : ""}
              </span>
              {c.ai_assisted && !deleted && (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 border border-violet-200 text-violet-800 px-2 py-0.5 text-xs">
                  <Sparkles className="size-3" /> AI-assisted
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!deleted && (
                <button
                  type="button"
                  onClick={() => focusCompose(c.parent_id ?? c.id)}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
                >
                  <Reply className="size-3" /> Reply
                </button>
              )}
              {canEdit && !editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(c.id);
                    setEditText(c.body ?? "");
                  }}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
                >
                  <Pencil className="size-3" /> Edit
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={() => softDelete(c.id)}
                  className="inline-flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700"
                >
                  <Trash2 className="size-3" /> Delete
                </button>
              )}
            </div>
          </div>

          {editing ? (
            <div className="mt-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="w-full rounded-lg border border-[var(--line)] p-2 text-sm"
                rows={3}
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => saveEdit(c.id)}
                  className="rounded-md bg-ink text-white px-3 py-1 text-xs"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setEditText("");
                  }}
                  className="rounded-md border border-[var(--line)] px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : deleted ? (
            <p className="mt-2 text-sm whitespace-pre-wrap text-ink">
              <span className="italic text-muted">This comment was deleted.</span>
            </p>
          ) : (
            (() => {
              const body = c.body ?? "";
              const isLong = collapseLongBodies && body.length > 350;
              const expanded = expandedBodies.includes(c.id);
              return (
                <>
                  <p
                    className={`mt-2 text-sm whitespace-pre-wrap break-words text-ink ${
                      isLong && !expanded ? "line-clamp-4" : ""
                    }`}
                  >
                    {body}
                  </p>
                  {isLong && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedBodies((cur) =>
                          cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id],
                        )
                      }
                      className="mt-1 text-xs font-medium text-[var(--text-secondary)] underline-offset-2 hover:text-ink hover:underline"
                    >
                      {expanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </>
              );
            })()
          )}
        </div>
        {(childrenByParent.get(c.id) ?? []).map((child) =>
          renderComment(child, depth + 1),
        )}
      </div>
    );
  }

  return (
    <section className="max-w-7xl mx-auto px-6 mt-8 pb-24">
      <header className="flex items-center gap-2 mb-4">
        <MessageSquare className="size-5 text-muted" />
        <h2 className="text-lg font-semibold text-ink">Comments</h2>
        {comments && comments.length > 0 && (
          <span className="text-sm text-muted">({comments.length})</span>
        )}
      </header>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      )}

      {loading && !comments && (
        <div className="text-sm text-muted">Loading comments…</div>
      )}

      {comments && comments.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-white p-6 text-sm text-muted">
          No comments yet. Start the discussion. Use the AI helper buttons
          below to draft a reply, summarize the thread, extract actions, or
          surface follow-up questions.
        </div>
      )}

      {comments && roots.map((c) => renderComment(c, 0))}

      <div className="mt-6 rounded-xl border border-[var(--line)] bg-white p-4">
        {parentId && (
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>Replying to a comment</span>
            <button
              type="button"
              onClick={() => setParentId(null)}
              className="text-muted hover:text-ink"
            >
              Cancel reply
            </button>
          </div>
        )}
        <div className="flex flex-wrap gap-2 mb-2">
          {(
            [
              ["draft_reply", "Draft reply"],
              ["summarize_thread", "Summarize thread"],
              ["extract_actions", "Action items"],
              ["suggest_followups", "Follow-up questions"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => runAssist(mode)}
              disabled={assistBusy !== null}
              className="inline-flex items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-2 py-1 text-xs text-violet-900 hover:bg-violet-100 disabled:opacity-50"
            >
              {assistBusy === mode ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              {label}
            </button>
          ))}
        </div>
        <textarea
          ref={composeRef}
          value={composeText}
          onChange={(e) => {
            setComposeText(e.target.value);
            // Any user typing after AI draft still counts as ai_assisted —
            // they kept (or edited) the AI text. If they fully cleared and
            // retyped, drop the flag.
            if (e.target.value.trim() === "") setAiAssistedDraft(false);
          }}
          placeholder={
            parentId ? "Write your reply…" : "Add a comment to the discussion…"
          }
          rows={3}
          className="w-full rounded-lg border border-[var(--line)] p-2 text-sm"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted">
            {aiAssistedDraft
              ? "Will be marked AI-assisted when posted."
              : "Posts as your own comment."}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={posting || !composeText.trim()}
            className="rounded-md bg-ink text-white px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {posting ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </section>
  );
}
