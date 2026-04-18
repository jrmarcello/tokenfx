#!/bin/bash
# WorktreeRemove — Clean up worktree branch and references
set -uo pipefail

INPUT=$(cat)
WORKTREE_PATH=$(echo "$INPUT" | jq -r '.worktree_path // empty')

[ -z "$WORKTREE_PATH" ] && exit 0

# Detect the branch before the worktree is removed
BRANCH=""
if [ -d "$WORKTREE_PATH/.git" ] || [ -f "$WORKTREE_PATH/.git" ]; then
  BRANCH=$(git -C "$WORKTREE_PATH" branch --show-current 2>/dev/null || true)
fi

# Remove the git worktree
echo "Removing worktree at ${WORKTREE_PATH}..." >&2
git worktree remove "$WORKTREE_PATH" --force >&2 || true

# Clean up leftover directory
rm -rf "$WORKTREE_PATH" 2>/dev/null || true

# Prune stale worktree references
git worktree prune >&2 || true

# Delete the worktree branch (only worktree-* branches, safety check)
if [ -n "$BRANCH" ] && [[ "$BRANCH" == worktree-* ]]; then
  # Only delete if fully merged into develop or main
  if git branch --merged develop 2>/dev/null | grep -q "$BRANCH"; then
    git branch -d "$BRANCH" >&2 || true
    echo "Deleted merged branch ${BRANCH}" >&2
  elif git branch --merged main 2>/dev/null | grep -q "$BRANCH"; then
    git branch -d "$BRANCH" >&2 || true
    echo "Deleted merged branch ${BRANCH}" >&2
  else
    echo "Branch ${BRANCH} has unmerged changes — keeping it" >&2
  fi
fi

exit 0
