// Durable Canvas state persistence.
//
// Pure DB layer for the `canvas_states` table introduced in migration
// 013. No rendering, no validation of widget content beyond a minimal
// shape check ("must be a JSON-serializable object"). Higher layers
// (`fromBrief.ts`, future Hermes synthesizer) own the schema.
//
// Version semantics: every successful save increments `version` by 1.
// Callers that need optimistic concurrency can pass `expectedVersion`
// and we'll throw if it doesn't match the row currently on disk.
import { db, type CanvasStateRow } from "../db";
import type { CanvasStateSource } from "../hermes/types";

export type PersistedCanvasState = {
  brief_id: string;
  canvas: unknown;
  source: CanvasStateSource;
  version: number;
  updated_at: number;
  updated_by_job_id: string | null;
};

export type SaveCanvasStateInput = {
  briefId: string;
  canvas: unknown;
  // Default `deterministic` matches the existing `fromBrief.ts` path so
  // PR 1 can save state without yet caring about Hermes provenance.
  source?: CanvasStateSource;
  jobId?: string | null;
  expectedVersion?: number;
};

export type SaveCanvasStateResult = {
  version: number;
};

function rowToState(r: CanvasStateRow): PersistedCanvasState {
  let canvas: unknown = null;
  try {
    canvas = JSON.parse(r.canvas_json);
  } catch {
    canvas = null;
  }
  return {
    brief_id: r.brief_id,
    canvas,
    source: r.source,
    version: r.version,
    updated_at: r.updated_at,
    updated_by_job_id: r.updated_by_job_id,
  };
}

export function getCanvasState(briefId: string): PersistedCanvasState | null {
  const row = db()
    .prepare(`SELECT * FROM canvas_states WHERE brief_id = ?`)
    .get(briefId) as CanvasStateRow | undefined;
  return row ? rowToState(row) : null;
}

export function saveCanvasState(
  input: SaveCanvasStateInput,
): SaveCanvasStateResult {
  // Minimal shape check: must be a non-null object that we can stringify.
  if (
    input.canvas === null ||
    input.canvas === undefined ||
    typeof input.canvas !== "object"
  ) {
    throw new Error("saveCanvasState: canvas must be a JSON-serializable object");
  }
  let canvasJson: string;
  try {
    canvasJson = JSON.stringify(input.canvas);
  } catch (e) {
    throw new Error("saveCanvasState: canvas is not JSON-serializable");
  }

  const source = input.source ?? "deterministic";
  const now = Date.now();
  const conn = db();

  const tx = conn.transaction(() => {
    const existing = conn
      .prepare(`SELECT version FROM canvas_states WHERE brief_id = ?`)
      .get(input.briefId) as { version: number } | undefined;

    if (existing) {
      if (
        typeof input.expectedVersion === "number" &&
        input.expectedVersion !== existing.version
      ) {
        throw new Error(
          `saveCanvasState: version conflict (expected ${input.expectedVersion}, got ${existing.version})`,
        );
      }
      const next = existing.version + 1;
      conn
        .prepare(
          `UPDATE canvas_states
             SET canvas_json = ?, source = ?, version = ?, updated_at = ?, updated_by_job_id = ?
           WHERE brief_id = ?`,
        )
        .run(canvasJson, source, next, now, input.jobId ?? null, input.briefId);
      return next;
    }

    if (
      typeof input.expectedVersion === "number" &&
      input.expectedVersion !== 0
    ) {
      throw new Error(
        `saveCanvasState: version conflict (expected ${input.expectedVersion}, got 0)`,
      );
    }
    conn
      .prepare(
        `INSERT INTO canvas_states
         (brief_id, canvas_json, source, version, updated_at, updated_by_job_id)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(input.briefId, canvasJson, source, now, input.jobId ?? null);
    return 1;
  });

  const version = tx();
  return { version };
}
