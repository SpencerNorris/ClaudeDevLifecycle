# Branch Lifecycle

## Purpose
Every branch is born with a defined end. The prior default — create
branches freely, never delete — produces 20+ stale local branches per
project, locked worktrees that the user must clean up by hand, and a
working-tree state where signal is buried under noise.

## States

A branch exists in exactly one of three states:

1. **In progress** — being worked on, may have a worktree.
2. **Ready for review** — pushed to remote, PR open, awaiting merge.
3. **Closed** — either *merged + deleted*, or *abandoned + deleted*.

There is no fourth state. "Lingering branch that might be useful
later" is not a state — it is neglected cleanup.

## At branch creation

When a branch is created:

- **Name follows convention:**
  - `dev/<topic>` — exploratory or scratch work.
  - `feat/<topic>` — new user-facing feature.
  - `fix/<topic>` — bug fix.
  - `chore/<topic>` — refactoring, deps, docs, CI.
  - Topics are short kebab-case.
- **Intent is stated** in the change report:
  > Creating branch `feat/x` for issue #N. Expected outcome: PR
  > opened, reviewed, merged.
- **Worktree intent stated** if applicable:
  > Using `isolation: "worktree"` at `.claude/worktrees/agent-12`.
  > Will be removed at session end.

## PR granularity — one per logical feature

A session that produces several features produces several branches and
several PRs: **one PR per logical feature, even small ones.** Each PR
is then independently reviewable, independently revertible, and shows
up as one clean entry when bisecting later.

Do not batch unrelated features into a single branch to save merge
clicks. The cost of an extra merge click is trivial; the cost of a PR
that mixes three concerns — unreviewable diff, all-or-nothing revert,
muddy history — is not.

The exception is changes that are genuinely one logical unit even
though they touch several areas (e.g., a rename that updates its call
sites). That is one feature, one PR — not batching.

## At branch end — merged

When a PR merges:

```bash
git checkout main
git pull
git branch -d <branch-name>          # delete local
# Remote is auto-deleted on merge if the GH repo has
# "automatically delete head branches" enabled; otherwise:
gh api -X DELETE /repos/<owner>/<repo>/git/refs/heads/<branch>
```

If the worktree is no longer needed:

```bash
git worktree remove <path>
```

State the cleanup in the report:

> Merged `feat/x` (PR #M). Local + remote branch deleted, worktree
> removed.

## At branch end — abandoned

When work on a branch is discontinued:

- State explicitly in the report:
  > Abandoning `dev/y` because <one-sentence reason>.
- Delete the local branch (force, since unmerged):
  ```bash
  git branch -D <branch-name>
  ```
- Remove any worktree:
  ```bash
  git worktree remove <path>
  ```
- If the branch was pushed, ask the user whether to delete the remote
  branch as well. Do not assume.

## End-of-session cleanup

At the end of every working session, run:

```bash
git worktree prune                              # remove dead worktree entries
git worktree list                               # confirm what remains is intentional
git branch --merged main                        # candidates for deletion
git branch | grep -E '^\s*(dev|feat|fix|chore)/' # candidates for review
```

Delete anything cleanly merged. Surface anything unmerged-but-stale to
the user with a one-line status:

> Stale branch `dev/abc`, last commit `de4f567` 2026-04-12, unmerged.
> Delete or keep?

## Worktree etiquette

- Dispatched agents using `isolation: "worktree"` get scratch
  directories under `.claude/worktrees/`. These are ephemeral.
- If a worktree-isolated agent produces work worth keeping, the work
  is merged into the parent branch and the worktree disposed.
- Do not leave 10+ agent worktrees lying around. If a session produced
  more than 3, summarize them and offer cleanup before declaring done.

## Never

- Never delete a branch the user owns without confirming.
- Never delete a remote branch without confirming.
- Never abandon work without surfacing it — abandoned-but-undeleted
  is the worst of both worlds.

## Where in-progress work-state lives

GitHub Issues is the single persistent cross-session tracker (the principle
lives in global `CLAUDE.md`; the pre-commit hook blocks ad-hoc tracker files
like `NEXT_STEPS.md` / `BACKLOG.md`). This rule owns the *branch-side* of that:
how a half-finished branch carries its own resume state.

**Cross-session resume anchor.** Work that spans sessions is resumed from three
durable places, never from an ad-hoc notes file:

- the **branch** itself (committed work — the code is the truth),
- a **live checklist in the tracking issue's body** (what's done / what
  remains) — update it at every session boundary; this is the resume anchor a
  fresh session reads first,
- a **draft PR** once there's a meaningful diff (reviewable). Before there's a
  diff, the issue checklist alone carries the state.

**Docs-vs-tracking razor.** Before writing a markdown file, ask: *does this
describe what* is*, or what* should be*?* What-is goes in `docs/` (durable
architectural knowledge). What-should-be is work — file it as an issue, and
write the doc once the work lands.

## Honesty

When listing branches in a status report, distinguish:
- Mine (created in this or recent sessions) vs. user's.
- Active vs. stale (no commits in 14+ days).
- Merged-but-not-deleted (a bug to fix) vs. abandoned (a state to act on).
