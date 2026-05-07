import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { hashPassword, newId } from "./password";

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
    up: (c) =>
      c.exec(
        "ALTER TABLE brief_shares ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'",
      ),
  },
];

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
  role: "admin" | "member";
  display_name: string | null;
  created_at: number;
  created_by: string | null;
  must_change_password: number;
  disabled_at: number | null;
  password_changed_at: number | null;
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
