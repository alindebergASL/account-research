// Hermes job + event persistence helpers.
//
// These helpers are the single write path for `hermes_jobs` and
// `hermes_job_events`. They enforce:
//   - transactional per-job sequence numbers (no gaps from races)
//   - aggressive sanitization of any caller-provided payload / error
//     string (no bearer tokens, no API keys, no Cookie headers, no
//     set-cookie values, no ANSI escapes)
//   - a hard cap on event list size regardless of caller-passed limit
//
// Public read API consumers (`web/app/api/briefs/[id]/hermes-events`)
// re-sanitize before returning, but writers MUST also sanitize so the
// at-rest DB never contains secrets even if the read path is bypassed.
import { db, type HermesJobEventRow } from "../db";
import { newId } from "../password";
import type {
  HermesEventKind,
  HermesJobEvent,
  HermesJobKind,
  HermesJobStatus,
} from "./types";

// Hard ceiling on `listHermesEventsForBrief` regardless of caller-passed
// limit. Keeps a single brief's history bounded for SSE / polling.
export const MAX_EVENT_LIMIT = 200;

const MAX_ERROR_BYTES = 4096;
const MAX_PAYLOAD_BYTES = 16 * 1024;

// Strip ANSI escape sequences ("\x1b[...m" etc.) — they're noise in a DB
// and can carry weird control bytes into log viewers.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// Token-shaped substring patterns. We replace with a constant marker so
// the surrounding context remains debuggable but the secret material is
// gone. Patterns are intentionally broad; false positives are acceptable
// since this is operator-debug telemetry, not user-facing copy.
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9._\-]+/gi, replacement: "Bearer [redacted]" },
  { re: /sk-[A-Za-z0-9\-_]{20,}/g, replacement: "[redacted-api-key]" },
  // Header lines for Cookie / Set-Cookie / Authorization. Match up to end
  // of line so we drop the whole header value, not just the name.
  { re: /Cookie:[^\n\r]*/gi, replacement: "Cookie: [redacted]" },
  { re: /set-cookie:[^\n\r]*/gi, replacement: "set-cookie: [redacted]" },
  { re: /authorization:[^\n\r]*/gi, replacement: "authorization: [redacted]" },
];

// Object keys that must NEVER survive sanitization regardless of value.
// Keep these in lockstep with the read-API `stripSensitive` allow-list.
const FORBIDDEN_KEY_RE =
  /^(authorization|cookie|set-cookie|api[_-]?key|service[_-]?token|token|tokens|password|secret|bearer|prompts?|messages?|completion|input_json|provider_error_body|headers)$/i;

const MAX_DEPTH = 5;

function sanitizeString(s: string): string {
  let out = s.replace(ANSI_RE, "");
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[truncated-depth]";
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_RE.test(k)) continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function sanitizeHermesPayload(
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
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    return { truncated: true, original_keys: Object.keys(raw) };
  }
  return cleaned;
}

function sanitizeErrorMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = sanitizeString(String(raw));
  if (Buffer.byteLength(s, "utf8") > MAX_ERROR_BYTES) {
    s = s.slice(0, MAX_ERROR_BYTES) + "…[truncated]";
  }
  return s;
}

// ---- jobs ------------------------------------------------------------------

export type CreateHermesJobInput = {
  id?: string;
  kind: HermesJobKind;
  status?: HermesJobStatus;
  user_id?: string | null;
  brief_id?: string | null;
  research_job_id?: string | null;
  provider?: string | null;
  model?: string | null;
  fake?: boolean;
};

export function createHermesJob(input: CreateHermesJobInput): string {
  const id = input.id ?? newId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO hermes_jobs
       (id, kind, status, user_id, brief_id, research_job_id, provider, model, fake, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      input.status ?? "queued",
      input.user_id ?? null,
      input.brief_id ?? null,
      input.research_job_id ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.fake ? 1 : 0,
      now,
    );
  return id;
}

export type UpdateHermesJobPatch = {
  status?: HermesJobStatus;
  provider?: string | null;
  model?: string | null;
  started_at?: number | null;
  finished_at?: number | null;
  error?: string | null;
};

