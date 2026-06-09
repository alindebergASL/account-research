import { createHash } from "node:crypto";

import { db, type JournalCockpitReadModelRow } from "@/lib/db";
import {
  REVIEWED_COCKPIT_STATUSES,
  type JournalCockpitCandidate,
  type JournalCockpitCandidateStatus,
  type JournalCockpitCandidateType,
} from "@/lib/journalCockpitSummary";

export const JOURNAL_COCKPIT_READ_MODEL_VERSION = 1;

export type JournalCockpitReadModelInvalidation = {
  briefUpdatedAt?: number | null;
  latestJournalEntryAt?: number | null;
  latestSourceUpdatedAt?: number | null;
  journalEntryFingerprint?: string | null;
  sourceFingerprint?: string | null;
};

export type JournalCockpitReadModelItem = {
  candidate_id: string;
  type: JournalCockpitCandidateType;
  status: JournalCockpitCandidateStatus;
  title: string;
  text: string;
  target: string | null;
  current_baseline: string | null;
  evidence: string | null;
  confidence: string | null;
  risk: string | null;
  source_entry_id: string | null;
  created_at: number;
  updated_at: number;
};

export type JournalCockpitReadModelSections = {
  brief_updates: JournalCockpitReadModelItem[];
  actions: JournalCockpitReadModelItem[];
  decisions: JournalCockpitReadModelItem[];
  open_questions: JournalCockpitReadModelItem[];
};

export type JournalCockpitReadModel = {
  schema_version: number;
  brief_id: string;
  generated_at: number;
  source_fingerprint: string;
  invalidation: Required<JournalCockpitReadModelInvalidation>;
  reviewed_candidate_ids: string[];
  advisory_counts: {
    pending: number;
    dismissed: number;
  };
  sections: JournalCockpitReadModelSections;
};

const REVIEWED = new Set<JournalCockpitCandidateStatus>(REVIEWED_COCKPIT_STATUSES);
const EMPTY_INVALIDATION: Required<JournalCockpitReadModelInvalidation> = {
  briefUpdatedAt: null,
  latestJournalEntryAt: null,
  latestSourceUpdatedAt: null,
  journalEntryFingerprint: null,
  sourceFingerprint: null,
};

function byMostRecent(a: JournalCockpitCandidate, b: JournalCockpitCandidate): number {
  return b.updated_at - a.updated_at || b.created_at - a.created_at || a.id.localeCompare(b.id);
}

