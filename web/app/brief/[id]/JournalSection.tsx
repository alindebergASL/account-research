"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ClipboardList,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  resolveCitedBriefSource,
  resolveCitedDocumentSource,
  resolveCitedJournalEntry,
} from "@/lib/journalCitationResolution";
import { citationEvidenceSnippet } from "@/lib/journalCitationEvidence";
import {
  buildReviewCandidateDraftFromAssistantEntry,
  buildReviewCandidateDraftsFromAssistantEntry,
  type ReviewCandidateDraft,
} from "@/lib/journalReviewCandidateExtraction";
import type { JournalCockpitReadModel, JournalCockpitReadModelItem } from "@/lib/journalCockpitReadModel";
import {
  buildJournalCatchUpContext,
  buildJournalCatchUpPrompt,
  journalCatchUpSince,
  type JournalCatchUpWindow,
} from "@/lib/journalCatchUp";
import {
  buildJournalSearchRecallPrompt,
  searchJournalWorkspace,
} from "@/lib/journalSearch";
import { findSourceLegendBlockStart } from "@/lib/journalSourceLegend";
import { SourceLink } from "@/components/SourceLink";
import CommentsSection from "./CommentsSection";
import type {
  Author,
  CockpitDisplay,
  Entry,
  IntelligenceAction,
  JournalBriefContext,
  JournalDocument,
  JournalSource,
  ReviewCandidate,
  ReviewCandidateStatus,
  ReviewCandidateType,
  SelectedCitationContext,
  SourceHealthStatus,
  TimelineFilter,
} from "./journal/types";
import {
  EDIT_WINDOW_MS,
  INTELLIGENCE_ACTIONS,
  REVIEW_QUEUE_ACTIONS,
  STRUCTURED_REVIEW_BOARDS,
  candidateStatusLabels,
  candidateTypeLabels,
  timelineFilterLabels,
} from "./journal/constants";
import {
  askAboutSourcePrompt,
  authorName,
  briefUpdatePrompt,
  cockpitDisplayFromModel,
  collectJournalSources,
  compareWithBriefPrompt,
  displayEntryBody,
  documentIdSnapshotKey,
  emptyCockpitCards,
  extractCitationLabels,
  formatFileSize,
  groupReviewCandidatesByType,
  relativeTime,
  sourceFingerprint,
  sourceHealthBadges,
  summarizeDocumentPrompt,
  trustedLegendStart,
} from "./journal/helpers";
import { Badge, Card, EmptyState, SectionHeader } from "./journal/ui";

