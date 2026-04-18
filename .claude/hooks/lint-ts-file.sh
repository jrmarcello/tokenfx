#!/bin/bash
# PostToolUse[Edit|Write] — Lint TypeScript/JavaScript file via ESLint
set -uo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only lint JS/TS files
if ! [[ "$FILE_PATH" =~ \.(ts|tsx|js|jsx|mjs|cjs)$ ]]; then
  exit 0
fi

# Skip missing files (e.g., deleted)
[[ ! -f "$FILE_PATH" ]] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Graceful bootstrap: skip if eslint isn't available yet
if ! [ -x "${REPO_ROOT}/node_modules/.bin/eslint" ] && ! command -v eslint >/dev/null 2>&1; then
  echo "lint-ts-file: eslint not installed yet — skipping" >&2
  exit 0
fi

# Prefer pnpm exec so it picks up the project's eslint config and plugins
OUT=$(cd "$REPO_ROOT" && pnpm exec eslint --max-warnings=0 --no-error-on-unmatched-pattern "$FILE_PATH" 2>&1)
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  printf "ESLint failed for %s:\n%s\n" "$FILE_PATH" "$OUT" >&2
  exit 2
fi

exit 0
