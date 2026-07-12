import {
  JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION,
  isJournalRadarManifest,
  type JournalRadarManifest,
} from "./journalRadarManifest";

export type JournalRadarDestination = {
  workspace: "timeline" | "sources" | "review" | "tasks" | "decisions";
  hash: string | null;
  review_tab?: "pending" | "history";
};

export type JournalRadarChangeItem = {
  key: string;
  id: string;
  label: string;
  changed_fields: string[];
  destination: JournalRadarDestination;
};

export type JournalRadarBucket = { count: number; items: JournalRadarChangeItem[] };
export type JournalRadarBuckets = {
  new_entries: JournalRadarBucket;
  edited_entries: JournalRadarBucket;
  removed_entries: JournalRadarBucket;
  source_changes: JournalRadarBucket;
  candidates_awaiting_review: JournalRadarBucket;
  candidate_status_transitions: JournalRadarBucket;
  new_tasks: JournalRadarBucket;
  completed_tasks: JournalRadarBucket;
  removed_tasks: JournalRadarBucket;
  task_detail_changes: JournalRadarBucket;
  new_decisions: JournalRadarBucket;
  decision_lifecycle_changes: JournalRadarBucket;
  brief_version_changes: JournalRadarBucket;
  monitor_updates: JournalRadarBucket;
};

export type JournalRadarReviewState = {
  state: "no_checkpoint" | "unchanged" | "changes";
  no_checkpoint_reason: "missing" | "incompatible" | null;
  reviewed_at: number | null;
  total_changes: number;
  buckets: JournalRadarBuckets;
};

const bucket = (): JournalRadarBucket => ({ count: 0, items: [] });
export function emptyJournalRadarBuckets(): JournalRadarBuckets {
  return {
    new_entries: bucket(), edited_entries: bucket(), removed_entries: bucket(),
    source_changes: bucket(), candidates_awaiting_review: bucket(),
    candidate_status_transitions: bucket(), new_tasks: bucket(), completed_tasks: bucket(),
    removed_tasks: bucket(), task_detail_changes: bucket(), new_decisions: bucket(),
    decision_lifecycle_changes: bucket(), brief_version_changes: bucket(), monitor_updates: bucket(),
  };
}

export function totalJournalRadarChanges(buckets: JournalRadarBuckets): number {
  return Object.values(buckets).reduce((sum, value) => sum + value.count, 0);
}

function add(target: JournalRadarBucket, item: JournalRadarChangeItem) {
  target.items.push(item);
  target.items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  target.count = target.items.length;
}

const timeline = (id: string): JournalRadarDestination => ({ workspace: "timeline", hash: `journal-entry-${id}` });
const sources = (): JournalRadarDestination => ({ workspace: "sources", hash: null });
const review = (pending: boolean): JournalRadarDestination => ({ workspace: "review", hash: null, review_tab: pending ? "pending" : "history" });
const tasks = (id: string): JournalRadarDestination => ({ workspace: "tasks", hash: `journal-task-${id}` });
const decisions = (id: string): JournalRadarDestination => ({ workspace: "decisions", hash: `journal-decision-${id}` });

function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}
function changed<T extends object>(before: T, after: T, fields: Array<keyof T>): string[] {
  return fields.filter((field) => before[field] !== after[field]).map(String);
}
function pending(status: string, deletedAt: number | null): boolean {
  return deletedAt === null && (status === "new" || status === "reviewing");
}

