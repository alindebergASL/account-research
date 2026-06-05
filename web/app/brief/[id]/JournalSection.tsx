"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
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

  async function submit() {
    const text = composeText.trim();
    if (!text || posting) return;
    setPosting(true);
    setAiError(null);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, ask_ai: askAi }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setComposeText("");
      if (data.ai_error) setAiError(data.ai_error);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to post entry");
    } finally {
      setPosting(false);
    }
  }

  async function uploadDocument() {
    if (!selectedFile || uploading) return;
    setUploading(true);
    setAiError(null);
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
      setSelectedFile(null);
      setComposeText("");
      await load();
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

          {!editing && !deleted && e.documents && e.documents.length > 0 && (
            <div className="mt-3 space-y-2">
              {e.documents.map((doc) => (
                <div
                  key={doc.id}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800"
                >
                  <div className="flex items-center gap-2 font-medium text-ink">
                    <FileText className="size-3.5" />
                    <span>{doc.filename}</span>
                    <span className="text-muted font-normal">
                      · {Math.ceil(doc.byte_size / 1024)} KB
                    </span>
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
        Log updates, ask questions, and chat with the assistant. Everyone with
        access to this brief can see and add to the journal.
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      )}

      {loading && !entries && (
        <div className="text-sm text-muted">Loading journal…</div>
      )}

      {entries && entries.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-white p-6 text-sm text-muted">
          No journal entries yet. Post an update, or toggle “Ask the assistant”
          to ask a question grounded in this brief.
        </div>
      )}

      {entries && entries.map((e) => renderEntry(e))}

      {aiError && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your entry was saved, but the assistant couldn’t reply: {aiError}
        </div>
      )}

      <div className="mt-6 rounded-xl border border-[var(--line)] bg-white p-4">
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
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex items-center gap-2 text-sm text-ink cursor-pointer select-none">
            <input
              type="checkbox"
              checked={askAi}
              onChange={(e) => setAskAi(e.target.checked)}
              className="size-4 accent-violet-600"
            />
            <span className="inline-flex items-center gap-1">
              <Sparkles className="size-3.5 text-violet-600" />
              Ask the assistant
            </span>
          </label>
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
              onClick={uploadDocument}
              disabled={uploading || !selectedFile}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-ink disabled:opacity-50"
            >
              {uploading && <Loader2 className="size-3.5 animate-spin" />}
              {uploading ? "Uploading…" : "Upload document"}
            </button>
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
      </div>
    </section>
  );
}