function itemFromCandidate(candidate: JournalCockpitCandidate): JournalCockpitReadModelItem {
  return {
    candidate_id: candidate.id,
    type: candidate.candidate_type,
    status: candidate.status,
    title: candidate.title,
    text: candidate.proposed_text,
    target: candidate.target ?? null,
    current_baseline: candidate.current_baseline ?? null,
    evidence: candidate.evidence ?? null,
    confidence: candidate.confidence ?? null,
    risk: candidate.risk ?? null,
    source_entry_id: candidate.source_entry_id ?? null,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
}

function emptySections(): JournalCockpitReadModelSections {
  return {
    brief_updates: [],
    actions: [],
    decisions: [],
    open_questions: [],
  };
}

function sectionKey(type: JournalCockpitCandidateType): keyof JournalCockpitReadModelSections {
  if (type === "brief_update") return "brief_updates";
  if (type === "action_item") return "actions";
  if (type === "decision") return "decisions";
  return "open_questions";
}

function fingerprint(input: {
  briefId: string;
  candidates: JournalCockpitCandidate[];
  invalidation: Required<JournalCockpitReadModelInvalidation>;
}): string {
  const candidateInputs = input.candidates
    .filter((candidate) =>
      REVIEWED.has(candidate.status)
      || candidate.status === "new"
      || candidate.status === "reviewing"
      || candidate.status === "dismissed",
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((candidate) => ({
      id: candidate.id,
      candidate_type: candidate.candidate_type,
      status: candidate.status,
      title: candidate.title,
      proposed_text: candidate.proposed_text,
      target: candidate.target ?? null,
      current_baseline: candidate.current_baseline ?? null,
      evidence: candidate.evidence ?? null,
      confidence: candidate.confidence ?? null,
      risk: candidate.risk ?? null,
      source_entry_id: candidate.source_entry_id ?? null,
      created_at: candidate.created_at,
      updated_at: candidate.updated_at,
    }));
  const payload = JSON.stringify({
    schema_version: JOURNAL_COCKPIT_READ_MODEL_VERSION,
    brief_id: input.briefId,
    invalidation: input.invalidation,
    candidates: candidateInputs,
  });
  const digest = createHash("sha256").update(payload).digest("hex");
  const candidateParts = candidateInputs.map(
    (candidate) => `candidate:${candidate.id}:${candidate.status}:${candidate.updated_at}`,
  );
  return [
    `schema:${JOURNAL_COCKPIT_READ_MODEL_VERSION}`,
    `brief:${input.briefId}:${input.invalidation.briefUpdatedAt ?? "none"}`,
    `journal:${input.invalidation.latestJournalEntryAt ?? "none"}`,
    `source:${input.invalidation.latestSourceUpdatedAt ?? "none"}`,
    `sha256:${digest}`,
    ...candidateParts,
  ].join("|");
}

export function buildJournalCockpitReadModel(args: {
  briefId: string;
  candidates: JournalCockpitCandidate[];
  generatedAt?: number;
  invalidation?: JournalCockpitReadModelInvalidation;
}): JournalCockpitReadModel {
  const generatedAt = args.generatedAt ?? Date.now();
  const invalidation = { ...EMPTY_INVALIDATION, ...(args.invalidation ?? {}) };
  const reviewedCandidates = args.candidates.filter((candidate) => REVIEWED.has(candidate.status)).sort(byMostRecent);
  const sections = emptySections();
  for (const candidate of reviewedCandidates) {
    sections[sectionKey(candidate.candidate_type)].push(itemFromCandidate(candidate));
  }

  return {
    schema_version: JOURNAL_COCKPIT_READ_MODEL_VERSION,
    brief_id: args.briefId,
    generated_at: generatedAt,
    source_fingerprint: fingerprint({ briefId: args.briefId, candidates: args.candidates, invalidation }),
    invalidation,
    reviewed_candidate_ids: reviewedCandidates.map((candidate) => candidate.id),
    advisory_counts: {
      pending: args.candidates.filter((candidate) => candidate.status === "new" || candidate.status === "reviewing").length,
      dismissed: args.candidates.filter((candidate) => candidate.status === "dismissed").length,
    },
    sections,
  };
}

export function saveJournalCockpitReadModel(model: JournalCockpitReadModel): void {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO journal_cockpit_read_models
         (brief_id, schema_version, source_fingerprint, model_json, generated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(brief_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         source_fingerprint = excluded.source_fingerprint,
         model_json = excluded.model_json,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      model.brief_id,
      model.schema_version,
      model.source_fingerprint,
      JSON.stringify(model),
      model.generated_at,
      now,
    );
}

function parseModel(row: JournalCockpitReadModelRow): JournalCockpitReadModel | null {
  try {
    const parsed = JSON.parse(row.model_json) as JournalCockpitReadModel;
    if (parsed.schema_version !== JOURNAL_COCKPIT_READ_MODEL_VERSION) return null;
    if (parsed.brief_id !== row.brief_id) return null;
    if (parsed.source_fingerprint !== row.source_fingerprint) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadJournalCockpitReadModel(briefId: string): JournalCockpitReadModel | null {
  const row = db()
    .prepare(`SELECT * FROM journal_cockpit_read_models WHERE brief_id = ?`)
    .get(briefId) as JournalCockpitReadModelRow | undefined;
  return row ? parseModel(row) : null;
}
