# Workflow Autonomy Rules

## Purpose
Make long-running and overnight Claude Code sessions productive and safe without
human babysitting. These rules govern how to handle approval gates, model
selection, sub-agent design, parallelism, and graceful exit when blocked.

## Fail-soft, don't block
- If a tool call is denied, times out, or hits a usage limit mid-task, treat it
  as a signal to checkpoint — not a signal to wait.
- Before exiting:
  1. Commit any durable work to the current branch.
  2. Post a checkpoint comment on the work's GitHub issue (format below) — the
     issue is the single cross-session tracker (per the constitution's
     single-tracker principle and `branch-lifecycle.md`). Never write a
     `NEXT_STEPS.md` or other ad-hoc markdown tracker; the pre-commit hook
     blocks them and they compete with the issue as the source of truth.
  3. End the turn cleanly.
- Do not sit idle waiting for human approval that may not arrive for hours.
- The only exception: a single retry is acceptable if the denial was clearly
  recoverable (typo in command, missing flag). Anything systemic — tool not in
  allow-list, sub-agent missing a tool, API rate limit — fails soft immediately.

## Commit at task boundaries
- When executing a multi-task plan (`docs/superpowers/plans/*.md` or
  equivalent), commit after each numbered task before starting the next.
- Uncommitted work across task boundaries is a bug. It blocks safe resumption
  and makes parallel sub-agent work dangerous.
- This applies to sub-agents too: a sub-agent dispatched for Tasks 1–4 that
  completes 3 must commit or document the 4th as blocked before returning.
- Exception: trivially small tasks (< 5 line change) may be batched into a
  following task's commit, but the first task of the batch must still leave
  the repo in a consistent state.

## Model tier selection
- **Default to Sonnet** for almost all work: orchestration, implementation,
  planning, code review, security audit, debugging with reasonable signal.
- **Escalate to Opus per-task, not as a standing tier**, when the task is
  visibly reasoning-heavy and Sonnet's output would be thin:
  - novel algorithm design
  - genuinely ambiguous architecture calls
  - complex debugging with sparse signal
  - state-machine or distributed-system reasoning
- **Do not assign Opus as the default `model:` in any agent frontmatter.** Opus
  is a per-dispatch escalation via the `model` argument on `Agent`. If an
  agent's work is consistently reasoning-heavy, dispatch it with Opus per call
  rather than baking Opus into the agent definition.
- **Haiku** stays for pattern-follow work: test writing, adapter boilerplate,
  migration files, CLI scaffolding, formulaic refactors.
- Rationale: Opus is ~5x the token cost and, as of early 2026, user reports of
  performance regressions make "Opus by default" no longer an obvious win. The
  tier discipline adapts naturally if Opus quality rebounds — just relax the
  escalation bar.

## Sub-agent tool scopes
- Every implementation sub-agent's frontmatter `tools:` must include at
  minimum: `Bash, Read, Write, Edit, Glob, Grep`.
- Read-only agents (security, audit, review, compliance) explicitly omit
  `Bash, Write, Edit` — they get `Read, Glob, Grep` only.
- An implementation sub-agent without Bash cannot run tests, lint, typecheck,
  or commit its own work. That is a bug in the agent definition.
- When creating a new agent via the `build-team` skill or manually, audit
  against this rule before saving.
- If a sub-agent returns with work uncommitted because Bash was denied, the
  fix is to add Bash to the agent frontmatter — not to work around the gap in
  the parent session.

## Parallel-first posture
- When entering a new phase of work, default to dispatching multiple sub-agents
  in parallel before doing serial planning. A typical opening:
  - `Explore` on the relevant module
  - a domain specialist reading the design spec
  - `code-reviewer` or similar reading the prior phase's diff
- When executing plans, identify tasks with independent file sets and dispatch
  them concurrently in a single tool-call batch.
- Use `run_in_background: true` on the `Agent` tool for long-running sub-agent
  work (full test runs, large refactors, multi-file rewrites) so the main
  thread keeps moving.
- Use git worktrees (`isolation: "worktree"` on sub-agent dispatches) for work
  that touches overlapping files — isolates the risk without blocking other
  tracks.
- Serial exploration is the exception, not the default.

## Permission bootstrapping on new projects
- On first entering a new project (detect by absence of
  `.claude/settings.local.json`), invoke the `bootstrap-permissions` skill
  before starting any substantial work.
- Do not rely on session-scoped approvals for long-running work — they don't
  persist across sessions.
- Destructive commands (`git push`, `git reset --hard`, `rm -rf`, `sudo`, any
  delete/drop SQL) stay unapproved. Prompting on them is the safety feature.

## Approval prompts during a session
- When Claude Code prompts for tool approval, prefer "always allow" for
  commands you trust (test runners, linters, `git` read/write-excluding-push).
  This persists to `settings.local.json` and prevents re-prompting.
- For one-off commands you don't want to persist, pick "allow for session".
- Never attempt to bypass the prompt system for destructive operations.

## Issue checkpoint format

When exiting a session with uncompleted work, post a comment on the work's
GitHub issue (the single cross-session tracker) with this structure:

```markdown
### Checkpoint — <YYYY-MM-DD HH:MM timezone>

**In progress:** <short description, or plan task ID>
**Branch:** <branch name>
**Last committed:** <commit hash and message>
**Uncommitted on disk:** <file paths, or "none">

**To resume:**
1. `git switch <branch>`
2. <specific command #1>
3. <specific command #2>

**Blocker:** <why this session ended — tool denial, usage limit, ambiguity.
If resolvable on resume, note the fix; if the user must decide something, state
it plainly.>

**Context:** <1–3 sentences: the goal, what's been tried, what's left — so a
fresh session can resume without reading the whole conversation.>
```

If resumption is a single command, keep it short; if the work is mid-design,
capture more. If no issue exists yet, file one first (the Gate-A issue
scaffolding), then checkpoint on it.

## Overnight-specific rules
- Before starting an overnight autonomous run:
  - Confirm `.claude/settings.local.json` is populated for this project.
  - Confirm every dispatched sub-agent has the required tools.
  - Commit the plan document into git so branch state is durable.
  - Ensure the main-thread model is Sonnet, not Opus, unless the overnight
    task genuinely requires Opus reasoning throughout.
- Sub-agents dispatched for overnight runs must have explicit instructions to
  commit at task boundaries and post an issue checkpoint (above) on any blocker.
- Prefer dispatching discrete chunks of work via background sub-agents rather
  than trying to hold a 12-hour context on the main thread. Main thread
  coordinates; sub-agents do the long work.
