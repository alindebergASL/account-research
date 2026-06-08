"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
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
import { buildReviewCandidateDraftFromAssistantEntry } from "@/lib/journalReviewCandidateExtraction";
import { buildJournalCockpitSummary } from "@/lib/journalCockpitSummary";
import {
  buildJournalSearchRecallPrompt,
  searchJournalWorkspace,
} from "@/lib/journalSearch";
import { findSourceLegendBlockStart } from "@/lib/journalSourceLegend";
import { SourceLink } from "@/components/SourceLink";
import CommentsSection from "./CommentsSection";

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

type JournalWorkspace = "timeline" | "sources" | "intelligence" | "review" | "team";
type TimelineFilter = "all" | "notes" | "assistant" | "documents";

type JournalSource = JournalDocument & {
  entryId: string;
  entryAuthor: string;
  entryBody: string | null;
  entryCreatedAt: number;
};

type SourceHealthStatus = "current" | "stale" | "duplicate" | "superseded" | "conflicting";

type JournalBriefContext = {
  account_name: string;
  priority_summary: string;
  next_action: string;
  sources_count: number;
  sources: Array<{ title: string; url: string; accessed: string }>;
};

type ReviewCandidateType = "brief_update" | "action_item" | "decision" | "open_question";
type ReviewCandidateStatus =
  | "new"
  | "reviewing"
  | "accepted"
  | "sent_to_brief_chat"
  | "applied"
  | "dismissed";

type ReviewCandidate = {
  id: string;
  candidate_type: ReviewCandidateType;
  status: ReviewCandidateStatus;
  title: string;
  proposed_text: string;
  target: string | null;
  current_baseline: string | null;
  evidence: string | null;
  confidence: string | null;
  risk: string | null;
  source_entry_id: string | null;
  created_at: number;
  updated_at: number;
};

type SelectedCitationContext =
  | {
      kind: "journal";
      label: string;
      title: string;
      body: string | null;
      meta: string;
      evidenceSnippet: string | null;
    }
  | {
      kind: "document";
      label: string;
      title: string;
      preview: string | null;
      evidenceSnippet: string | null;
    }
  | {
      kind: "brief_source";
      label: string;
      title: string;
      url: string;
      accessed: string;
      evidenceSnippet: string | null;
    }
  | {
      kind: "unresolved";
      label: string;
      message: string;
    };

const timelineFilterLabels: Record<TimelineFilter, string> = {
  all: "All entries",
  notes: "Notes",
  assistant: "Assistant",
  documents: "Documents",
};

const candidateTypeLabels: Record<ReviewCandidateType, string> = {
  brief_update: "Brief update",
  action_item: "Action item",
  decision: "Decision",
  open_question: "Open question",
};

const candidateStatusLabels: Record<ReviewCandidateStatus, string> = {
  new: "New",
  reviewing: "Reviewing",
  accepted: "Accepted",
  sent_to_brief_chat: "Sent to brief chat",
  applied: "Applied",
  dismissed: "Dismissed",
};

const STRUCTURED_REVIEW_BOARDS: Array<{
  type: ReviewCandidateType;
  title: string;
  description: string;
  empty: string;
}> = [
  {
    type: "action_item",
    title: "Actions board",
    description: "Follow-ups, owners, deliverables, and next moves that need human review.",
    empty: "No action item candidates yet.",
  },
  {
    type: "decision",
    title: "Decisions log",
    description: "Accepted or pending decisions with evidence before they become account truth.",
    empty: "No decision candidates yet.",
  },
  {
    type: "open_question",
    title: "Open questions",
    description: "Unknowns and follow-up questions that still need evidence or owner input.",
    empty: "No open question candidates yet.",
  },
  {
    type: "brief_update",
    title: "Brief updates",
    description: "Field-level account brief changes to send through the normal versioned brief flow.",
    empty: "No brief update candidates yet.",
  },
];

function groupReviewCandidatesByType(candidates: ReviewCandidate[]): Record<ReviewCandidateType, ReviewCandidate[]> {
  return {
    brief_update: candidates.filter((candidate) => candidate.candidate_type === "brief_update"),
    action_item: candidates.filter((candidate) => candidate.candidate_type === "action_item"),
    decision: candidates.filter((candidate) => candidate.candidate_type === "decision"),
    open_question: candidates.filter((candidate) => candidate.candidate_type === "open_question"),
  };
}

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