export function updateHermesJob(id: string, patch: UpdateHermesJobPatch): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.model !== undefined) {
    sets.push("model = ?");
    args.push(patch.model);
  }
  if (patch.started_at !== undefined) {
    sets.push("started_at = ?");
    args.push(patch.started_at);
  }
  if (patch.finished_at !== undefined) {
    sets.push("finished_at = ?");
    args.push(patch.finished_at);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    args.push(sanitizeErrorMessage(patch.error));
  }
  if (sets.length === 0) return;
  args.push(id);
  db()
    .prepare(`UPDATE hermes_jobs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args);
}

// ---- events ----------------------------------------------------------------

export type AppendHermesEventInput = {
  job_id: string;
  brief_id?: string | null;
  actor_user_id?: string | null;
  kind: HermesEventKind;
  title: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
};

export function appendHermesEvent(input: AppendHermesEventInput): HermesJobEvent {
  const id = newId();
  const now = Date.now();
  const cleaned = sanitizeHermesPayload(input.payload ?? null);
  const payloadJson = cleaned ? JSON.stringify(cleaned) : null;
  const summary = input.summary ? sanitizeString(input.summary) : null;

  const conn = db();
  // Transactional `seq` allocation: SELECT MAX inside the same tx that
  // does the INSERT, so two concurrent writers can't pick the same seq.
  // UNIQUE(job_id, seq) is the backstop.
  const tx = conn.transaction(() => {
    const row = conn
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM hermes_job_events WHERE job_id = ?`,
      )
      .get(input.job_id) as { m: number };
    const seq = (row?.m ?? 0) + 1;
    conn
      .prepare(
        `INSERT INTO hermes_job_events
         (id, job_id, brief_id, actor_user_id, seq, event_type, title, summary, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.job_id,
        input.brief_id ?? null,
        input.actor_user_id ?? null,
        seq,
        input.kind,
        input.title,
        summary,
        payloadJson,
        now,
      );
    return seq;
  });
  const seq = tx();

  return {
    id,
    job_id: input.job_id,
    brief_id: input.brief_id ?? null,
    actor_user_id: input.actor_user_id ?? null,
    seq,
    kind: input.kind,
    title: input.title,
    summary,
    payload: cleaned,
    created_at: now,
  };
}

// ---- reads -----------------------------------------------------------------

function rowToEvent(r: HermesJobEventRow): HermesJobEvent {
  let payload: Record<string, unknown> | null = null;
  if (r.payload_json) {
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      payload = null;
    }
  }
  return {
    id: r.id,
    job_id: r.job_id,
    brief_id: r.brief_id,
    actor_user_id: r.actor_user_id,
    seq: r.seq,
    kind: r.event_type,
    title: r.title,
    summary: r.summary,
    payload,
    created_at: r.created_at,
  };
}

export type ListEventsOptions = {
  limit?: number;
  afterSeq?: number;
};

// Returns events ordered by (created_at, seq) ascending so an SSE/poller
// can resume past the highest-seen seq. Limit is clamped to
// MAX_EVENT_LIMIT regardless of caller input.
export function listHermesEventsForBrief(
  briefId: string,
  opts: ListEventsOptions = {},
): HermesJobEvent[] {
  const requested = typeof opts.limit === "number" ? opts.limit : MAX_EVENT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_EVENT_LIMIT, Math.floor(requested)));
  try {
    let rows: HermesJobEventRow[];
    if (typeof opts.afterSeq === "number" && Number.isFinite(opts.afterSeq)) {
      rows = db()
        .prepare(
          `SELECT * FROM hermes_job_events
           WHERE brief_id = ? AND seq > ?
           ORDER BY created_at ASC, seq ASC
           LIMIT ?`,
        )
        .all(briefId, Math.floor(opts.afterSeq), limit) as HermesJobEventRow[];
    } else {
      rows = db()
        .prepare(
          `SELECT * FROM hermes_job_events
           WHERE brief_id = ?
           ORDER BY created_at ASC, seq ASC
           LIMIT ?`,
        )
        .all(briefId, limit) as HermesJobEventRow[];
    }
    return rows.map(rowToEvent);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[hermes_events] list failed", err);
    return [];
  }
}

// Internal helper: list events for a single job. Used by the verify
// script. Same MAX_EVENT_LIMIT cap.
export function listHermesEventsForJob(
  jobId: string,
  opts: { limit?: number } = {},
): HermesJobEvent[] {
  const requested = typeof opts.limit === "number" ? opts.limit : MAX_EVENT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_EVENT_LIMIT, Math.floor(requested)));
  try {
    const rows = db()
      .prepare(
        `SELECT * FROM hermes_job_events
         WHERE job_id = ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(jobId, limit) as HermesJobEventRow[];
    return rows.map(rowToEvent);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[hermes_events] list-for-job failed", err);
    return [];
  }
}