function renderCitationChips(
  entry: Entry,
  onCitationClick?: (label: string, entry: Entry) => void,
) {
  const labels = extractCitationLabels(entry);
  if (labels.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-violet-900">
      <span className="font-medium">Sources cited</span>
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          onClick={() => onCitationClick?.(label, entry)}
          className="rounded-full border border-violet-200 bg-white px-2 py-0.5 font-mono text-[11px] text-violet-800 shadow-sm hover:bg-violet-50"
          title="Open cited source context"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function JournalSection({
  briefId,
  currentUserId,
  isAdmin,
  canManage,
  briefContext,
  onViewBriefBaseline,
}: {
  briefId: string;
  currentUserId: string;
  isAdmin: boolean;
  canManage: boolean;
  briefContext: JournalBriefContext;
  onViewBriefBaseline?: () => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [showDeletedEntries, setShowDeletedEntries] = useState(false);
  const [reviewCandidates, setReviewCandidates] = useState<ReviewCandidate[]>([]);
  const [cockpitModel, setCockpitModel] = useState<JournalCockpitReadModel | null>(null);
  const [cockpitLoading, setCockpitLoading] = useState(false);
  const [cockpitError, setCockpitError] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [newCandidateType, setNewCandidateType] = useState<ReviewCandidateType>("brief_update");
  const [newCandidateTitle, setNewCandidateTitle] = useState("");
  const [newCandidateTarget, setNewCandidateTarget] = useState("");
  const [newCandidateText, setNewCandidateText] = useState("");
  const [newCandidateEvidence, setNewCandidateEvidence] = useState("");
  const [newCandidateConfidence, setNewCandidateConfidence] = useState("");
  const [newCandidateRisk, setNewCandidateRisk] = useState("");
  const [newCandidateSourceEntryId, setNewCandidateSourceEntryId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<JournalSource | null>(null);
  const [selectedCitationContext, setSelectedCitationContext] = useState<SelectedCitationContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [askAi, setAskAi] = useState(false);
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [scopedDocumentIds, setScopedDocumentIds] = useState<string[]>([]);
  const [requireSourceDocumentScope, setRequireSourceDocumentScope] = useState(false);
  const [excludedDocumentIds, setExcludedDocumentIds] = useState<string[]>([]);
  const [journalSearchQuery, setJournalSearchQuery] = useState("");
  const [catchUpWindow, setCatchUpWindow] = useState<JournalCatchUpWindow>("24h");
  const [pendingJournalContextSince, setPendingJournalContextSince] = useState<number | null>(null);
  const [pendingCatchUpWindow, setPendingCatchUpWindow] = useState<JournalCatchUpWindow | null>(null);
  const [pendingCatchUpExcludedDocumentKey, setPendingCatchUpExcludedDocumentKey] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const sourcePreviewRef = useRef<HTMLDivElement>(null);
  const [centerTab, setCenterTab] = useState<"timeline" | "team">("timeline");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [activeFullView, setActiveFullView] = useState<
    "sources" | "intelligence" | "review" | null
  >(null);
  function goToComposer() {
    setActiveFullView(null);
    setCenterTab("timeline");
    window.setTimeout(() => composeRef.current?.focus(), 0);
  }
  // Side-peek: source preview and citation context open in a right-side panel
  // over the current view rather than inline, keeping the feed calm.
  function closePeek() {
    setSelectedSource(null);
    setSelectedCitationContext(null);
  }
  // ⌘K / Ctrl-K toggles the AI command palette; Escape closes it.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (ev.key === "Escape") {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const loadCockpitModel = useCallback(async () => {
    setCockpitLoading(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal/cockpit`, {
        cache: "no-store",
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setCockpitModel(data.model ?? null);
      setCockpitError(null);
    } catch (e: any) {
      setCockpitError(e?.message || "Failed to load cockpit read model");
    } finally {
      setCockpitLoading(false);
    }
  }, [briefId]);

  const loadReviewCandidates = useCallback(async () => {
    setReviewLoading(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal/review-candidates`, {
        cache: "no-store",
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setReviewCandidates(data.candidates ?? []);
      setReviewError(null);
    } catch (e: any) {
      setReviewError(e?.message || "Failed to load review candidates");
    } finally {
      setReviewLoading(false);
    }
  }, [briefId]);

  useEffect(() => {
    load();
    loadReviewCandidates();
    loadCockpitModel();
  }, [load, loadReviewCandidates, loadCockpitModel]);

  const excludedDocumentSnapshotKey = useMemo(
    () => documentIdSnapshotKey(excludedDocumentIds),
    [excludedDocumentIds],
  );

  useEffect(() => {
    if (
      pendingCatchUpExcludedDocumentKey !== null
      && pendingCatchUpExcludedDocumentKey !== excludedDocumentSnapshotKey
    ) {
      setComposeText("");
      setScopedDocumentIds([]);
      setRequireSourceDocumentScope(false);
      setPendingJournalContextSince(null);
      setPendingCatchUpWindow(null);
      setPendingCatchUpExcludedDocumentKey(null);
      setUploadNotice("Invalidated catch-up prompt after source exclusions changed. Run catch-up again to rebuild it with the latest included sources.");
    }
  }, [excludedDocumentSnapshotKey, pendingCatchUpExcludedDocumentKey]);

  function prepareAssistantPrompt(
    text: string,
    sourceDocumentIds: string[] = [],
    requireSourceDocumentScope = false,
    journalContextSince: number | null = null,
    catchUpExcludedDocumentKey: string | null = null,
    journalCatchUpWindow: JournalCatchUpWindow | null = null,
  ) {
    if (
      composeText.trim() &&
      composeText !== text &&
      !window.confirm("Replace your current draft with this assistant prompt?")
    ) {
      return;
    }
    setAskAi(true);
    setRequireSourceDocumentScope(requireSourceDocumentScope);
    setScopedDocumentIds(filteredSourceDocumentIds(sourceDocumentIds));
    setPendingJournalContextSince(journalContextSince);
    setPendingCatchUpWindow(journalCatchUpWindow);
    setPendingCatchUpExcludedDocumentKey(catchUpExcludedDocumentKey);
    setComposeText(text);
    // The composer only renders in Timeline/Team Room, so staging a prompt
    // anywhere else must bring the user to it — otherwise the action looks
    // like it silently did nothing.
    goToComposer();
    window.setTimeout(() => composeRef.current?.focus(), 0);
  }

  async function postJournalEntry(
    text: string,
    askAssistant: boolean,
    sourceDocumentIds = scopedDocumentIds,
    additionalAvailableDocumentIds: string[] = [],
    forceSourceDocumentScope = false,
    journalContextSince: number | null = null,
    journalCatchUpWindow: JournalCatchUpWindow | null = null,
  ) {
    const trimmed = text.trim();
    if (!trimmed || posting) return false;
    const safeSourceDocumentIds = askAssistant
      ? filteredSourceDocumentIds(sourceDocumentIds, additionalAvailableDocumentIds)
      : [];
    setPosting(true);
    setAiError(null);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: trimmed,
          ask_ai: askAssistant,
          ...(askAssistant && (forceSourceDocumentScope || safeSourceDocumentIds.length > 0)
            ? { source_document_ids: safeSourceDocumentIds }
            : {}),
          ...(askAssistant && excludedDocumentIds.length > 0
            ? { excluded_source_document_ids: excludedDocumentIds }
            : {}),
          ...(askAssistant && journalContextSince !== null
            ? { journal_context_since: journalContextSince }
            : {}),
          ...(askAssistant && journalCatchUpWindow !== null
            ? { journal_catch_up_window: journalCatchUpWindow }
            : {}),
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setComposeText("");
      setRequireSourceDocumentScope(false);
      setScopedDocumentIds([]);
      setPendingJournalContextSince(null);
      setPendingCatchUpWindow(null);
      setPendingCatchUpExcludedDocumentKey(null);
      if (data.ai_error) setAiError(data.ai_error);
      await load();
      if (askAssistant) goToComposer();
      return !data.ai_error;
    } catch (e: any) {
      setError(e?.message || "Failed to post entry");
      return false;
    } finally {
      setPosting(false);
    }
  }

  async function submit() {
    await postJournalEntry(composeText, askAi, scopedDocumentIds, [], requireSourceDocumentScope, pendingJournalContextSince, pendingCatchUpWindow);
  }

  async function runIntelligenceAction(prompt: string) {
    if (
      composeText.trim() &&
      !window.confirm("Replace your current draft with this intelligence action?")
    ) {
      return;
    }
    setAskAi(true);
    setRequireSourceDocumentScope(false);
    setScopedDocumentIds([]);
    await postJournalEntry(prompt, true, []);
  }

  async function createReviewCandidate() {
    const title = newCandidateTitle.trim();
    const proposedText = newCandidateText.trim();
    if (!title || !proposedText) {
      setReviewError("Review candidate needs a title and proposed text.");
      return;
    }
    setReviewLoading(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal/review-candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate_type: newCandidateType,
          title,
          proposed_text: proposedText,
          target: newCandidateTarget,
          current_baseline: briefContext.priority_summary,
          evidence: newCandidateEvidence,
          confidence: newCandidateConfidence,
          risk: newCandidateRisk,
          ...(newCandidateSourceEntryId ? { source_entry_id: newCandidateSourceEntryId } : {}),
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      setNewCandidateTitle("");
      setNewCandidateTarget("");
      setNewCandidateText("");
      setNewCandidateEvidence("");
      setNewCandidateConfidence("");
      setNewCandidateRisk("");
      setNewCandidateSourceEntryId(null);
      setReviewError(null);
      await loadReviewCandidates();
      await loadCockpitModel();
    } catch (e: any) {
      setReviewError(e?.message || "Failed to create review candidate");
    } finally {
      setReviewLoading(false);
    }
  }

  async function saveReviewCandidateDraft(draft: ReviewCandidateDraft) {
    setReviewLoading(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal/review-candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate_type: draft.candidate_type,
          title: draft.title,
          proposed_text: draft.proposed_text,
          target: draft.target ?? "",
          current_baseline: briefContext.priority_summary,
          evidence: draft.evidence ?? "",
          confidence: draft.confidence ?? "",
          risk: draft.risk ?? "Review before applying; this card was promoted from an assistant reply.",
          source_entry_id: draft.source_entry_id,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      setReviewError(null);
      setUploadNotice("Added suggested review card to the Review Queue. Review status before sending anything to the brief.");
      await loadReviewCandidates();
      await loadCockpitModel();
      setActiveFullView("review");
    } catch (e: any) {
      setReviewError(e?.message || "Failed to save suggested review card");
      setActiveFullView("review");
    } finally {
      setReviewLoading(false);
    }
  }

  function editReviewCandidateDraft(draft: ReviewCandidateDraft) {
    setNewCandidateType(draft.candidate_type);
    setNewCandidateTitle(draft.title);
    setNewCandidateTarget(draft.target ?? "");
    setNewCandidateText(draft.proposed_text);
    setNewCandidateEvidence(draft.evidence ?? "");
    setNewCandidateConfidence(draft.confidence ?? "");
    setNewCandidateRisk(draft.risk ?? "Review before applying; this card was drafted from an assistant reply.");
    setNewCandidateSourceEntryId(draft.source_entry_id);
    setReviewError(null);
    setActiveFullView("review");
  }

  function draftReviewCandidateFromAssistant(entry: Entry) {
    const draft = buildReviewCandidateDraftFromAssistantEntry(entry);
    if (!draft) {
      setReviewError("Only saved assistant replies can be converted into review candidates.");
      setActiveFullView("review");
      return;
    }
    editReviewCandidateDraft(draft);
  }

  async function updateCandidateStatus(candidateId: string, status: ReviewCandidateStatus) {
    setReviewLoading(true);
    try {
      const r = await fetch(`/api/briefs/${briefId}/journal/review-candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      await loadReviewCandidates();
      await loadCockpitModel();
    } catch (e: any) {
      setReviewError(e?.message || "Failed to update review candidate");
    } finally {
      setReviewLoading(false);
    }
  }

  function briefChatPromptForCandidate(candidate: ReviewCandidate): string {
    const provenance = candidate.source_entry_id
      ? `\nSource assistant reply: ${candidate.source_entry_id}\nNote: Evidence labels such as [J1] or [D1] are response-scoped to that assistant reply. Resolve them from the saved Journal reply/source legend before using them as brief evidence.`
      : "";
    return `Please review this human-accepted Journal candidate and update the brief only if appropriate.\n\nType: ${candidateTypeLabels[candidate.candidate_type]}\nStatus: ${candidateStatusLabels[candidate.status]}\nTarget: ${candidate.target || "Not specified"}\nCurrent brief baseline: ${candidate.current_baseline || "Not specified"}\nProposed text: ${candidate.proposed_text}\nEvidence: ${candidate.evidence || "Not specified"}${provenance}\nConfidence: ${candidate.confidence || "Not specified"}\nRisk / review notes: ${candidate.risk || "Not specified"}\n\nPreserve version history and do not invent evidence.`;
  }

  async function copyBriefChatPrompt(candidate: ReviewCandidate) {
    const prompt = briefChatPromptForCandidate(candidate);
    try {
      await navigator.clipboard.writeText(prompt);
      setUploadNotice("Copied brief-chat prompt. Open the brief to apply it through the normal versioned chat flow.");
    } catch {
      setComposeText(prompt);
      setAskAi(false);
      goToComposer();
      window.setTimeout(() => composeRef.current?.focus(), 0);
      setUploadNotice("Clipboard was unavailable, so the brief-chat prompt was copied into the Journal composer.");
    }
  }

  function openBriefToApply(candidate?: ReviewCandidate) {
    if (candidate) void updateCandidateStatus(candidate.id, "sent_to_brief_chat");
    onViewBriefBaseline?.();
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
      setScopedDocumentIds([]);
      const filename = data?.document?.filename || uploadedFileName;
      setUploadNotice(
        summarizeAfterUpload
          ? `Uploaded ${filename}. Asking the journal assistant to summarize it now…`
          : `Uploaded ${filename}. Its extracted text is now available to the journal assistant and brief chat.`,
      );
      if (summarizeAfterUpload) {
        const uploadedDocumentId = typeof data?.document?.id === "string" ? data.document.id : null;
        const assistantPosted = await postJournalEntry(
          summarizeDocumentPrompt(filename),
          true,
          uploadedDocumentId ? [uploadedDocumentId] : [],
          uploadedDocumentId ? [uploadedDocumentId] : [],
        );
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

  function renderSourceCard(source: JournalSource) {
    const isSelected = scopedDocumentIds.includes(source.id);
    const isExcluded = excludedDocumentIds.includes(source.id);
    const healthBadges = sourceHealthBadges(source, sources);
    return (
      <div
        key={`${source.entryId}-${source.id}`}
        className={`rounded-xl border p-4 transition-colors ${
          isExcluded
            ? "border-slate-200 bg-slate-50 opacity-75"
            : "border-slate-200 bg-white hover:border-slate-300"
        }`}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600">
              <FileText className="size-3" /> Source
            </span>
            <span className="text-xs text-muted" title={new Date(source.created_at).toISOString()}>
              Uploaded {relativeTime(source.created_at)} by {source.entryAuthor}
            </span>
            {isExcluded ? (
              <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800">
                Excluded from AI context
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                <CheckCircle2 className="size-3" /> In AI context
              </span>
            )}
          </div>
          <h3 className="mt-2 truncate text-sm font-semibold text-ink">
            {source.filename}
          </h3>
          <p className="mt-1 text-xs text-muted">
            {source.mime_type || "document"} · {formatFileSize(source.byte_size)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source health</span>
            {healthBadges.map((badge) => (
              <span
                key={badge.status}
                title={badge.description}
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  badge.status === "current"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : badge.status === "conflicting"
                      ? "border-rose-200 bg-rose-50 text-rose-800"
                      : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                {badge.label}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-3 line-clamp-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
          {source.content_preview || "No text preview extracted."}
        </p>
        {source.entryBody && (
          <p className="mt-2 line-clamp-2 text-xs text-muted">
            Attached to journal note: {source.entryBody}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          {/* Primary source actions */}
          <button
            type="button"
            disabled={isExcluded}
            onClick={() => prepareAssistantPrompt(askAboutSourcePrompt(source.filename), [source.id], true)}
            className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="size-3" /> Ask about this source
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedSource(source);
              // Preview stacks above the source list; bring it into view when
              // opened from a card further down.
              window.setTimeout(
                () => sourcePreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
                0,
              );
            }}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Preview source
          </button>
          <button
            type="button"
            onClick={() => toggleSourceExclusion(source)}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            {isExcluded ? "Include source" : "Exclude source"}
          </button>
          <details className="group relative ml-auto">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
              More source actions
            </summary>
            <div className="absolute right-0 z-10 mt-2 flex w-60 flex-col gap-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
              {/* Secondary source actions */}
              <button
                type="button"
                onClick={() => toggleSourceSelection(source.id)}
                disabled={isExcluded}
                aria-pressed={isSelected && !isExcluded}
                className={`rounded-md border px-2 py-1 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isSelected && !isExcluded
                    ? "border-violet-300 bg-violet-600 text-white"
                    : "border-violet-200 bg-white text-violet-800 hover:bg-violet-50"
                }`}
              >
                {isSelected && !isExcluded ? "Selected for batch AI" : "Select for batch AI"}
              </button>
              <button
                type="button"
                disabled={isExcluded}
                onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(source.filename), [source.id], true)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="size-3 text-violet-600" /> Summarize
              </button>
              <button
                type="button"
                disabled={isExcluded}
                onClick={() => prepareAssistantPrompt(briefUpdatePrompt(source.filename), [source.id], true)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Find supported brief updates
              </button>
              <button
                type="button"
                disabled={isExcluded}
                onClick={() => prepareAssistantPrompt(compareWithBriefPrompt(source.filename), [source.id], true)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Compare with brief
              </button>
            </div>
          </details>
        </div>
      </div>
    );
  }

  function renderSourcePreview() {
    if (!selectedSource) return null;
    const isSelectedSourceExcluded = excludedDocumentIds.includes(selectedSource.id);
    return (
      <div ref={sourcePreviewRef} className="rounded-2xl border border-sky-200 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-800">
              <FileText className="size-3.5" /> Source preview
            </div>
            <h3 className="mt-3 text-sm font-semibold text-ink">{selectedSource.filename}</h3>
            <p className="mt-1 text-xs text-muted">
              Uploaded {relativeTime(selectedSource.created_at)} by {selectedSource.entryAuthor} · {formatFileSize(selectedSource.byte_size)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSelectedSource(null)}
            className="rounded-md border border-slate-200 bg-white p-1 text-slate-500 hover:bg-slate-50"
            aria-label="Close source preview"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-slate-800">
          {selectedSource.content_preview || "No text preview extracted."}
        </p>
        {selectedSource.entryBody && (
          <p className="mt-3 rounded-lg border border-slate-100 bg-white p-3 text-xs text-muted">
            Attached journal note: {selectedSource.entryBody}
          </p>
        )}
        {isSelectedSourceExcluded && (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            This source is excluded from AI context. Include it before running source-scoped prompts from this preview.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={isSelectedSourceExcluded}
            onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(selectedSource.filename), [selectedSource.id], true)}
            className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="size-3" /> Summarize
          </button>
          <button
            type="button"
            disabled={isSelectedSourceExcluded}
            onClick={() => prepareAssistantPrompt(compareWithBriefPrompt(selectedSource.filename), [selectedSource.id], true)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Compare with brief
          </button>
        </div>
      </div>
    );
  }

  async function copyCitationEvidence(evidenceSnippet: string) {
    try {
      await navigator.clipboard.writeText(evidenceSnippet);
    } catch {
      setError("Could not copy evidence snippet to clipboard.");
    }
  }

  function renderCitationContext() {
    if (!selectedCitationContext) return null;
    const context = selectedCitationContext;
    return (
      <div className="mb-4 rounded-2xl border border-violet-200 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-800">
              <Sparkles className="size-3.5" /> Citation source context {context.label}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-ink">
              {context.kind === "journal" && "Referenced journal entry"}
              {context.kind === "document" && "Referenced uploaded document"}
              {context.kind === "brief_source" && "Referenced brief source"}
              {context.kind === "unresolved" && "Citation context unavailable"}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => setSelectedCitationContext(null)}
            className="rounded-md border border-slate-200 bg-white p-1 text-slate-500 hover:bg-slate-50"
            aria-label="Close citation source context"
          >
            <X className="size-4" />
          </button>
        </div>
        {context.kind === "journal" && (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
            <p className="text-xs font-medium text-muted">{context.meta}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-900">
              {context.body || "No journal text available."}
            </p>
          </div>
        )}
        {context.kind === "document" && (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
            <p className="text-sm font-medium text-ink">{context.title}</p>
            {context.preview && (
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-slate-900">
                {context.preview}
              </p>
            )}
          </div>
        )}
        {context.kind === "brief_source" && (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
            <p className="text-sm font-medium text-ink">{context.title || "Untitled source"}</p>
            <div className="mt-1 text-sm">
              <SourceLink
                source={context.url}
                className="break-all text-sky-800 hover:underline"
                mutedClassName="break-all text-muted"
              />
            </div>
            {context.accessed && <p className="mt-1 text-xs text-muted">Accessed {context.accessed}</p>}
          </div>
        )}
        {context.kind !== "unresolved" && context.evidenceSnippet && (
          <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-violet-800">
                  Cited source snippet
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-violet-950">
                  {context.evidenceSnippet}
                </p>
              </div>
              <button
                type="button"
                onClick={() => copyCitationEvidence(context.evidenceSnippet || "")}
                className="shrink-0 rounded-md border border-violet-200 bg-white px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100"
              >
                Copy evidence snippet
              </button>
            </div>
          </div>
        )}
        {context.kind === "unresolved" && (
          <p className="mt-3 rounded-xl border border-dashed border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
            {context.message}
          </p>
        )}
      </div>
    );
  }

  function renderReviewCandidate(candidate: ReviewCandidate) {
    return (
      <div key={candidate.id} className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                {candidateTypeLabels[candidate.candidate_type]}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
                {candidateStatusLabels[candidate.status]}
              </span>
              {candidate.confidence && <span className="text-xs text-muted">Confidence: {candidate.confidence}</span>}
            </div>
            <h3 className="mt-2 text-sm font-semibold text-ink">{candidate.title}</h3>
            {candidate.target && <p className="mt-1 text-xs text-muted">Target: {candidate.target}</p>}
          </div>
          <select
            aria-label="Review candidate status"
            value={candidate.status}
            disabled={reviewLoading}
            onChange={(ev) => updateCandidateStatus(candidate.id, ev.target.value as ReviewCandidateStatus)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
          >
            {Object.entries(candidateStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        {candidate.current_baseline && (
          <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-700">
            <span className="font-semibold text-slate-800">Current baseline:</span> {candidate.current_baseline}
          </div>
        )}
        <p className="mt-3 whitespace-pre-wrap text-sm text-slate-900">{candidate.proposed_text}</p>
        {candidate.evidence && (
          <p className="mt-3 rounded-lg bg-violet-50 p-3 text-xs text-violet-900">
            Evidence: {candidate.evidence}
          </p>
        )}
        {candidate.risk && (
          <p className="mt-2 rounded-lg bg-rose-50 p-3 text-xs text-rose-900">
            Risk / review note: {candidate.risk}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => copyBriefChatPrompt(candidate)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Copy brief-chat prompt
          </button>
          {onViewBriefBaseline && (
            <button
              type="button"
              onClick={() => openBriefToApply(candidate)}
              className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
            >
              Open brief to apply
            </button>
          )}
        </div>
      </div>
    );
  }

  function openCitationContext(label: string, entry: Entry) {
    setSelectedCitationContext(null);
    const evidenceSnippet = citationEvidenceSnippet(label, entry.body);
    if (label.startsWith("[D")) {
      const source = resolveCitedDocumentSource(label, entry.body, sources);
      if (source) {
        setSelectedSource(source);
        setSelectedCitationContext({
          kind: "document",
          label,
          title: source.filename,
          preview: source.content_preview,
          evidenceSnippet,
        });
        setActiveFullView("sources");
        return;
      }
      const briefSource = resolveCitedBriefSource(label, entry.body, currentBriefSources);
      if (briefSource) {
        setSelectedCitationContext({
          kind: "brief_source",
          label,
          title: briefSource.title,
          url: briefSource.url,
          accessed: briefSource.accessed,
          evidenceSnippet,
        });
        setActiveFullView("sources");
        return;
      }
    }
    if (label.startsWith("[J")) {
      const journalEntry = resolveCitedJournalEntry(label, entry.body, entries ?? []);
      if (journalEntry) {
        setSelectedCitationContext({
          kind: "journal",
          label,
          title: authorName(journalEntry),
          body: displayEntryBody(journalEntry),
          meta: `${authorName(journalEntry)} · ${relativeTime(journalEntry.created_at)}`,
          evidenceSnippet,
        });
        setTimelineFilter("all");
        goToComposer();
        return;
      }
    }
    setSelectedCitationContext({
      kind: "unresolved",
      label,
      message:
        "This citation label was present in the assistant reply, but the current Journal data could not resolve it to a saved note, uploaded document, or brief source. No evidence was fabricated.",
    });
    setTimelineFilter("all");
    goToComposer();
  }

  function renderAssistantReviewSuggestions(entry: Entry) {
    const drafts = buildReviewCandidateDraftsFromAssistantEntry(entry).slice(0, 6);
    if (drafts.length === 0) return null;
    return (
      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/80 p-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
              Suggested review candidates
            </p>
            <p className="mt-1 text-xs text-amber-900">
              Assistant output is advisory. Add only the cards you want humans to review; nothing edits the brief automatically.
            </p>
          </div>
          <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-amber-800">
            {drafts.length} suggestion{drafts.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {drafts.map((draft, index) => (
            <div key={`${entry.id}-${index}-${draft.title}`} className="rounded-lg border border-amber-200 bg-white p-3 text-xs shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                  {candidateTypeLabels[draft.candidate_type]}
                </span>
                {draft.confidence && <span className="text-muted">Confidence: {draft.confidence}</span>}
              </div>
              <h4 className="mt-2 text-sm font-semibold text-ink">{draft.title}</h4>
              {draft.target && <p className="mt-1 text-muted">Target: {draft.target}</p>}
              <p className="mt-2 line-clamp-3 text-slate-800">{draft.proposed_text}</p>
              {draft.evidence && <p className="mt-2 text-violet-800">Evidence: {draft.evidence}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => saveReviewCandidateDraft(draft)}
                  disabled={reviewLoading}
                  className="rounded-md bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  Add to Review Queue
                </button>
                <button
                  type="button"
                  onClick={() => editReviewCandidateDraft(draft)}
                  className="rounded-md border border-amber-200 bg-white px-2 py-1 font-medium text-amber-800 hover:bg-amber-50"
                >
                  Edit before adding
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
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
                displayEntryBody(e)
              )}
            </p>
          )}

          {isAssistant && !editing && !deleted && renderCitationChips(e, openCitationContext)}
          {isAssistant && !editing && !deleted && renderAssistantReviewSuggestions(e)}

          {isAssistant && !editing && !deleted && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => draftReviewCandidateFromAssistant(e)}
                className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-xs font-medium text-amber-800 shadow-sm hover:bg-amber-50"
              >
                <CheckCircle2 className="size-3" /> Draft review candidate
              </button>
            </div>
          )}

          {!editing && !deleted && e.documents && e.documents.length > 0 && (
            <div className="mt-3 space-y-2">
              {e.documents.map((doc) => {
                const isDocExcluded = excludedDocumentIds.includes(doc.id);
                return (
                <div
                  key={doc.id}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800"
                >
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2 font-medium text-ink">
                      <FileText className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate" title={doc.filename}>{doc.filename}</span>
                      <span className="shrink-0 text-muted font-normal">
                        · {formatFileSize(doc.byte_size)}
                      </span>
                      {isDocExcluded && (
                        <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-800">
                          Excluded from AI context
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={isDocExcluded}
                        onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(doc.filename), [doc.id], true)}
                        className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-white px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Sparkles className="size-3" /> Summarize with AI
                      </button>
                      <button
                        type="button"
                        disabled={isDocExcluded}
                        onClick={() => prepareAssistantPrompt(briefUpdatePrompt(doc.filename), [doc.id], true)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Find brief updates
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted">
                    {doc.content_preview}
                  </p>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  const sources = collectJournalSources(entries);
  const currentBriefSources = briefContext.sources ?? [];
  const totalSourceCount = currentBriefSources.length + sources.length;
  const totalIncludedSourceCount = currentBriefSources.length + sources.length - excludedDocumentIds.length;
  const activeScopedDocumentIds = filteredSourceDocumentIds(scopedDocumentIds);
  const journalSearchResult = useMemo(
    () => searchJournalWorkspace({
      query: journalSearchQuery,
      entries: entries ?? [],
      sources,
      reviewCandidates,
      excludedDocumentIds,
    }),
    [journalSearchQuery, entries, sources, reviewCandidates, excludedDocumentIds],
  );
  const searchEntryIds = useMemo(() => new Set(journalSearchResult.entryIds), [journalSearchResult.entryIds]);
  const searchSourceIds = useMemo(() => new Set(journalSearchResult.sourceIds), [journalSearchResult.sourceIds]);
  const searchReviewCandidateIds = useMemo(
    () => new Set(journalSearchResult.reviewCandidateIds),
    [journalSearchResult.reviewCandidateIds],
  );
  const displayedSources = journalSearchResult.isActive
    ? sources.filter((source) => searchSourceIds.has(source.id))
    : sources;
  const displayedReviewCandidates = journalSearchResult.isActive
    ? reviewCandidates.filter((candidate) => searchReviewCandidateIds.has(candidate.id))
    : reviewCandidates;
  const selectedPreviewMatchesSearch =
    !selectedSource || !journalSearchResult.isActive || searchSourceIds.has(selectedSource.id);
  const reviewCandidatesByType = groupReviewCandidatesByType(displayedReviewCandidates);
  const cockpitDisplay = cockpitDisplayFromModel(cockpitModel);
  // Command-palette model: every AI action funnels through one on-demand list
  // (⌘K) instead of always-visible button grids — each item dispatches an
  // existing handler.
  const paletteGroups: Array<{
    label: string;
    items: Array<{ label: string; run: () => void }>;
  }> = [
    {
      label: "Catch up",
      items: [
        { label: "Catch me up — last 24h", run: () => runCatchUpPrompt("24h") },
        { label: "Catch me up — last 7 days", run: () => runCatchUpPrompt("7d") },
        { label: "Catch me up — all loaded", run: () => runCatchUpPrompt("all") },
      ],
    },
    {
      label: "Generate & analyze",
      items: INTELLIGENCE_ACTIONS.map((a) => ({
        label: a.label,
        run: () => runIntelligenceAction(a.prompt),
      })),
    },
    {
      label: "Quick prompts",
      items: [
        {
          label: "Summarize latest document",
          run: () =>
            prepareAssistantPrompt(
              "Summarize the most recent uploaded document and explain why it matters for this account.",
            ),
        },
        {
          label: "Suggest brief updates",
          run: () =>
            prepareAssistantPrompt(
              "What brief updates are supported by the recent journal documents? Cite filenames and be explicit about where each update belongs.",
            ),
        },
        {
          label: "Draft next actions",
          run: () =>
            prepareAssistantPrompt(
              "Turn the recent journal notes and documents into recommended next actions for this account.",
            ),
        },
      ],
    },
  ];

  function filteredSourceDocumentIds(ids: string[], additionalAvailableDocumentIds: string[] = []): string[] {
    const availableIds = new Set([...sources.map((source) => source.id), ...additionalAvailableDocumentIds]);
    const excludedIds = new Set(excludedDocumentIds);
    return ids.filter((id) => availableIds.has(id) && !excludedIds.has(id));
  }

  function toggleSourceSelection(sourceId: string) {
    setAskAi(true);
    setScopedDocumentIds((ids) =>
      ids.includes(sourceId) ? ids.filter((id) => id !== sourceId) : [...ids, sourceId],
    );
  }

  function toggleSourceExclusion(source: JournalSource) {
    setExcludedDocumentIds((ids) =>
      ids.includes(source.id) ? ids.filter((id) => id !== source.id) : [...ids, source.id],
    );
    setScopedDocumentIds((ids) => ids.filter((id) => id !== source.id));
  }

  function runSelectedSourcePrompt(prompt: string) {
    const selectedIds = filteredSourceDocumentIds(scopedDocumentIds);
    if (selectedIds.length === 0) {
      setUploadNotice("Select at least one included uploaded source before running a source-scoped prompt.");
      setActiveFullView("sources");
      return;
    }
    prepareAssistantPrompt(prompt, selectedIds);
  }

  function runSearchRecallPrompt() {
    const sourceIds = journalSearchResult.recallSourceDocumentIds;
    if (!journalSearchResult.isActive || !journalSearchResult.hasMatches) {
      setUploadNotice("Search the Journal first, then ask about matching notes, sources, and review candidates.");
      return;
    }
    const prompt = buildJournalSearchRecallPrompt({
      query: journalSearchResult.query,
      entries: entries ?? [],
      sources,
      reviewCandidates,
      result: journalSearchResult,
    });
    prepareAssistantPrompt(prompt, sourceIds, true);
  }

  function runCatchUpPrompt(window: JournalCatchUpWindow = catchUpWindow) {
    const now = Date.now();
    const context = buildJournalCatchUpContext({
      window,
      now,
      entries: entries ?? [],
      sources,
      reviewCandidates,
      excludedDocumentIds,
    });
    const prompt = buildJournalCatchUpPrompt({
      context,
      entries: entries ?? [],
      sources,
      reviewCandidates,
    });
    setCatchUpWindow(window);
    prepareAssistantPrompt(
      prompt,
      context.recallSourceDocumentIds,
      true,
      journalCatchUpSince(window, now),
      excludedDocumentSnapshotKey,
      window,
    );
  }

  const deletedEntryCount = entries?.filter((entry) => entry.deleted_at !== null).length ?? 0;
  const filteredEntries = useMemo(() => {
    if (!entries) return null;
    const visibleAuditEntries = entries.filter((entry) => entry.deleted_at === null || showDeletedEntries);
    const timelineEntries = (() => {
      if (timelineFilter === "notes") return visibleAuditEntries.filter((e) => e.author_type === "user" && (e.documents?.length ?? 0) === 0);
      if (timelineFilter === "assistant") return visibleAuditEntries.filter((e) => e.author_type === "assistant");
      if (timelineFilter === "documents") return visibleAuditEntries.filter((e) => (e.documents?.length ?? 0) > 0);
      return visibleAuditEntries;
    })();
    return journalSearchResult.isActive
      ? timelineEntries.filter((entry) => searchEntryIds.has(entry.id))
      : timelineEntries;
  }, [entries, timelineFilter, journalSearchResult.isActive, searchEntryIds, showDeletedEntries]);

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

      <div className="grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_340px]">
        <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <Card className="p-3">
            <SectionHeader
              icon={<FileText className="size-4 text-sky-600" />}
              title="Sources"
              count={totalSourceCount}
              actions={
                <button
                  type="button"
                  onClick={goToComposer}
                  className="rounded-md border border-[var(--line)] bg-white px-2 py-1 text-xs font-medium text-ink transition-colors hover:bg-slate-50"
                >
                  + Add
                </button>
              }
            />
            <p className="mt-1 text-[11px] text-muted">
              {totalIncludedSourceCount} included for AI · {excludedDocumentIds.length} excluded
            </p>
            <div className="mt-3 flex flex-col gap-0.5">
              {sources.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[var(--line)] px-3 py-4 text-center text-xs text-muted">
                  No uploaded sources yet.
                </p>
              ) : (
                sources.map((source) => {
                  const excluded = excludedDocumentIds.includes(source.id);
                  return (
                    <div
                      key={source.id}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        checked={!excluded}
                        onChange={() => toggleSourceExclusion(source)}
                        aria-label={excluded ? "Include source in AI context" : "Exclude source from AI context"}
                        className="size-3.5 shrink-0 accent-violet-600"
                      />
                      <button
                        type="button"
                        onClick={() => setSelectedSource(source)}
                        className="min-w-0 flex-1 truncate text-left text-xs font-medium text-ink transition-colors hover:text-violet-700"
                        title={source.filename}
                      >
                        {source.filename}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            <button
              type="button"
              onClick={() => setActiveFullView("sources")}
              className="mt-3 w-full rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Open full Sources ({currentBriefSources.length} brief · {sources.length} uploaded)
            </button>
          </Card>
          <Card className="mt-3 p-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
              Brief baseline
            </div>
            <h3 className="mt-2 text-sm font-semibold text-ink">{briefContext.account_name}</h3>
            <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Current brief priority
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-700">
              {briefContext.priority_summary || "Not set yet."}
            </p>
            <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Current next action
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-700">
              {briefContext.next_action || "Not set yet."}
            </p>
            {onViewBriefBaseline && (
              <button
                type="button"
                onClick={onViewBriefBaseline}
                className="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                View brief baseline first
              </button>
            )}
          </Card>
        </aside>        <div className="min-w-0">

      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <label className="min-w-0 flex-1 text-sm font-medium text-ink">
            Search Journal, sources, and review candidates
            <input
              value={journalSearchQuery}
              onChange={(event) => setJournalSearchQuery(event.target.value)}
              placeholder="Search notes, assistant replies, source snippets, evidence labels, or review cards…"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-ink placeholder:text-muted"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {journalSearchResult.isActive && (
              <button
                type="button"
                onClick={() => setJournalSearchQuery("")}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                Clear search
              </button>
            )}
            <button
              type="button"
              onClick={runSearchRecallPrompt}
              disabled={!journalSearchResult.isActive || !journalSearchResult.hasMatches || posting || loading}
              className="rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-800 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Ask about search results
            </button>
          </div>
        </div>
        {journalSearchResult.isActive && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-full bg-slate-100 px-2 py-0.5">
              {journalSearchResult.entryIds.length} timeline match{journalSearchResult.entryIds.length === 1 ? "" : "es"}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5">
              {journalSearchResult.sourceIds.length} source match{journalSearchResult.sourceIds.length === 1 ? "" : "es"}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5">
              {journalSearchResult.reviewCandidateIds.length} review card match{journalSearchResult.reviewCandidateIds.length === 1 ? "" : "es"}
            </span>
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-900">
              {journalSearchResult.recallSourceDocumentIds.length} included source{journalSearchResult.recallSourceDocumentIds.length === 1 ? "" : "s"} available for recall
            </span>
          </div>
        )}
      </div>

      {activeFullView ? (
        <div className="mb-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setActiveFullView(null)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-slate-50"
          >
            ← Back to feed
          </button>
          <span className="text-sm font-semibold text-muted">
            {activeFullView === "sources"
              ? "Source Library"
              : activeFullView === "review"
                ? "Review Queue"
                : "Journal Intelligence"}
          </span>
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-[var(--line)] bg-white p-0.5 text-sm"
            role="tablist"
            aria-label="Journal feed"
          >
          <button
            type="button"
            role="tab"
            aria-selected={centerTab === "timeline"}
            onClick={() => setCenterTab("timeline")}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              centerTab === "timeline" ? "bg-ink text-white" : "text-muted hover:text-ink"
            }`}
          >
            Timeline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={centerTab === "team"}
            onClick={() => setCenterTab("team")}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              centerTab === "team" ? "bg-ink text-white" : "text-muted hover:text-ink"
            }`}
          >
            Team Room
          </button>
          </div>
          {/* Below xl the Studio rail (which holds Intelligence/Review entry
              points) is hidden, so surface the preserved full views here too. */}
          <div className="flex flex-wrap items-center gap-1.5 xl:hidden">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Full views
            </span>
            <button
              type="button"
              onClick={() => setActiveFullView("sources")}
              className="rounded-md border border-[var(--line)] bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Sources
            </button>
            <button
              type="button"
              onClick={() => setActiveFullView("intelligence")}
              className="rounded-md border border-[var(--line)] bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Intelligence
            </button>
            <button
              type="button"
              onClick={() => setActiveFullView("review")}
              className="rounded-md border border-[var(--line)] bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Review Queue
            </button>
          </div>
        </div>
      )}

      {activeFullView === "intelligence" && (
        <div className="mb-4 space-y-4">
          <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-sky-50 p-4 shadow-sm">
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
                follow-ups, and open questions. Compare evidence against the current brief baseline,
                keep replies in the journal, and cite source labels such as [J1]
                and [D1] when the model uses notes or uploaded documents.
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

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-800">
                  Account intelligence loop
                </div>
                <h3 className="mt-3 text-base font-semibold text-ink">Catch up, review, then promote durable signals</h3>
                <p className="mt-1 max-w-3xl text-sm text-muted">
                  Use advisory prompts to find what changed, promote only the useful suggestions into human review, then let accepted/sent/applied cards feed the cockpit.
                </p>
              </div>
              <span className="w-fit rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">
                Official only after human review
              </span>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              <div className="rounded-xl border border-violet-100 bg-violet-50/70 p-3">
                <div className="text-sm font-semibold text-violet-950">1. Catch up</div>
                <p className="mt-1 text-xs text-violet-900">Run a windowed catch-up or a focused intelligence action against included sources.</p>
              </div>
              <div className="rounded-xl border border-amber-100 bg-amber-50/70 p-3">
                <div className="text-sm font-semibold text-amber-950">2. Review suggestions</div>
                <p className="mt-1 text-xs text-amber-900">Assistant suggestions stay advisory until you add or edit them as Review Queue cards.</p>
              </div>
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-3">
                <div className="text-sm font-semibold text-indigo-950">3. Promote cockpit signals</div>
                <p className="mt-1 text-xs text-indigo-900">Accepted, sent-to-brief-chat, or applied cards become durable cockpit signals with provenance.</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 text-xs md:grid-cols-2">
              <div className="rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-sky-950">
                <span className="font-semibold">Current source scope:</span> {totalIncludedSourceCount} included for AI; {excludedDocumentIds.length} excluded from AI.
              </div>
              <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-emerald-950">
                <span className="font-semibold">Catch-up freshness:</span> cached catch-ups refresh when Journal entries, source scope, or reviewed cockpit signals change.
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  What changed since
                </div>
                <h3 className="mt-1 text-sm font-semibold text-ink">Time-windowed Journal catch-up</h3>
                <p className="mt-1 max-w-3xl text-sm text-muted">
                  Generate an advisory catch-up over a clear recent window. The prompt includes matching Journal entries, included uploaded sources, and reviewed versus pending review cards without editing durable account data.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {([
                  ["24h", "Last 24h"],
                  ["7d", "Last 7d"],
                  ["all", "All loaded"],
                ] as Array<[JournalCatchUpWindow, string]>).map(([window, label]) => (
                  <button
                    key={window}
                    type="button"
                    aria-pressed={catchUpWindow === window}
                    onClick={() => runCatchUpPrompt(window)}
                    disabled={posting || loading || !entries}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                      catchUpWindow === window
                        ? "border-emerald-300 bg-emerald-600 text-white"
                        : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-indigo-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                  Reviewed account signals
                </div>
                <h3 className="mt-1 text-base font-semibold text-ink">Account Intelligence Cockpit</h3>
                <p className="mt-1 max-w-3xl text-sm text-muted">
                  Durable cockpit cards are loaded from the Journal read model and derived only from review candidates that are accepted, sent to brief chat, or applied. New, reviewing, and dismissed cards remain in the Review Queue until a human promotes them.
                </p>
                <p className="mt-1 text-xs text-muted">
                  {cockpitLoading
                    ? "Refreshing cockpit read model…"
                    : cockpitDisplay.refreshedAt
                      ? `read-model refreshed ${relativeTime(cockpitDisplay.refreshedAt)}`
                      : "read-model not generated yet"}
                </p>
                {cockpitError && <p className="mt-1 text-xs text-rose-700">{cockpitError}</p>}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2">
                  <div className="text-lg font-semibold text-indigo-900">{cockpitDisplay.reviewedCount}</div>
                  <div className="text-indigo-700">reviewed</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-lg font-semibold text-slate-800">{cockpitDisplay.pendingCount}</div>
                  <div className="text-muted">pending</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-lg font-semibold text-slate-800">{cockpitDisplay.dismissedCount}</div>
                  <div className="text-muted">dismissed</div>
                </div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-4">
              {STRUCTURED_REVIEW_BOARDS.map((board) => {
                const reviewedCards = cockpitDisplay.cardsByType[board.type];
                return (
                  <div key={board.type} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-ink">{board.title}</h4>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs text-muted">{reviewedCards.length}</span>
                    </div>
                    {reviewedCards.length === 0 ? (
                      <p className="mt-2 text-xs text-muted">No reviewed signal yet.</p>
                    ) : (
                      <p className="mt-2 line-clamp-3 text-xs text-slate-700">{reviewedCards[0].title}</p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 space-y-2">
              <h4 className="text-sm font-semibold text-ink">Priority reviewed cards</h4>
              {cockpitDisplay.priorityCards.length === 0 ? (
                <div className="rounded-xl border border-dashed border-indigo-200 bg-indigo-50/60 p-4 text-sm text-indigo-950">
                  <div className="font-semibold">No reviewed cockpit signals yet</div>
                  <p className="mt-1 text-indigo-900/80">
                    No accepted, sent, or applied review candidates yet. Promote reviewed cards from the Review Queue to seed cockpit intelligence.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveFullView("review")}
                    className="mt-3 rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-xs font-medium text-indigo-800 hover:bg-indigo-50"
                  >
                    Review suggested candidates
                  </button>
                </div>
              ) : (
                cockpitDisplay.priorityCards.map((card) => (
                  <div key={card.candidate_id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{card.title}</span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs text-muted">{candidateStatusLabels[card.status as ReviewCandidateStatus]}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-muted">{card.text}</p>
                    {card.evidence && <p className="mt-2 text-xs text-slate-600">Evidence: {card.evidence}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {activeFullView === "review" && (
        <div className="mb-4 space-y-4">
          <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-violet-50 p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-800">
                  <CheckCircle2 className="size-3.5" /> Review Queue
                </div>
                <h3 className="mt-3 text-base font-semibold text-ink">
                  Turn messy evidence into human-review candidates
                </h3>
                <p className="mt-1 max-w-2xl text-sm text-muted">
                  Brief-grounded review starts with the current brief baseline, then
                  queues journal evidence as brief updates, action items, decisions,
                  and open questions. The assistant can suggest candidates with
                  evidence and confidence, but it does not edit the brief, assign
                  tasks, or mark decisions official.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-2">
                {REVIEW_QUEUE_ACTIONS.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => runIntelligenceAction(action.prompt)}
                    disabled={posting || loading || !entries}
                    className={`rounded-xl border px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      action.primary
                        ? "border-amber-300 bg-amber-600 text-white shadow-sm hover:bg-amber-700"
                        : "border-slate-200 bg-white text-ink hover:border-amber-200 hover:bg-amber-50"
                    }`}
                  >
                    <span className="block font-medium">{action.label}</span>
                    <span
                      className={`mt-0.5 block text-xs ${
                        action.primary ? "text-amber-100" : "text-muted"
                      }`}
                    >
                      {action.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Human-reviewed lanes
                </div>
                <h3 className="mt-1 text-sm font-semibold text-ink">Structured review boards</h3>
                <p className="mt-1 text-xs text-muted">
                  Review candidates stay in the same human-approved workflow, but are grouped into boards so actions, decisions, open questions, and brief updates are easier to scan.
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted">
                {displayedReviewCandidates.length} card{displayedReviewCandidates.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-4 grid gap-3 xl:grid-cols-4 md:grid-cols-2">
              {STRUCTURED_REVIEW_BOARDS.map((board) => {
                const boardCandidates = reviewCandidatesByType[board.type];
                return (
                  <div key={board.type} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="text-sm font-semibold text-ink">{board.title}</h4>
                        <p className="mt-1 text-xs text-muted">{board.description}</p>
                      </div>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700">
                        {boardCandidates.length}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {boardCandidates.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-slate-200 bg-white p-3 text-xs text-muted">
                          {board.empty}
                        </div>
                      ) : (
                        boardCandidates.slice(0, 3).map((candidate) => (
                          <div key={candidate.id} className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-ink">{candidate.title}</span>
                              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-muted">
                                {candidateStatusLabels[candidate.status]}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-muted">{candidate.proposed_text}</p>
                          </div>
                        ))
                      )}
                      {boardCandidates.length > 3 && (
                        <div className="text-xs text-muted">+ {boardCandidates.length - 3} more in the full Review Queue below</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-ink">Create review candidate card</h3>
            <p className="mt-1 text-xs text-muted">
              Save the human-reviewed takeaway as a durable card. Cards can move through New, Reviewing, Accepted, Sent to brief chat, Applied, or Dismissed without automatically changing the brief.
            </p>
            {newCandidateSourceEntryId && (
              <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
                <div>
                  Drafted from assistant reply {newCandidateSourceEntryId}. Evidence labels are preserved from that reply’s trusted source legend when available.
                </div>
                <button
                  type="button"
                  onClick={() => setNewCandidateSourceEntryId(null)}
                  className="mt-1 font-medium underline decoration-violet-300 underline-offset-2 hover:text-violet-700"
                >
                  Clear assistant provenance
                </button>
              </div>
            )}
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <select
                value={newCandidateType}
                onChange={(ev) => setNewCandidateType(ev.target.value as ReviewCandidateType)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                aria-label="Review candidate type"
              >
                {Object.entries(candidateTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <input
                value={newCandidateTitle}
                onChange={(ev) => setNewCandidateTitle(ev.target.value)}
                placeholder="Candidate title"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <input
                value={newCandidateTarget}
                onChange={(ev) => setNewCandidateTarget(ev.target.value)}
                placeholder="Target brief field/section, owner, or question category"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <input
                value={newCandidateConfidence}
                onChange={(ev) => setNewCandidateConfidence(ev.target.value)}
                placeholder="Confidence, e.g. high / medium / low"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <textarea
                value={newCandidateText}
                onChange={(ev) => setNewCandidateText(ev.target.value)}
                placeholder="Proposed text / action / decision / open question"
                rows={3}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm lg:col-span-2"
              />
              <textarea
                value={newCandidateEvidence}
                onChange={(ev) => setNewCandidateEvidence(ev.target.value)}
                placeholder="Evidence/source labels, e.g. [J1], [D1], filename, quote"
                rows={2}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <textarea
                value={newCandidateRisk}
                onChange={(ev) => setNewCandidateRisk(ev.target.value)}
                placeholder="Risk of applying / reviewer note"
                rows={2}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            {reviewError && (
              <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                {reviewError}
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={createReviewCandidate}
                disabled={reviewLoading}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {reviewLoading && <Loader2 className="size-3.5 animate-spin" />}
                Save review candidate
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <h3 className="whitespace-nowrap text-sm font-semibold text-ink">Full Review Queue</h3>
              <span className="text-xs text-muted">
                Same human-review cards, shown ungrouped for status changes and brief-chat handoff.
              </span>
            </div>
            {displayedReviewCandidates.length === 0 ? (
              <EmptyState
                icon={<ClipboardList className="size-5" />}
                title={journalSearchResult.isActive ? "No matching review cards" : "Review Queue is empty"}
                description={
                  journalSearchResult.isActive
                    ? "Clear the search to see the full Review Queue."
                    : "Promote assistant suggestions here with \u201CAdd to Review Queue\u201D, or edit them first before saving for team follow-up."
                }
              />
            ) : (
              displayedReviewCandidates.map((candidate) => renderReviewCandidate(candidate))
            )}
          </div>
        </div>
      )}

      {activeFullView === "sources" && (
        <div className="mb-4 space-y-3">
          <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-800">
              <FileText className="size-3.5" /> Source Library
            </div>
            <h3 className="mt-3 text-base font-semibold text-ink">
              Review brief and uploaded evidence before asking AI to synthesize it
            </h3>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Sources include the current brief baseline sources plus any journal
              document uploads. Use source-scoped prompts to summarize uploaded
              documents, compare against the brief, or find supported brief update
              candidates without directly editing the brief.
            </p>
            <div className="mt-3 grid gap-2 text-xs text-sky-950 sm:grid-cols-3">
              <div className="rounded-lg border border-sky-100 bg-white/80 px-3 py-2">
                Brief baseline sources: {currentBriefSources.length}
              </div>
              <div className="rounded-lg border border-sky-100 bg-white/80 px-3 py-2">
                Journal uploads: {sources.length}
              </div>
              <div className="rounded-lg border border-sky-100 bg-white/80 px-3 py-2 font-medium">
                Total available to Journal AI: {totalIncludedSourceCount}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Brief baseline sources</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted">
                {currentBriefSources.length}
              </span>
            </div>
            {currentBriefSources.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-[var(--line)] bg-slate-50 p-4 text-sm text-muted">
                No current brief sources are saved on the baseline brief.
              </div>
            ) : (
              <div className="mt-3 grid gap-3 xl:grid-cols-2">
                {currentBriefSources.map((source, index) => (
                  <div key={`${source.url}-${index}`} className="rounded-xl border border-[var(--line)] bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Source {index + 1}
                    </div>
                    <p className="mt-1 text-sm font-medium text-ink">
                      {source.title || "Untitled source"}
                    </p>
                    <div className="mt-1 text-sm">
                      <SourceLink
                        source={source.url}
                        className="break-all text-sky-800 hover:underline"
                        mutedClassName="break-all text-muted"
                      />
                    </div>
                    {source.accessed && (
                      <p className="mt-1 text-xs text-muted">Accessed {source.accessed}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-ink">Journal uploaded sources</h3>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted">
                    {displayedSources.length}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  source-scoped prompts only include selected, non-excluded uploads. Exclude stale,
                  duplicate, superseded, or conflicting sources when they should not ground the next answer.
                </p>
              </div>
              {sources.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={activeScopedDocumentIds.length === 0}
                    onClick={() => runSelectedSourcePrompt(
                      "Answer using only the selected included Journal sources. Summarize what these sources establish, what remains uncertain, and the best next account-team questions. Cite source labels like [D1] when available.",
                    )}
                    className="rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Ask about selected sources
                  </button>
                  <button
                    type="button"
                    disabled={activeScopedDocumentIds.length === 0}
                    onClick={() => runSelectedSourcePrompt(
                      "Review selected source health. Identify stale, duplicate, superseded, and conflicting evidence signals; explain which sources should be included, excluded, or reconciled before brief updates. Do not edit the brief.",
                    )}
                    className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Review selected source health
                  </button>
                </div>
              )}
            </div>
            {sources.length > 0 && (
              <div className="mt-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                {activeScopedDocumentIds.length} selected included source{activeScopedDocumentIds.length === 1 ? "" : "s"}; {excludedDocumentIds.length} excluded from AI context.
              </div>
            )}
            {sources.length === 0 ? (
              <EmptyState
                className="mt-3"
                icon={<FileText className="size-5" />}
                title="No sources uploaded yet"
                description="Upload a document from the Timeline composer to make its extracted evidence available to the Journal assistant."
                action={
                  <button
                    type="button"
                    onClick={() => {
                      goToComposer();
                      window.setTimeout(() => composeRef.current?.focus(), 0);
                    }}
                    className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800"
                  >
                    Add a source
                  </button>
                }
              />
            ) : displayedSources.length === 0 ? (
              <EmptyState
                className="mt-3"
                icon={<Search className="size-5" />}
                title="No sources match this search"
                description="Clear the search to see all uploaded sources."
              />
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                {displayedSources.map((source) => renderSourceCard(source))}
              </div>
            )}
          </div>
        </div>
      )}

      {!activeFullView && centerTab === "team" && (
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700">
            <MessageSquare className="size-3.5" /> Team Room
          </div>
          <h3 className="mt-3 text-base font-semibold text-ink">General team discussion</h3>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Use this general team discussion space for teammate review comments and alignment that should not be mixed with source-grounded Journal evidence or assistant review cards.
          </p>
          <div className="mt-4">
            <CommentsSection briefId={briefId} currentUserId={currentUserId} isAdmin={isAdmin} />
          </div>
        </div>
      )}

      {!activeFullView && centerTab === "timeline" && entries && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(timelineFilterLabels) as TimelineFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={timelineFilter === filter}
                onClick={() => setTimelineFilter(filter)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  timelineFilter === filter
                    ? "bg-ink text-white"
                    : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                }`}
              >
                {timelineFilterLabels[filter]}
              </button>
            ))}
          </div>
          {deletedEntryCount > 0 && (
            <button
              type="button"
              aria-pressed={showDeletedEntries}
              onClick={() => setShowDeletedEntries((value) => !value)}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              {showDeletedEntries ? "Hide audit entries" : "Show audit entries"}
              <span className="ml-1 text-slate-500">
                {showDeletedEntries
                  ? `(${deletedEntryCount} deleted audit entr${deletedEntryCount === 1 ? "y is" : "ies are"} visible)`
                  : `(${deletedEntryCount} deleted entries hidden from the main Timeline)`}
              </span>
            </button>
          )}
        </div>
      )}

      {!activeFullView && centerTab === "timeline" &&
        filteredEntries &&
        filteredEntries.length === 0 &&
        (entries?.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="size-5" />}
            title="No journal entries yet"
            description="Post an update, upload a document, or switch to Ask assistant to ask a question grounded in this brief."
            action={
              <button
                type="button"
                onClick={() => composeRef.current?.focus()}
                className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800"
              >
                Add your first note
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={<Search className="size-5" />}
            title={journalSearchResult.isActive ? "No matching entries" : "No entries match this filter"}
            description={
              journalSearchResult.isActive
                ? "Clear the search or try another query."
                : "Try a different Timeline filter."
            }
          />
        ))}

      {!activeFullView && centerTab === "timeline" && filteredEntries && filteredEntries.map((e) => renderEntry(e))}

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

      {!activeFullView ? (
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
              onClick={() => {
                setAskAi(false);
                setRequireSourceDocumentScope(false);
                setScopedDocumentIds([]);
              }}
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
        {askAi && activeScopedDocumentIds.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <FileText className="size-3.5" />
            <span>
              AI context scoped to {activeScopedDocumentIds.length} selected source{activeScopedDocumentIds.length === 1 ? "" : "s"}.
            </span>
            <button
              type="button"
              onClick={() => {
                setRequireSourceDocumentScope(false);
                setScopedDocumentIds([]);
              }}
              className="font-medium underline decoration-sky-300 underline-offset-2 hover:text-sky-700"
            >
              Use recent sources instead
            </button>
          </div>
        )}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-100"
          >
            <Sparkles className="size-3" /> Ask / generate…
            <span className="ml-1 rounded border border-violet-200 bg-white px-1 text-[10px] text-violet-500">
              ⌘K
            </span>
          </button>
        </div>
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
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-ink transition-colors hover:bg-slate-50">
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
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-ink transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {uploading && <Loader2 className="size-3.5 animate-spin" />}
              {uploading ? "Uploading…" : "Upload document"}
            </button>
            <button
              type="button"
              onClick={() => uploadDocument({ summarizeAfterUpload: true })}
              disabled={uploading || posting || !selectedFile}
              className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-800 transition-colors hover:bg-violet-100 disabled:opacity-50"
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
              className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
            >
              {posting && <Loader2 className="size-3.5 animate-spin" />}
              {posting ? (askAi ? "Asking…" : "Posting…") : askAi ? "Ask" : "Post"}
            </button>
        </div>
      </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            goToComposer();
            window.setTimeout(() => composeRef.current?.focus(), 0);
          }}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--line)] bg-white px-4 py-3 text-sm font-medium text-muted transition-colors hover:border-slate-300 hover:text-ink"
        >
          <BookOpen className="size-4" />
          {activeFullView === "sources"
            ? "Upload a source or add a note in Timeline"
            : "Add a note or ask the assistant in Timeline"}
        </button>
      )}
        </div>
        <aside className="hidden xl:flex xl:flex-col gap-3 xl:sticky xl:top-4 xl:self-start">
          <Card className="p-4">
            <SectionHeader
              icon={<Sparkles className="size-4 text-violet-600" />}
              title="Studio"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Generate from your notes and sources. Advisory only — nothing edits the brief automatically.
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {INTELLIGENCE_ACTIONS.slice(0, 4).map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => runIntelligenceAction(action.prompt)}
                  disabled={posting || loading}
                  className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
            <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Catch up
            </p>
            <div className="mt-1.5 inline-flex rounded-lg border border-[var(--line)] bg-white p-0.5 text-xs">
              {(["24h", "7d", "all"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => runCatchUpPrompt(w)}
                  disabled={posting || loading}
                  className={`rounded-md px-2.5 py-1 transition-colors disabled:opacity-50 ${
                    catchUpWindow === w ? "bg-ink text-white" : "text-muted hover:text-ink"
                  }`}
                >
                  {w === "all" ? "All" : w}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setActiveFullView("intelligence")}
              className="mt-4 w-full rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Open full Intelligence
            </button>
          </Card>
          <Card className="p-4">
            <SectionHeader
              title="Review Queue"
              count={reviewCandidates.length}
              actions={
                <button
                  type="button"
                  onClick={() => setActiveFullView("review")}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  Open
                </button>
              }
            />
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="accepted">{cockpitDisplay.reviewedCount} reviewed</Badge>
              <Badge tone="review">{cockpitDisplay.pendingCount} pending</Badge>
              <Badge tone="neutral">{cockpitDisplay.dismissedCount} dismissed</Badge>
            </div>
            {cockpitDisplay.priorityCards.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {cockpitDisplay.priorityCards.slice(0, 4).map((item) => (
                  <button
                    key={item.candidate_id}
                    type="button"
                    onClick={() => setActiveFullView("review")}
                    className="rounded-lg border border-[var(--line)] bg-white p-2.5 text-left transition-colors hover:bg-slate-50"
                  >
                    <Badge tone="neutral">{candidateTypeLabels[item.type]}</Badge>
                    <p className="mt-1 line-clamp-2 text-xs font-medium text-ink">{item.title}</p>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </aside>      </div>
      {(selectedSource || selectedCitationContext) && (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-slate-900/20"
            onClick={closePeek}
            aria-hidden="true"
          />
          <div className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-[var(--line)] bg-white p-4 shadow-xl">
            {selectedCitationContext ? (
              renderCitationContext()
            ) : selectedPreviewMatchesSearch ? (
              renderSourcePreview()
            ) : (
              <div className="rounded-2xl border border-dashed border-sky-200 bg-white p-4 text-sm text-muted">
                The selected source preview does not match this search. Clear search or open a matching source.
              </div>
            )}
          </div>
        </div>
      )}
      {paletteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]"
          role="dialog"
          aria-modal="true"
          aria-label="AI command palette"
        >
          <div
            className="absolute inset-0 bg-slate-900/30"
            onClick={() => setPaletteOpen(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-2xl">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
              <Sparkles className="size-4 shrink-0 text-violet-600" />
              <input
                autoFocus
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
                placeholder="Ask or generate… (catch up, what changed, summarize, draft actions)"
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              />
              <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-muted">
                Esc
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {(() => {
                const q = paletteQuery.trim().toLowerCase();
                const groups = paletteGroups
                  .map((group) => ({
                    label: group.label,
                    items: group.items.filter((it) => it.label.toLowerCase().includes(q)),
                  }))
                  .filter((group) => group.items.length > 0);
                if (groups.length === 0) {
                  return (
                    <p className="px-2 py-6 text-center text-sm text-muted">
                      No matching actions.
                    </p>
                  );
                }
                return groups.map((group) => (
                  <div key={group.label} className="mb-2">
                    <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {group.label}
                    </div>
                    {group.items.map((it) => (
                      <button
                        key={it.label}
                        type="button"
                        onClick={() => {
                          it.run();
                          setPaletteOpen(false);
                          setPaletteQuery("");
                        }}
                        disabled={posting || loading}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-slate-50 disabled:opacity-50"
                      >
                        <Sparkles className="size-3 shrink-0 text-violet-500" />
                        {it.label}
                      </button>
                    ))}
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
