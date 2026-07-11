// Shared types for the Journal section. Extracted verbatim from
// JournalSection.tsx during the cockpit decomposition (behavior-preserving).
import type { JournalCockpitReadModelItem } from "@/lib/journalCockpitReadModel";

export type Author = {
  id: string;
  display_name: string | null;
  email: string;
};

// Mirrors JournalMentionDto (web/lib/journalMentions.ts) — the brief members
// @mentioned in an entry, surfaced for highlight rendering.
export type EntryMention = {
  user_id: string;
  display_name: string | null;
  email: string;
};

// A brief member who can be @mentioned, as returned by the members endpoint
// for the composer autocomplete. `handle` is the canonical token to insert.
export type BriefMemberOption = {
  id: string;
  display_name: string | null;
  email: string;
  handle: string;
};

export type JournalDocument = {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  created_at: number;
  content_preview: string;
  source_url: string | null;
  // True when the original uploaded bytes are stored and can be viewed/downloaded.
  has_original?: boolean;
};

export type Entry = {
  id: string;
  author_type: "user" | "assistant";
  body: string | null;
  reply_to: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  author: Author | null;
  documents?: JournalDocument[];
  pinned_at?: number | null;
  tags?: string[];
  mentions?: EntryMention[];
};

// Curated journal entry tags (mirrors web/lib/journalEntryTags.ts). Label map
// keeps the UI human-readable; values must match the server's allowlist.
export const JOURNAL_TAG_VALUES = [
  "decision",
  "risk",
  "follow_up",
  "question",
  "idea",
] as const;
export const JOURNAL_TAG_LABELS: Record<string, string> = {
  decision: "Decision",
  risk: "Risk",
  follow_up: "Follow-up",
  question: "Question",
  idea: "Idea",
};

export type JournalWorkspace =
  | "timeline"
  | "sources"
  | "tasks"
  | "intelligence"
  | "review"
  | "team";
export type TimelineFilter = "all" | "notes" | "assistant" | "documents";

export type JournalSource = JournalDocument & {
  entryId: string;
  entryAuthor: string;
  entryBody: string | null;
  entryCreatedAt: number;
};

export type SourceHealthStatus =
  | "current"
  | "stale"
  | "duplicate"
  | "superseded"
  | "conflicting";

export type JournalBriefContext = {
  account_name: string;
  priority_summary: string;
  next_action: string;
  sources_count: number;
  sources: Array<{ title: string; url: string; accessed: string }>;
};

export type ReviewCandidateType =
  | "brief_update"
  | "action_item"
  | "decision"
  | "open_question";
export type ReviewCandidateStatus =
  | "new"
  | "reviewing"
  | "accepted"
  | "sent_to_brief_chat"
  | "applied"
  | "dismissed";

export type ReviewCandidate = {
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

export type CockpitDisplay = {
  reviewedCount: number;
  pendingCount: number;
  dismissedCount: number;
  refreshedAt: number | null;
  cardsByType: Record<ReviewCandidateType, JournalCockpitReadModelItem[]>;
  priorityCards: JournalCockpitReadModelItem[];
};

export type SelectedCitationContext =
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

export type IntelligenceAction = {
  label: string;
  description: string;
  prompt: string;
  primary?: boolean;
};
