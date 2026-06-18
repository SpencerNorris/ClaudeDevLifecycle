# Single Tracker

## Purpose
GitHub Issues is the only persistent tracker. The prior default —
proliferating `NEXT_STEPS.md`, `BACKLOG.md`, `PHASE_*.md`,
`REVIEW.md`, `docs/issues-to-file.md`, etc. — created N parallel
sources of truth, which is N-1 too many. The user cannot manage
multiple projects when project state is fragmented across ad-hoc
files in the working tree.

## Allowed persistent state

| Layer | Where | What |
|---|---|---|
| **Tracked work** | GitHub Issues | All bugs, features, follow-ups, open questions |
| **Milestone groupings** | GitHub Milestones / Projects | Grouped issues with deadlines or themes |
| **In-conversation work** | TaskCreate / TaskUpdate | Scratchpad for the current session; never persisted to disk |
| **Architectural decisions** | `docs/adr/` | One ADR per decision, immutable after acceptance |
| **Feature docs** | `docs/features/` | What/why/how/where for a subsystem |
| **Design specs** | `docs/superpowers/specs/` or `docs/specs/` | Pre-implementation design artifacts |
| **Changelog** | `CHANGELOG.md` | Release notes only |
| **Working memory** | `~/.claude/memory/` (auto-memory) | Cross-session facts about user/project/feedback |

## Forbidden persistent state

Never create:

- `NEXT_STEPS.md`
- `BACKLOG.md`
- `TODO.md`
- `REVIEW.md`
- `PHASE_*.md`, `PHASE_*_BUGS.md`, `PHASE_*_FOLLOWUPS.md`
- `ISSUES_TO_FILE.md`
- `BUGS.md`, `KNOWN_ISSUES.md`
- Any other ad-hoc list of "things to do later" living in the working tree

If something would belong in one of those files, file it as a GitHub
issue with the appropriate label/milestone.

The single-source-of-truth principle applies even when the local list
seems convenient. Convenience now is the cause of the user's pain
later.

## Status snapshots

If a status snapshot is requested, **generate it on demand from the
source of truth** — never hand-author a file that will go stale.

Use:

```bash
gh issue list --label "milestone/X" --state open
gh pr list --search "is:open author:@me"
gh project item-list <project-id>
git log main --since "2 weeks ago" --oneline
```

If a snapshot artifact must persist (for a meeting, for a report),
output to terminal or write to a file marked clearly as generated:

```markdown
<!-- GENERATED FROM `gh issue list ...` on $DATE — do not hand-edit -->
# Project status snapshot
...
```

The user can then regenerate the snapshot rather than maintain it.

## When you find a forbidden file

If you encounter a forbidden tracker file in a project:

1. Read it carefully — do not lose information.
2. File each unresolved item as a GitHub issue with appropriate
   labels and milestone.
3. Delete the file in the same commit that links to the new issues.
4. Surface to the user:
   > Found and migrated `<file>` → GitHub issues #N..#M. File deleted.

Do **not** "preserve" forbidden trackers under a different name or
move them to `docs/archive/`. The information lives in GitHub Issues
now; the file is dead.

## In-conversation tracking

For multi-step work within a single conversation, use TaskCreate /
TaskUpdate. These are session-scoped and disappear when the
conversation ends. **That is correct.** Anything worth keeping across
sessions belongs in GitHub Issues, not in a markdown file.

If a session needs to be resumable across breaks, the resumption
state is encoded as:
- A branch with committed work (durable).
- An open GitHub issue whose **body carries a live checklist** of what's
  done and what remains (durable, searchable). This checklist is the
  resume anchor — update it at each session boundary so a fresh session
  reads the issue and knows exactly where to pick up.
- A draft PR once the work is far enough along to show a diff (durable,
  reviewable). Early on, before there's a meaningful diff, the issue
  checklist alone carries the state.

There is no `NEXT_STEPS.md` step in this resumption protocol. The
checklist that would have gone in `NEXT_STEPS.md` lives in the issue
body instead, where it is searchable and survives working-tree churn.

## Documentation vs. tracking

A document that describes a system (`docs/features/auth.md`,
`docs/architecture/overview.md`) is allowed and encouraged — it is
durable architectural knowledge.

A document that lists work to do (`docs/features/auth-todo.md`,
`docs/architecture/refactor-plan.md`) is a tracker in disguise — file
the work as issues, write the doc only after the work lands.

If the line is unclear, ask: "Does this describe what *is*, or what
*should be*?" Describing-what-is goes in docs. Describing-what-should-be
goes in GitHub Issues.
