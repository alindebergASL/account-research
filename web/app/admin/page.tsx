"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Copy, Loader2, Plus, Trash2, UserPlus } from "lucide-react";

type AdminUser = {
  id: string;
  email: string;
  role: "admin" | "member";
  display_name: string | null;
  created_at: number;
  brief_count: number;
};

type AdminBrief = {
  id: string;
  account_name: string;
  segment: string | null;
  audience: string;
  generated_at: string;
  created_at: number;
  user_id: string;
  owner_email: string;
};

export default function AdminPage() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [briefs, setBriefs] = useState<AdminBrief[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [tempCred, setTempCred] = useState<{
    email: string;
    password: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user?.role !== "admin") {
          router.replace("/");
          return;
        }
        setAuthorized(true);
        loadAll();
      })
      .catch(() => router.replace("/login"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll() {
    const [u, b] = await Promise.all([
      fetch("/api/admin/users", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/admin/briefs", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setUsers(u.users || []);
    setBriefs(b.briefs || []);
  }

  async function deleteUser(id: string, email: string) {
    if (!confirm(`Delete user ${email}? Their briefs will be reassigned to you.`)) {
      return;
    }
    const r = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    if (r.ok) loadAll();
    else {
      const d = await r.json().catch(() => ({}));
      alert(d?.error || "Delete failed");
    }
  }

  if (authorized === null) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading…
      </main>
    );
  }

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="font-display text-4xl mb-8 tracking-tight">Admin</h1>

      <section className="mb-12">
        <div className="flex items-center mb-4">
          <h2 className="font-display text-xl">Users</h2>
          <span className="ml-3 text-xs text-muted">
            {users ? users.length : "…"}
          </span>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="ml-auto inline-flex items-center gap-2 bg-ink text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            <UserPlus className="size-4" /> Create user
          </button>
        </div>

        {tempCred && (
          <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
            <div className="font-medium mb-1">
              One-time temp password for {tempCred.email}
            </div>
            <div className="flex items-center gap-3">
              <code className="text-base bg-white border border-amber-200 rounded px-2 py-1">
                {tempCred.password}
              </code>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(tempCred.password)
                }
                className="inline-flex items-center gap-1 text-xs text-amber-900 hover:text-ink"
              >
                <Copy className="size-3.5" /> Copy
              </button>
              <button
                type="button"
                onClick={() => setTempCred(null)}
                className="ml-auto text-xs text-muted hover:text-ink"
              >
                Dismiss
              </button>
            </div>
            <div className="text-xs text-muted mt-2">
              Hand this to the user. It won&apos;t be shown again.
            </div>
          </div>
        )}

        <div className="card p-0 hover:!translate-y-0 hover:!cursor-default hover:!shadow-none overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg)] text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Email</th>
                <th className="text-left px-4 py-2 font-medium">Role</th>
                <th className="text-left px-4 py-2 font-medium">Created</th>
                <th className="text-left px-4 py-2 font-medium">Briefs</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => (
                <tr key={u.id} className="border-t border-[var(--line)]">
                  <td className="px-4 py-2">{u.email}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full border ${
                        u.role === "admin"
                          ? "bg-ink text-white border-ink"
                          : "bg-white border-[var(--line)] text-muted"
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-muted">{u.brief_count}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => deleteUser(u.id, u.email)}
                      className="text-muted hover:text-red-600 p-1.5 rounded"
                      aria-label={`Delete ${u.email}`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {users && users.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-muted text-center">
                    No users.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex items-center mb-4">
          <h2 className="font-display text-xl">All briefs</h2>
          <span className="ml-3 text-xs text-muted">
            {briefs ? briefs.length : "…"}
          </span>
        </div>
        <div className="card p-0 hover:!translate-y-0 hover:!cursor-default hover:!shadow-none overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg)] text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Account</th>
                <th className="text-left px-4 py-2 font-medium">Segment</th>
                <th className="text-left px-4 py-2 font-medium">Owner</th>
                <th className="text-left px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {briefs?.map((b) => (
                <tr key={b.id} className="border-t border-[var(--line)] hover:bg-[var(--bg)]">
                  <td className="px-4 py-2">
                    <Link
                      href={`/brief/${b.id}`}
                      className="hover:text-accent font-medium"
                    >
                      {b.account_name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-muted">{b.segment || "—"}</td>
                  <td className="px-4 py-2 text-muted">{b.owner_email}</td>
                  <td className="px-4 py-2 text-muted">
                    {new Date(b.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
              {briefs && briefs.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-muted text-center">
                    No briefs in the system yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showCreate && (
        <CreateUserDialog
          onClose={() => setShowCreate(false)}
          onCreated={(email, password) => {
            setShowCreate(false);
            setTempCred({ email, password });
            loadAll();
          }}
        />
      )}

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

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          display_name: displayName.trim() || undefined,
          role,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d?.error || `Failed (${r.status})`);
        return;
      }
      onCreated(d.user.email, d.temp_password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[var(--line)] overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-[var(--line)]">
          <div className="font-medium">Create user</div>
          <div className="text-xs text-muted">
            A one-time temp password will be generated.
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
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
              disabled={submitting}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
              Display name (optional)
            </span>
            <input
              type="text"
              className="field"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
              Role
            </span>
            <div className="flex gap-2">
              {(["member", "admin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  disabled={submitting}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    role === r
                      ? "bg-ink text-white border-ink"
                      : "bg-white border-[var(--line)] hover:border-ink"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </label>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 bg-[var(--bg)] flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm hover:bg-white"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !email.trim()}
            className="inline-flex items-center gap-2 bg-ink text-white rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-accent transition-colors"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