export function compareJournalRadarManifests(input: {
  checkpoint: unknown;
  current: JournalRadarManifest;
  reviewedAt: number | null;
  noCheckpointReason?: "missing" | "incompatible";
}): JournalRadarReviewState {
  const buckets = emptyJournalRadarBuckets();
  if (!isJournalRadarManifest(input.checkpoint)) {
    return {
      state: "no_checkpoint",
      no_checkpoint_reason: input.noCheckpointReason ?? (input.checkpoint === null ? "missing" : "incompatible"),
      reviewed_at: null,
      total_changes: 0,
      buckets,
    };
  }
  if (input.checkpoint.schema_version !== JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION || input.current.schema_version !== JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION) {
    return { state: "no_checkpoint", no_checkpoint_reason: "incompatible", reviewed_at: null, total_changes: 0, buckets };
  }

  const beforeEntries = indexById(input.checkpoint.entries);
  for (const row of input.current.entries) {
    const before = beforeEntries.get(row.id);
    if (!before) {
      if (row.deleted_at === null) add(buckets.new_entries, { key: row.id, id: row.id, label: "New Journal entry", changed_fields: ["created_at"], destination: timeline(row.id) });
      else add(buckets.removed_entries, { key: row.id, id: row.id, label: "Journal entry added, then removed", changed_fields: ["created_at", "deleted_at"], destination: { workspace: "timeline", hash: null } });
    } else if (before.deleted_at === null && row.deleted_at !== null) {
      add(buckets.removed_entries, { key: row.id, id: row.id, label: "Journal entry removed", changed_fields: ["deleted_at"], destination: { workspace: "timeline", hash: null } });
    } else if (row.deleted_at === null && (before.content_hash !== row.content_hash || before.edited_at !== row.edited_at)) {
      add(buckets.edited_entries, { key: row.id, id: row.id, label: "Journal entry edited", changed_fields: changed(before, row, ["content_hash", "edited_at"]), destination: timeline(row.id) });
    }
  }

  const beforeDocuments = indexById(input.checkpoint.documents);
  for (const row of input.current.documents) {
    const before = beforeDocuments.get(row.id);
    if (!before) {
      add(buckets.source_changes, { key: `added:${row.id}`, id: row.id, label: row.effectively_removed_at === null ? "Source added" : "Source added under a removed entry", changed_fields: ["created_at"], destination: sources() });
      continue;
    }
    const fields = changed(before, row, ["journal_entry_id", "filename_hash", "mime_type", "byte_size", "content_hash", "source_url_hash", "effectively_removed_at"]);
    if (fields.length) {
      const removal = before.effectively_removed_at === null && row.effectively_removed_at !== null;
      add(buckets.source_changes, { key: `changed:${row.id}`, id: row.id, label: removal ? "Source removed with its Journal entry" : "Source metadata changed", changed_fields: fields, destination: sources() });
    }
  }
  const currentDocuments = indexById(input.current.documents);
  for (const row of input.checkpoint.documents) {
    if (!currentDocuments.has(row.id)) add(buckets.source_changes, {
      key: `removed:${row.id}`, id: row.id, label: "Source removed",
      changed_fields: ["removed"], destination: sources(),
    });
  }

  const beforeCandidates = indexById(input.checkpoint.candidates);
  for (const row of input.current.candidates) {
    const before = beforeCandidates.get(row.id);
    if (!before) {
      if (pending(row.status, row.deleted_at)) add(buckets.candidates_awaiting_review, { key: row.id, id: row.id, label: "Candidate awaiting review", changed_fields: ["created_at"], destination: review(true) });
      else add(buckets.candidate_status_transitions, { key: row.id, id: row.id, label: row.deleted_at !== null ? "Review candidate added, then removed" : "Review candidate added to history", changed_fields: ["created_at", "status", ...(row.deleted_at !== null ? ["deleted_at"] : [])], destination: review(false) });
      continue;
    }
    const fields = changed(before, row, ["status", "deleted_at"]);
    if (fields.length) add(buckets.candidate_status_transitions, { key: row.id, id: row.id, label: row.deleted_at !== null ? "Review candidate removed" : "Review candidate status changed", changed_fields: fields, destination: review(pending(row.status, row.deleted_at)) });
  }

  const beforeTasks = indexById(input.checkpoint.tasks);
  for (const row of input.current.tasks) {
    const before = beforeTasks.get(row.id);
    if (!before) {
      if (row.deleted_at === null) {
        add(buckets.new_tasks, { key: row.id, id: row.id, label: "New to-do", changed_fields: ["created_at"], destination: tasks(row.id) });
        if (row.done) add(buckets.completed_tasks, { key: row.id, id: row.id, label: "New to-do completed", changed_fields: ["done", "done_at"], destination: tasks(row.id) });
      } else add(buckets.removed_tasks, { key: row.id, id: row.id, label: "To-do added, then removed", changed_fields: ["created_at", "deleted_at"], destination: { workspace: "tasks", hash: null } });
      continue;
    }
    if (before.deleted_at === null && row.deleted_at !== null) {
      add(buckets.removed_tasks, { key: row.id, id: row.id, label: "To-do removed", changed_fields: ["deleted_at"], destination: { workspace: "tasks", hash: null } });
      continue;
    }
    if (row.deleted_at !== null) continue;
    if (before.done !== row.done || before.done_at !== row.done_at) add(buckets.completed_tasks, { key: row.id, id: row.id, label: row.done ? "To-do completed" : "To-do reopened", changed_fields: changed(before, row, ["done", "done_at"]), destination: tasks(row.id) });
    const fields = changed(before, row, ["owner_text_hash", "assignee_user_id", "priority", "due_at", "content_hash"]);
    if (fields.length) add(buckets.task_detail_changes, { key: row.id, id: row.id, label: "To-do details changed", changed_fields: fields, destination: tasks(row.id) });
  }

  const beforeDecisions = indexById(input.checkpoint.decisions);
  for (const row of input.current.decisions) {
    const before = beforeDecisions.get(row.id);
    if (!before) {
      if (row.deleted_at === null) {
        add(buckets.new_decisions, { key: row.id, id: row.id, label: "New decision", changed_fields: ["created_at"], destination: decisions(row.id) });
        if (row.lifecycle !== "active" || row.supersedes_id !== null || row.superseded_by_id !== null) add(buckets.decision_lifecycle_changes, { key: row.id, id: row.id, label: row.lifecycle === "revoked" ? "New decision revoked" : row.lifecycle === "superseded" ? "New decision superseded" : "New decision linkage changed", changed_fields: ["lifecycle", "supersedes_id", "superseded_by_id"], destination: decisions(row.id) });
      } else add(buckets.decision_lifecycle_changes, { key: row.id, id: row.id, label: "Decision added, then removed", changed_fields: ["created_at", "deleted_at"], destination: { workspace: "decisions", hash: null } });
      continue;
    }
    const fields = changed(before, row, ["deleted_at", "lifecycle", "supersedes_id", "superseded_by_id", "owner_text_hash", "decision_at", "content_hash", "updated_at"]);
    if (fields.length) add(buckets.decision_lifecycle_changes, { key: row.id, id: row.id, label: row.deleted_at !== null ? "Decision removed" : row.lifecycle === "revoked" ? "Decision revoked" : row.lifecycle === "superseded" ? "Decision superseded" : "Decision record changed", changed_fields: fields, destination: row.deleted_at !== null ? { workspace: "decisions", hash: null } : decisions(row.id) });
  }

  const beforeVersions = indexById(input.checkpoint.brief_versions);
  for (const row of input.current.brief_versions) if (!beforeVersions.has(row.id)) add(buckets.brief_version_changes, { key: row.id, id: row.id, label: `Brief version ${row.version_no} saved`, changed_fields: ["created_at"], destination: { workspace: "timeline", hash: null } });
  const beforeMonitors = indexById(input.checkpoint.monitor_updates);
  for (const row of input.current.monitor_updates) if (!beforeMonitors.has(row.id)) add(buckets.monitor_updates, { key: row.id, id: row.id, label: "Monitor applied an update", changed_fields: ["ran_at"], destination: { workspace: "timeline", hash: null } });

  const total = totalJournalRadarChanges(buckets);
  return { state: total === 0 ? "unchanged" : "changes", no_checkpoint_reason: null, reviewed_at: input.reviewedAt, total_changes: total, buckets };
}
