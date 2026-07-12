import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { db, type JournalRadarCheckpointRow } from "./db";
import {
  JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION,
  JOURNAL_RADAR_MAX_MANIFEST_BYTES,
  buildJournalRadarManifest,
  canonicalizeJournalRadarManifest,
  isJournalRadarManifest,
  type JournalRadarManifest,
} from "./journalRadarManifest";

export type JournalRadarCheckpointRead =
  | { state: "missing"; manifest: null; reviewed_at: null; manifest_hash: null }
  | { state: "invalid"; manifest: null; reviewed_at: number | null; manifest_hash: string | null }
  | { state: "valid"; manifest: JournalRadarManifest; reviewed_at: number; manifest_hash: string };

export class JournalRadarStaleManifestError extends Error {
  readonly code = "stale_manifest";
  constructor(public readonly currentHash: string, public readonly currentSchemaVersion: number) {
    super("The Journal changed after this radar was displayed. Refresh and review the latest changes.");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function readJournalRadarCheckpoint(
  briefId: string,
  userId: string,
  connection: Database.Database = db(),
): JournalRadarCheckpointRead {
  const row = connection.prepare(`SELECT brief_id, user_id, manifest_schema_version, manifest_json,
      manifest_hash, reviewed_at, created_at, updated_at
    FROM journal_radar_checkpoints WHERE brief_id = ? AND user_id = ?`).get(briefId, userId) as JournalRadarCheckpointRow | undefined;
  if (!row) return { state: "missing", manifest: null, reviewed_at: null, manifest_hash: null };
  if (row.manifest_schema_version !== JOURNAL_RADAR_MANIFEST_SCHEMA_VERSION
      || Buffer.byteLength(row.manifest_json, "utf8") > JOURNAL_RADAR_MAX_MANIFEST_BYTES
      || !/^[a-f0-9]{64}$/.test(row.manifest_hash)) {
    return { state: "invalid", manifest: null, reviewed_at: row.reviewed_at, manifest_hash: row.manifest_hash };
  }
  try {
    const parsed: unknown = JSON.parse(row.manifest_json);
    if (!isJournalRadarManifest(parsed)) throw new Error("invalid manifest schema");
    const canonical = canonicalizeJournalRadarManifest(parsed);
    if (canonical !== row.manifest_json || sha256(canonical) !== row.manifest_hash) throw new Error("manifest integrity mismatch");
    return { state: "valid", manifest: parsed, reviewed_at: row.reviewed_at, manifest_hash: row.manifest_hash };
  } catch {
    return { state: "invalid", manifest: null, reviewed_at: row.reviewed_at, manifest_hash: row.manifest_hash };
  }
}

export function saveJournalRadarCheckpoint(input: {
  briefId: string;
  userId: string;
  expectedHash: string;
  expectedSchemaVersion: number;
  now?: number;
  connection?: Database.Database;
}): { reviewed_at: number; manifest_hash: string; manifest_schema_version: number } {
  const connection = input.connection ?? db();
  const run = connection.transaction(() => {
    // Build and compare synchronously inside the same SQLite transaction, then
    // freeze exactly the state whose hash the caller displayed.
    const current = buildJournalRadarManifest(input.briefId, connection);
    if (input.expectedSchemaVersion !== current.manifest.schema_version || input.expectedHash !== current.hash) {
      throw new JournalRadarStaleManifestError(current.hash, current.manifest.schema_version);
    }
    const now = input.now ?? Date.now();
    connection.prepare(`INSERT INTO journal_radar_checkpoints
      (brief_id,user_id,manifest_schema_version,manifest_json,manifest_hash,reviewed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(brief_id,user_id) DO UPDATE SET
        manifest_schema_version=excluded.manifest_schema_version,
        manifest_json=excluded.manifest_json,
        manifest_hash=excluded.manifest_hash,
        reviewed_at=excluded.reviewed_at,
        updated_at=excluded.updated_at`).run(
      input.briefId, input.userId, current.manifest.schema_version, current.canonicalJson,
      current.hash, now, now, now,
    );
    return { reviewed_at: now, manifest_hash: current.hash, manifest_schema_version: current.manifest.schema_version };
  });
  return run.immediate();
}