function compareWithBriefPrompt(filename: string): string {
  return `Compare the uploaded document "${filename}" with the current account brief. Identify supported updates, contradictions, stale assumptions, and open questions. Cite the document by filename and do not claim you edited the brief.`;
}

function askAboutSourcePrompt(filename: string): string {
  return `Answer questions using the uploaded document "${filename}" as the primary source. Start with a concise summary of what this source is useful for, then list the highest-value questions the account team should ask next. Cite the document by filename.`;
}

type IntelligenceAction = {
  label: string;
  description: string;
  prompt: string;
  primary?: boolean;
};

const INTELLIGENCE_ACTIONS: IntelligenceAction[] = [
  {
    label: "Catch me up",
    description: "Concise account catch-up grounded in recent evidence.",
    primary: true,
    prompt:
      "Catch me up on this account using the current brief baseline plus recent journal notes and uploaded documents. Use sections: Current state, What changed, What needs attention, Suggested next move, Evidence. Cite source labels like [J1] and [D1].",
  },
  {
    label: "What changed since the last brief version",
    description: "New evidence, challenged assumptions, and stale fields.",
    prompt:
      "Explain what changed since the last brief version based on recent journal notes and uploaded documents. Identify new facts, changed assumptions, stale brief fields, unresolved questions, and recommended brief-update candidates. Cite source labels like [J1] and [D1].",
  },
  {
    label: "What needs attention",
    description: "Prioritized risks, blockers, and next actions.",
    prompt:
      "Identify what needs attention for this account now. Rank the highest-priority risks, blockers, open questions, and next actions. For each item include why it matters, evidence source labels like [J1] or [D1], and whether it should become a review candidate.",
  },
  {
    label: "Generate account update",
    description: "What changed, why it matters, and recommended moves.",
    primary: true,
    prompt:
      "Generate an account update from the recent journal notes and uploaded documents, explicitly comparing it to the current brief baseline. Use sections: What changed, Current brief baseline, Evidence, Recommended next moves. Cite source labels like [J1] and [D1] for factual claims.",
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
      "Find brief update candidates supported by the recent journal notes and uploaded documents. For each candidate include the target brief section or field, which current brief claim it supports, contradicts, or updates, proposed change, confidence, and evidence source labels like [J1] or [D1]. Do not claim you edited the brief.",
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

const REVIEW_QUEUE_ACTIONS: IntelligenceAction[] = [
  {
    label: "Review brief update candidates",
    description: "Proposed brief changes with target fields, confidence, and evidence.",
    primary: true,
    prompt:
      "Create a review queue of brief update candidates from recent journal notes and uploaded documents. For each candidate include: target brief section or field, current brief baseline or claim, proposed text, evidence source labels like [J1] or [D1], confidence, risk of applying, and suggested reviewer action. Do not claim you edited the brief; this is a human-review queue only.",
  },
  {
    label: "Review action items",
    description: "Suggested tasks that need owner/date review before becoming durable.",
    prompt:
      "Create a human-review queue of action item candidates from recent journal notes and uploaded documents. For each candidate include: task, owner if stated, due date or trigger if stated, evidence source labels like [J1] or [D1], missing fields, confidence, and suggested reviewer action. Do not assign anyone or create durable tasks.",
  },
  {
    label: "Review decisions",
    description: "Potential decisions, rationale, reversals, and contradictions.",
    prompt:
      "Create a human-review queue of decision candidates from recent journal notes and uploaded documents. For each candidate include: decision statement, date or timing if known, decider or owner if stated, rationale, evidence source labels like [J1] or [D1], alternatives or reversal conditions if present, confidence, and suggested reviewer action. Do not mark anything official.",
  },
  {
    label: "Review open questions",
    description: "Unresolved account questions to ask, answer, or convert to brief updates.",
    prompt:
      "Create a human-review queue of open questions from recent journal notes and uploaded documents. Group by account strategy, stakeholders, technical fit, procurement, budget/timing, competitors, and next meeting prep. For each question include evidence source labels like [J1] or [D1], why it matters, whether it blocks outreach or brief edits, and suggested reviewer action.",
  },
];

function trustedLegendStart(entry: Entry): number {
  if (entry.author_type !== "assistant" || !entry.reply_to || !entry.body) {
    return -1;
  }
  return findSourceLegendBlockStart(entry.body);
}

function extractCitationLabels(entry: Entry): string[] {
  const legendStart = trustedLegendStart(entry);
  if (legendStart < 0 || !entry.body) return [];
  const answerText = entry.body.slice(0, legendStart);
  const legendText = entry.body.slice(legendStart);
  const validLabels = new Set<string>();
  for (const match of legendText.matchAll(/\[(?:J|D)\d+\]/g)) {
    validLabels.add(match[0]);
  }
  const citedLabels = new Set<string>();
  for (const match of answerText.matchAll(/\[(?:J|D)\d+\]/g)) {
    if (validLabels.has(match[0])) citedLabels.add(match[0]);
  }
  return Array.from(citedLabels);
}

function displayEntryBody(entry: Entry): string | null {
  const legendStart = trustedLegendStart(entry);
  if (legendStart < 0 || !entry.body) return entry.body;
  return entry.body.slice(0, legendStart).trimEnd();
}

function collectJournalSources(entries: Entry[] | null): JournalSource[] {
  if (!entries) return [];
  return entries
    .flatMap((entry) =>
      (entry.documents ?? []).map((doc) => ({
        ...doc,
        entryId: entry.id,
        entryAuthor: authorName(entry),
        entryBody: displayEntryBody(entry),
        entryCreatedAt: entry.created_at,
      })),
    )
    .sort((a, b) => b.created_at - a.created_at);
}

function sourceFingerprint(source: JournalSource): string {
  return `${source.filename.trim().toLowerCase()}::${source.byte_size}`;
}

function sourceHealthBadges(
  source: JournalSource,
  allSources: JournalSource[],
): Array<{ status: SourceHealthStatus; label: string; description: string }> {
  const badges: Array<{ status: SourceHealthStatus; label: string; description: string }> = [];
  const sameFingerprint = allSources.filter((candidate) =>
    sourceFingerprint(candidate) === sourceFingerprint(source),
  );
  const newestDuplicate = sameFingerprint.reduce<JournalSource | null>(
    (newest, candidate) => !newest || candidate.created_at > newest.created_at ? candidate : newest,
    null,
  );
  const searchableText = `${source.filename} ${source.entryBody ?? ""} ${source.content_preview ?? ""}`.toLowerCase();

  if (sameFingerprint.length > 1) {
    badges.push({
      status: "duplicate",
      label: "duplicate",
      description: "Another uploaded source has the same filename and size.",
    });
  }
  if (newestDuplicate && newestDuplicate.id !== source.id) {
    badges.push({
      status: "superseded",
      label: "superseded",
      description: "A newer duplicate upload exists; prefer the latest copy unless review says otherwise.",
    });
  }
  if (Date.now() - source.created_at > 1000 * 60 * 60 * 24 * 45) {
    badges.push({
      status: "stale",
      label: "stale",
      description: "This source is older than 45 days and may need a freshness check.",
    });
  }
  if (/\b(conflict|conflicting|contradict|contradiction|dispute|disputed)\b/.test(searchableText)) {
    badges.push({
      status: "conflicting",
      label: "conflicting",
      description: "This source mentions conflict or contradiction and needs reconciliation.",
    });
  }
  if (badges.length === 0) {
    badges.push({
      status: "current",
      label: "current",
      description: "No freshness, duplicate, superseded, or conflict signal detected.",
    });
  }
  return badges;
}

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
  const [activeWorkspace, setActiveWorkspace] =
    useState<JournalWorkspace>("team");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [reviewCandidates, setReviewCandidates] = useState<ReviewCandidate[]>([]);
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
  }, [load, loadReviewCandidates]);

  function prepareAssistantPrompt(
    text: string,
    sourceDocumentIds: string[] = [],
    requireSourceDocumentScope = false,
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
    setComposeText(text);
    window.setTimeout(() => composeRef.current?.focus(), 0);
  }

  async function postJournalEntry(
    text: string,
    askAssistant: boolean,
    sourceDocumentIds = scopedDocumentIds,
    additionalAvailableDocumentIds: string[] = [],
    forceSourceDocumentScope = false,
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
      if (data.ai_error) setAiError(data.ai_error);
      await load();
      if (askAssistant) setActiveWorkspace("timeline");
      return !data.ai_error;
    } catch (e: any) {
      setError(e?.message || "Failed to post entry");
      return false;
    } finally {
      setPosting(false);
    }
  }

  async function submit() {
    await postJournalEntry(composeText, askAi, scopedDocumentIds, [], requireSourceDocumentScope);
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
    } catch (e: any) {
      setReviewError(e?.message || "Failed to create review candidate");
    } finally {
      setReviewLoading(false);
    }
  }

  function draftReviewCandidateFromAssistant(entry: Entry) {
    const draft = buildReviewCandidateDraftFromAssistantEntry(entry);
    if (!draft) {
      setReviewError("Only saved assistant replies can be converted into review candidates.");
      setActiveWorkspace("review");
      return;
    }
    setNewCandidateType(draft.candidate_type);
    setNewCandidateTitle(draft.title);
    setNewCandidateTarget(draft.target ?? "");
    setNewCandidateText(draft.proposed_text);
    setNewCandidateEvidence(draft.evidence ?? "");
    setNewCandidateConfidence(draft.confidence ?? "");
    setNewCandidateRisk(draft.risk ?? "Review before applying; this card was drafted from an assistant reply.");
    setNewCandidateSourceEntryId(draft.source_entry_id);
    setReviewError(null);
    setActiveWorkspace("review");
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
        className={`rounded-xl border p-4 shadow-sm ${
          isExcluded ? "border-slate-200 bg-slate-50 opacity-75" : "border-slate-200 bg-white"
        }`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800">
                <FileText className="size-3" /> Source
              </span>
              <span className="text-xs text-muted" title={new Date(source.created_at).toISOString()}>
                Uploaded {relativeTime(source.created_at)} by {source.entryAuthor}
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                isExcluded
                  ? "border-rose-200 bg-rose-50 text-rose-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}>
                {isExcluded ? "Excluded from AI context" : "Included in AI context"}
              </span>
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
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => toggleSourceSelection(source.id)}
              disabled={isExcluded}
              aria-pressed={isSelected && !isExcluded}
              className={`rounded-md border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                isSelected && !isExcluded
                  ? "border-violet-300 bg-violet-600 text-white"
                  : "border-violet-200 bg-white text-violet-800 hover:bg-violet-50"
              }`}
            >
              {isSelected && !isExcluded ? "Selected for AI" : "Select for AI"}
            </button>
            <button
              type="button"
              onClick={() => toggleSourceExclusion(source)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {isExcluded ? "Include source" : "Exclude source"}
            </button>
            <button
              type="button"
              onClick={() => setSelectedSource(source)}
              className="rounded-md border border-sky-200 bg-white px-2 py-1 text-xs font-medium text-sky-800 hover:bg-sky-50"
            >
              Preview source
            </button>
            <button
              type="button"
              disabled={isExcluded}
              onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(source.filename), [source.id])}
              className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles className="size-3" /> Summarize
            </button>
            <button
              type="button"
              disabled={isExcluded}
              onClick={() => prepareAssistantPrompt(briefUpdatePrompt(source.filename), [source.id])}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Brief updates
            </button>
            <button
              type="button"
              disabled={isExcluded}
              onClick={() => prepareAssistantPrompt(compareWithBriefPrompt(source.filename), [source.id])}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Compare with brief
            </button>
            <button
              type="button"
              disabled={isExcluded}
              onClick={() => prepareAssistantPrompt(askAboutSourcePrompt(source.filename), [source.id])}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Ask about this
            </button>
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
      </div>
    );
  }

  function renderSourcePreview() {
    if (!selectedSource) {
      return (
        <div className="hidden rounded-2xl border border-dashed border-sky-200 bg-white p-4 text-sm text-muted shadow-sm xl:block">
          <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-800">
            <FileText className="size-3.5" /> Source preview
          </div>
          <p className="mt-3">
            Select “Preview source” on a source card to inspect extracted text and run source-scoped prompts without changing the brief.
          </p>
        </div>
      );
    }
    const isSelectedSourceExcluded = excludedDocumentIds.includes(selectedSource.id);
    return (
      <div className="rounded-2xl border border-sky-200 bg-white p-4 shadow-sm">
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
            onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(selectedSource.filename), [selectedSource.id])}
            className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="size-3" /> Summarize
          </button>
          <button
            type="button"
            disabled={isSelectedSourceExcluded}
            onClick={() => prepareAssistantPrompt(compareWithBriefPrompt(selectedSource.filename), [selectedSource.id])}
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
        setActiveWorkspace("sources");
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
        setActiveWorkspace("sources");
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
        setActiveWorkspace("timeline");
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
    setActiveWorkspace("timeline");
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
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      <FileText className="size-3.5" />
                      <span>{doc.filename}</span>
                      <span className="text-muted font-normal">
                        · {formatFileSize(doc.byte_size)}
                      </span>
                      {isDocExcluded && (
                        <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-800">
                          Excluded from AI context
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={isDocExcluded}
                        onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(doc.filename), [doc.id])}
                        className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-white px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Sparkles className="size-3" /> Summarize with AI
                      </button>
                      <button
                        type="button"
                        disabled={isDocExcluded}
                        onClick={() => prepareAssistantPrompt(briefUpdatePrompt(doc.filename), [doc.id])}
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
  const cockpitSummary = buildJournalCockpitSummary(displayedReviewCandidates);

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
      setActiveWorkspace("sources");
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

  const filteredEntries = useMemo(() => {
    if (!entries) return null;
    const timelineEntries = (() => {
      if (timelineFilter === "notes") return entries.filter((e) => e.author_type === "user" && (e.documents?.length ?? 0) === 0);
      if (timelineFilter === "assistant") return entries.filter((e) => e.author_type === "assistant");
      if (timelineFilter === "documents") return entries.filter((e) => (e.documents?.length ?? 0) > 0);
      return entries;
    })();
    return journalSearchResult.isActive
      ? timelineEntries.filter((entry) => searchEntryIds.has(entry.id))
      : timelineEntries;
  }, [entries, timelineFilter, journalSearchResult.isActive, searchEntryIds]);
  const workspaceTabs: Array<{
    id: JournalWorkspace;
    label: string;
    description: string;
    count?: number;
  }> = [
    {
      id: "team",
      label: "Team Room",
      description: "General discussion",
    },
    {
      id: "timeline",
      label: "Timeline",
      description: "Canonical account history",
      count: entries?.length,
    },
    {
      id: "sources",
      label: "Sources",
      description: "Brief + uploaded evidence",
      count: totalSourceCount,
    },
    {
      id: "intelligence",
      label: "Intelligence",
      description: "Advisory AI actions",
    },
    {
      id: "review",
      label: "Review Queue",
      description: "Brief, action, decision candidates",
      count: reviewCandidates.length,
    },
  ];

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

      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700">
              Brief baseline
            </div>
            <h3 className="mt-3 text-base font-semibold text-ink">
              {briefContext.account_name}
            </h3>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Current brief priority
                </div>
                <p className="mt-1 line-clamp-3 text-sm text-slate-800">
                  {briefContext.priority_summary || "Not set yet."}
                </p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Current next action
                </div>
                <p className="mt-1 line-clamp-3 text-sm text-slate-800">
                  {briefContext.next_action || "Not set yet."}
                </p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Current brief sources
                </div>
                <p className="mt-1 text-sm text-slate-800">
                  {briefContext.sources_count} saved source{briefContext.sources_count === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <p className="mt-3 max-w-3xl text-sm text-muted">
              Use this workspace to reconcile new journal evidence with what the brief already says,
              then send accepted changes through the main brief chat or brief editor.
            </p>
          </div>
          {onViewBriefBaseline && (
            <button
              type="button"
              onClick={onViewBriefBaseline}
              className="shrink-0 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              View brief baseline first
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      )}

      {loading && !entries && (
        <div className="text-sm text-muted">Loading journal…</div>
      )}

      <div className="mb-4 grid gap-2 rounded-2xl border border-[var(--line)] bg-white p-2 shadow-sm md:grid-cols-5">
        {workspaceTabs.map((tab) => {
          const active = activeWorkspace === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveWorkspace(tab.id)}
              aria-pressed={active}
              className={`rounded-xl px-3 py-2 text-left transition ${
                active
                  ? "bg-ink text-white shadow-sm"
                  : "text-ink hover:bg-slate-50"
              }`}
            >
              <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                {tab.label}
                {tab.count !== undefined && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      active ? "bg-white/15 text-white" : "bg-slate-100 text-muted"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </span>
              <span className={`mt-0.5 block text-xs ${active ? "text-white/75" : "text-muted"}`}>
                {tab.description}
              </span>
            </button>
          );
        })}
      </div>

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

      {renderCitationContext()}

      {activeWorkspace === "intelligence" && (
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

          <div className="rounded-2xl border border-indigo-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                  Reviewed account signals
                </div>
                <h3 className="mt-1 text-base font-semibold text-ink">Account Intelligence Cockpit</h3>
                <p className="mt-1 max-w-3xl text-sm text-muted">
                  First-pass cockpit cards are derived only from review candidates that are accepted, sent to brief chat, or applied. New, reviewing, and dismissed cards remain in the Review Queue until a human promotes them.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2">
                  <div className="text-lg font-semibold text-indigo-900">{cockpitSummary.reviewedCount}</div>
                  <div className="text-indigo-700">reviewed</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-lg font-semibold text-slate-800">{cockpitSummary.pendingCount}</div>
                  <div className="text-muted">pending</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-lg font-semibold text-slate-800">{cockpitSummary.dismissedCount}</div>
                  <div className="text-muted">dismissed</div>
                </div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-4">
              {STRUCTURED_REVIEW_BOARDS.map((board) => {
                const reviewedCards = cockpitSummary.cardsByType[board.type];
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
              {cockpitSummary.priorityCards.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-muted">
                  No accepted, sent, or applied review candidates yet. Promote reviewed cards from the Review Queue to seed cockpit intelligence.
                </div>
              ) : (
                cockpitSummary.priorityCards.map((card) => (
                  <div key={card.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{card.title}</span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs text-muted">{candidateStatusLabels[card.status]}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-muted">{card.proposed_text}</p>
                    {card.evidence && <p className="mt-2 text-xs text-slate-600">Evidence: {card.evidence}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {activeWorkspace === "review" && (
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
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Full Review Queue</h3>
              <span className="text-xs text-muted">
                Same human-review cards, shown ungrouped for status changes and brief-chat handoff.
              </span>
            </div>
            {displayedReviewCandidates.length === 0 ? (
              <div className="rounded-xl border border-dashed border-amber-200 bg-white p-6 text-sm text-muted">
                {journalSearchResult.isActive
                  ? "No review candidate cards match this search. Clear search to see the full Review Queue."
                  : "No review candidate cards yet. Use the assistant actions above to draft candidates, then save the reviewed items here for team follow-up."}
              </div>
            ) : (
              displayedReviewCandidates.map((candidate) => renderReviewCandidate(candidate))
            )}
          </div>
        </div>
      )}

      {activeWorkspace === "sources" && (
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
              <div className="mt-3 rounded-xl border border-dashed border-[var(--line)] bg-white p-6 text-sm text-muted">
                No uploaded sources yet. Choose a document in the composer below to
                make extracted evidence available to the Journal assistant.
              </div>
            ) : displayedSources.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-[var(--line)] bg-white p-6 text-sm text-muted">
                No uploaded sources match this search. Clear search to see all uploaded sources.
              </div>
            ) : (
              <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="grid gap-3 xl:grid-cols-2">
                  {displayedSources.map((source) => renderSourceCard(source))}
                </div>
                {selectedPreviewMatchesSearch ? renderSourcePreview() : (
                  <div className="rounded-2xl border border-dashed border-sky-200 bg-white p-4 text-sm text-muted">
                    The selected source preview does not match this search. Clear search or open a matching source.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeWorkspace === "team" && (
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

      {activeWorkspace === "timeline" && entries && (
        <div className="mb-3 flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-2">
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
      )}

      {activeWorkspace === "timeline" && filteredEntries && filteredEntries.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-white p-6 text-sm text-muted">
          {entries?.length === 0
            ? "No journal entries yet. Add a note, upload a document, or switch to Ask assistant to ask a question grounded in this brief."
            : journalSearchResult.isActive
              ? "No Timeline entries match this search. Clear search or try another query."
              : "No entries match this Timeline filter."}
        </div>
      )}

      {activeWorkspace === "timeline" && filteredEntries && filteredEntries.map((e) => renderEntry(e))}

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
