"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check } from "lucide-react";

type Actor = { id: string; display_name: string | null; email: string } | null;
type Notification = {
  id: string;
  type: "journal_mention";
  brief_id: string | null;
  brief_account_name: string | null;
  source_entry_id: string | null;
  entry_deleted: boolean;
  excerpt: string | null;
  actor: Actor;
  created_at: number;
  read_at: number | null;
};

const POLL_CLOSED_MS = 30000; // background badge refresh
const POLL_OPEN_MS = 10000; // livelier while the panel is open

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function actorName(a: Actor): string {
  if (!a) return "Someone";
  return a.display_name || a.email.split("@")[0] || "Someone";
}

export default function NotificationBell() {
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications?count=1", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setUnread(d.unread_count ?? 0);
      }
    } catch {
      /* network blips ignored */
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/notifications?limit=20", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setItems(d.notifications ?? []);
        setUnread(d.unread_count ?? 0);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  // Background badge poll — faster while the panel is open.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!alive) return;
      await refreshCount();
      if (!alive) return;
      timer = setTimeout(tick, open ? POLL_OPEN_MS : POLL_CLOSED_MS);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [open, refreshCount]);

  // Load the list whenever the panel opens.
  useEffect(() => {
    if (open) loadList();
  }, [open, loadList]);

  // Close on outside click / Escape (matches Header + ResearchTray).
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    setItems((cur) =>
      cur.map((n) => (ids.includes(n.id) && n.read_at === null ? { ...n, read_at: Date.now() } : n)),
    );
    setUnread((u) => Math.max(0, u - ids.length));
    try {
      const r = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (r.ok) {
        const d = await r.json();
        setUnread(d.unread_count ?? 0);
      }
    } catch {
      /* optimistic update already applied */
    }
  }

  async function markAllRead() {
    setItems((cur) => cur.map((n) => (n.read_at === null ? { ...n, read_at: Date.now() } : n)));
    setUnread(0);
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      /* optimistic */
    }
  }

  function openNotification(n: Notification) {
    if (n.read_at === null) void markRead([n.id]);
    setOpen(false);
    if (n.brief_id && n.source_entry_id && !n.entry_deleted) {
      router.push(`/brief/${n.brief_id}#journal-entry-${n.source_entry_id}`);
    } else if (n.brief_id) {
      router.push(`/brief/${n.brief_id}`);
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex items-center rounded-lg border border-transparent px-2 py-1 text-muted transition-colors hover:border-[var(--line)] hover:bg-white hover:text-ink"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        title="Notifications"
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[var(--accent,#e11d48)] px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-[360px] overflow-hidden rounded-xl border border-[var(--line)] bg-white shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2.5">
            <span className="text-sm font-medium text-ink">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-ink"
              >
                <Check className="size-3" /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted">
                You&apos;re all caught up. Mentions of you in a journal will show up here.
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openNotification(n)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-[var(--line)] px-4 py-3 text-left transition-colors last:border-0 hover:bg-[var(--bg)] ${
                    n.read_at === null ? "bg-[var(--bg)]/60" : ""
                  }`}
                >
                  <div className="flex w-full items-center gap-2">
                    {n.read_at === null && (
                      <span className="size-2 shrink-0 rounded-full bg-[var(--accent,#e11d48)]" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      <span className="font-medium">{actorName(n.actor)}</span> mentioned you
                      {n.brief_account_name ? (
                        <span className="text-muted"> on {n.brief_account_name}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">{relativeTime(n.created_at)}</span>
                  </div>
                  <span className="line-clamp-2 pl-0 text-xs text-muted">
                    {n.entry_deleted ? <em>This entry was deleted.</em> : n.excerpt}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
