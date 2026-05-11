import { db, type BriefEventRow } from "./db";
import { newId } from "./password";

export type ActorType = "user" | "worker" | "system" | "hermes";

export type CreateBriefEventInput = {
  brief_id?: string | null;
  job_id?: string | null;
  actor_user_id?: string | null;
  actor_type?: ActorType;
  event_type: string;
  title: string;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type BriefEvent = {
  id: string;
  brief_id: string | null;
  job_id: string | null;
  actor_user_id: string | null;
  actor_type: ActorType;
  event_type: string;
  title: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
};

// Keys that must never appear in metadata, regardless of nesting depth.
// Broad on purpose: catches `prompt`, `messages`, `content`, secrets, tokens,
// cookies, sessions. Audit-trail metadata should be IDs, counts, enums, and
// short labels — not free text.
const FORBIDDEN_KEY =
  /password|secret|token|api[_-]?key|authorization|cookie|session|bearer|prompt|message|messages|completion|content/i;

const MAX_DEPTH = 4;
const MAX_SERIALIZED_BYTES = 8 * 1024;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    try {
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return "[unserializable]";
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function sanitizeEventMetadata(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!raw) return null;
  const cleaned = sanitizeValue(raw, 0) as Record<string, unknown>;
  let serialized: string;
  try {
    serialized = JSON.stringify(cleaned);
  } catch {
    return { truncated: true, original_keys: Object.keys(raw) };
  }
  if (serialized.length > MAX_SERIALIZED_BYTES) {
    return { truncated: true, original_keys: Object.keys(raw) };
  }
  return cleaned;
}

// Fire-and-forget. NEVER throws. Call sites must not need try/catch.
export function createBriefEvent(input: CreateBriefEventInput): void {
  try {
    const id = newId();
    const cleaned = input.metadata
      ? sanitizeEventMetadata(input.metadata)
      : null;
    const metadataJson = cleaned ? JSON.stringify(cleaned) : null;
    db()
      .prepare(
        `INSERT INTO brief_events
         (id, brief_id, job_id, actor_user_id, actor_type, event_type, title, summary, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.brief_id ?? null,
        input.job_id ?? null,
        input.actor_user_id ?? null,
        input.actor_type ?? "user",
        input.event_type,
        input.title,
        input.summary ?? null,
        metadataJson,
        Date.now(),
      );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[brief_events] insert failed", err);
  }
}

function rowToEvent(r: BriefEventRow): BriefEvent {
  let metadata: Record<string, unknown> | null = null;
  if (r.metadata_json) {
    try {
      metadata = JSON.parse(r.metadata_json);
    } catch {
      metadata = null;
    }
  }
  return {
    id: r.id,
    brief_id: r.brief_id,
    job_id: r.job_id,
    actor_user_id: r.actor_user_id,
    actor_type: r.actor_type,
    event_type: r.event_type,
    title: r.title,
    summary: r.summary,
    metadata,
    created_at: r.created_at,
  };
}

export function listBriefEventsForBrief(
  briefId: string,
  limit = 50,
): BriefEvent[] {
  try {
    const rows = db()
      .prepare(
        `SELECT * FROM brief_events
         WHERE brief_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(briefId, limit) as BriefEventRow[];
    return rows.map(rowToEvent);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[brief_events] list failed", err);
    return [];
  }
}

// ---- convenience wrappers --------------------------------------------------

export function logBriefCreated(p: {
  briefId: string;
  jobId: string;
  actorUserId: string;
  accountName: string;
  mode: string;
  costCents: number | null;
  sourceCount?: number;
}) {
  createBriefEvent({
    brief_id: p.briefId,
    job_id: p.jobId,
    actor_user_id: p.actorUserId,
    actor_type: "worker",
    event_type: "brief_created",
    title: `Brief created for ${p.accountName}`,
    summary: `Mode: ${p.mode}`,
    metadata: {
      account_name: p.accountName,
      mode: p.mode,
      cost_cents: p.costCents,
      source_count: p.sourceCount ?? null,
    },
  });
}

export function logJobCompleted(p: {
  briefId: string | null;
  jobId: string;
  actorUserId: string;
  accountName: string;
  mode: string;
  intent: "create" | "refresh";
  costCents: number | null;
}) {
  createBriefEvent({
    brief_id: p.briefId,
    job_id: p.jobId,
    actor_user_id: p.actorUserId,
    actor_type: "worker",
    event_type: "job_completed",
    title: `Research job completed (${p.intent})`,
    summary: `Account: ${p.accountName} · mode: ${p.mode}`,
    metadata: {
      intent: p.intent,
      mode: p.mode,
      cost_cents: p.costCents,
    },
  });
}

export function logBriefRefreshed(p: {
  briefId: string;
  jobId: string;
  actorUserId: string;
  mode: string;
  costCents: number | null;
  preRefreshVersionId: string | null;
  previouslyFoundAdded?: number;
}) {
  createBriefEvent({
    brief_id: p.briefId,
    job_id: p.jobId,
    actor_user_id: p.actorUserId,
    actor_type: "worker",
    event_type: "refresh_completed",
    title: "Brief refreshed",
    summary: `Mode: ${p.mode}`,
    metadata: {
      mode: p.mode,
      cost_cents: p.costCents,
      pre_refresh_version_id: p.preRefreshVersionId,
      previously_found_added: p.previouslyFoundAdded ?? null,
    },
  });
}

export function logBriefVersionSnapshot(p: {
  briefId: string;
  versionId: string;
  versionNo: number;
  reason: string;
  refreshJobId: string | null;
  actorUserId: string;
  actorType?: ActorType;
}) {
  createBriefEvent({
    brief_id: p.briefId,
    job_id: p.refreshJobId,
    actor_user_id: p.actorUserId,
    actor_type: p.actorType ?? "worker",
    event_type: "version_snapshot_created",
    title: `Version v${p.versionNo} snapshot`,
    summary: `Reason: ${p.reason}`,
    metadata: {
      version_id: p.versionId,
      version_no: p.versionNo,
      reason: p.reason,
      refresh_job_id: p.refreshJobId,
    },
  });
}

export function logBriefReverted(p: {
  briefId: string;
  revertedFromVersionId: string;
  preRevertVersionId: string;
  actorUserId: string;
}) {
  createBriefEvent({
    brief_id: p.briefId,
    actor_user_id: p.actorUserId,
    actor_type: "user",
    event_type: "version_reverted",
    title: "Brief reverted to previous version",
    metadata: {
      reverted_from_version_id: p.revertedFromVersionId,
      pre_revert_version_id: p.preRevertVersionId,
    },
  });
}

export function logChatPatchedBrief(p: {
  briefId: string;
  actorUserId: string;
  patchesApplied: number;
  patchErrors: number;
  touchedFields: string[];
}) {
  createBriefEvent({
    brief_id: p.briefId,
    actor_user_id: p.actorUserId,
    actor_type: "user",
    event_type: "chat_patch",
    title: "Chat updated brief",
    summary: `${p.patchesApplied} patch(es) applied to: ${p.touchedFields.join(", ") || "(none)"}`,
    metadata: {
      patches_applied: p.patchesApplied,
      patch_errors_count: p.patchErrors,
      touched_fields: p.touchedFields,
    },
  });
}
