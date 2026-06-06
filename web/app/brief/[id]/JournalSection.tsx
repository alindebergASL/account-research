"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";

type Author = {
  id: string;
  display_name: string | null;
  email: string;
};

type JournalDocument = {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  created_at: number;
  content_preview: string;
};

type Entry = {
  id: string;
  author_type: "user" | "assistant";
  body: string | null;
  reply_to: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  author: Author | null;
  documents?: JournalDocument[];
};

const EDIT_WINDOW_MS = 15 * 60 * 1000;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function authorName(e: Entry): string {
  if (e.author_type === "assistant") return "Assistant";
  return e.author?.display_name || e.author?.email || "Unknown";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.ceil(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function summarizeDocumentPrompt(filename: string): string {
  return `Summarize the uploaded document "${filename}" for this account. Call out: 1) what changed or is being requested, 2) why it matters for the account brief, and 3) recommended next actions. Use the document as evidence and name it in your answer.`;
}

function briefUpdatePrompt(filename: string): string {
  return `Review the uploaded document "${filename}" and tell me what should be added or changed in the account brief. Be specific about fields or sections, and cite the uploaded document by filename.`;
}

type IntelligenceAction = {
  label: string;
  description: string;
  prompt: string;
  primary?: boolean;
};

const INTELLIGENCE_ACTIONS: IntelligenceAction[] = [
  {
    label: "Generate account update",
    description: "What changed, why it matters, and recommended moves.",
    primary: true,
    prompt:
      "Generate an account update from the recent journal notes and uploaded documents. Use sections: What changed, Why it matters, Evidence, Recommended next moves. Cite source labels like [J1] and [D1] for factual claims.",
  },
  {
    label: "Extract action items",
    description: "Owners, deliverables, dates, and evidence.",
    prompt:
      "Extract action items from the recent journal notes and uploaded documents. For each action item include owner if stated, deliverable, due date or trigger if stated, and supporting source labels like [J1] or [D1]. If ownership or dates are missing, say so explicitly.",
  },
  {
    label: "Find brief update candidates",
    description: "Field-level suggestions to send to brief chat.",
    prompt:
      "Find brief update candidates supported by the recent journal notes and uploaded documents. For each candidate include the target brief section or field, proposed change, confidence, and evidence source labels like [J1] or [D1]. Do not claim you edited the brief.",
  },
  {
    label: "Draft follow-up",
    description: "A concise stakeholder-ready note.",
    prompt:
      "Draft a concise follow-up message for the account team based on recent journal notes and uploaded documents. Include key context, next steps, and source labels like [J1] or [D1] in a short evidence section.",
  },
  {
    label: "Open questions",
    description: "Gaps to resolve before outreach or brief edits.",
    prompt:
      "Identify open questions and evidence gaps from the recent journal notes and uploaded documents. Group by account strategy, stakeholders, technical fit, procurement, and next action. Cite source labels where a gap is based on a specific note or document.",
  },
];

function extractCitationLabels(body: string | null): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/\[(?:J|D)\d+\]/g)) {
    seen.add(match[0]);
  }
  return Array.from(seen);
}

