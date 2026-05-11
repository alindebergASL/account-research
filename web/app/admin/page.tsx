"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Ban,
  Bell,
  BellOff,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  UserPlus,
} from "lucide-react";

type AdminUser = {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  display_name: string | null;
  created_at: number;
  disabled_at: number | null;
  must_change_password: number;
  email_notifications_enabled: 0 | 1;
  brief_count: number;
};

const ROLE_LABEL: Record<AdminUser["role"], string> = {
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
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

type AdminJob = {
  id: string;
  account_name: string;
  mode: "quick" | "standard" | "deep";
  intent: "create" | "refresh";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  cost_usd_cents: number | null;
  created_at: number;
  finished_at: number | null;
  brief_id: string | null;
  target_brief_id: string | null;
  error: string | null;
  user_email: string | null;
};

export default function AdminPage() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [me, setMe] = useState<{ id: string } | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [briefs, setBriefs] = useState<AdminBrief[] | null>(null);
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [tempCred, setTempCred] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user?.role !== "admin") {
          router.replace("/");
          return;
        }
        setMe({ id: d.user.id });
        setAuthorized(true);
        loadAll();
      })
      .catch(() => router.replace("/login"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll() {
    const [u, b, e, j] = await Promise.all([
      fetch("/api/admin/users", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/admin/briefs", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/admin/email-status", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { configured: false }))
        .catch(() => ({ configured: false })),
      fetch("/api/admin/jobs?limit=25", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { jobs: [] }))
        .catch(() => ({ jobs: [] })),
    ]);
    setUsers(u.users || []);
    setBriefs(b.briefs || []);
    setEmailConfigured(!!e.configured);
    setJobs(j.jobs || []);
  }

  async function toggleNotifications(u: AdminUser) {
    const next = !u.email_notifications_enabled;
    setBusyUser(u.id);
    try {
      const r = await fetch(`/api/admin/users/${u.id}/notifications`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email_notifications_enabled: next }),
      });
      if (r.ok) loadAll();
      else {
        const d = await r.json().catch(() => ({}));
        alert(d?.error || "Failed");
      }
    } finally {
      setBusyUser(null);
    }
  }

  async function deleteUser(id: string, email: string) {
    if (
      !confirm(
        `Permanently delete ${email}? Their briefs will be reassigned to you. ` +
          `Use Disable instead to keep their data intact.`,
      )
    ) {
      return;
    }
    setBusyUser(id);
    try {
      const r = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
      if (r.ok) loadAll();
      else {
        const d = await r.json().catch(() => ({}));
        alert(d?.error || "Delete failed");
      }
    } finally {
      setBusyUser(null);
    }
  }

  async function toggleDisabled(u: AdminUser) {
    const path = u.disabled_at
      ? `/api/admin/users/${u.id}/enable`
      : `/api/admin/users/${u.id}/disable`;
    setBusyUser(u.id);
    try {
      const r = await fetch(path, { method: "POST" });
      if (r.ok) loadAll();
      else {
        const d = await r.json().catch(() => ({}));
        alert(d?.error || "Failed");
      }
    } finally {
      setBusyUser(null);
    }
  }

  async function changeRole(u: AdminUser, next: AdminUser["role"]) {
    if (next === u.role) return;
    if (next === "admin" && !confirm(`Promote ${u.email} to admin?`)) return;
    setBusyUser(u.id);
    try {
      const r = await fetch(`/api/admin/users/${u.id}/role`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      if (r.ok) loadAll();
      else {
        const d = await r.json().catch(() => ({}));
        alert(d?.error || "Failed");
      }
    } finally {
      setBusyUser(null);
    }
  }

  async function resetPassword(u: AdminUser) {
    if (
      !confirm(
        `Reset ${u.email}'s password? They'll be signed out everywhere ` +
          `and forced to set a new password on next login.`,
      )
    )
      return;
    setBusyUser(u.id);
    try {
      const r = await fetch(
        `/api/admin/users/${u.id}/reset-password`,
        { method: "POST" },
      );
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.temp_password) {
        setTempCred({ email: d.email, password: d.temp_password });
        loadAll();
      } else {
        alert(d?.error || "Failed");
      }
    } finally {
      setBusyUser(null);
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
        {emailConfigured !== null && (
          <div
            className={`mb-4 rounded-xl border px-4 py-2.5 text-sm flex items-center justify-between ${
              emailConfigured
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-amber-300 bg-amber-50 text-amber-900"
            }`}
          >
            <span className="flex items-center gap-2">
              {emailConfigured ? (
                <Bell className="size-4" />
              ) : (
                <BellOff className="size-4" />
              )}
              Email notifications:{" "}
              {emailConfigured
                ? "configured"
                : "not configured (set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM)"}
            </span>
          </div>
        )}
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
              {users?.map((u) => {
                const isSelf = me?.id === u.id;
                const busy = busyUser === u.id;
                return (
                  <tr
                    key={u.id}
                    className={`border-t border-[var(--line)] ${u.disabled_at ? "opacity-60" : ""}`}
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span>{u.email}</span>
                        {u.disabled_at && (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                            Disabled
                          </span>
                        )}
                        {!u.disabled_at && u.must_change_password ? (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                            Pending password change
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {isSelf ? (
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full border ${
                            u.role === "admin"
                              ? "bg-ink text-white border-ink"
                              : "bg-white border-[var(--line)] text-muted"
                          }`}
                        >
                          {ROLE_LABEL[u.role]}
                        </span>
                      ) : (
                        <select
                          value={u.role}
                          onChange={(e) =>
                            changeRole(u, e.target.value as AdminUser["role"])
                          }
                          disabled={busy}
                          aria-label={`Role for ${u.email}`}
                          className="text-xs border border-[var(--line)] rounded-lg px-2 py-1 bg-white disabled:opacity-50"
                        >
                          <option value="admin">Admin</option>
                          <option value="member">Member</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-muted">{u.brief_count}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        {busy && (
                          <Loader2 className="size-4 animate-spin text-muted" />
                        )}
                        <button
                          type="button"
                          onClick={() => toggleNotifications(u)}
                          disabled={busy}
                          className="text-muted hover:text-ink p-1.5 rounded disabled:opacity-40"
                          aria-label={
                            u.email_notifications_enabled
                              ? `Disable email notifications for ${u.email}`
                              : `Enable email notifications for ${u.email}`
                          }
                          title={
                            u.email_notifications_enabled
                              ? "Email notifications: on"
                              : "Email notifications: off"
                          }
                        >
                          {u.email_notifications_enabled ? (
                            <Bell className="size-4" />
                          ) : (
                            <BellOff className="size-4 text-muted/60" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => resetPassword(u)}
                          disabled={busy}
                          className="text-muted hover:text-ink p-1.5 rounded disabled:opacity-40"
                          aria-label={`Reset password for ${u.email}`}
                          title="Reset password"
                        >
                          <KeyRound className="size-4" />
                        </button>
                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => toggleDisabled(u)}
                            disabled={busy}
                            className="text-muted hover:text-ink p-1.5 rounded disabled:opacity-40"
                            aria-label={u.disabled_at ? `Enable ${u.email}` : `Disable ${u.email}`}
                            title={u.disabled_at ? "Enable" : "Disable"}
                          >
                            {u.disabled_at ? (
                              <CheckCircle2 className="size-4" />
                            ) : (
                              <Ban className="size-4" />
                            )}
                          </button>
                        )}
                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => deleteUser(u.id, u.email)}
                            disabled={busy}
                            className="text-muted hover:text-red-600 p-1.5 rounded disabled:opacity-40"
                            aria-label={`Delete ${u.email}`}
                            title="Permanently delete"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
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

      <section className="mt-12">
        <div className="flex items-center mb-4">
          <h2 className="font-display text-xl">Recent jobs</h2>
          <span className="ml-3 text-xs text-muted">
            {jobs ? jobs.length : "…"}
          </span>
          <button
            type="button"
            onClick={loadAll}
            className="ml-auto text-xs text-muted hover:text-fg"
          >
            Refresh
          </button>
        </div>
        <div className="card p-0 hover:!translate-y-0 hover:!cursor-default hover:!shadow-none overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg)] text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Account</th>
                <th className="text-left px-4 py-2 font-medium">User</th>
                <th className="text-left px-4 py-2 font-medium">Intent</th>
                <th className="text-left px-4 py-2 font-medium">Mode</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Cost</th>
                <th className="text-left px-4 py-2 font-medium">Created</th>
                <th className="text-left px-4 py-2 font-medium">Finished</th>
                <th className="text-left px-4 py-2 font-medium">Brief</th>
                <th className="text-left px-4 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs?.map((j) => {
                const briefId = j.brief_id ?? j.target_brief_id;
                const cost =
                  j.cost_usd_cents == null
                    ? "—"
                    : `$${(j.cost_usd_cents / 100).toFixed(2)}`;
                return (
                  <tr key={j.id} className="border-t border-[var(--line)] hover:bg-[var(--bg)]">
                    <td className="px-4 py-2 font-medium">{j.account_name}</td>
                    <td className="px-4 py-2 text-muted">{j.user_email || "—"}</td>
                    <td className="px-4 py-2 text-muted">{j.intent}</td>
                    <td className="px-4 py-2 text-muted">{j.mode}</td>
                    <td className="px-4 py-2 text-muted">{j.status}</td>
                    <td className="px-4 py-2 text-muted">{cost}</td>
                    <td className="px-4 py-2 text-muted">
                      {new Date(j.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-muted">
                      {j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2">
                      {briefId ? (
                        <Link href={`/brief/${briefId}`} className="hover:text-accent">
                          open
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      className="px-4 py-2 text-muted max-w-[260px] truncate"
                      title={j.error || ""}
                    >
                      {j.error || ""}
                    </td>
                  </tr>
                );
              })}
              {jobs && jobs.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-6 text-muted text-center">
                    No research jobs yet.
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
  const [role, setRole] = useState<"admin" | "member" | "viewer">("member");
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
            <div className="flex gap-2 flex-wrap">
              {(["member", "viewer", "admin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  disabled={submitting}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors capitalize ${
                    role === r
                      ? "bg-ink text-white border-ink"
                      : "bg-white border-[var(--line)] hover:border-ink"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <span className="block text-xs text-muted mt-2">
              {role === "viewer"
                ? "Read-only: can open briefs shared with them but cannot start new research."
                : role === "admin"
                  ? "Full access: user management + every brief."
                  : "Standard: can start research and own briefs."}
            </span>
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
