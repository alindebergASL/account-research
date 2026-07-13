#!/usr/bin/env bash
# safety-grep.sh
#
# Reports occurrences of safety-sensitive patterns in the PR diff. Always
# emits a workflow-summary table classifying hits by path. Fails (exit 1)
# only if a hit lands in a BLOCKING path:
#   - web/app/api/share/**
#   - web/app/s/**
#   - any migration directory (matches /migrations/ in the path)
#   - any "production" config (matches /production in the path)
#
# Hits in tests/, docs/, the real-anthropic adapter file, or hits that
# appear only inside comment lines are treated as ALLOWED (informational).
#
# Cross-refs:
#   docs/BLOCKERS.md
#   docs/runbooks/phase-a7-paid-model-validation.md
#
# Usage: safety-grep.sh <base_sha> <head_sha>

set -uo pipefail

BASE_SHA="${1:-}"
HEAD_SHA="${2:-}"

if [[ -z "$BASE_SHA" ]]; then
  echo "safety-grep: missing BASE_SHA argument" >&2
  exit 2
fi

if [[ -z "$HEAD_SHA" ]]; then
  echo "safety-grep: missing HEAD_SHA argument" >&2
  exit 2
fi

# Same pattern set documented in the A.7 PR runbooks.
PATTERN='fetch[(]|anthropic|openai|resend|NEXT_PUBLIC|feature flag|app/s|api/share|UPDATE briefs|INSERT INTO briefs|write.brief_json|brief_json.UPDATE|password|secret|api_key|private_key|ANTHROPIC_API_KEY|OPENAI_API_KEY'

SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

{
  echo "## safety-grep report"
  echo ""
  echo "Base: \`$BASE_SHA\`"
  echo "Head: \`$HEAD_SHA\`"
  echo ""
} >> "$SUMMARY_FILE"

# Pull the diff between base and head (three-dot: changes on head since
# merge-base with base).
if ! DIFF="$(git diff "$BASE_SHA"..."$HEAD_SHA")"; then
  echo "safety-grep: failed closed: unable to produce diff for base '$BASE_SHA' and head '$HEAD_SHA'." >&2
  exit 2
fi
if [[ -z "$DIFF" ]]; then
  echo "_No diff between base and head._" >> "$SUMMARY_FILE"
  echo "safety-grep: empty diff; nothing to scan."
  exit 0
fi

# Extract only added lines (those starting with '+', excluding the '+++' file
# header lines), keeping track of the current file path so we can classify
# each hit by location.
if ! RAW_HITS="$(
  awk -v pat="$PATTERN" '
    /^diff --git / {
      # parse "diff --git a/<path> b/<path>"
      n = split($0, parts, " ")
      path = parts[n]
      sub(/^b\//, "", path)
      next
    }
    /^\+\+\+ / { next }
    /^--- /    { next }
    /^@@/      { next }
    /^\+/ {
      line = substr($0, 2)
      if (line ~ pat) {
        # Crude comment detection: lines starting with // or # or * (after
        # leading whitespace) are treated as comments.
        trimmed = line
        sub(/^[[:space:]]+/, "", trimmed)
        is_comment = "false"
        if (trimmed ~ /^(\/\/|#|\*|<!--)/) is_comment = "true"
        printf "%s\t%s\t%s\n", path, is_comment, line
      }
    }
  ' <<< "$DIFF"
)"; then
  echo "safety-grep: failed closed: awk extraction failed." >&2
  exit 2
fi

if [[ -z "$RAW_HITS" ]]; then
  echo "_No safety-pattern hits in added lines._" >> "$SUMMARY_FILE"
  echo "safety-grep: clean."
  exit 0
fi

# Classify each hit.
BLOCKING=0
ALLOWED_COUNT=0
BLOCKING_COUNT=0

{
  echo "| Path | Classification | Comment? | Snippet |"
  echo "|------|----------------|----------|---------|"
} >> "$SUMMARY_FILE"

while IFS=$'\t' read -r path is_comment snippet; do
  [[ -z "$path" ]] && continue

  classification="allowed"

  # Blocking paths
  if [[ "$path" == web/app/api/share/* ]] \
     || [[ "$path" == web/app/s/* ]] \
     || [[ "$path" == *"/migrations/"* ]] \
     || [[ "$path" == *"/production"* ]] \
     || [[ "$path" == *"/production/"* ]]; then
    classification="BLOCKING"
  fi

  # Always-allowed locations override blocking only when in safe zones.
  if [[ "$path" == tests/* ]] \
     || [[ "$path" == docs/* ]] \
     || [[ "$path" == "web/lib/accountGraph/validationPipeline/adapters/realAnthropic.ts" ]]; then
    classification="allowed"
  fi

  # Pure-comment hits are always informational.
  if [[ "$is_comment" == "true" ]]; then
    classification="allowed (comment)"
  fi

  # Trim snippet for table rendering.
  short="${snippet:0:120}"
  short="${short//|/\\|}"

  printf "| %s | %s | %s | \`%s\` |\n" "$path" "$classification" "$is_comment" "$short" >> "$SUMMARY_FILE"

  if [[ "$classification" == "BLOCKING" ]]; then
    BLOCKING_COUNT=$((BLOCKING_COUNT + 1))
    BLOCKING=1
  else
    ALLOWED_COUNT=$((ALLOWED_COUNT + 1))
  fi
done <<< "$RAW_HITS"

{
  echo ""
  echo "**Totals:** allowed=$ALLOWED_COUNT, blocking=$BLOCKING_COUNT"
} >> "$SUMMARY_FILE"

if [[ "$BLOCKING" -eq 1 ]]; then
  echo "safety-grep: $BLOCKING_COUNT blocking hit(s) found." >&2
  exit 1
fi

echo "safety-grep: $ALLOWED_COUNT allowed hit(s), 0 blocking."
exit 0
