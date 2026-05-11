#!/usr/bin/env bash
set -euo pipefail

# Production health check for account-research.
# Reads APP_BASE_URL from env, falls back to web/.env.local, then a default.
# Never prints secrets (SMTP_PASS, ANTHROPIC_API_KEY, SESSION_SECRET, etc.).
# Exit 0 if no FAIL; exit 1 if any FAIL. WARNs are informational.

BRIEF_DB_PATH="${BRIEF_DB_PATH:-$HOME/account-research/web/data/briefs.sqlite}"
EXPECTED_MIGRATION="${EXPECTED_LATEST_MIGRATION:-012}"
REPO_ROOT="${REPO_ROOT:-$HOME/account-research}"

resolve_app_base_url() {
  if [[ -n "${APP_BASE_URL:-}" ]]; then
    echo "$APP_BASE_URL"
    return
  fi
  local envf="$REPO_ROOT/web/.env.local"
  if [[ -f "$envf" ]]; then
    local v
    v="$(grep -E '^APP_BASE_URL=' "$envf" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    if [[ -n "$v" ]]; then
      echo "$v"
      return
    fi
  fi
  echo "https://research.ai-lab1.com"
}

APP_BASE_URL_RESOLVED="$(resolve_app_base_url)"

FAIL=0

say() { echo "[health-check] $*"; }
pass() { say "PASS $*"; }
warn() { say "WARN $*"; }
fail() { say "FAIL $*"; FAIL=1; }

# 1. Git commit
if cd "$REPO_ROOT" 2>/dev/null && git rev-parse --short HEAD >/dev/null 2>&1; then
  pass "git commit $(git rev-parse --short HEAD)"
else
  warn "git commit unknown (repo not at $REPO_ROOT)"
fi

# 2 + 3. PM2 status (per app, parsed from jlist)
check_pm2_app() {
  local name="$1"
  if ! command -v pm2 >/dev/null 2>&1; then
    fail "pm2 not installed; cannot check $name"
    return
  fi
  local status
  status="$(pm2 jlist 2>/dev/null \
    | python3 -c "import json,sys
data=json.load(sys.stdin)
for a in data:
  if a.get('name')=='$name':
    print(a.get('pm2_env',{}).get('status','unknown'))
    break
else:
  print('missing')" 2>/dev/null || echo "unknown")"
  if [[ "$status" == "online" ]]; then
    pass "pm2 $name online"
  else
    fail "pm2 $name status=$status"
  fi
}
check_pm2_app "account-brief"
check_pm2_app "account-brief-worker"

# 4. HTTPS HEAD
code="$(curl -sI -o /dev/null -w '%{http_code}' --max-time 10 "$APP_BASE_URL_RESOLVED" || echo "000")"
if [[ "$code" =~ ^[23] ]]; then
  pass "HTTPS HEAD $APP_BASE_URL_RESOLVED -> $code"
else
  fail "HTTPS HEAD $APP_BASE_URL_RESOLVED -> $code"
fi

# 5. SQLite integrity
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$BRIEF_DB_PATH" ]]; then
  integ="$(sqlite3 "$BRIEF_DB_PATH" 'PRAGMA integrity_check' 2>/dev/null | head -n1 || echo "error")"
  if [[ "$integ" == "ok" ]]; then
    pass "sqlite integrity_check ok"
  else
    fail "sqlite integrity_check=$integ"
  fi
else
  fail "sqlite3 missing or DB path not found: $BRIEF_DB_PATH"
fi

# 6. Latest migration
if [[ -f "$BRIEF_DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
  latest="$(sqlite3 "$BRIEF_DB_PATH" 'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1' 2>/dev/null || echo "")"
  if [[ -n "$latest" ]]; then
    if [[ "$latest" == *"$EXPECTED_MIGRATION"* ]]; then
      pass "latest migration $latest"
    else
      warn "latest migration $latest (expected to contain $EXPECTED_MIGRATION)"
    fi
  else
    warn "no migrations recorded"
  fi
fi

# 7. Queued/running jobs
if [[ -f "$BRIEF_DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
  qrun="$(sqlite3 "$BRIEF_DB_PATH" "SELECT COUNT(*) FROM research_jobs WHERE status IN ('queued','running')" 2>/dev/null || echo "?")"
  if [[ "$qrun" =~ ^[0-9]+$ ]] && (( qrun > 5 )); then
    warn "queued/running jobs=$qrun (> 5 — possible stuck queue)"
  else
    pass "queued/running jobs=$qrun"
  fi
fi

# 8. Latest failed jobs (last 5)
if [[ -f "$BRIEF_DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
  echo "[health-check] last 5 failed jobs:"
  sqlite3 -separator '|' "$BRIEF_DB_PATH" \
    "SELECT id, account_name, finished_at, substr(COALESCE(error,''), 1, 80)
     FROM research_jobs WHERE status='failed'
     ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 5" 2>/dev/null \
    | awk -F'|' '{printf "  - %s | %s | %s | %s\n", $1, $2, $3, $4}' \
    || true
fi

# 9. PM2 log scan, per app
scan_app_logs() {
  local name="$1"
  if ! command -v pm2 >/dev/null 2>&1; then return; fi
  local logs
  logs="$(pm2 logs --nostream --lines 500 "$name" 2>/dev/null || true)"
  local count
  count="$(echo "$logs" | grep -ciE 'zod|send_failed|unhandledrejection|exception|failed job' || true)"
  if [[ "$count" =~ ^[0-9]+$ ]] && (( count > 0 )); then
    warn "$name: $count suspect log line(s) in last 500"
    echo "$logs" | grep -iE 'zod|send_failed|unhandledrejection|exception|failed job' | tail -n 5 | sed 's/^/    /'
  else
    pass "$name: no suspect log lines in last 500"
  fi
}
scan_app_logs "account-brief"
scan_app_logs "account-brief-worker"

if (( FAIL > 0 )); then
  say "RESULT: FAIL"
  exit 1
fi
say "RESULT: OK"
exit 0
