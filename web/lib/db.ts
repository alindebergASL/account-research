import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { hashPassword, newId } from "./password";

const DB_PATH =
  process.env.BRIEF_DB_PATH ||
  path.join(process.cwd(), "data", "briefs.sqlite");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  `);

  _db = conn;
  applyMigrations(conn);
  bootstrapAdmin(conn);
  return _db;
}

function applyMigrations(conn: Database.Database) {
  // Idempotent ALTER TABLEs — better-sqlite3 throws on duplicate column,
  // so we swallow that specific error and continue.
  const addCol = (sql: string) => {
    try {
      conn.exec(sql);
    } catch (e: any) {
      if (!/duplicate column name/i.test(String(e?.message ?? e))) throw e;
    }
  };
  addCol(
    "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
  );
  addCol("ALTER TABLE users ADD COLUMN disabled_at INTEGER");
  addCol("ALTER TABLE users ADD COLUMN password_changed_at INTEGER");

  conn.exec(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      email           TEXT PRIMARY KEY COLLATE NOCASE,
      failed_count    INTEGER NOT NULL DEFAULT 0,
      last_failed_at  INTEGER,
      locked_until    INTEGER
    );
  `);
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
