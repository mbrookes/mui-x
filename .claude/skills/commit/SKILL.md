---
name: commit
description: Use when the user types `/commit` or asks to commit work, especially in a shared or contaminated working tree. Stages only changes made during this session, splits them into separate logically-scoped commits, and verifies each diff (typecheck/tests/lint) before committing.
version: '1.0.0'
---

# Commit session changes

Produce clean, atomic commits from a possibly-messy working tree. Never assume the whole tree is yours to commit.

## Workflow

1. **Survey the tree.** Run `git status` and `git diff` (and `git diff --staged`). Identify which changes belong to _this session's_ work versus pre-existing/unrelated noise.

2. **Scope out contamination.** Only stage changes you made this session. If you are unsure whether a change is yours, ask before including it. Use hunk-level staging (`git add -p`) when a single file mixes session work with unrelated changes.

3. **Group by logical concern.** Split the session changes into separate commits, one per coherent unit of work (e.g. a bug fix, a rename, a docs update). Don't bundle unrelated concerns into one commit.

4. **Verify before each commit.** For the staged subset, run the relevant checks and read the output:
   - `pnpm typescript` (or the scoped `--filter` variant for the touched package)
   - relevant tests: `pnpm test:unit --project "<pkg>" --run`
   - `pnpm eslint` / `pnpm prettier` on changed files
     Only proceed once they pass. Show me the result if anything fails.

5. **Write the message.** Follow the repo's existing commit style (check `git log --oneline -20`). Match the prevailing `type(scope): subject` convention.

6. **Branch safety.** If on the default branch (`master`), create a branch first. Commit or push only when asked.

7. **Report.** After committing, show the resulting commit graph (`git log --oneline -<n>`) so the scoping is verifiable.

## Notes

- Prefer explicit `if/else` or early returns over nested ternaries in any code touched along the way.
- Co-author trailer for commits, per repo convention:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
