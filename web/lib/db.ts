import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { hashPassword, newId } from "./password";
import { assertNoFakeProviderInProd } from "./envGuard";

assertNoFakeProviderInProd();

const DB_PATH =
  process.env.BRIEF_DB_PATH ||
  path.join(process.cwd(), "data", "briefs.sqlite");

let _db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (_db) return _db;
  const start = Date.now();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(`[db] init start path=${DB_PATH}`);
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS briefs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      segment TEXT,
      audience TEXT NOT NULL DEFAULT 'internal',
      generated_at TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      brief_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_briefs_user_created
      ON briefs (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS brief_chats (
      id TEXT PRIMARY KEY,
      brief_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      patches TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_brief_created
      ON brief_chats (brief_id, created_at);

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',
      display_name  TEXT,
      created_at    INTEGER NOT NULL,
      created_by    TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS brief_shares (
      brief_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      granted_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (brief_id, user_id),
      FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shares_user ON brief_shares(user_id);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);

  _db = conn;
  const { applied, skipped } = runMigrations(conn);
  bootstrapAdmin(conn);
  // eslint-disable-next-line no-console
  console.log(
    `[db] init done ms=${Date.now() - start} applied=${applied} skipped=${skipped}`,
  );
  return _db;
}

export function db(): Database.Database {
  return _db ?? initDb();
}

type Migration = { id: string; up: (c: Database.Database) => void };

const MIGRATIONS: Migration[] = [
  {
    id: "001_users_must_change_password",
    up: (c) =>
      c.exec(
        "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
      ),
  },
  {
    id: "002_users_disabled_at",
    up: (c) => c.exec("ALTER TABLE users ADD COLUMN disabled_at INTEGER"),
  },
  {
    id: "003_users_password_changed_at",
    up: (c) =>
      c.exec("ALTER TABLE users ADD COLUMN password_changed_at INTEGER"),
  },
  {
    id: "004_login_attempts_table",
    up: (c) =>
      c.exec(`
        CREATE TABLE IF NOT EXISTS login_attempts (
          email           TEXT PRIMARY KEY COLLATE NOCASE,
          failed_count    INTEGER NOT NULL DEFAULT 0,
          last_failed_at  INTEGER,
          locked_until    INTEGER
        );
      `),
  },
  {
    id: "005_brief_shares_role",
    // Legacy: this added the column with DEFAULT 'viewer'. Migration 006
    // renames live values to 'reader'; the column DEFAULT is left as
    // 'viewer' (changing it requires a SQLite table rebuild and app
    // code passes role explicitly on every insert).
    up: (c) =>
      c.exec(
        "ALTER TABLE brief_shares ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'",
      ),
  },
  {
    id: "006_brief_shares_role_rename_viewer_to_reader",
    up: (c) =>
      c.exec("UPDATE brief_shares SET role = 'reader' WHERE role = 'viewer'"),
  },
  {
    id: "007_brief_share_links",
    up: (c) =>
      c.exec(`
        CREATE TABLE IF NOT EXISTS brief_share_links (
          id                TEXT PRIMARY KEY,
          brief_id          TEXT NOT NULL,
          token             TEXT NOT NULL UNIQUE,
          created_by        TEXT NOT NULL,
          created_at        INTEGER NOT NULL,
          expires_at        INTEGER,
          revoked_at        INTEGER,
          last_accessed_at  INTEGER,
          access_count      INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_share_links_brief
          ON brief_share_links(brief_id);
      `),
  },
  {
    id: "008_research_jobs_and_email_prefs",
    up: (c) => {
      c.exec(`
        CREATE TABLE IF NOT EXISTS research_jobs (
          id               TEXT PRIMARY KEY,
          user_id          TEXT NOT NULL,
          account_name     TEXT NOT NULL,
          account_segment  TEXT,
          region           TEXT,
          goal             TEXT,
          intake_json      TEXT NOT NULL,
          mode             TEXT NOT NULL,
          status           TEXT NOT NULL,
          created_at       INTEGER NOT NULL,
          started_at       INTEGER,
          finished_at      INTEGER,
          brief_id         TEXT,
          error            TEXT,
          usage_json       TEXT,
          cost_usd_cents   INTEGER,
          retry_of_job_id  TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE SET NULL,
          FOREIGN KEY (retry_of_job_id) REFERENCES research_jobs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_user_created
          ON research_jobs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_status_created
          ON research_jobs(status, created_at);
      `);
      // Defensive column-exists guard: SQLite's ALTER TABLE cannot be
      // rolled back cleanly, so make this re-runnable if a previous
      // attempt failed mid-flight.
      const cols = c
        .prepare("PRAGMA table_info(users)")
        .all() as Array<{ name: string }>;
      if (!cols.some((r) => r.name === "email_notifications_enabled")) {
        c.exec(
          "ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 1",
        );
      }
    },
  },
  {
    id: "009_brief_share_emails",
    up: (c) =>
      c.exec(`
        CREATE TABLE IF NOT EXISTS brief_share_emails (
          id              TEXT PRIMARY KEY,
          link_id         TEXT NOT NULL,
          brief_id        TEXT NOT NULL,
          sender_user_id  TEXT NOT NULL,
          recipient       TEXT NOT NULL COLLATE NOCASE,
          send_status     TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          error           TEXT,
          FOREIGN KEY (link_id) REFERENCES brief_share_links(id) ON DELETE CASCADE,
          FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
          FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_share_emails_sender_created
          ON brief_share_emails(sender_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_share_emails_link_created
          ON brief_share_emails(link_id, created_at DESC);
      `),
  },
  {
    id: "010_brief_versions",
    up: (c) =>
      c.exec(`
        CREATE TABLE IF NOT EXISTS brief_versions (
          id              TEXT PRIMARY KEY,
          brief_id        TEXT NOT NULL,
          version_no      INTEGER NOT NULL,
          brief_json      TEXT NOT NULL,
          reason          TEXT NOT NULL,
          triggered_by    TEXT NOT NULL,
          refresh_job_id  TEXT,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
          FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (refresh_job_id) REFERENCES research_jobs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brief_versions_brief_created
          ON brief_versions(brief_id, created_at DESC);
      `),
  },
  {
    id: "011_research_jobs_refresh_intent",
    up: (c) => {
      const cols = c.prepare("PRAGMA table_info(research_jobs)").all() as Array<{ name: string }>;
      if (!cols.some((r) => r.name === "intent")) {
        c.exec("ALTER TABLE research_jobs ADD COLUMN intent TEXT NOT NULL DEFAULT 'create'");
      }
      if (!cols.some((r) => r.name === "target_brief_id")) {
        c.exec("ALTER TABLE research_jobs ADD COLUMN target_brief_id TEXT");
      }
      c.exec("CREATE INDEX IF NOT EXISTS idx_jobs_target_status ON research_jobs(target_brief_id, status)");
    },
  },
  {
    id: "012_brief_events",
    up: (c) =>
      c.exec(`
        CREATE TABLE IF NOT EXISTS brief_events (
          id              TEXT PRIMARY KEY,
          brief_id        TEXT,
          job_id          TEXT,
          actor_user_id   TEXT,
          actor_type      TEXT NOT NULL DEFAULT 'user',
          event_type      TEXT NOT NULL,
          title           TEXT NOT NULL,
          summary         TEXT,
          metadata_json   TEXT,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brief_events_brief_created
          ON brief_events(brief_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_brief_events_job
          ON brief_events(job_id);
        CREATE INDEX IF NOT EXISTS idx_brief_events_actor_created
          ON brief_events(actor_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_brief_events_type_created
          ON brief_events(event_type, created_at DESC);
      `),
  },
  {
    id: "013_hermes_runtime_events_and_canvas_state",
    // Hermes runtime substrate. Three additive tables:
    //   - hermes_jobs:        durable job rows for research / chat / canvas
    //                         synthesis dispatched to the (future) Hermes
    //                         runtime. `fake` distinguishes lab/no-spend rows.
    //   - hermes_job_events:  ordered, sanitized event log per job. Seq is
    //                         computed transactionally per job; payload_json
    //                         must never contain raw tokens, cookies, or
    //                         provider response bodies.
    //   - canvas_states:      durable Canvas blob per brief, separate from
    //                         brief_json so Hermes-driven Canvas updates
    //                         have their own version history.
    //
    // No data backfill — all rows are created on demand once the matching
    // Hermes runtime feature flag is enabled. Migration is purely additive
    // so rollback = leave tables in place, set flags back to 0.
    up: (c) => {
      c.exec(`
        CREATE TABLE IF NOT EXISTS hermes_jobs (
          id              TEXT PRIMARY KEY,
          kind            TEXT NOT NULL,
          status          TEXT NOT NULL,
          user_id         TEXT,
          brief_id        TEXT,
          research_job_id TEXT,
          provider        TEXT,
          model           TEXT,
          fake            INTEGER NOT NULL DEFAULT 0,
          input_json      TEXT,
          result_json     TEXT,
          error           TEXT,
          created_at      INTEGER NOT NULL,
          started_at      INTEGER,
          finished_at     INTEGER,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
          FOREIGN KEY (research_job_id) REFERENCES research_jobs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hermes_jobs_brief_created
          ON hermes_jobs(brief_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_hermes_jobs_user_created
          ON hermes_jobs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_hermes_jobs_status_created
          ON hermes_jobs(status, created_at);

        CREATE TABLE IF NOT EXISTS hermes_job_events (
          id              TEXT PRIMARY KEY,
          job_id          TEXT NOT NULL,
          brief_id        TEXT,
          actor_user_id   TEXT,
          seq             INTEGER NOT NULL,
          event_type      TEXT NOT NULL,
          title           TEXT NOT NULL,
          summary         TEXT,
          payload_json    TEXT,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (job_id) REFERENCES hermes_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
          FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(job_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_hermes_events_brief_created
          ON hermes_job_events(brief_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_hermes_events_job_seq
          ON hermes_job_events(job_id, seq);

        CREATE TABLE IF NOT EXISTS canvas_states (
          brief_id          TEXT PRIMARY KEY,
          canvas_json       TEXT NOT NULL,
          source            TEXT NOT NULL,
          version           INTEGER NOT NULL DEFAULT 1,
          updated_at        INTEGER NOT NULL,
          updated_by_job_id TEXT,
          FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
          FOREIGN KEY (updated_by_job_id) REFERENCES hermes_jobs(id) ON DELETE SET NULL
        );
      `);
    },
  },
];

// Row types for the Hermes substrate. Kept here next to the rest of the
// row type definitions so callers can import them from "@/lib/db" like
// every other row type.
export type HermesJobRow = {
  id: string;
  kind: "research" | "chat" | "canvas_synthesis";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  user_id: string | null;
  brief_id: string | null;
  research_job_id: string | null;
  provider: string | null;
  model: string | null;
  fake: 0 | 1;
  input_json: string | null;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export type HermesJobEventRow = {
  id: string;
  job_id: string;
  brief_id: string | null;
  actor_user_id: string | null;
  seq: number;
  event_type: string;
  title: string;
  summary: string | null;
  payload_json: string | null;
  created_at: number;
};

export type CanvasStateRow = {
  brief_id: string;
  canvas_json: string;
  source: "deterministic" | "hermes" | "fake";
  version: number;
  updated_at: number;
  updated_by_job_id: string | null;
};

function runMigrations(conn: Database.Database): {
  applied: number;
  skipped: number;
} {
  const seenStmt = conn.prepare(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
  );
  const recordStmt = conn.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );
  let applied = 0;
  let skipped = 0;
  for (const m of MIGRATIONS) {
    if (seenStmt.get(m.id)) {
      skipped++;
      continue;
    }
    try {
      const tx = conn.transaction(() => {
        m.up(conn);
        recordStmt.run(m.id, Date.now());
      });
      tx();
      applied++;
      // eslint-disable-next-line no-console
      console.log(`[db] migration applied id=${m.id}`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Backfill case: schema was migrated out-of-band on prod DBs that
      // pre-date the ledger. Record the id so subsequent boots are clean.
      if (
        /duplicate column name/i.test(msg) ||
        /table .* already exists/i.test(msg)
      ) {
        recordStmt.run(m.id, Date.now());
        skipped++;
        // eslint-disable-next-line no-console
        console.log(
          `[db] migration backfilled id=${m.id} (already applied out-of-band)`,
        );
        continue;
      }
      throw e;
    }
  }
  return { applied, skipped };
}

function bootstrapAdmin(conn: Database.Database) {
  const row = conn
    .prepare("SELECT COUNT(*) AS n FROM users")
    .get() as { n: number };
  if (row.n > 0) return;

  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    throw new Error(
      "No users in DB and ADMIN_EMAIL / ADMIN_PASSWORD are not set. " +
        "Set both env vars on first run to seed the admin account.",
    );
  }

  const adminId = newId();
  const now = Date.now();
  const tx = conn.transaction(() => {
    conn
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, display_name, created_at)
         VALUES (?, ?, ?, 'admin', ?, ?)`,
      )
      .run(adminId, email, hashPassword(password), email, now);
    conn.prepare("UPDATE briefs SET user_id = ?").run(adminId);
    conn.prepare("UPDATE brief_chats SET user_id = ?").run(adminId);
  });
  tx();

  // eslint-disable-next-line no-console
  console.log(
    `[db] seeded admin user ${email} and reassigned existing briefs to it`,
  );
}

export type BriefChatRow = {
  id: string;
  brief_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  patches: string | null;
  created_at: number;
};

export type BriefRow = {
  id: string;
  user_id: string;
  account_name: string;
  segment: string | null;
  audience: string;
  generated_at: string;
  created_at: number;
  brief_json: string;
};

export type BriefSummary = {
  id: string;
  account_name: string;
  segment: string | null;
  audience: string;
  generated_at: string;
  created_at: number;
};

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: "admin" | "member" | "viewer";
  display_name: string | null;
  created_at: number;
  created_by: string | null;
  must_change_password: number;
  disabled_at: number | null;
  password_changed_at: number | null;
  email_notifications_enabled: 0 | 1;
};

export type ResearchJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type ResearchJobRow = {
  id: string;
  user_id: string;
  account_name: string;
  account_segment: string | null;
  region: string | null;
  goal: string | null;
  intake_json: string;
  mode: "quick" | "standard" | "deep";
  status: ResearchJobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  brief_id: string | null;
  error: string | null;
  usage_json: string | null;
  cost_usd_cents: number | null;
  retry_of_job_id: string | null;
  intent: "create" | "refresh";
  target_brief_id: string | null;
};

export type BriefVersionRow = {
  id: string;
  brief_id: string;
  version_no: number;
  brief_json: string;
  reason: string;
  triggered_by: string;
  refresh_job_id: string | null;
  created_at: number;
};

export type LoginAttemptRow = {
  email: string;
  failed_count: number;
  last_failed_at: number | null;
  locked_until: number | null;
};

export type SessionRow = {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
};

export type BriefEventRow = {
  id: string;
  brief_id: string | null;
  job_id: string | null;
  actor_user_id: string | null;
  actor_type: "user" | "worker" | "system" | "hermes";
  event_type: string;
  title: string;
  summary: string | null;
  metadata_json: string | null;
  created_at: number;
};

export type ShareLinkRow = {
  id: string;
  brief_id: string;
  token: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_accessed_at: number | null;
  access_count: number;
};
