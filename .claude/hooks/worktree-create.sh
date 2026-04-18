#!/bin/bash
# WorktreeCreate — Create git worktree and run project setup (TS/Next.js)
# Replaces default git worktree behavior. Must print worktree path to stdout.
set -euo pipefail

INPUT=$(cat)
NAME=$(echo "$INPUT" | jq -r '.name')

REPO_ROOT=$(git rev-parse --show-toplevel)
SAFE_NAME=$(echo "$NAME" | tr '/' '-')
WORKTREE_DIR="${REPO_ROOT}/.claude/worktrees/${SAFE_NAME}"
BRANCH="worktree-${NAME}"

# ── Determine base branch ────────────────────────────────────────
# Prefer origin/main, fallback to origin/HEAD
if git rev-parse --verify "origin/main" &>/dev/null; then
  BASE="origin/main"
else
  DEFAULT=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@' || echo "main")
  BASE="origin/${DEFAULT}"
fi

echo "Creating worktree '${NAME}' from ${BASE}..." >&2

# ── Fetch latest ──────────────────────────────────────────────────
git fetch origin >&2 || true

# ── Create git worktree ──────────────────────────────────────────
mkdir -p "$(dirname "$WORKTREE_DIR")"

if git rev-parse --verify "$BRANCH" &>/dev/null; then
  echo "Reusing existing branch ${BRANCH}" >&2
  git worktree add "$WORKTREE_DIR" "$BRANCH" >&2
else
  git worktree add "$WORKTREE_DIR" -b "$BRANCH" "$BASE" >&2
fi

cd "$WORKTREE_DIR"

# ── Project setup ────────────────────────────────────────────────

# 0. Ensure git identity (inherit from main repo → global → env vars → warn)
if [ -z "$(git config user.email 2>/dev/null)" ]; then
  MAIN_EMAIL=$(git -C "${REPO_ROOT}" config user.email 2>/dev/null || echo "${GIT_AUTHOR_EMAIL:-}")
  MAIN_NAME=$(git -C "${REPO_ROOT}" config user.name 2>/dev/null || echo "${GIT_AUTHOR_NAME:-}")
  if [ -n "$MAIN_EMAIL" ] && [ -n "$MAIN_NAME" ]; then
    git config user.email "$MAIN_EMAIL"
    git config user.name "$MAIN_NAME"
    echo "Git identity: ${MAIN_NAME} <${MAIN_EMAIL}>" >&2
  else
    echo "WARNING: Git identity not configured. Commits will fail." >&2
  fi
fi

# 1. Install Node dependencies
if command -v pnpm &>/dev/null; then
  if [ -f "pnpm-lock.yaml" ]; then
    echo "Installing pnpm dependencies (frozen lockfile)..." >&2
    pnpm install --frozen-lockfile >&2 || pnpm install >&2
  else
    echo "Installing pnpm dependencies..." >&2
    pnpm install >&2
  fi
else
  echo "WARNING: pnpm not found — skipping dependency install" >&2
fi

# 2. Copy .env from main project (not tracked by git)
if [ -f "${REPO_ROOT}/.env" ]; then
  cp "${REPO_ROOT}/.env" "$WORKTREE_DIR/.env"
  echo "Copied .env from main project" >&2
elif [ -f "${REPO_ROOT}/.env.example" ]; then
  cp "${REPO_ROOT}/.env.example" "$WORKTREE_DIR/.env"
  echo "Copied .env.example as .env (review settings)" >&2
fi

# 3. Copy local settings (not tracked by git)
if [ -f "${REPO_ROOT}/.claude/settings.local.json" ]; then
  mkdir -p "$WORKTREE_DIR/.claude"
  cp "${REPO_ROOT}/.claude/settings.local.json" "$WORKTREE_DIR/.claude/settings.local.json"
  echo "Copied .claude/settings.local.json" >&2
fi

# 4. Copy local SQLite DB if it exists (speeds up worktree bootstrapping)
if [ -f "${REPO_ROOT}/data/dashboard.db" ]; then
  mkdir -p "$WORKTREE_DIR/data"
  cp "${REPO_ROOT}/data/dashboard.db" "$WORKTREE_DIR/data/dashboard.db"
  echo "Copied data/dashboard.db from main project" >&2
fi

# 5. Verify typecheck (skip if script missing)
if command -v pnpm &>/dev/null && [ -f "package.json" ]; then
  if jq -e '.scripts.typecheck // empty' package.json >/dev/null 2>&1; then
    echo "Verifying typecheck..." >&2
    if pnpm typecheck >&2; then
      echo "Typecheck OK" >&2
    else
      echo "WARNING: Typecheck failed — dependencies or code may need updating" >&2
    fi
  fi
fi

echo "" >&2
echo "Worktree ready: ${WORKTREE_DIR}" >&2
echo "Branch: ${BRANCH} (based on ${BASE})" >&2

# Return the worktree path (stdout — Claude Code reads this)
echo "$WORKTREE_DIR"
