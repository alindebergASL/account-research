"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Loader2, Search } from "lucide-react";

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

export default function Home() {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [segment, setSegment] = useState("");
  const [region, setRegion] = useState("");
  const [goal, setGoal] = useState("");
  const [notes, setNotes] = useState("");
  const [audience, setAudience] = useState<"internal" | "shareable">("internal");
  const [advanced, setAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

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
      sessionStorage.setItem("brief", JSON.stringify(data.brief));
      router.push("/brief");
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
