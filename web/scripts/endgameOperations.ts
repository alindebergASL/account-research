import { createHash } from "node:crypto";
import fs from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DB_NAME = "briefs.sqlite";
const MANIFEST_NAME = "manifest.json";
const RAW_DATA_DIR = "raw-data";
const BLOB_DIR = "journal-docs";

export type ManifestFile = { relative_path: string; bytes: number; sha256: string };
export type SourceInventoryFile = { relative_path: string; bytes: number };
export type BackupManifest = {
  schema_version: 1;
  created_at: string;
  source_data_dir: string;
  consistency: string;
  source_inventory: SourceInventoryFile[];
  files: ManifestFile[];
  sqlite: { integrity_check: string; quick_check: string; foreign_key_check: unknown[] };
};

export type BlobReport = {
  missing: Array<{ id: string; storage_path: string }>;
  mismatched: Array<{ id: string; storage_path: string; reasons: string[] }>;
  invalid_paths: Array<{ id: string; storage_path: string }>;
  orphans: string[];
  deleted_orphans: string[];
};

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function normalizedAbsolute(value: string): string {
  let existing = path.resolve(value);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalParent = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  return path.join(canonicalParent, ...suffix);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function safeManifestPath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) return false;
  const normalized = path.posix.normalize(relativePath);
  return normalized === relativePath && normalized !== ".." && !normalized.startsWith("../");
}

