"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { safeApplicationPath } from "../../lib/safeApplicationPath";

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const search = useSearchParams();
  const from = safeApplicationPath(search.get("from"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data?.error || `Login failed (${r.status})`);
        setLoading(false);
        return;
      }
      if (data?.must_change_password) {
        router.replace(
          `/change-password?from=${encodeURIComponent(from)}`,
        );
      } else {
        router.replace(from);
      }
      router.refresh();
    } catch (err: any) {
      setError(err?.message || "Network error");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-3xl mb-2">Sign in</h1>
        <p className="text-sm text-muted mb-6">
          Use the email and password your admin gave you.
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
              Email
            </span>
            <input
              type="email"
              required
              autoFocus
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
              Password
            </span>
            <input
              type="password"
              required
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            disabled={loading || !email || !password}
            className="w-full inline-flex items-center justify-center gap-2 bg-ink text-white rounded-xl px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent transition-colors"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Signing in
              </>
            ) : (
              "Sign in"
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
