#!/usr/bin/env node
// Break-glass admin CLI for the account-brief-builder.
//
// Operates directly on the SQLite DB. Use when the only admin has lost their
// password, or to inspect/repair the user table without booting the web app.
//
// Usage:
//   BRIEF_DB_PATH=/path/to/briefs.sqlite node scripts/admin-cli.mjs <cmd> [args]
//
// Commands:
//   list-users
//       Print every user (id, email, role, disabled, created).
//   reset-password <email>
//       Generate a new temp password, mark must_change_password=1, and
//       invalidate all that user's sessions. Prints the temp password once.
//   set-password <email> <password>
//       Set an explicit password (no temp). Clears must_change_password.
//       Useful for restoring access without a forced-change step.
//   promote <email>
//       Set role='admin'.
//   demote <email>
//       Set role='member'.
//   enable <email>
//       Clear disabled_at.
//   disable <email>
//       Set disabled_at=now and invalidate the user's sessions.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const Database = require(path.join(repoRoot, "web/node_modules/better-sqlite3"));
const {
  hashPassword,
  randomTempPassword,
} = require(path.join(repoRoot, "web/lib/password.cjs"));

const DB_PATH =
  process.env.BRIEF_DB_PATH ||
  path.join(repoRoot, "web/data/briefs.sqlite");

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

const [, , cmd, ...args] = process.argv;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function findUser(email) {
  return db
    .prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
    .get(email.trim().toLowerCase());
}

function clearSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

function clearLockout(email) {
  db.prepare("DELETE FROM login_attempts WHERE email = ?").run(email);
}

switch (cmd) {
  case undefined:
  case "help":
  case "-h":
  case "--help": {
    const help = [
      "Usage:",
      "  list-users",
      "  reset-password <email>",
      "  set-password <email> <password>",
      "  promote <email>",
      "  demote <email>",
      "  enable <email>",
      "  disable <email>",
    ].join("\n");
    console.log(help);
    break;
  }

  case "list-users": {
    const rows = db
      .prepare(
        `SELECT id, email, role, disabled_at, must_change_password, created_at
         FROM users ORDER BY created_at ASC`,
      )
      .all();
    for (const r of rows) {
      console.log(
        `${r.id}\t${r.email}\trole=${r.role}\tdisabled=${r.disabled_at ? "yes" : "no"}\tmust_change=${r.must_change_password ? "yes" : "no"}\tcreated=${new Date(r.created_at).toISOString()}`,
      );
    }
    break;
  }

  case "reset-password": {
    const email = args[0];
    if (!email) fail("usage: reset-password <email>");
    const u = findUser(email);
    if (!u) fail(`no user: ${email}`);
    const temp = randomTempPassword(12);
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?`,
    ).run(hashPassword(temp), Date.now(), u.id);
    clearSessions(u.id);
    clearLockout(u.email);
    console.log(`Reset ${u.email}`);
    console.log(`Temp password: ${temp}`);
    console.log(`User must change it on next login.`);
    break;
  }

  case "set-password": {
    const [email, password] = args;
    if (!email || !password) fail("usage: set-password <email> <password>");
    if (password.length < 8) fail("password must be at least 8 chars");
    const u = findUser(email);
    if (!u) fail(`no user: ${email}`);
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?`,
    ).run(hashPassword(password), Date.now(), u.id);
    clearSessions(u.id);
    clearLockout(u.email);
    console.log(`Set password for ${u.email} (no forced change).`);
    break;
  }

  case "promote":
  case "demote": {
    const role = cmd === "promote" ? "admin" : "member";
    const email = args[0];
    if (!email) fail(`usage: ${cmd} <email>`);
    const u = findUser(email);
    if (!u) fail(`no user: ${email}`);
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, u.id);
    console.log(`${u.email} is now ${role}.`);
    break;
  }

  case "enable": {
    const email = args[0];
    if (!email) fail("usage: enable <email>");
    const u = findUser(email);
    if (!u) fail(`no user: ${email}`);
    db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(u.id);
    console.log(`Enabled ${u.email}.`);
    break;
  }

  case "disable": {
    const email = args[0];
    if (!email) fail("usage: disable <email>");
    const u = findUser(email);
    if (!u) fail(`no user: ${email}`);
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").run(
      Date.now(),
      u.id,
    );
    clearSessions(u.id);
    console.log(`Disabled ${u.email}.`);
    break;
  }

  default:
    fail(`Unknown command: ${cmd}. Run with --help for usage.`);
}
