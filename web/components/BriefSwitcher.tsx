"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Plus, Trash2, Loader2 } from "lucide-react";

type BriefSummary = {
  id: string;
  account_name: string;
  segment: string | null;
  audience: string;
  generated_at: string;
  created_at: number;
  shared_by_email?: string | null;
  role?: "reader" | "editor" | null;
};

export default function BriefSwitcher({
  currentBriefId,
  currentName,
}: {
  currentBriefId: string;
  currentName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BriefSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click + escape
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onClick);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Lazy-load on first open
  async function loadList() {
    if (items !== null || loading) return;
    setLoading(true);
    try {
      const r = await fetch("/api/briefs", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        setItems(data.briefs ?? []);
      } else {
        setItems([]);
      }
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!open) loadList();
    setOpen((v) => !v);
  }

  async function deleteBrief(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (deleting) return;
    if (!confirm("Delete this brief?")) return;
    setDeleting(id);
    try {
      const r = await fetch(`/api/briefs/${id}`, { method: "DELETE" });
      if (r.ok) {
        setItems((prev) => (prev ? prev.filter((it) => it.id !== id) : prev));
        if (id === currentBriefId) {
          router.push("/");
        }
      }
    } finally {
      setDeleting(null);
    }
  }

  const others = (items ?? []).filter((b) => b.id !== currentBriefId);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink transition-colors px-3 py-1.5 rounded-lg hover:bg-white border border-transparent hover:border-[var(--line)]"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="hidden sm:inline">Switch brief</span>
        <span className="sm:hidden">Briefs</span>
        <ChevronDown
          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 mt-2 w-[340px] max-h-[480px] overflow-hidden flex flex-col bg-white border border-[var(--line)] rounded-xl shadow-xl z-30"
          >
            <div className="px-4 py-3 border-b border-[var(--line)] flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted">
                  Your briefs
                </div>
                <div className="text-sm font-medium truncate max-w-[200px]">
                  {currentName}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push("/");
                }}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-ink text-white hover:bg-accent transition-colors"
              >
                <Plus className="size-3.5" />
                New
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              {loading && (
                <div className="px-4 py-6 text-sm text-muted flex items-center gap-2 justify-center">
                  <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
              )}
              {!loading && others.length === 0 && (
                <div className="px-4 py-6 text-sm text-muted text-center">
                  No other briefs yet. Run a new research from the home page.
                </div>
              )}
              {!loading &&
                others.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      router.push(`/brief/${b.id}`);
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-[var(--bg)] border-b border-[var(--line)] last:border-b-0 group"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm truncate">
                          {b.account_name}
                        </div>
                        <div className="text-xs text-muted truncate">
                          {b.segment || "—"}
                        </div>
                        <div className="text-[11px] text-muted mt-0.5">
                          {formatDate(b.created_at)}
                        </div>
                      </div>
                      {b.shared_by_email ? (
                        <span
                          className={
                            "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded self-center " +
                            (b.role === "editor"
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              : "bg-[var(--bg)] text-muted")
                          }
                        >
                          {b.role === "editor" ? "Editor" : "Shared"}
                        </span>
                      ) : (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => deleteBrief(b.id, e)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              deleteBrief(b.id, e as any);
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted hover:text-red-600 p-1 rounded cursor-pointer"
                          aria-label={`Delete ${b.account_name}`}
                        >
                          {deleting === b.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function formatDate(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const diff = Math.floor((now.getTime() - ts) / 86400000);
  if (same) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (diff < 7) {
    return `${diff}d ago`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
