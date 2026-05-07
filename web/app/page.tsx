"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Clock, Loader2, Search, Trash2 } from "lucide-react";

type RecentBrief = {
  id: string;
  account_name: string;
  segment: string | null;
  audience: string;
  generated_at: string;
  created_at: number;
};

const SECTORS = [
  "Public sector / government",
  "Healthcare",
  "Higher education",
  "K-12 education",
  "Financial services",
  "Manufacturing",
  "Retail",
  "Technology",
  "Telecommunications",
  "Energy / utilities",
  "Transportation",
  "Nonprofit",
  "Commercial enterprise",
  "Mid-market",
  "SMB",
];

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
  const [account, setAccount] = useState(search.get("account") ?? "");
  const [segment, setSegment] = useState(search.get("segment") ?? "");
  const [region, setRegion] = useState(search.get("region") ?? "");
  const [goal, setGoal] = useState(search.get("goal") ?? "");
  const [notes, setNotes] = useState("");
  const [audience, setAudience] = useState<"internal" | "shareable">(
    search.get("audience") === "shareable" ? "shareable" : "internal",
  );
  const [mode, setMode] = useState<"quick" | "standard" | "deep">(() => {
    const m = search.get("mode");
    return m === "quick" || m === "deep" ? m : "standard";
  });
  const [advanced, setAdvanced] = useState(
    !!(search.get("segment") || search.get("region") || search.get("goal")),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [recents, setRecents] = useState<RecentBrief[] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function loadRecents() {
    try {
      const r = await fetch("/api/briefs", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        setRecents(data.briefs ?? []);
      } else {
        setRecents([]);
      }
    } catch {
      setRecents([]);
    }
  }

  useEffect(() => {
    loadRecents();
  }, []);

  async function deleteRecent(id: string) {
    if (deleting) return;
    if (!confirm("Delete this brief?")) return;
    setDeleting(id);
    try {
      const r = await fetch(`/api/briefs/${id}`, { method: "DELETE" });
      if (r.ok) {
        setRecents((prev) => (prev ? prev.filter((b) => b.id !== id) : prev));
      }
    } finally {
      setDeleting(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!account.trim() || loading) return;
    setError(null);
    setLoading(true);
    setProgress(0);

    const tick = setInterval(() => {
      setProgress((p) => Math.min(p + 1.5, 92));
    }, 800);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: account.trim(),
          segment: segment || undefined,
          region: region || undefined,
          goal: goal || undefined,
          notes: notes || undefined,
          audience,
          mode,
        }),
      });
      const data = await res.json();
      clearInterval(tick);
      if (!res.ok) {
        setError(data.error || "Research failed");
        setLoading(false);
        return;
      }
      setProgress(100);

      // Persist for the user, then navigate to the canonical id-based URL.
      const saveRes = await fetch("/api/briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief: data.brief }),
      });
      if (!saveRes.ok) {
        const saveData = await saveRes.json().catch(() => ({}));
        setError(saveData.error || "Could not save brief");
        setLoading(false);
        return;
      }
      const { id } = await saveRes.json();
      router.push(`/brief/${id}`);
    } catch (err: any) {
      clearInterval(tick);
      setError(err?.message ?? "Network error");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-10"
        >
          <div className="inline-flex items-center gap-2 mb-4 text-xs uppercase tracking-widest text-muted">
            <span className="size-1.5 rounded-full bg-accent" /> Live research
          </div>
          <h1 className="font-display text-5xl md:text-6xl tracking-tight leading-[1.05]">
            Research an account.
            <br />
            <span className="italic text-muted">Get a brief in minutes.</span>
          </h1>
          <p className="mt-4 text-muted max-w-lg">
            Enter an organization. We&rsquo;ll gather public signals, map personas,
            assess AI/tech maturity, and surface the conversation angle for your
            next meeting.
          </p>
        </motion.div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="card p-2 flex items-center gap-2 hover:!translate-y-0 hover:cursor-text">
            <Search className="size-5 ml-3 text-muted shrink-0" />
            <input
              autoFocus
              required
              placeholder="Acme Corp, Mayo Clinic, City of Austin…"
              className="flex-1 bg-transparent outline-none px-2 py-3 text-lg placeholder:text-muted/70"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              disabled={loading}
            />
            <button
              type="submit"
              disabled={!account.trim() || loading}
              className="m-1 inline-flex items-center gap-2 bg-ink text-white rounded-xl px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Researching
                </>
              ) : (
                <>
                  Research
                  <ArrowRight className="size-4" />
                </>
              )}
            </button>
          </div>

          <ModeSelector mode={mode} setMode={setMode} disabled={loading} />

          <div className="flex items-center justify-between text-sm text-muted">
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="hover:text-ink transition-colors"
            >
              {advanced ? "Hide" : "Add"} context · industry, region, goal, notes
            </button>
            <span>
              <span className="kbd">Enter</span> to research
            </span>
          </div>

          <AnimatePresence>
            {advanced && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="card p-5 space-y-4 hover:!translate-y-0 hover:!cursor-default hover:!shadow-none">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Industry / segment">
                      <select
                        className="field"
                        value={segment}
                        onChange={(e) => setSegment(e.target.value)}
                      >
                        <option value="">Auto-detect</option>
                        {SECTORS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Region">
                      <input
                        className="field"
                        placeholder="Midwest US, EMEA, APAC…"
                        value={region}
                        onChange={(e) => setRegion(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field label="Goal for the brief">
                    <input
                      className="field"
                      placeholder="Pre-meeting brief for next Tuesday's CIO call"
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                    />
                  </Field>
                  <Field label="Internal notes (optional)">
                    <textarea
                      className="field min-h-[80px]"
                      placeholder="CRM notes, prior-call summary, internal context…"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </Field>
                  <Field label="Audience">
                    <div className="flex gap-2">
                      {(["internal", "shareable"] as const).map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => setAudience(a)}
                          className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                            audience === a
                              ? "bg-ink text-white border-ink"
                              : "bg-white border-[var(--line)] hover:border-ink"
                          }`}
                        >
                          {a === "internal" ? "Internal only" : "Customer-shareable"}
                        </button>
                      ))}
                    </div>
                  </Field>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          {loading && (
            <div className="space-y-2">
              <div className="h-1.5 bg-[var(--line)] rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-accent"
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.6 }}
                />
              </div>
              <div className="text-xs text-muted">
                Searching public sources, mapping signals, ranking personas… (this can take 1–2 minutes)
              </div>
            </div>
          )}
        </form>

        {!loading && recents && recents.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
            className="mt-12"
          >
            <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-widest text-muted">
              <Clock className="size-3.5" />
              <span>Your recent briefs</span>
              <span className="ml-auto text-muted/70">{recents.length}</span>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {recents.slice(0, 8).map((b) => (
                <li
                  key={b.id}
                  className="card p-3 group !cursor-pointer"
                  onClick={() => router.push(`/brief/${b.id}`)}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {b.account_name}
                      </div>
                      <div className="text-xs text-muted truncate">
                        {b.segment || "—"}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {formatRelative(b.created_at)}
                      </div>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRecent(b.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          deleteRecent(b.id);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted hover:text-red-600 p-1.5 rounded cursor-pointer"
                      aria-label={`Delete ${b.account_name}`}
                    >
                      {deleting === b.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </motion.section>
        )}
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

const MODE_OPTIONS: Array<{
  id: "quick" | "standard" | "deep";
  label: string;
  caption: string;
}> = [
  { id: "quick", label: "Quick", caption: "~30s · ~$0.10" },
  { id: "standard", label: "Standard", caption: "~70s · ~$0.35" },
  { id: "deep", label: "Deep", caption: "~2-3 min · ~$1+" },
];

const MODE_HINT: Record<"quick" | "standard" | "deep", string> = {
  quick: "Fast snapshot — Sonnet, single pass, web search only. Good for low-stakes accounts.",
  standard: "Balanced depth — Opus + Haiku scout, web search + fetch. Default.",
  deep: "Exhaustive — Opus at maximum effort, full source list. Use for high-stakes meetings.",
};

function ModeSelector({
  mode,
  setMode,
  disabled,
}: {
  mode: "quick" | "standard" | "deep";
  setMode: (m: "quick" | "standard" | "deep") => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div
        role="radiogroup"
        aria-label="Research depth"
        className="inline-flex p-1 gap-1 bg-white border border-[var(--line)] rounded-xl"
      >
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setMode(opt.id)}
              disabled={disabled}
              className={`relative flex flex-col items-start gap-0.5 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                active
                  ? "bg-ink text-white"
                  : "bg-transparent text-ink hover:bg-[var(--bg)]"
              }`}
            >
              <span className="font-medium">{opt.label}</span>
              <span
                className={`text-[11px] ${active ? "text-white/70" : "text-muted"}`}
              >
                {opt.caption}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted">{MODE_HINT[mode]}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-muted uppercase tracking-wider mb-1.5">
        {label}
      </span>
      {children}
    </label>
  );
}

function formatRelative(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const diffDays = Math.floor((now.getTime() - ts) / 86400000);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
