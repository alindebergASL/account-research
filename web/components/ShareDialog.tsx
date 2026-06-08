"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Globe2, Loader2, Lock, Mail, Share2, X } from "lucide-react";
import {
  SHARE_LINK_TTL_OPTIONS,
  type ShareLinkTtl,
} from "@/lib/publicBrief";

type Role = "reader" | "editor";

type ShareRow = {
  user_id: string;
  email: string;
  granted_by_email: string;
  created_at: number;
  role: Role;
};

type ShareLink = {
  id: string;
  token: string;
  created_at: number;
  expires_at: number | null;
  last_accessed_at: number | null;
  access_count: number;
  recent_emails?: Array<{ recipient: string; created_at: number }>;
};

type Audience = "internal" | "shareable";

export default function ShareDialog({
  briefId,
  briefName,
  briefAudience,
  onClose,
}: {
  briefId: string;
  briefName: string;
  briefAudience: Audience;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("reader");
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Public-link state
  const [audience, setAudience] = useState<Audience>(briefAudience);
  const [audienceBusy, setAudienceBusy] = useState(false);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [ttl, setTtl] = useState<ShareLinkTtl>("7d");
  const [creatingLink, setCreatingLink] = useState(false);
  const [revokingLink, setRevokingLink] = useState<string | null>(null);
  const [justCreatedToken, setJustCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [linkEmailInputs, setLinkEmailInputs] = useState<Record<string, string>>({});
  const [sendingLinkEmail, setSendingLinkEmail] = useState<string | null>(null);
  const [linkEmailErrors, setLinkEmailErrors] = useState<Record<string, string>>({});
  const [linkEmailSuccess, setLinkEmailSuccess] = useState<Record<string, string>>({});

  const load = useCallback(async function load() {
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
  }, [briefId]);

  const loadLinks = useCallback(async function loadLinks() {
    try {
      const r = await fetch(`/api/briefs/${briefId}/share-links`, {
        cache: "no-store",
      });
      if (r.ok) {
        const d = await r.json();
        setLinks(d.links || []);
      } else {
        setLinks([]);
      }
    } catch {
      setLinks([]);
    }
  }, [briefId]);

  useEffect(() => {
    load();
    loadLinks();
  }, [briefId, load, loadLinks]);

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

  async function flipAudience() {
    if (audienceBusy) return;
    setAudienceBusy(true);
    try {
      const next: Audience = audience === "internal" ? "shareable" : "internal";
      const r = await fetch(`/api/briefs/${briefId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: next }),
      });
      if (r.ok) {
        setAudience(next);
      }
    } finally {
      setAudienceBusy(false);
    }
  }

  async function createLink() {
    if (creatingLink) return;
    setCreatingLink(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/share-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttl }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.link) {
        setJustCreatedToken(d.link.token);
        setLinks((prev) => (prev ? [d.link, ...prev] : [d.link]));
      }
    } finally {
      setCreatingLink(false);
    }
  }

  async function revokeLink(id: string) {
    if (revokingLink) return;
    setRevokingLink(id);
    try {
      const r = await fetch(
        `/api/briefs/${briefId}/share-links/${id}`,
        { method: "DELETE" },
      );
      if (r.ok) {
        setLinks((prev) => (prev ? prev.filter((l) => l.id !== id) : prev));
        if (justCreatedToken && links?.find((l) => l.id === id)?.token === justCreatedToken) {
          setJustCreatedToken(null);
        }
      }
    } finally {
      setRevokingLink(null);
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(
        () => setCopied((c) => (c === key ? null : c)),
        1500,
      );
    });
  }

  function publicUrl(token: string): string {
    if (typeof window === "undefined") return `/s/${token}`;
    return `${window.location.origin}/s/${token}`;
  }

  async function sendPublicLinkEmail(link: ShareLink) {
    if (sendingLinkEmail) return;
    const recipient = (linkEmailInputs[link.id] || "").trim();
    if (!recipient) return;
    setSendingLinkEmail(link.id);
    setLinkEmailErrors((prev) => ({ ...prev, [link.id]: "" }));
    setLinkEmailSuccess((prev) => ({ ...prev, [link.id]: "" }));
    try {
      const r = await fetch(
        `/api/briefs/${briefId}/share-links/${link.id}/email`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipient }),
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setLinkEmailErrors((prev) => ({
          ...prev,
          [link.id]: emailErrorMessage(r.status, d?.code, d?.error),
        }));
        return;
      }
      const sent = d.email || { recipient, created_at: Date.now() };
      setLinks((prev) =>
        prev
          ? prev.map((l) =>
              l.id === link.id
                ? {
                    ...l,
                    recent_emails: [
                      sent,
                      ...(l.recent_emails || []).filter(
                        (e) => e.recipient !== sent.recipient,
                      ),
                    ].slice(0, 3),
                  }
                : l,
            )
          : prev,
      );
      setLinkEmailInputs((prev) => ({ ...prev, [link.id]: "" }));
      setLinkEmailSuccess((prev) => ({
        ...prev,
        [link.id]: `Sent to ${sent.recipient} just now`,
      }));
    } finally {
      setSendingLinkEmail(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[var(--line)] overflow-hidden max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--line)] flex items-start gap-3">
          <Share2 className="size-5 mt-0.5 text-accent" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Share brief</div>
            <div className="text-xs text-muted truncate">{briefName}</div>
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

        <div className="overflow-y-auto flex-1">
          {/* ---- Public link section ---- */}
          <div className="px-5 py-4 border-b border-[var(--line)]">
            <div className="flex items-center gap-2 mb-2">
              <Globe2 className="size-4 text-muted" />
              <div className="text-xs font-medium uppercase tracking-wider text-muted">
                Public link
              </div>
            </div>

            {audience === "internal" ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 flex items-start gap-2">
                <Lock className="size-4 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div>
                    Public links are off for briefs marked <strong>internal</strong>.
                  </div>
                  <button
                    type="button"
                    onClick={flipAudience}
                    disabled={audienceBusy}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs text-amber-900 underline hover:no-underline disabled:opacity-50"
                  >
                    {audienceBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    Switch this brief to customer-shareable
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* List of active links */}
                {links === null && (
                  <div className="text-sm text-muted flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" /> Loading…
                  </div>
                )}
                {links !== null && links.length === 0 && !justCreatedToken && (
                  <div className="text-sm text-muted">
                    No public links yet.
                  </div>
                )}
                {justCreatedToken && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm">
                    <div className="text-xs uppercase tracking-wider text-emerald-800 mb-1">
                      Link created
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 min-w-0 truncate bg-white border border-emerald-200 rounded px-2 py-1 text-xs">
                        {publicUrl(justCreatedToken)}
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          copy(publicUrl(justCreatedToken), "just")
                        }
                        className="inline-flex items-center gap-1 text-xs text-emerald-900 hover:text-ink p-1.5 rounded"
                        aria-label="Copy link"
                      >
                        {copied === "just" ? (
                          <>
                            <Check className="size-3.5" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="size-3.5" /> Copy
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
                {links?.map((l) => (
                  <div
                    key={l.id}
                    className="border border-[var(--line)] rounded-lg px-3 py-2.5 text-sm space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono truncate text-muted">
                          {publicUrl(l.token)}
                        </div>
                        <div className="text-[11px] text-muted mt-0.5 flex items-center gap-2 flex-wrap">
                          <span>{formatExpiry(l.expires_at)}</span>
                          <span>·</span>
                          <span>
                            {l.access_count} view{l.access_count === 1 ? "" : "s"}
                          </span>
                          {l.last_accessed_at && (
                            <>
                              <span>·</span>
                              <span>last {formatRelative(l.last_accessed_at)}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => copy(publicUrl(l.token), l.id)}
                        className="text-muted hover:text-ink p-1.5 rounded"
                        aria-label="Copy link"
                        title="Copy link"
                      >
                        {copied === l.id ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => revokeLink(l.id)}
                        disabled={revokingLink === l.id}
                        className="text-muted hover:text-red-600 p-1.5 rounded disabled:opacity-50"
                        aria-label="Revoke link"
                        title="Revoke"
                      >
                        {revokingLink === l.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <X className="size-3.5" />
                        )}
                      </button>
                    </div>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        sendPublicLinkEmail(l);
                      }}
                      className="pt-2 border-t border-[var(--line)] space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="email"
                          placeholder="customer@example.com"
                          className="field flex-1 !py-2 text-xs"
                          value={linkEmailInputs[l.id] || ""}
                          onChange={(e) =>
                            setLinkEmailInputs((prev) => ({
                              ...prev,
                              [l.id]: e.target.value,
                            }))
                          }
                          disabled={sendingLinkEmail === l.id}
                          aria-label="Recipient email for public link"
                        />
                        <button
                          type="submit"
                          disabled={
                            sendingLinkEmail === l.id ||
                            !(linkEmailInputs[l.id] || "").trim()
                          }
                          className="inline-flex items-center gap-1.5 bg-ink text-white rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-40 hover:bg-accent transition-colors"
                        >
                          {sendingLinkEmail === l.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Mail className="size-3.5" />
                          )}
                          Email link
                        </button>
                      </div>
                      {linkEmailErrors[l.id] && (
                        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                          {linkEmailErrors[l.id]}
                        </div>
                      )}
                      {linkEmailSuccess[l.id] && (
                        <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                          {linkEmailSuccess[l.id]}
                        </div>
                      )}
                      {(l.recent_emails || []).length > 0 && (
                        <div className="text-[11px] text-muted space-y-1">
                          <div className="font-medium text-ink/70">Recent sends</div>
                          {(l.recent_emails || []).slice(0, 3).map((e) => (
                            <div key={`${e.recipient}-${e.created_at}`}>
                              Sent to {e.recipient} {formatRelative(e.created_at)}
                            </div>
                          ))}
                        </div>
                      )}
                    </form>
                  </div>
                ))}

                {/* Create new link */}
                <div className="flex items-center gap-2 pt-1">
                  <select
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value as ShareLinkTtl)}
                    disabled={creatingLink}
                    className="text-sm border border-[var(--line)] rounded-lg px-2 py-1.5 bg-white"
                    aria-label="Link expiry"
                  >
                    {SHARE_LINK_TTL_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        Expires in {o.label.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={createLink}
                    disabled={creatingLink}
                    className="ml-auto inline-flex items-center gap-2 bg-ink text-white rounded-xl px-3.5 py-2 text-sm font-medium disabled:opacity-40 hover:bg-accent transition-colors"
                  >
                    {creatingLink ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Globe2 className="size-4" />
                    )}
                    Create link
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ---- Email-based share section ---- */}
          <div className="px-5 py-4 border-b border-[var(--line)]">
            <div className="text-xs font-medium uppercase tracking-wider text-muted mb-2">
              Share with someone in your workspace
            </div>
            <div className="text-[11px] text-muted mb-3">
              Readers can read &amp; ask · editors can also edit
            </div>
            <form onSubmit={add}>
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
                  <option value="reader">Reader</option>
                  <option value="editor">Editor</option>
                </select>
                <button
                  type="submit"
                  disabled={submitting || !email.trim()}
                  className="inline-flex items-center gap-2 bg-ink text-white rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-accent transition-colors"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    "Share"
                  )}
                </button>
              </div>
              {error && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">
                  {error}
                </div>
              )}
            </form>
          </div>

          <div>
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
                  <option value="reader">Reader</option>
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

function emailErrorMessage(status: number, code?: string, fallback?: string): string {
  if (status === 429 || code === "rate_limited") {
    return "You’ve reached the share-link email limit. Try again later.";
  }
  if (status === 503 || code === "email_not_configured") {
    return "Email is not configured. Ask an admin to enable SMTP.";
  }
  if (status === 502 || code === "email_send_failed") {
    return "SMTP send failed. Try again or ask an admin to check email settings.";
  }
  if (status === 400 || code === "bad_email") {
    return "Enter a valid email address.";
  }
  return fallback || `Could not email link (${status})`;
}

function formatExpiry(ts: number | null): string {
  if (ts === null) return "Never expires";
  const ms = ts - Date.now();
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days >= 1) return `Expires in ${days}d`;
  if (hours >= 1) return `Expires in ${hours}h`;
  return "Expires soon";
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
