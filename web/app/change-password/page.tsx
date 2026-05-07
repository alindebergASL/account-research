"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function ChangePasswordPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <ChangePassword />
    </Suspense>
  );
}

type Me = {
  id: string;
  email: string;
  must_change_password: boolean;
} | null;

function ChangePassword() {
  const router = useRouter();
  const search = useSearchParams();
  const from = search.get("from") || "/";
  const [me, setMe] = useState<Me>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (!d.user) {
          router.replace(`/login?from=${encodeURIComponent("/change-password")}`);
          return;
        }
        setMe(d.user);
      })
      .catch(() => router.replace("/login"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    if (next.length < 10) {
      setError("New password must be at least 10 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New password and confirmation don't match.");
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          current_password: current,
          new_password: next,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d?.error || `Change failed (${r.status})`);
        setLoading(false);
        return;
      }
      router.replace(from);
      router.refresh();
    } catch (err: any) {
      setError(err?.message || "Network error");
      setLoading(false);
    }
  }

  if (!me) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading…
      </main>
    );
  }

  const forced = me.must_change_password;

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-3xl mb-2">
          {forced ? "Set your password" : "Change password"}
        </h1>
        <p className="text-sm text-muted mb-6">
          {forced
            ? "Pick a new password to replace the temporary one."
            : "Changing your password signs you out of all other sessions."}
        </p>
        <form onSubmit={submit} className="space-y-3">
          {!forced && (
            <label className="block">
              <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
                Current password
              </span>
              <input
                type="password"
                required
                autoFocus
                className="field"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                disabled={loading}
              />
            </label>
          )}
          <label className="block">
            <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
              New password
            </span>
            <input
              type="password"
              required
              autoFocus={forced}
              minLength={10}
              className="field"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              disabled={loading}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
              Confirm new password
            </span>
            <input
              type="password"
              required
              minLength={10}
              className="field"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={loading}
            />
          </label>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={
              loading ||
              !next ||
              !confirm ||
              (!forced && !current)
            }
            className="w-full inline-flex items-center justify-center gap-2 bg-ink text-white rounded-xl px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent transition-colors"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Updating
              </>
            ) : (
              "Update password"
            )}
          </button>
        </form>
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
    </main>
  );
}
