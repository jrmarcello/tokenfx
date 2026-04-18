#!/bin/bash
# Stop — Ralph Loop continuation hook
# Checks if a ralph-loop session is active and determines whether to loop.
# Returns exit 2 to continue looping, exit 0 to let stop-validate.sh run normally.
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SPECS_DIR="${REPO_ROOT}/.specs"

# ── Check for active ralph loop ──────────────────────────────────
# Find any .active.md file (state marker created by ralph-loop skill)
ACTIVE_FILE=$(find "$SPECS_DIR" -name "*.active.md" -type f 2>/dev/null | head -1)

# No active loop → pass through (let stop-validate.sh handle normally)
[ -z "$ACTIVE_FILE" ] && exit 0

# ── Read state ───────────────────────────────────────────────────
SPEC_FILE=$(head -1 "$ACTIVE_FILE" 2>/dev/null)
[ -z "$SPEC_FILE" ] || [ ! -f "$SPEC_FILE" ] && exit 0

# ── Loop breaker (max 30 iterations for safety) ─────────────────
COUNTER_FILE="/tmp/ralph-loop-${SESSION_ID}"
COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if [ "$COUNT" -ge 30 ]; then
  rm -f "$COUNTER_FILE" "$ACTIVE_FILE"
  echo "Ralph Loop: MAX ITERATIONS (30) reached. Stopping." >&2
  # Update spec status to FAILED
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/^## Status:.*/## Status: FAILED (max iterations)/' "$SPEC_FILE" 2>/dev/null || true
  else
    sed -i 's/^## Status:.*/## Status: FAILED (max iterations)/' "$SPEC_FILE" 2>/dev/null || true
  fi
  exit 0  # Let stop-validate run its normal validation
fi

# ── Count remaining tasks ────────────────────────────────────────
# `grep -c` already prints "0" on no-match (with exit 1). Avoid a `|| echo 0`
# fallback here — under exit 1 both would print, producing "0\n0" which then
# blows up $((TOTAL - DONE)) and leaves REMAINING unset under `set -u`.
TOTAL=$(grep -c '^\- \[[ x]\] TASK-' "$SPEC_FILE" 2>/dev/null)
DONE=$(grep -c '^\- \[x\] TASK-' "$SPEC_FILE" 2>/dev/null)
TOTAL=${TOTAL:-0}
DONE=${DONE:-0}
REMAINING=$((TOTAL - DONE))

if [ "$REMAINING" -le 0 ]; then
  # All tasks done — clean up and let stop-validate run final validation
  rm -f "$COUNTER_FILE" "$ACTIVE_FILE"
  echo "Ralph Loop: All ${TOTAL} tasks complete. Running final validation." >&2
  exit 0  # Pass through to stop-validate.sh
fi

# ── Typecheck before continuing (skip if script missing) ────────
if [ -f "${REPO_ROOT}/package.json" ] && grep -q '"typecheck"' "${REPO_ROOT}/package.json" 2>/dev/null; then
  BUILD_OUT=$(cd "$REPO_ROOT" && pnpm typecheck 2>&1)
  BUILD_STATUS=$?

  if [ "$BUILD_STATUS" -ne 0 ]; then
    echo "Ralph Loop: Task ${DONE}/${TOTAL} done but TYPECHECK FAILED. Fix the type errors, then continue with the next task." >&2
    echo "Output:" >&2
    echo "$BUILD_OUT" >&2
    exit 2  # Continue — let Claude fix
  fi
fi

# ── More tasks remain — loop ────────────────────────────────────
# Next task info for context (concise stderr message)
NEXT_TASK=$(grep '^\- \[ \] TASK-' "$SPEC_FILE" 2>/dev/null | head -1 | sed 's/^- \[ \] //')

echo "Ralph Loop: Task ${DONE}/${TOTAL} complete (iteration ${COUNT}). Next: ${NEXT_TASK}" >&2
echo "Read the spec file at ${SPEC_FILE}, execute the next uncompleted task, then stop." >&2

exit 2  # Continue the loop
