# No-Shed Rule

## Purpose
Stop using "filed as issue" as an escape hatch from finishing the
current change. Bugs found while implementing a feature get fixed in
the same change, not filed for later.

The prior default — file liberally to declare done — has been observed
to leave the codebase in worse shape after a feature lands than before.
A feature plus 50 new issues is not a win; it is a debt rollup
disguised as progress.

## Default behavior

When a bug is discovered during implementation, the default action is
**fix it in this change.**

This includes:
- Type errors in nearby code.
- Tests that were already broken (red on `main`).
- Lint or formatting violations the file already had.
- Off-by-one errors found while reading code.
- Stale comments, dead code, obviously-wrong logic.
- Latent bugs revealed by the new code path.

If the fix is small, just do it. Note it under "Incidental fixes" in
the change report.

## Two exceptions only

A bug may be filed as a separate issue instead of fixed in-PR if:

1. **Orthogonal scope.** The bug is in a genuinely different
   subsystem from the change. Tests for orthogonality:
   - Different architectural layer (UI vs. API vs. ORM vs. infra).
   - Different module with no shared imports with the changed code.
   - Fixing it would require expertise or context outside the scope
     of the original change.
2. **Explicit user deferral.** The user has been informed of the bug
   and has explicitly said "defer." Not implicit. Not assumed.

These are **not** valid exceptions:
- "I'm worried about scope creep."
  → Judge orthogonality, not creep. Bugs found while you were touching
    the file are not creep; they are the cost of working in that file.
- "The PR is already big."
  → Bug count is the cost of the prior problem, not the cost of
    finding the bugs. Report the size honestly.
- "I want to keep the diff focused."
  → Focused on a working feature, not on the original ticket's
    literal lines.
- "It's quicker to file an issue than to fix it."
  → No, it isn't. Filing the issue, writing the title and body,
    discovering the bug again later, re-loading context — total cost
    is higher than fixing in place.

## Signal vs. shed

If you find yourself about to file 5+ issues while implementing one
feature, **stop and surface that to the user.** The signal is one of:

- The original change is bigger than expected → replan it.
- The codebase is in worse shape than expected → audit it.
- The bugs are not actually orthogonal → fix them.

Drop a single status update with this shape:

> While implementing X, I have found N bugs:
>   - <list with one-line summaries>
> I propose fixing M of them in this PR (in-scope:
>   `<which>`) and filing N-M as orthogonal (justification:
>   `<which>`). Confirm or redirect.

Let the user choose. Never silently file and continue.

## Cross-link

When an orthogonal-scope issue *is* filed, cross-link it in the PR
description so the trail is visible:

> Found during PR #<this>; orthogonal scope (justification: <one line>).
> Filed as #<new>.

## Tradeoff acknowledgment

This rule produces larger PRs and slower cycle times in exchange for
fewer broken features, fewer open issues, and fewer regressions. That
is the intended trade. If a project's review process cannot accept
larger PRs, the right answer is to land the bug fixes as separate
commits in the same PR (preserving reviewability) — not to file them.
