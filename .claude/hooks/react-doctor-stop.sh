#!/usr/bin/env bash
# React Doctor regression gate — fires on Stop (in background via asyncRewake).
#
# Scans only the NEW error-severity issues introduced by the current React
# changes (modified + brand-new files) vs HEAD. If any are found, exits 2 so
# the agent is re-woken to fix them before finishing. Retries are bounded so an
# unfixable regression can't loop forever.
#
# Mirrors the react-doctor skill's "after making React code changes, check the
# score did not regress" step, automated at end-of-turn.

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" || exit 0

# Stop-hook stdin carries session_id (keys the per-session retry count).
input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // "nosession"' 2>/dev/null || echo "nosession")

# Cheap guard: do nothing unless React files changed. Covers both modified
# tracked files and brand-new untracked files. Keeps the hook off conversational
# turns and off clean trees, and avoids paying npx's monorepo-enumeration cost.
modified=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(tsx|jsx)$' || true)
untracked=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(tsx|jsx)$' || true)
if [ -z "$modified" ] && [ -z "$untracked" ]; then
  exit 0
fi

# git diff (and therefore react-doctor --scope changed) can't see untracked
# files. Mark them intent-to-add so they show in the diff — this stages NO
# content, only the path. The trap restores the untracked state on ANY exit
# (including kill/error), so the working tree is left exactly as we found it.
restore_untracked() {
  if [ -n "$untracked" ]; then
    # shellcheck disable=SC2086
    git reset -q -- $untracked 2>/dev/null || true
  fi
}
trap restore_untracked EXIT
if [ -n "$untracked" ]; then
  # shellcheck disable=SC2086
  git add -N -- $untracked 2>/dev/null || true
fi

MAX_ATTEMPTS=3
counter_file="${TMPDIR:-/tmp}/react-doctor-attempts-${session_id}"
attempts=$(cat "$counter_file" 2>/dev/null || echo 0)

# Only NEW error-severity issues vs HEAD. --no-score skips the hosted score API
# (faster, offline-friendly); --no-dead-code skips the slow repo-wide pass.
out=$(npx react-doctor@latest --scope changed --base HEAD \
  --no-dead-code --no-score --blocking error --verbose 2>&1)
code=$?

if [ "$code" -eq 0 ]; then
  rm -f "$counter_file"
  exit 0
fi

attempts=$((attempts + 1))
echo "$attempts" > "$counter_file"

if [ "$attempts" -gt "$MAX_ATTEMPTS" ]; then
  rm -f "$counter_file"
  printf '{"systemMessage":"React Doctor still reports new issues after %s auto-fix attempts — stopping. Review manually with: npx react-doctor --scope changed"}\n' "$MAX_ATTEMPTS"
  exit 0
fi

echo "React Doctor found NEW error-severity issues in your React changes (attempt ${attempts}/${MAX_ATTEMPTS}). Fix these regressions before finishing, then stop again to re-verify:"
echo
echo "$out"
exit 2