async function assertEmptyOrAbsent(target: string, message: string): Promise<void> {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${message}; symbolic-link targets are not allowed`);
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error(message);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not supported: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return result;
}

function verifySqlite(databasePath: string): { integrity_check: string; quick_check: string; foreign_key_check: unknown[] } {
  const conn = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = conn.pragma("integrity_check") as Array<Record<string, unknown>>;
    const integrity = String(Object.values(integrityRows[0] ?? {})[0] ?? "");
    const quickRows = conn.pragma("quick_check") as Array<Record<string, unknown>>;
    const quick = String(Object.values(quickRows[0] ?? {})[0] ?? "");
    const foreignKeys = conn.pragma("foreign_key_check") as unknown[];
    if (integrity !== "ok" || integrityRows.length !== 1) {
      throw new Error(`SQLite integrity_check failed: ${integrity || "no result"}`);
    }
    if (quick !== "ok") throw new Error(`SQLite quick_check failed: ${quick || "no result"}`);
    if (foreignKeys.length > 0) throw new Error(`SQLite foreign_key_check failed: ${foreignKeys.length} row(s)`);
    return { integrity_check: integrity, quick_check: quick, foreign_key_check: foreignKeys };
  } finally {
    conn.close();
  }
}

// Durable source filenames are rejected, at any depth, when a dot/dash/underscore
// delimited component is commonly used for credentials or runtime environments.
// Contents are never opened for this policy and the error never includes a path.
const PROHIBITED_DURABLE_FILENAME = /((^|[._-])(env|environment|secrets?|credentials?|password|passwd|tokens?|auth|authorization|service[_-]?accounts?|api[_-]?keys?|private[_-]?keys?|id[_-]?(rsa|dsa|ecdsa|ed25519)|npmrc|netrc)([._-]|$)|\.(key|pem|p12|pfx)$)/i;
const SECRET_SHAPED_FILENAME_ERROR = "source data contains a prohibited secret-shaped filename";

async function assertNoSecretShapedFilenames(sourceDataDir: string): Promise<void> {
  for (const relativePath of await listFiles(sourceDataDir)) {
    if (PROHIBITED_DURABLE_FILENAME.test(path.posix.basename(relativePath))) {
      throw new Error(SECRET_SHAPED_FILENAME_ERROR);
    }
  }
}

let testBackupSmokeHook: ((smokeRoot: string) => void | Promise<void>) | null = null;

export function __setTestBackupSmokeHook(hook: ((smokeRoot: string) => void | Promise<void>) | null): void {
  testBackupSmokeHook = hook;
}

async function sourceInventory(sourceDataDir: string): Promise<SourceInventoryFile[]> {
  const rows: SourceInventoryFile[] = [];
  for (const relativePath of await listFiles(sourceDataDir)) {
    const info = await stat(path.join(sourceDataDir, ...relativePath.split("/")));
    rows.push({ relative_path: relativePath, bytes: info.size });
  }
  return rows.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
}

export async function createDataBackup(args: {
  sourceDataDir: string;
  backupDir: string;
}): Promise<BackupManifest> {
  const source = normalizedAbsolute(args.sourceDataDir);
  const backup = normalizedAbsolute(args.backupDir);
  const repositoryRoot = normalizedAbsolute(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  if (backup === repositoryRoot || isInside(repositoryRoot, backup)) {
    throw new Error("backup directory must be outside the repository");
  }
  if (source === backup || isInside(source, backup) || isInside(backup, source)) {
    throw new Error("backup directory must be separate from the source data directory");
  }
  await assertEmptyOrAbsent(backup, "backup directory must be empty");
  const sourceDb = path.join(source, DB_NAME);
  if (!fs.statSync(sourceDb).isFile()) throw new Error(`SQLite database not found: ${sourceDb}`);
  await assertNoSecretShapedFilenames(source);

  const staging = `${backup}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(path.join(staging, RAW_DATA_DIR), { recursive: true });
    const conn = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try {
      await conn.backup(path.join(staging, DB_NAME));
    } finally {
      conn.close();
    }
    const sqliteRuntimeFiles = new Set([DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`, `${DB_NAME}-journal`]);
    for (const relativePath of await listFiles(source)) {
      if (sqliteRuntimeFiles.has(relativePath)) continue;
      const destination = path.join(staging, RAW_DATA_DIR, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(source, ...relativePath.split("/")), destination, {
        errorOnExist: true, force: false,
      });
    }
    const sqlite = verifySqlite(path.join(staging, DB_NAME));
    const blobs = reconcileJournalDocumentBlobs({
      dataDir: path.join(staging, RAW_DATA_DIR),
      databasePath: path.join(staging, DB_NAME),
    });
    if (blobs.invalid_paths.length || blobs.missing.length || blobs.mismatched.length) {
      throw new Error("backup journal-document blob verification failed");
    }
    const files: ManifestFile[] = [];
    for (const relativePath of await listFiles(staging)) {
      if (relativePath === MANIFEST_NAME) continue;
      const absolute = path.join(staging, relativePath);
      const info = await stat(absolute);
      files.push({ relative_path: relativePath, bytes: info.size, sha256: sha256File(absolute) });
    }
    const manifest: BackupManifest = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      source_data_dir: source,
      consistency: "SQLite is an online-consistent snapshot; journal-doc blobs require application quiescence for DB+blob consistency.",
      source_inventory: await sourceInventory(source),
      files,
      sqlite,
    };
    await writeFile(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const smokeRoot = await mkdtemp(path.join(tmpdir(), "account-research-backup-smoke-"));
    try {
      const smokeTarget = path.join(smokeRoot, "restored-data");
      if (isInside(source, smokeRoot) || isInside(backup, smokeRoot)) {
        throw new Error("isolated backup smoke path is not separate");
      }
      if (testBackupSmokeHook) await testBackupSmokeHook(smokeRoot);
      await restoreDataBackup({ backupDir: staging, targetDataDir: smokeTarget, sourceDataDir: source });
    } finally {
      await rm(smokeRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(backup)) await rmdir(backup);
    await rename(staging, backup);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function readAndValidateManifest(backup: string): BackupManifest {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(backup, MANIFEST_NAME), "utf8"));
  } catch {
    throw new Error("backup manifest is missing or invalid");
  }
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) throw new Error("unsupported backup manifest");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!safeManifestPath(file.relative_path) || seen.has(file.relative_path)) throw new Error("backup manifest contains an unsafe or duplicate path");
    seen.add(file.relative_path);
    const absolute = path.join(backup, ...file.relative_path.split("/"));
    let info;
    try { info = fs.statSync(absolute); } catch { throw new Error(`backup file missing: ${file.relative_path}`); }
    if (!info.isFile() || info.size !== file.bytes || sha256File(absolute) !== file.sha256) {
      throw new Error(`checksum mismatch: ${file.relative_path}`);
    }
  }
  if (!seen.has(DB_NAME)) throw new Error("backup manifest does not contain briefs.sqlite");
  const backupFiles: string[] = [];
  function walkBackup(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`backup contains a symbolic link: ${path.relative(backup, absolute)}`);
      if (entry.isDirectory()) walkBackup(absolute);
      else if (entry.isFile()) backupFiles.push(path.relative(backup, absolute).split(path.sep).join("/"));
    }
  }
  walkBackup(backup);
  for (const relativePath of backupFiles) {
    if (relativePath !== MANIFEST_NAME && !seen.has(relativePath)) {
      throw new Error(`backup contains an unmanifested file: ${relativePath}`);
    }
  }
  return manifest;
}

export async function restoreDataBackup(args: {
  backupDir: string;
  targetDataDir: string;
  sourceDataDir: string;
}): Promise<{ integrity_check: string; quick_check: string; foreign_key_check: unknown[]; blobs: BlobReport }> {
  const backup = normalizedAbsolute(args.backupDir);
  const target = normalizedAbsolute(args.targetDataDir);
  const source = normalizedAbsolute(args.sourceDataDir);
  if (target === source || isInside(source, target) || isInside(target, source)) {
    throw new Error("restore target must be separate from the source data directory");
  }
  if (target === backup || isInside(backup, target) || isInside(target, backup)) {
    throw new Error("restore target must be separate from the backup directory");
  }
  await assertEmptyOrAbsent(target, "restore target directory must be empty");
  const manifest = readAndValidateManifest(backup);
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { recursive: true });
    await cp(path.join(backup, DB_NAME), path.join(staging, DB_NAME), { errorOnExist: true, force: false });
    const raw = path.join(backup, RAW_DATA_DIR);
    for (const relativePath of await listFiles(raw)) {
      const destination = path.join(staging, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(raw, ...relativePath.split("/")), destination, { errorOnExist: true, force: false });
    }
    const sqlite = verifySqlite(path.join(staging, DB_NAME));
    const blobs = reconcileJournalDocumentBlobs({ dataDir: staging, databasePath: path.join(staging, DB_NAME) });
    if (blobs.invalid_paths.length || blobs.missing.length || blobs.mismatched.length) {
      throw new Error("restored journal-document blob verification failed");
    }
    if (fs.existsSync(target)) await rmdir(target);
    await rename(staging, target);
    return { ...sqlite, blobs };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

type DocumentBlobRow = { id: string; storage_path: string; content_hash: string; byte_size: number };

function canonicalBlobPath(dataDir: string, row: DocumentBlobRow): { relative: string; absolute: string } | null {
  if (!/^[a-f0-9]{64}$/i.test(row.content_hash)) return null;
  const expected = `${BLOB_DIR}/${row.content_hash.slice(0, 2).toLowerCase()}/${row.content_hash.toLowerCase()}`;
  if (row.storage_path !== expected || !safeManifestPath(row.storage_path)) return null;
  const root = path.resolve(dataDir, BLOB_DIR);
  const absolute = path.resolve(dataDir, ...row.storage_path.split("/"));
  if (!isInside(root, absolute)) return null;
  for (const candidate of [root, path.dirname(absolute), absolute]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) return null;
  }
  return { relative: expected, absolute };
}

export function reconcileJournalDocumentBlobs(args: {
  dataDir: string;
  databasePath?: string;
  cleanupOrphans?: boolean;
}): BlobReport {
  const dataDir = path.resolve(args.dataDir);
  const databasePath = path.resolve(args.databasePath ?? path.join(dataDir, DB_NAME));
  const conn = new Database(databasePath, { readonly: true, fileMustExist: true });
  let rows: DocumentBlobRow[];
  try {
    rows = conn.prepare(
      "SELECT id, storage_path, content_hash, byte_size FROM journal_documents WHERE storage_path IS NOT NULL",
    ).all() as DocumentBlobRow[];
  } finally { conn.close(); }
  const report: BlobReport = { missing: [], mismatched: [], invalid_paths: [], orphans: [], deleted_orphans: [] };
  const referenced = new Set<string>();
  for (const row of rows) {
    if (safeManifestPath(row.storage_path)) {
      const storedAbsolute = path.resolve(dataDir, ...row.storage_path.split("/"));
      if (isInside(path.resolve(dataDir, BLOB_DIR), storedAbsolute)) referenced.add(row.storage_path);
    }
    const confined = canonicalBlobPath(dataDir, row);
    if (!confined) { report.invalid_paths.push({ id: row.id, storage_path: row.storage_path }); continue; }
    referenced.add(confined.relative);
    if (!fs.existsSync(confined.absolute)) { report.missing.push({ id: row.id, storage_path: row.storage_path }); continue; }
    const reasons: string[] = [];
    const info = fs.statSync(confined.absolute);
    if (info.size !== row.byte_size) reasons.push("byte_size");
    if (sha256File(confined.absolute) !== row.content_hash.toLowerCase()) reasons.push("content_hash");
    if (reasons.length) report.mismatched.push({ id: row.id, storage_path: row.storage_path, reasons });
  }
  const blobRoot = path.join(dataDir, BLOB_DIR);
  const files: string[] = [];
  function walkSync(dir: string, destination: string[]) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not supported: ${absolute}`);
      if (entry.isDirectory()) walkSync(absolute, destination);
      else if (entry.isFile()) destination.push(path.relative(dataDir, absolute).split(path.sep).join("/"));
    }
  }
  walkSync(blobRoot, files);
  report.orphans = files.filter((file) => !referenced.has(file)).sort();
  if (args.cleanupOrphans) {
    const cleanupConn = new Database(databasePath, { fileMustExist: true });
    try {
      cleanupConn.pragma("busy_timeout = 5000");
      cleanupConn.exec("BEGIN IMMEDIATE");
      const freshRows = cleanupConn.prepare(
        "SELECT storage_path FROM journal_documents WHERE storage_path IS NOT NULL",
      ).all() as Array<{ storage_path: string }>;
      const freshReferenced = new Set(freshRows.map((row) => row.storage_path));
      const freshFiles: string[] = [];
      walkSync(blobRoot, freshFiles);
      for (const relative of freshFiles.filter((file) => !freshReferenced.has(file)).sort()) {
        const absolute = path.resolve(dataDir, ...relative.split("/"));
        if (!isInside(path.resolve(blobRoot), absolute)) throw new Error("orphan cleanup path escaped journal-docs");
        fs.rmSync(absolute, { force: true });
        report.deleted_orphans.push(relative);
      }
      cleanupConn.exec("COMMIT");
      report.orphans = freshFiles.filter((file) => !freshReferenced.has(file)).sort();
    } catch (error) {
      if (cleanupConn.inTransaction) cleanupConn.exec("ROLLBACK");
      throw error;
    } finally {
      cleanupConn.close();
    }
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const [command, first, second] = args;
  const configuredDataDir = path.dirname(path.resolve(process.env.BRIEF_DB_PATH || path.join(process.cwd(), "data", DB_NAME)));
  if (command === "backup" && first && args.length === 2) {
    console.log(JSON.stringify(await createDataBackup({ sourceDataDir: configuredDataDir, backupDir: first }), null, 2));
    return;
  }
  if (command === "restore" && first && second && args.length === 3) {
    console.log(JSON.stringify(await restoreDataBackup({ backupDir: first, targetDataDir: second, sourceDataDir: configuredDataDir }), null, 2));
    return;
  }
  if (command === "reconcile" && first && args.length <= 3 && (!second || second === "--cleanup-orphans")) {
    console.log(JSON.stringify(reconcileJournalDocumentBlobs({ dataDir: first, cleanupOrphans: second === "--cleanup-orphans" }), null, 2));
    return;
  }
  throw new Error("usage: endgameOperations.ts backup <backup-dir> | restore <backup-dir> <target-data-dir> | reconcile <data-dir> [--cleanup-orphans]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
