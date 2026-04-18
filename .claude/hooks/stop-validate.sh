#!/bin/bash
# Stop — Post-implementation validation gate for TS/Next.js
# Tiers:
#   1st attempt  → typecheck + lint + tests
#   2nd attempt  → typecheck only (fast fail-safe)
#   3rd+ attempt → pass (avoid infinite loop)
set -uo pipefail

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# ── Loop breaker ────────────────────────────────────────────────────
COUNTER_FILE="/tmp/claude-validate-${SESSION_ID}"
COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if [ "$COUNT" -ge 3 ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

# ── Skip during active Ralph Loop (intermediate iterations) ────────
SPECS_DIR="${REPO_ROOT}/.specs"
if find "$SPECS_DIR" -name "*.active.md" -type f 2>/dev/null | head -1 | grep -q .; then
  exit 0
fi

# ── Detect TS/TSX changes ──────────────────────────────────────────
CHANGED_FILES=""
CHANGED_FILES+=$(git -C "$REPO_ROOT" diff --name-only 2>/dev/null || true)
CHANGED_FILES+=$'\n'
CHANGED_FILES+=$(git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null || true)
CHANGED_FILES+=$'\n'
CHANGED_FILES+=$(git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null || true)

TS_CHANGES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx)$' | sort -u || true)

# No TS changes → pass
if [ -z "$TS_CHANGES" ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

# ── Detect package.json scripts ────────────────────────────────────
PKG_JSON="${REPO_ROOT}/package.json"
if [ ! -f "$PKG_JSON" ]; then
  # No package.json yet — bootstrap phase
  rm -f "$COUNTER_FILE"
  exit 0
fi

has_script() {
  jq -e --arg name "$1" '.scripts[$name] // empty' "$PKG_JSON" >/dev/null 2>&1
}

ERRORS=""

cd "$REPO_ROOT"

if [ "$STOP_HOOK_ACTIVE" != "true" ]; then
  # ── Tier 1: typecheck + lint + tests ─────────────────────────────
  if has_script typecheck; then
    TC_OUT=$(pnpm typecheck 2>&1) || ERRORS="${ERRORS}TYPECHECK FAILED:\n${TC_OUT}\n\n"
  fi
  if [ -z "$ERRORS" ] && has_script lint; then
    LINT_OUT=$(pnpm lint 2>&1) || ERRORS="${ERRORS}LINT FAILED:\n${LINT_OUT}\n\n"
  fi
  if [ -z "$ERRORS" ] && has_script test; then
    TEST_OUT=$(pnpm test --run --silent 2>&1) || ERRORS="${ERRORS}TEST FAILURES:\n${TEST_OUT}\n\n"
  fi
else
  # ── Tier 2: typecheck only ───────────────────────────────────────
  if has_script typecheck; then
    TC_OUT=$(pnpm typecheck 2>&1) || ERRORS="TYPECHECK FAILED:\n${TC_OUT}\n\n"
  fi
fi

# ── Result ─────────────────────────────────────────────────────────
if [ -n "$ERRORS" ]; then
  printf "Post-implementation validation FAILED:\n\n%b" "$ERRORS" >&2
  exit 2
fi

rm -f "$COUNTER_FILE"
exit 0
