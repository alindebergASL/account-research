"use client";

import { useEffect, useMemo, useState } from "react";
import { MessageSquare, Sparkles } from "lucide-react";

// Public-share read-only DTO. Shape mirrors web/lib/briefComments.ts
// PublicCommentDto — duplicated here as a type so we don't import a
// server module into a client component. The contract is enforced by
// the route handler, which is the canonical producer of this shape.
type PublicComment = {
  id: string;
  parent_id: string | null;
  body: string | null;
  ai_assisted: boolean;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  author_display_name: string | null;
};

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

function authorName(c: PublicComment): string {
  return c.author_display_name || "Unknown";
}

export default function PublicCommentsSection({ token }: { token: string }) {
  const [comments, setComments] = useState<PublicComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${encodeURIComponent(token)}/comments`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) {
          // 404 here just means "no thread visible" — treat it the same
          // as an empty list rather than surfacing an error to anonymous
          // readers who can't act on it anyway.
          if (r.status === 404) {
            if (!cancelled) setComments([]);
            return null;
          }
          throw new Error(`HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        if (cancelled || data == null) return;
        setComments(Array.isArray(data.comments) ? data.comments : []);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load comments");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const { roots, childrenByParent } = useMemo(() => {
    const map = new Map<string, PublicComment[]>();
    const top: PublicComment[] = [];
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

  function renderComment(c: PublicComment, depth: number) {
    const deleted = c.deleted_at !== null;
    return (
      <div key={c.id} className={depth > 0 ? "ml-8 mt-3" : "mt-4"}>
        <div className="rounded-xl border border-[var(--line)] bg-white p-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-ink">
              {deleted ? "(deleted)" : authorName(c)}
            </span>
            <span className="text-muted">·</span>
            <span
              className="text-muted"
              title={new Date(c.created_at).toISOString()}
            >
              {relativeTime(c.created_at)}
              {c.edited_at && !deleted ? " · edited" : ""}
            </span>
            {c.ai_assisted && !deleted && (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 border border-violet-200 text-violet-800 px-2 py-0.5 text-xs">
                <Sparkles className="size-3" /> AI-assisted
              </span>
            )}
          </div>
          <p className="mt-2 text-sm whitespace-pre-wrap text-ink">
            {deleted ? (
              <span className="italic text-muted">
                This comment was deleted.
              </span>
            ) : (
              c.body
            )}
          </p>
        </div>
        {(childrenByParent.get(c.id) ?? []).map((child) =>
          renderComment(child, depth + 1),
        )}
      </div>
    );
  }

  return (
    <section className="max-w-7xl mx-auto px-6 mt-8 pb-16">
      <header className="flex items-center gap-2 mb-4">
        <MessageSquare className="size-5 text-muted" />
        <h2 className="text-lg font-semibold text-ink">Comments</h2>
        {comments && comments.length > 0 && (
          <span className="text-sm text-muted">({comments.length})</span>
        )}
        <span className="ml-auto rounded-full border border-[var(--line)] bg-white px-2 py-0.5 text-xs text-muted">
          Read-only view. Sign in to participate.
        </span>
      </header>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      )}

      {comments === null && !error && (
        <div className="text-sm text-muted">Loading comments…</div>
      )}

      {comments && comments.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-white p-6 text-sm text-muted">
          No comments yet.
        </div>
      )}

      {comments && roots.map((c) => renderComment(c, 0))}
    </section>
  );
}
