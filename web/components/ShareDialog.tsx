"use client";

import { useEffect, useState } from "react";
import { Loader2, Share2, X } from "lucide-react";

type Role = "viewer" | "editor";

type ShareRow = {
  user_id: string;
  email: string;
  granted_by_email: string;
  created_at: number;
  role: Role;
};

export default function ShareDialog({
  briefId,
  briefName,
  onClose,
}: {
  briefId: string;
  briefName: string;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/briefs/${briefId}/shares`, {
        cache: "no-store",
      });
      if (r.ok) {
        const d = await r.json();
        setShares(d.shares || []);
      } else {
        setShares([]);
      }
    } catch {
      setShares([]);
    }
  }

  useEffect(() => {
    load();
  }, [briefId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !email.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/shares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d?.error || `Could not share (${r.status})`);
        return;
      }
      setEmail("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(userId: string) {
    if (removing) return;
    setRemoving(userId);
    try {
      const r = await fetch(
        `/api/briefs/${briefId}/shares/${userId}`,
        { method: "DELETE" },
      );
      if (r.ok) {
        setShares((prev) =>
          prev ? prev.filter((s) => s.user_id !== userId) : prev,
        );
      }
    } finally {
      setRemoving(null);
    }
  }

  async function changeRole(userId: string, next: Role) {
    if (updatingRole) return;
    const prev = shares;
    setShares((cur) =>
      cur
        ? cur.map((s) => (s.user_id === userId ? { ...s, role: next } : s))
        : cur,
    );
    setUpdatingRole(userId);
    try {
      const r = await fetch(`/api/briefs/${briefId}/shares/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      if (!r.ok) {
        setShares(prev);
      }
    } catch {
      setShares(prev);
    } finally {
      setUpdatingRole(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[var(--line)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--line)] flex items-start gap-3">
          <Share2 className="size-5 mt-0.5 text-accent" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Share brief</div>
            <div className="text-xs text-muted truncate">
              {briefName} · viewers can read & ask, editors can also edit
            </div>
          </div>
          <button
            type="button"
            className="text-muted hover:text-ink p-1 rounded"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={add} className="px-5 py-4 border-b border-[var(--line)]">
          <label className="block">
            <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
              Share with email
            </span>
            <div className="flex gap-2">
              <input
                type="email"
                placeholder="alice@acme.com"
                className="field flex-1"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
              <select
                className="field !w-auto"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={submitting}
                aria-label="Role"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button
                type="submit"
                disabled={submitting || !email.trim()}
                className="inline-flex items-center gap-2 bg-ink text-white rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-accent transition-colors"
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : "Share"}
              </button>
            </div>
          </label>
          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">
              {error}
            </div>
          )}
        </form>

        <div className="max-h-72 overflow-y-auto">
          {shares === null && (
            <div className="px-5 py-6 text-sm text-muted flex items-center gap-2 justify-center">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {shares !== null && shares.length === 0 && (
            <div className="px-5 py-6 text-sm text-muted text-center">
              Not shared with anyone yet.
            </div>
          )}
          {shares?.map((s) => (
            <div
              key={s.user_id}
              className="px-5 py-3 flex items-center gap-3 border-b border-[var(--line)] last:border-b-0"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{s.email}</div>
                <div className="text-[11px] text-muted">
                  Shared by {s.granted_by_email}
                </div>
              </div>
              <select
                value={s.role}
                onChange={(e) =>
                  changeRole(s.user_id, e.target.value as Role)
                }
                disabled={updatingRole === s.user_id}
                className="text-xs border border-[var(--line)] rounded-lg px-2 py-1 bg-white disabled:opacity-50"
                aria-label={`Role for ${s.email}`}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button
                type="button"
                onClick={() => remove(s.user_id)}
                disabled={removing === s.user_id}
                className="text-muted hover:text-red-600 p-1.5 rounded disabled:opacity-50"
                aria-label={`Remove ${s.email}`}
              >
                {removing === s.user_id ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>
      </div>

      <style jsx global>{`
        .field {
          width: 100%;
          background: white;
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 10px 12px;
          font-size: 14px;
          outline: none;
          transition: border-color 0.15s ease;
        }
        .field:focus {
          border-color: var(--accent);
        }
      `}</style>
    </div>
  );
}
