import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

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
  `);
  _db = conn;
  return _db;
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
