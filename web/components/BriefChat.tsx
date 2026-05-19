"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUp,
  Loader2,
  MessageSquare,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import type { Brief } from "@/lib/schema";

type HermesEvent = {
  id: string;
  event_type: string;
  title: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: number;
};

type ChatPatch = { op: "set" | "append"; field: string; value: any };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  patches?: ChatPatch[] | null;
  created_at?: number;
  // Local-only flag so we can grey-out optimistic user messages
  pending?: boolean;
};

const SAMPLE_PROMPTS = [
  "Summarize the AI maturity rationale in one sentence.",
  "What's the most important conversation angle here?",
  "Find their CISO and add to personas if you can.",
  "What active RFPs do they have?",
];

export default function BriefChat({
  briefId,
  brief,
  onBriefUpdate,
  onHermesCanvasEvent,
  readOnly = false,
}: {
  briefId: string;
  brief: Brief;
  onBriefUpdate?: (next: Brief) => void;
  onHermesCanvasEvent?: () => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hermesEvents, setHermesEvents] = useState<HermesEvent[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load history once when the drawer first opens.
  useEffect(() => {
    if (!open || historyLoaded) return;
    let cancelled = false;
    fetch(`/api/briefs/${briefId}/chat`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages ?? []);
        setHistoryLoaded(true);
      })
      .catch(() => setHistoryLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [open, historyLoaded, briefId]);

  // Subscribe to Hermes/Canvas events only while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const es = new EventSource(`/api/briefs/${briefId}/hermes-events/stream`);
    es.addEventListener("ready", () => setStreamConnected(true));
    es.addEventListener("error", () => setStreamConnected(false));
    es.addEventListener("hermes-event", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data) as HermesEvent;
        setHermesEvents((prev) => {
          if (prev.some((e) => e.id === data.id)) return prev;
          return [...prev.slice(-7), data];
        });
        if (data.event_type === "canvas.state.updated") {
          onHermesCanvasEvent?.();
        }
      } catch {
        // ignore malformed event frames
      }
    });
    return () => {
      setStreamConnected(false);
      es.close();
    };
  }, [open, briefId, onHermesCanvasEvent]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  // Esc closes; focus input when opened.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(text: string) {
    if (!text.trim() || sending) return;
    setError(null);
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
      pending: true,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);
    try {
      const res = await fetch(`/api/briefs/${briefId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Chat failed (${res.status})`);
      }
      // Mark user message no longer pending; append assistant reply.
      setMessages((prev) =>
        prev
          .map((m) => (m.id === userMsg.id ? { ...m, pending: false } : m))
          .concat({
            id: `local-${Date.now() + 1}`,
            role: "assistant",
            content: data.reply || "(no reply)",
            patches:
              Array.isArray(data.patches_applied) &&
              data.patches_applied.length > 0
                ? data.patches_applied
                : null,
          }),
      );
      if (data.brief && onBriefUpdate) {
        onBriefUpdate(data.brief);
      }
    } catch (e: any) {
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      setError(e?.message ?? "Chat failed");
    } finally {
      setSending(false);
    }
  }

  async function clearHistory() {
    if (!confirm("Clear this chat history?")) return;
    try {
      const res = await fetch(`/api/briefs/${briefId}/chat`, {
        method: "DELETE",
      });
      if (res.ok) setMessages([]);
    } catch {
      /* swallow */
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <>
      {/* Floating toggle on the left edge */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed left-0 top-1/2 -translate-y-1/2 z-30 flex items-center gap-2 bg-ink text-white px-2.5 py-3 rounded-r-xl shadow-lg hover:bg-accent transition-colors"
        aria-label="Open chat"
      >
        <MessageSquare className="size-4" />
        <span className="text-xs font-medium [writing-mode:vertical-rl] rotate-180 tracking-widest uppercase">
          Chat
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 bg-ink/30 backdrop-blur-sm z-40 md:bg-transparent md:backdrop-blur-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setOpen(false)}
            />
            <motion.aside
              role="dialog"
              aria-label="Brief chat"
              className="fixed left-0 top-0 bottom-0 z-50 w-full md:w-[420px] bg-white border-r border-[var(--line)] shadow-2xl flex flex-col"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 280, damping: 32 }}
            >
              <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--line)]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted">
                    <Sparkles className="size-3.5" />
                    Chat
                  </div>
                  <div className="text-sm font-medium truncate">
                    {brief.account_name}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={clearHistory}
                    className="p-2 text-muted hover:text-ink rounded-lg hover:bg-[var(--bg)] transition-colors"
                    title="Clear conversation"
                  >
                    <RotateCcw className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="p-2 text-muted hover:text-ink rounded-lg hover:bg-[var(--bg)] transition-colors"
                    aria-label="Close"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </header>

              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
                {!historyLoaded && (
                  <div className="text-sm text-muted flex items-center gap-2 justify-center py-6">
                    <Loader2 className="size-4 animate-spin" />
                    Loading conversation…
                  </div>
                )}

                {historyLoaded && messages.length === 0 && (
                  <div className="space-y-3 pt-2">
                    <p className="text-sm text-muted leading-snug">
                      {readOnly
                        ? "Ask questions about anything in the brief. Read-only — your replies won't change the brief."
                        : "Ask about anything in the brief, or have me find more and add it to the canvas."}
                    </p>
                    <div className="space-y-1.5">
                      {SAMPLE_PROMPTS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => send(p)}
                          disabled={sending}
                          className="block w-full text-left text-sm px-3 py-2 rounded-lg bg-[var(--bg)] border border-[var(--line)] hover:border-ink transition-colors disabled:opacity-50"
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}

                {hermesEvents.length > 0 && (
                  <div className="space-y-1 rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-xs text-muted">
                    <div className="flex items-center gap-1.5 font-medium text-ink">
                      <Sparkles className="size-3" />
                      Hermes events {streamConnected ? "live" : "reconnecting"}
                    </div>
                    {hermesEvents.slice(-3).map((e) => (
                      <div key={e.id} className="truncate">
                        {e.title || e.event_type}
                      </div>
                    ))}
                  </div>
                )}

                {sending && (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="size-4 animate-spin" />
                    Researching…
                  </div>
                )}

                {error && (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send(input);
                }}
                className="border-t border-[var(--line)] p-3"
              >
                <div className="flex items-end gap-2">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={readOnly ? "Ask a question…" : "Ask or instruct…"}
                    rows={1}
                    disabled={sending}
                    className="flex-1 resize-none bg-white border border-[var(--line)] rounded-xl px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50 max-h-32"
                    style={{ minHeight: "40px" }}
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || sending}
                    className="shrink-0 size-10 grid place-items-center rounded-xl bg-ink text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent transition-colors"
                    aria-label="Send"
                  >
                    {sending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowUp className="size-4" />
                    )}
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted">
                  Sonnet 4.6 / Hermes runtime when enabled · cmd+enter sends
                </p>
              </form>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm bg-ink text-white whitespace-pre-wrap ${
            message.pending ? "opacity-60" : ""
          }`}
        >
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1.5">
        <div className="rounded-2xl rounded-bl-md px-3.5 py-2 text-sm bg-[var(--bg)] border border-[var(--line)] whitespace-pre-wrap leading-snug">
          {message.content}
        </div>
        {message.patches && message.patches.length > 0 && (
          <div className="ml-1 flex flex-wrap gap-1">
            {summarizeFields(message.patches).map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200"
              >
                <Sparkles className="size-2.5" />
                Updated {label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function summarizeFields(patches: ChatPatch[]): string[] {
  const set = new Set<string>();
  for (const p of patches) set.add(p.field);
  return Array.from(set);
}