function renderCitationChips(body: string | null) {
  const labels = extractCitationLabels(body);
  if (labels.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-violet-900">
      <span className="font-medium">Sources cited</span>
      {labels.map((label) => (
        <span
          key={label}
          className="rounded-full border border-violet-200 bg-white px-2 py-0.5 font-mono text-[11px] text-violet-800 shadow-sm"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export default function JournalSection({
  briefId,
  currentUserId,
  isAdmin,
  canManage,
}: {
  briefId: string;
  currentUserId: string;
  isAdmin: boolean;
  canManage: boolean;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [askAi, setAskAi] = useState(false);
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal`, {
        cache: "no-store",
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setEntries(data.entries ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load journal");
    } finally {
      setLoading(false);
    }
  }, [briefId]);

  useEffect(() => {
    load();
  }, [load]);

  function prepareAssistantPrompt(text: string) {
    if (
      composeText.trim() &&
      composeText !== text &&
      !window.confirm("Replace your current draft with this assistant prompt?")
    ) {
      return;
    }
    setAskAi(true);
    setComposeText(text);
    window.setTimeout(() => composeRef.current?.focus(), 0);
  }

  async function postJournalEntry(text: string, askAssistant: boolean) {
    const trimmed = text.trim();
    if (!trimmed || posting) return false;
    setPosting(true);
    setAiError(null);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed, ask_ai: askAssistant }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setComposeText("");
      if (data.ai_error) setAiError(data.ai_error);
      await load();
      return !data.ai_error;
    } catch (e: any) {
      setError(e?.message || "Failed to post entry");
      return false;
    } finally {
      setPosting(false);
    }
  }

  async function submit() {
    await postJournalEntry(composeText, askAi);
  }

  async function runIntelligenceAction(prompt: string) {
    setAskAi(true);
    await postJournalEntry(prompt, true);
  }

  async function uploadDocument({ summarizeAfterUpload = false } = {}) {
    if (!selectedFile || uploading) return;
    const uploadedFileName = selectedFile.name;
    setUploading(true);
    setAiError(null);
    setUploadNotice(null);
    try {
      const form = new FormData();
      form.set("file", selectedFile);
      if (composeText.trim()) form.set("body", composeText.trim());
      const r = await fetch(`/api/briefs/${briefId}/journal/documents`, {
        method: "POST",
        body: form,
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setSelectedFile(null);
      setComposeText("");
      const filename = data?.document?.filename || uploadedFileName;
      setUploadNotice(
        summarizeAfterUpload
          ? `Uploaded ${filename}. Asking the journal assistant to summarize it now…`
          : `Uploaded ${filename}. Its extracted text is now available to the journal assistant and brief chat.`,
      );
      if (summarizeAfterUpload) {
        const assistantPosted = await postJournalEntry(summarizeDocumentPrompt(filename), true);
        if (assistantPosted) {
          setUploadNotice(`Uploaded ${filename}. The journal assistant reply was added below.`);
        } else {
          setUploadNotice(`Uploaded ${filename}. The assistant could not summarize it automatically; try again from Ask assistant.`);
        }
      } else {
        await load();
      }
    } catch (e: any) {
      setError(e?.message || "Failed to upload document");
    } finally {
      setUploading(false);
    }
  }

  async function saveEdit(entryId: string) {
    const text = editText.trim();
    if (!text) return;
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal/${entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      setEditingId(null);
      setEditText("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to edit entry");
    }
  }

  async function softDelete(entryId: string) {
    if (!confirm("Delete this entry?")) return;
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal/${entryId}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to delete entry");
    }
  }

  function renderEntry(e: Entry) {
    const deleted = e.deleted_at !== null;
    const isAssistant = e.author_type === "assistant";
    const isOwnUser =
      !isAssistant && e.author?.id === currentUserId && !deleted;
    const withinEditWindow = Date.now() - e.created_at <= EDIT_WINDOW_MS;
    const canEdit = isOwnUser && withinEditWindow;
    const canDelete =
      !deleted && (isOwnUser || isAdmin || canManage);
    const editing = editingId === e.id;
    return (
      <div key={e.id} className="mt-4">
        <div
          className={`rounded-xl border p-4 ${
            isAssistant
              ? "border-violet-200 bg-violet-50/60"
              : "border-[var(--line)] bg-white"
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-ink">
                {deleted ? "(deleted)" : authorName(e)}
              </span>
              {isAssistant && !deleted && (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 border border-violet-200 text-violet-800 px-2 py-0.5 text-xs">
                  <Sparkles className="size-3" /> Assistant
                </span>
              )}
              <span className="text-muted">·</span>
              <span
                className="text-muted"
                title={new Date(e.created_at).toISOString()}
              >
                {relativeTime(e.created_at)}
                {e.edited_at && !deleted ? " · edited" : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {canEdit && !editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(e.id);
                    setEditText(e.body ?? "");
                  }}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
                >
                  <Pencil className="size-3" /> Edit
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={() => softDelete(e.id)}
                  className="inline-flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700"
                >
                  <Trash2 className="size-3" /> Delete
                </button>
              )}
            </div>
          </div>

          {editing ? (
            <div className="mt-2">
              <textarea
                value={editText}
                onChange={(ev) => setEditText(ev.target.value)}
                className="w-full rounded-lg border border-[var(--line)] p-2 text-sm"
                rows={3}
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => saveEdit(e.id)}
                  className="rounded-md bg-ink text-white px-3 py-1 text-xs"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setEditText("");
                  }}
                  className="rounded-md border border-[var(--line)] px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm whitespace-pre-wrap text-ink">
              {deleted ? (
                <span className="italic text-muted">
                  This entry was deleted.
                </span>
              ) : (
                e.body
              )}
            </p>
          )}

          {isAssistant && !editing && !deleted && renderCitationChips(e.body)}

          {!editing && !deleted && e.documents && e.documents.length > 0 && (
            <div className="mt-3 space-y-2">
              {e.documents.map((doc) => (
                <div
                  key={doc.id}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      <FileText className="size-3.5" />
                      <span>{doc.filename}</span>
                      <span className="text-muted font-normal">
                        · {formatFileSize(doc.byte_size)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(doc.filename))}
                        className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-white px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50"
                      >
                        <Sparkles className="size-3" /> Summarize with AI
                      </button>
                      <button
                        type="button"
                        onClick={() => prepareAssistantPrompt(briefUpdatePrompt(doc.filename))}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        Find brief updates
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted">
                    {doc.content_preview}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="max-w-7xl mx-auto px-6 mt-6 pb-24">
      <header className="flex items-center gap-2 mb-1">
        <BookOpen className="size-5 text-muted" />
        <h2 className="text-lg font-semibold text-ink">Journal</h2>
        {entries && entries.length > 0 && (
          <span className="text-sm text-muted">({entries.length})</span>
        )}
      </header>
      <p className="text-sm text-muted mb-4">
        Log updates, attach evidence, and ask the journal assistant to interpret
        recent notes or uploaded documents. Journal replies are advisory; use the
        main brief chat when you want the brief itself edited.
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      )}

      {loading && !entries && (
        <div className="text-sm text-muted">Loading journal…</div>
      )}

      <div className="mb-4 rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-sky-50 p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-800">
              <Sparkles className="size-3.5" /> Journal Intelligence
            </div>
            <h3 className="mt-3 text-base font-semibold text-ink">
              Turn notes and evidence into account motion
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Generate advisory digests, action items, brief-update candidates,
              follow-ups, and open questions. Replies stay in the journal and cite
              source labels such as [J1] and [D1] when the model uses notes or
              uploaded documents.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {INTELLIGENCE_ACTIONS.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => runIntelligenceAction(action.prompt)}
                disabled={posting || loading || !entries}
                className={`rounded-xl border px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  action.primary
                    ? "border-violet-300 bg-violet-600 text-white shadow-sm hover:bg-violet-700"
                    : "border-slate-200 bg-white text-ink hover:border-violet-200 hover:bg-violet-50"
                }`}
              >
                <span className="block font-medium">{action.label}</span>
                <span
                  className={`mt-0.5 block text-xs ${
                    action.primary ? "text-violet-100" : "text-muted"
                  }`}
                >
                  {action.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {entries && entries.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-white p-6 text-sm text-muted">
          No journal entries yet. Add a note, upload a document, or switch to
          “Ask assistant” to ask a question grounded in this brief.
        </div>
      )}

      {entries && entries.map((e) => renderEntry(e))}

      {aiError && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your entry was saved, but the assistant couldn’t reply: {aiError}
        </div>
      )}

      {uploadNotice && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span>{uploadNotice}</span>
        </div>
      )}

      <div className="mt-6 rounded-xl border border-[var(--line)] bg-white p-4">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            role="group"
            aria-label="Journal compose mode"
            className="inline-flex w-fit rounded-lg border border-[var(--line)] bg-slate-50 p-0.5 text-sm"
          >
            <button
              type="button"
              aria-pressed={!askAi}
              onClick={() => setAskAi(false)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                !askAi ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              Add note
            </button>
            <button
              type="button"
              aria-pressed={askAi}
              onClick={() => setAskAi(true)}
              className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 transition-colors ${
                askAi ? "bg-violet-600 text-white shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              <Sparkles className="size-3.5" /> Ask assistant
            </button>
          </div>
          <p className="text-xs text-muted">
            {askAi
              ? "Assistant answers appear in the journal and can use recent uploaded documents."
              : "Notes are saved as-is. Turn on Ask assistant when you want an AI reply."}
          </p>
        </div>
        <textarea
          ref={composeRef}
          value={composeText}
          onChange={(e) => setComposeText(e.target.value)}
          placeholder={
            askAi
              ? "Ask the assistant a question about this account…"
              : "Add an update to the journal…"
          }
          rows={3}
          className="w-full rounded-lg border border-[var(--line)] p-2 text-sm"
        />
        {askAi && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => prepareAssistantPrompt("Summarize the most recent uploaded document and explain why it matters for this account.")}
              className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100"
            >
              Summarize latest document
            </button>
            <button
              type="button"
              onClick={() => prepareAssistantPrompt("What brief updates are supported by the recent journal documents? Cite filenames and be explicit about where each update belongs.")}
              className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100"
            >
              Suggest brief updates
            </button>
            <button
              type="button"
              onClick={() => prepareAssistantPrompt("Turn the recent journal notes and documents into recommended next actions for this account.")}
              className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100"
            >
              Draft next actions
            </button>
          </div>
        )}
        <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <Paperclip className="size-3.5" /> Upload evidence
              </div>
              <p className="mt-1 text-xs text-muted">
                PDFs up to 50 pages / 2MB, plus text, markdown, CSV, JSON, XML,
                and YAML. Uploading extracts text and makes it available to AI;
                it does not edit the brief automatically.
              </p>
              {selectedFile && (
                <p className="mt-2 truncate text-xs text-ink">
                  Selected: <span className="font-medium">{selectedFile.name}</span>
                  <span className="text-muted"> · {formatFileSize(selectedFile.size)}</span>
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-ink hover:bg-slate-50">
              <Paperclip className="size-3.5" />
              <span>{selectedFile ? selectedFile.name : "Choose document"}</span>
              <input
                type="file"
                accept=".pdf,.txt,.md,.markdown,.csv,.json,.xml,.yaml,.yml,application/pdf,text/*,application/json,application/xml"
                className="sr-only"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button
              type="button"
              onClick={() => uploadDocument()}
              disabled={uploading || posting || !selectedFile}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-ink disabled:opacity-50"
            >
              {uploading && <Loader2 className="size-3.5 animate-spin" />}
              {uploading ? "Uploading…" : "Upload document"}
            </button>
            <button
              type="button"
              onClick={() => uploadDocument({ summarizeAfterUpload: true })}
              disabled={uploading || posting || !selectedFile}
              className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-800 disabled:opacity-50"
            >
              {uploading && <Loader2 className="size-3.5 animate-spin" />}
              Upload + summarize
            </button>
            </div>
          </div>
        </div>
        <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={submit}
              disabled={posting || !composeText.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-ink text-white px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {posting && <Loader2 className="size-3.5 animate-spin" />}
              {posting ? (askAi ? "Asking…" : "Posting…") : askAi ? "Ask" : "Post"}
            </button>
        </div>
      </div>
    </section>
  );
}
