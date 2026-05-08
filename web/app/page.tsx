"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";

type OwnedBrief = {
  id: string;
  account_name: string;
  segment: string | null;
  audience: string;
  generated_at: string;
  created_at: number;
};

type SharedBrief = OwnedBrief & {
  shared_by_email: string;
  role: "reader" | "editor";
};

type CardItem =
  | (OwnedBrief & { kind: "mine" })
  | (SharedBrief & { kind: "shared" });

type Filter = "all" | "mine" | "shared";

type Me = {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
} | null;

const LEGACY_FORM_PARAMS = [
  "account",
  "segment",
  "region",
  "goal",
  "mode",
  "audience",
] as const;

export default function Page() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <Home />
    </Suspense>
  );
}

function Home() {
  const router = useRouter();
  const search = useSearchParams();
  const [me, setMe] = useState<Me>(null);
  const [owned, setOwned] = useState<OwnedBrief[] | null>(null);
  const [shared, setShared] = useState<SharedBrief[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [denied, setDenied] = useState(search.get("denied") === "viewer");
  const [queuedJob, setQueuedJob] = useState<string | null>(
    search.get("queued"),
  );
  const [failedJob, setFailedJob] = useState<string | null>(
    search.get("failed"),
  );

  // Bookmark redirect: if any legacy form query params are present,
  // forward to /new preserving them. Old URLs of the form
  //   /?account=Acme&mode=deep
  // continue to land on the form.
  useEffect(() => {
    const legacy = LEGACY_FORM_PARAMS.find((k) => search.get(k));
    if (legacy) {
      router.replace(`/new?${search.toString()}`);
    }
  }, [router, search]);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d) => setMe(d.user))
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    fetch("/api/briefs", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { owned: [], shared: [] }))
      .then((d) => {
        setOwned(d.owned ?? []);
        setShared(d.shared ?? []);
      })
      .catch(() => {
        setOwned([]);
        setShared([]);
      });
  }, []);

  async function deleteBrief(id: string) {
    if (deleting) return;
    if (!confirm("Delete this brief?")) return;
    setDeleting(id);
    try {
      const r = await fetch(`/api/briefs/${id}`, { method: "DELETE" });
      if (r.ok) {
        setOwned((prev) => (prev ? prev.filter((b) => b.id !== id) : prev));
      }
    } finally {
      setDeleting(null);
    }
  }

  const items = useMemo<CardItem[]>(() => {
    const mine: CardItem[] = (owned ?? []).map((b) => ({ ...b, kind: "mine" }));
    const shared_: CardItem[] = (shared ?? []).map((b) => ({
      ...b,
      kind: "shared",
    }));
    const merged = [...mine, ...shared_].sort(
      (a, b) => b.created_at - a.created_at,
    );
    if (filter === "mine") return merged.filter((i) => i.kind === "mine");
    if (filter === "shared") return merged.filter((i) => i.kind === "shared");
    return merged;
  }, [owned, shared, filter]);

  const isLoading = owned === null || shared === null;
  const isViewer = me?.role === "viewer";
  const totalCount = (owned?.length ?? 0) + (shared?.length ?? 0);

  return (
    <main className="min-h-screen px-6 py-10 md:py-14">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex items-end justify-between gap-4 mb-8"
        >
          <div>
            <h1 className="font-display text-3xl md:text-4xl tracking-tight">
              Briefs
            </h1>
            <p className="text-sm text-muted mt-1">
              {isViewer
                ? "Briefs that have been shared with you."
                : "Your account research, in one place."}
            </p>
          </div>
          {!isViewer && (
            <Link
              href="/new"
              className="inline-flex items-center gap-2 bg-ink text-white rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-accent transition-colors"
            >
              <Plus className="size-4" /> Start research
            </Link>
          )}
        </motion.div>

        {queuedJob && (
          <div
            className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900 flex items-center justify-between"
            role="status"
          >
            <span>
              Queued — we&rsquo;ll notify you in the tray when the brief is ready.
            </span>
            <button
              type="button"
              onClick={() => setQueuedJob(null)}
              className="text-xs text-emerald-900/80 hover:text-emerald-900"
            >
              Dismiss
            </button>
          </div>
        )}

        {failedJob && (
          <div
            className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-900 flex items-center justify-between"
            role="status"
          >
            <span>
              A research job failed. Open the Research tray (top-right) to see
              details or retry.
            </span>
            <button
              type="button"
              onClick={() => setFailedJob(null)}
              className="text-xs text-red-900/80 hover:text-red-900"
            >
              Dismiss
            </button>
          </div>
        )}

        {denied && (
          <div
            className="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 flex items-center justify-between"
            role="status"
          >
            <span>
              Read-only access — starting new research isn&rsquo;t available
              for your account.
            </span>
            <button
              type="button"
              onClick={() => setDenied(false)}
              className="text-xs text-amber-900/80 hover:text-amber-900"
            >
              Dismiss
            </button>
          </div>
        )}

        {!isLoading && totalCount > 0 && (
          <div className="flex items-center gap-2 mb-4 text-xs">
            {(["all", "mine", "shared"] as const).map((f) => {
              const active = filter === f;
              const count =
                f === "all"
                  ? totalCount
                  : f === "mine"
                    ? owned?.length ?? 0
                    : shared?.length ?? 0;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-full border transition-colors capitalize ${
                    active
                      ? "bg-ink text-white border-ink"
                      : "bg-white border-[var(--line)] text-muted hover:border-ink hover:text-ink"
                  }`}
                >
                  {f} <span className="opacity-70">· {count}</span>
                </button>
              );
            })}
          </div>
        )}

        {isLoading && (
          <div className="text-sm text-muted flex items-center gap-2 py-12 justify-center">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <EmptyState isViewer={isViewer} totalCount={totalCount} />
        )}

        {!isLoading && items.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((b) => (
              <BriefCard
                key={b.id}
                item={b}
                deleting={deleting === b.id}
                onOpen={() => router.push(`/brief/${b.id}`)}
                onDelete={
                  b.kind === "mine" ? () => deleteBrief(b.id) : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function EmptyState({
  isViewer,
  totalCount,
}: {
  isViewer: boolean;
  totalCount: number;
}) {
  // totalCount is 0 in this branch; if filter hides items but data exists,
  // we render nothing (no false empty-state). Caller already guards.
  void totalCount;
  return (
    <div className="border border-dashed border-[var(--line)] rounded-2xl px-8 py-12 text-center bg-white/40">
      <div className="text-sm text-muted mb-4">
        {isViewer
          ? "No briefs have been shared with you yet."
          : "No briefs yet. Queue your first account research."}
      </div>
      {!isViewer && (
        <Link
          href="/new"
          className="inline-flex items-center gap-2 bg-ink text-white rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-accent transition-colors"
        >
          Start research <ArrowRight className="size-4" />
        </Link>
      )}
    </div>
  );
}

function BriefCard({
  item,
  deleting,
  onOpen,
  onDelete,
}: {
  item: CardItem;
  deleting: boolean;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  return (
    <li
      className="card p-3 sm:p-3.5 group !cursor-pointer flex flex-col gap-2"
      onClick={onOpen}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{item.account_name}</div>
          {item.segment && (
            <div className="text-xs text-muted truncate">{item.segment}</div>
          )}
        </div>
        {onDelete && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onDelete();
              }
            }}
            className="text-muted/50 hover:text-red-600 focus:text-red-600 transition-colors p-1 rounded cursor-pointer"
            aria-label={`Delete ${item.account_name}`}
          >
            {deleting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <OriginChip item={item} />
        <span>·</span>
        <span>{formatRelative(item.created_at)}</span>
      </div>
    </li>
  );
}

function OriginChip({ item }: { item: CardItem }) {
  if (item.kind === "mine") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--bg)] text-muted border border-[var(--line)]">
        Mine
      </span>
    );
  }
  const editor = item.role === "editor";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border ${
        editor
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : "bg-amber-50 text-amber-800 border-amber-200"
      }`}
      title={`Shared by ${item.shared_by_email}`}
    >
      Shared · {editor ? "editor" : "reader"}
    </span>
  );
}

function formatRelative(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const diffDays = Math.floor((now.getTime() - ts) / 86400000);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
