// Pure helpers for the Journal section. Extracted verbatim from
// JournalSection.tsx (behavior-preserving). No JSX, no component state.
import type {
  JournalCockpitReadModel,
  JournalCockpitReadModelItem,
} from "@/lib/journalCockpitReadModel";
import { findSourceLegendBlockStart } from "@/lib/journalSourceLegend";
import type {
  CockpitDisplay,
  Entry,
  JournalSource,
  ReviewCandidate,
  ReviewCandidateType,
  SourceHealthStatus,
} from "./types";

export function groupReviewCandidatesByType(
  candidates: ReviewCandidate[],
): Record<ReviewCandidateType, ReviewCandidate[]> {
  return {
    brief_update: candidates.filter((candidate) => candidate.candidate_type === "brief_update"),
    action_item: candidates.filter((candidate) => candidate.candidate_type === "action_item"),
    decision: candidates.filter((candidate) => candidate.candidate_type === "decision"),
    open_question: candidates.filter((candidate) => candidate.candidate_type === "open_question"),
  };
}

export function emptyCockpitCards(): Record<ReviewCandidateType, JournalCockpitReadModelItem[]> {
  return {
    brief_update: [],
    action_item: [],
    decision: [],
    open_question: [],
  };
}

export function cockpitDisplayFromModel(model: JournalCockpitReadModel | null): CockpitDisplay {
  if (!model) {
    return {
      reviewedCount: 0,
      pendingCount: 0,
      dismissedCount: 0,
      refreshedAt: null,
      cardsByType: emptyCockpitCards(),
      priorityCards: [],
    };
  }
  const cardsByType: Record<ReviewCandidateType, JournalCockpitReadModelItem[]> = {
    brief_update: model.sections.brief_updates,
    action_item: model.sections.actions,
    decision: model.sections.decisions,
    open_question: model.sections.open_questions,
  };
  return {
    reviewedCount: model.reviewed_candidate_ids.length,
    pendingCount: model.advisory_counts.pending,
    dismissedCount: model.advisory_counts.dismissed,
    refreshedAt: model.generated_at,
    cardsByType,
    priorityCards: [
      ...cardsByType.action_item,
      ...cardsByType.decision,
      ...cardsByType.open_question,
      ...cardsByType.brief_update,
    ].sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at || a.candidate_id.localeCompare(b.candidate_id)).slice(0, 6),
  };
}

export function relativeTime(ts: number): string {
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

export function authorName(e: Entry): string {
  if (e.author_type === "assistant") return "Assistant";
  return e.author?.display_name || e.author?.email || "Unknown";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.ceil(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function documentIdSnapshotKey(ids: string[]): string {
  return Array.from(new Set(ids)).sort().join("\u0000");
}

export function summarizeDocumentPrompt(filename: string): string {
  return `Summarize the uploaded document "${filename}" for this account. Call out: 1) what changed or is being requested, 2) why it matters for the account brief, and 3) recommended next actions. Use the document as evidence and name it in your answer.`;
}

export function briefUpdatePrompt(filename: string): string {
  return `Review the uploaded document "${filename}" and tell me what should be added or changed in the account brief. Be specific about fields or sections, and cite the uploaded document by filename.`;
}

export function compareWithBriefPrompt(filename: string): string {
  return `Compare the uploaded document "${filename}" with the current account brief. Identify supported updates, contradictions, stale assumptions, and open questions. Cite the document by filename and do not claim you edited the brief.`;
}

export function askAboutSourcePrompt(filename: string): string {
  return `Answer questions using the uploaded document "${filename}" as the primary source. Start with a concise summary of what this source is useful for, then list the highest-value questions the account team should ask next. Cite the document by filename.`;
}

export function trustedLegendStart(entry: Entry): number {
  if (entry.author_type !== "assistant" || !entry.reply_to || !entry.body) {
    return -1;
  }
  return findSourceLegendBlockStart(entry.body);
}

export function extractCitationLabels(entry: Entry): string[] {
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

export function displayEntryBody(entry: Entry): string | null {
  const legendStart = trustedLegendStart(entry);
  const base =
    legendStart < 0 || !entry.body
      ? entry.body
      : entry.body.slice(0, legendStart).trimEnd();
  if (!base) return base;
  // Defensive: never surface raw source-legend metadata comments as body text.
  return base.replace(/<!--\s*JOURNAL_SOURCE_LEGEND:[\s\S]*?-->/g, "").trim();
}

export function collectJournalSources(entries: Entry[] | null): JournalSource[] {
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

export function sourceFingerprint(source: JournalSource): string {
  return `${source.filename.trim().toLowerCase()}::${source.byte_size}`;
}

export function sourceHealthBadges(
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
