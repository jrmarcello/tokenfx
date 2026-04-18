#!/bin/bash
# PreToolUse[Bash] — Block dangerous patterns not caught by permission deny rules
set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Block staging .env files (secrets)
if echo "$COMMAND" | grep -qE 'git\s+add\s+(.+\s+)*\.env(\s|$)'; then
  deny "Blocked: .env files contain secrets and must never be committed"
fi

# Block git add -A / git add . (may catch .env or binaries)
if echo "$COMMAND" | grep -qE 'git\s+add\s+(-A|--all|\.)(\s|$)'; then
  deny "Blocked: use 'git add <specific-files>' instead of bulk staging to avoid committing secrets or binaries"
fi

# Block dropping databases
if echo "$COMMAND" | grep -qiE 'DROP\s+(DATABASE|TABLE|SCHEMA)\s'; then
  deny "Blocked: DROP statements are destructive. Use migrations instead"
fi

# Block --no-verify on git commit/push (skip hooks = skip safety)
if echo "$COMMAND" | grep -qE 'git\s+(commit|push)\s+.*--no-verify'; then
  deny "Blocked: --no-verify skips pre-commit hooks which enforce code quality"
fi

exit 0
