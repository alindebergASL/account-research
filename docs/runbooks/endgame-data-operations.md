# Endgame data operations runbook

Status: local operational tooling only. Task 7 does not deploy to production, change production configuration, invoke providers, or authorize replacing a live data directory.

## Safety model

Run operator entrypoints from the repository root. `BRIEF_DB_PATH` identifies the configured SQLite database; the source data directory is its parent. If unset, it is `web/data/briefs.sqlite`. Keep `PROVIDER_CALLS_ENABLED=0`. These commands do not call Hermes or any provider.

The SQLite backup API produces an online-consistent database snapshot and the manifest inventories source WAL/SHM/journal files. Blob copying is separate: the backup is only DB+blob consistent when uploads and all other data writes are quiesced for the whole command. Do not claim point-in-time DB+blob atomicity without that maintenance window.

## Backup and checksums

Choose a new, empty path outside both the source tree and repository, quiesce application/worker writes, then run:

```bash
PROVIDER_CALLS_ENABLED=0 BRIEF_DB_PATH=/tmp/endgame-source/briefs.sqlite \
  ./scripts/backup-web-data.sh /tmp/endgame-backup
```

The published backup is deliberately a directory, not a tar/zip archive: it contains an online SQLite snapshot, every non-SQLite source data file under `raw-data/`, and `manifest.json`. The manifest records every copied relative path, byte count, and SHA-256 digest, plus full source inventory (including SQLite WAL/SHM/journal files) and the copied database's `integrity_check`, optional defense-in-depth `quick_check`, and `foreign_key_check` results.

Before copying or publishing, the command rejects secret-shaped filenames at any depth without reading contents or printing the offending path. The conservative case-insensitive policy rejects dot/dash/underscore-delimited filename components commonly shaped as `env`, `environment`, `secret`, `credential`, `password`/`passwd`, `token`, `auth`, service-account, API/private-key, SSH private-key, npm/netrc credential names, and `.key`, `.pem`, `.p12`, or `.pfx` suffixes. Keep such files outside durable `web/data` storage.

The command verifies every referenced journal-document path, size, and SHA-256 against the staged snapshot. It then automatically restores the staged directory into an isolated operating-system temporary directory and repeats manifest checks, checksums, SQLite integrity/quick/FK checks, and blob reconciliation. The temporary restore is outside the source and final destination and is removed on success or failure. Only after that smoke passes is the staging directory atomically renamed to the requested backup path. A failed check removes staging and never publishes the requested directory. It also refuses a nonempty backup path, a repository path, a path inside/around the source, symlinks, and copy failures. Retain source quiescence until the command exits.

The legacy `scripts/backup-briefs.sh` name is only a compatibility wrapper for this same full-data operation. It is no longer a SQLite-only gzip command and exits nonzero when the configured source database is absent.

## Isolated restore smoke

Never point the restore target at the configured source, anywhere inside it, or a directory containing it. The target must be absent or empty:

```bash
PROVIDER_CALLS_ENABLED=0 BRIEF_DB_PATH=/tmp/endgame-source/briefs.sqlite \
  ./scripts/restore-web-data.sh /tmp/endgame-backup /tmp/endgame-isolated-restore
```

Before materialization, restore validates the manifest, every size and SHA-256, rejects missing or unmanifested files, and refuses unsafe paths. It materializes into a sibling staging directory, then runs SQLite `integrity_check`, `quick_check`, `foreign_key_check`, and journal blob reconciliation. Only a fully verified staging tree is renamed into the isolated target. Any failure removes staging and leaves the requested target unactivated. For disaster recovery, the configured source database and data directory may already be absent. Their configured path remains a protected boundary: restore still refuses a target equal to, inside, or containing that source data path. The entrypoint has no implicit live replacement or force mode.

Run a separate read-only inventory if desired:

```bash
cd web && PROVIDER_CALLS_ENABLED=0 npm run ops:reconcile-blobs -- /tmp/endgame-isolated-restore
```

A clean report has empty `missing`, `mismatched`, `invalid_paths`, and `orphans` arrays. `mismatched.reasons` distinguishes `byte_size` and `content_hash` defects.

## Orphan reconciliation and rollback

Reconciliation reports only by default. Investigate missing, mismatched, and invalid/traversal DB paths; it never repairs those records automatically. Cleanup is explicit:

```bash
cd web
PROVIDER_CALLS_ENABLED=0 npm run ops:reconcile-blobs -- /tmp/endgame-isolated-restore --cleanup-orphans
```

Cleanup starts a fresh rescan under an immediate SQLite write lock and deletes only files whose relative paths are absent from every `journal_documents.storage_path`. DB-referenced files, including safely confined but structurally invalid references, are preserved. Keep uploads quiesced during operator reconciliation.

If backup or restore verification fails, do not activate its output: preserve the prior known-good data directory, retain logs/manifest for diagnosis, and create a new backup or restore target after correcting the cause. Swapping an isolated target into a live service and production rollback are intentionally outside this Task 7 runbook's authorization.

## Migration 031 startup repair

`scripts/prod-health-check.sh` requires the latest migration ID to equal canonical `031_journal_radar_checkpoints` exactly; prefixes, suffixes, and the stale migration 012 value fail. The same health gate performs a read-only readiness import/syntax check of the full-data backup/restore implementation and operator entrypoints. It does not create a backup or touch application data.

At startup, a ledger row for `031_journal_radar_checkpoints` is not trusted by itself. The runner verifies the table's columns, composite primary key, cascading foreign keys, and user/reviewed index. A missing table or index is recreated transactionally. An incompatible empty partial table is transactionally rebuilt. An incompatible table with rows fails startup without dropping, rewriting, or synthesizing data; restore the prior application version or repair from an operator-reviewed backup before retrying. The existing migration ID remains authoritative; no additional migration is introduced.

## Upload rollback behavior

New uploads fail closed if original-byte persistence fails. Database failure after a newly created content-addressed blob triggers confined cleanup only after confirming no `journal_documents` row references that path. Existing/shared blobs are preserved. Use the reconciliation report to detect historical orphans; never manually delete a DB-referenced blob.

## Provider and Hermes gates

Keep `PROVIDER_CALLS_ENABLED=0` for all data operations. A Hermes-enabled runtime requires `HERMES_SERVICE_TOKEN`; the web/worker client and loopback runtime service must use the same nonempty token. Do not print it, place it in command history, manifests, or reports, or pass it to these scripts. Task 7 performs no Hermes health call, provider validation, deployment, or flag enablement.
