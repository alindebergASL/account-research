import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "../web/node_modules/better-sqlite3";
import {
  createDataBackup,
  __setTestBackupSmokeHook,
  restoreDataBackup,
  reconcileJournalDocumentBlobs,
} from "../web/scripts/endgameOperations";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "endgame-ops-"));
  const data = path.join(root, "data");
  mkdirSync(data);
  const databasePath = path.join(data, "briefs.sqlite");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE parents (id TEXT PRIMARY KEY);
    CREATE TABLE journal_documents (
      id TEXT PRIMARY KEY, storage_path TEXT, content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL, parent_id TEXT REFERENCES parents(id)
    );
  `);
  const bytes = Buffer.from("fixture original bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const rel = `journal-docs/${hash.slice(0, 2)}/${hash}`;
  mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
  writeFileSync(path.join(data, rel), bytes);
  mkdirSync(path.join(data, "local-metadata"));
  writeFileSync(path.join(data, "local-metadata", "settings.json"), "{}\n");
  db.prepare("INSERT INTO parents VALUES (?)").run("p1");
  db.prepare("INSERT INTO journal_documents VALUES (?, ?, ?, ?, ?)")
    .run("d1", rel, hash, bytes.length, "p1");
  return { root, data, databasePath, db, bytes, hash, rel };
}

test("backup and isolated restore verify SQLite, checksums, and blobs end to end", async (t) => {
  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  const backup = path.join(f.root, "backup");
  const manifest = await createDataBackup({ sourceDataDir: f.data, backupDir: backup });
  assert.equal(manifest.sqlite.integrity_check, "ok");
  assert.equal(manifest.sqlite.quick_check, "ok");
  assert.deepEqual(manifest.sqlite.foreign_key_check, []);
  assert.ok(manifest.source_inventory.some((row) => row.relative_path === "briefs.sqlite-wal"));
  assert.ok(manifest.files.some((row) => row.relative_path === "briefs.sqlite"));
  assert.ok(manifest.files.some((row) => row.relative_path === `raw-data/${f.rel}`));
  assert.ok(manifest.files.some((row) => row.relative_path === "raw-data/local-metadata/settings.json"));

  const restored = path.join(f.root, "isolated-restore");
  const result = await restoreDataBackup({ backupDir: backup, targetDataDir: restored, sourceDataDir: f.data });
  assert.equal(result.quick_check, "ok");
  assert.deepEqual(result.foreign_key_check, []);
  assert.equal(result.blobs.missing.length, 0);
  assert.equal(result.blobs.mismatched.length, 0);
  assert.deepEqual(readFileSync(path.join(restored, f.rel)), f.bytes);
  assert.equal(readFileSync(path.join(restored, "local-metadata", "settings.json"), "utf8"), "{}\n");
});

test("backup rejects nested secret-shaped durable filenames with a fixed non-secret error", async (t) => {
  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  mkdirSync(path.join(f.data, "nested", "configuration"), { recursive: true });
  writeFileSync(path.join(f.data, "nested", "configuration", ".env.production"), "do-not-read");
  await assert.rejects(
    createDataBackup({ sourceDataDir: f.data, backupDir: path.join(f.root, "backup") }),
    (error: Error) => error.message === "source data contains a prohibited secret-shaped filename",
  );
  assert.equal(existsSync(path.join(f.root, "backup")), false);
});

test("restore rejects checksum-valid secret-shaped filenames before materializing the target", async (t) => {
  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  const backup = path.join(f.root, "backup");
  await createDataBackup({ sourceDataDir: f.data, backupDir: backup });

  const secretPath = path.join(backup, "raw-data", ".env");
  const secretBytes = Buffer.from("external-manifest-value");
  writeFileSync(secretPath, secretBytes);
  const manifestPath = path.join(backup, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.push({
    relative_path: "raw-data/.env",
    bytes: secretBytes.length,
    sha256: createHash("sha256").update(secretBytes).digest("hex"),
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const target = path.join(f.root, "rejected-restore");
  await assert.rejects(
    restoreDataBackup({ backupDir: backup, targetDataDir: target, sourceDataDir: f.data }),
    (error: Error) => error.message === "source data contains a prohibited secret-shaped filename",
  );
  assert.equal(existsSync(target), false);
});

test("backup fails before publication for missing and mismatched referenced blobs", async (t) => {
  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  await rm(path.join(f.data, f.rel));
  await assert.rejects(
    createDataBackup({ sourceDataDir: f.data, backupDir: path.join(f.root, "missing-backup") }),
    /backup journal-document blob verification failed/,
  );
  assert.equal(existsSync(path.join(f.root, "missing-backup")), false);
  writeFileSync(path.join(f.data, f.rel), "same length but bad hash!!");
  await assert.rejects(
    createDataBackup({ sourceDataDir: f.data, backupDir: path.join(f.root, "mismatch-backup") }),
    /backup journal-document blob verification failed/,
  );
  assert.equal(existsSync(path.join(f.root, "mismatch-backup")), false);
});

test("backup smoke failure cleans temporary work and never publishes", async (t) => {
  const f = fixture();
  let smokeRoot = "";
  t.after(() => {
    __setTestBackupSmokeHook(null);
    f.db.close();
    return rm(f.root, { recursive: true, force: true });
  });
  __setTestBackupSmokeHook((root) => {
    smokeRoot = root;
    throw new Error("forced isolated smoke failure");
  });
  const backup = path.join(f.root, "backup");
  await assert.rejects(createDataBackup({ sourceDataDir: f.data, backupDir: backup }), /forced isolated smoke failure/);
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(smokeRoot), false);
  assert.deepEqual(readdirSync(f.root).sort(), ["data"]);
});

test("backup rejects repository-contained destinations through the API and operator wrapper", async (t) => {
  const f = fixture();
  const repo = path.resolve(import.meta.dirname, "..");
  const root = mkdtempSync(path.join(tmpdir(), "endgame-repo-backup-"));
  const repoAlias = path.join(root, "repository-alias");
  const apiBackup = path.join(repo, `.endgame-api-backup-${process.pid}-${Date.now()}`);
  const wrapperBackup = path.join(repoAlias, `.endgame-wrapper-backup-${process.pid}-${Date.now()}`);
  symlinkSync(repo, repoAlias, "dir");
  t.after(async () => {
    f.db.close();
    await rm(apiBackup, { recursive: true, force: true });
    await rm(path.join(repo, path.basename(wrapperBackup)), { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  for (const backupDir of [repo, apiBackup]) {
    await assert.rejects(
      createDataBackup({ sourceDataDir: f.data, backupDir }),
      (error: Error) => error.message === "backup directory must be outside the repository",
    );
  }
  assert.equal(existsSync(apiBackup), false);

  const wrapperEnv = { ...process.env, BRIEF_DB_PATH: f.databasePath };
  delete wrapperEnv.NODE_TEST_CONTEXT;
  const result = spawnSync("bash", [path.join(repo, "scripts/backup-web-data.sh"), wrapperBackup], {
    env: wrapperEnv, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(existsSync(wrapperBackup), false);
});

test("backup entrypoints fail closed for absent source; restore permits disaster recovery but refuses the configured source", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "endgame-entrypoints-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.resolve(import.meta.dirname, "..");
  const env = { ...process.env, BRIEF_DB_PATH: path.join(root, "absent", "briefs.sqlite"), BRIEF_BACKUP_DIR: path.join(root, "backups") };
  for (const script of ["scripts/backup-web-data.sh", "scripts/backup-briefs.sh"]) {
    const result = spawnSync("bash", [path.join(repo, script), path.join(root, "requested")], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0, `${script} must fail for absent source`);
  }

  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  const backup = path.join(root, "safe-backup");
  const backedUp = spawnSync("bash", [path.join(repo, "scripts/backup-web-data.sh"), backup], {
    env: { ...process.env, BRIEF_DB_PATH: f.databasePath }, encoding: "utf8",
  });
  assert.equal(backedUp.status, 0, backedUp.stderr);
  assert.equal(existsSync(path.join(backup, "manifest.json")), true);
  const refused = spawnSync("bash", [path.join(repo, "scripts/restore-web-data.sh"), backup, f.data], {
    env: { ...process.env, BRIEF_DB_PATH: f.databasePath }, encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);

  const absentSourceData = path.join(root, "lost-live-data");
  const restored = path.join(root, "disaster-recovery-target");
  const disasterEnv = { ...process.env, BRIEF_DB_PATH: path.join(absentSourceData, "briefs.sqlite") };
  const recovered = spawnSync("bash", [path.join(repo, "scripts/restore-web-data.sh"), backup, restored], {
    env: disasterEnv, encoding: "utf8",
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(path.join(restored, "briefs.sqlite")), true);
  assert.deepEqual(readFileSync(path.join(restored, f.rel)), f.bytes);

  const sameSource = spawnSync("bash", [path.join(repo, "scripts/restore-web-data.sh"), backup, absentSourceData], {
    env: disasterEnv, encoding: "utf8",
  });
  assert.notEqual(sameSource.status, 0);
  assert.equal(existsSync(absentSourceData), false);
});

test("production health gate requires exact canonical migration and backup readiness", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../scripts/prod-health-check.sh"), "utf8");
  assert.match(source, /EXPECTED_MIGRATION="031_journal_radar_checkpoints"/);
  assert.match(source, /\[\[ "\$latest" == "\$EXPECTED_MIGRATION" \]\]/);
  assert.doesNotMatch(source, /EXPECTED_LATEST_MIGRATION|\*"\$EXPECTED_MIGRATION"\*/);
  assert.doesNotMatch(source, /expected to contain/);
  assert.match(source, /backup-web-data\.sh/);
  assert.match(source, /restore-web-data\.sh/);
  assert.match(source, /endgameOperations\.ts/);
});

test("restore refuses tampering, source targets, and nonempty targets", async (t) => {
  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  const backup = path.join(f.root, "backup");
  await createDataBackup({ sourceDataDir: f.data, backupDir: backup });
  await assert.rejects(
    restoreDataBackup({ backupDir: backup, targetDataDir: f.data, sourceDataDir: f.data }),
    /source data directory/,
  );
  const nonempty = path.join(f.root, "nonempty");
  mkdirSync(nonempty);
  writeFileSync(path.join(nonempty, "keep"), "x");
  await assert.rejects(
    restoreDataBackup({ backupDir: backup, targetDataDir: nonempty, sourceDataDir: f.data }),
    /target directory must be empty/,
  );
  writeFileSync(path.join(backup, "briefs.sqlite"), "tampered");
  await assert.rejects(
    restoreDataBackup({ backupDir: backup, targetDataDir: path.join(f.root, "tampered"), sourceDataDir: f.data }),
    /checksum mismatch/,
  );
});

test("restore rejects unmanifested files and targets nested under the source", async (t) => {
  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  const backup = path.join(f.root, "backup");
  await createDataBackup({ sourceDataDir: f.data, backupDir: backup });
  writeFileSync(path.join(backup, "raw-data", "unexpected"), "not in manifest");
  await assert.rejects(
    restoreDataBackup({ backupDir: backup, targetDataDir: path.join(f.root, "extra"), sourceDataDir: f.data }),
    /unmanifested file/,
  );
  await rm(path.join(backup, "raw-data", "unexpected"));
  await assert.rejects(
    restoreDataBackup({ backupDir: backup, targetDataDir: path.join(f.data, "restore"), sourceDataDir: f.data }),
    /source data directory/,
  );
  assert.equal(existsSync(path.join(f.data, "restore")), false);
});

test("blob inventory reports defects and cleanup deletes only fresh unreferenced files", async (t) => {
  const f = fixture();
  t.after(() => { f.db.close(); return rm(f.root, { recursive: true, force: true }); });
  const orphan = path.join(f.data, "journal-docs", "ff", "orphan");
  mkdirSync(path.dirname(orphan), { recursive: true });
  writeFileSync(orphan, "orphan");
  f.db.prepare("INSERT INTO journal_documents VALUES (?, ?, ?, ?, ?)")
    .run("bad-path", "../escape", "a".repeat(64), 1, "p1");
  const confinedInvalid = "journal-docs/ee/database-referenced";
  mkdirSync(path.dirname(path.join(f.data, confinedInvalid)), { recursive: true });
  writeFileSync(path.join(f.data, confinedInvalid), "preserve");
  f.db.prepare("INSERT INTO journal_documents VALUES (?, ?, ?, ?, ?)")
    .run("bad-hash", confinedInvalid, "not-a-hash", 8, "p1");
  f.db.prepare("INSERT INTO journal_documents VALUES (?, ?, ?, ?, ?)")
    .run("missing", `journal-docs/${"b".repeat(2)}/${"b".repeat(64)}`, "b".repeat(64), 9, "p1");
  writeFileSync(path.join(f.data, f.rel), "changed");

  const report = reconcileJournalDocumentBlobs({ dataDir: f.data, databasePath: f.databasePath });
  assert.equal(report.invalid_paths.length, 2);
  assert.equal(report.missing.length, 1);
  assert.equal(report.mismatched.length, 1);
  assert.deepEqual(report.orphans, ["journal-docs/ff/orphan"]);
  assert.equal(readFileSync(orphan, "utf8"), "orphan");

  const cleaned = reconcileJournalDocumentBlobs({
    dataDir: f.data, databasePath: f.databasePath, cleanupOrphans: true,
  });
  assert.deepEqual(cleaned.deleted_orphans, ["journal-docs/ff/orphan"]);
  assert.throws(() => readFileSync(orphan), /ENOENT/);
  assert.equal(readFileSync(path.join(f.data, f.rel), "utf8"), "changed");
  assert.equal(readFileSync(path.join(f.data, confinedInvalid), "utf8"), "preserve");
});
