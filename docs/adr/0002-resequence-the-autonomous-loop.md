# ADR-0002: Re-sequence the autonomous loop

## Status
Accepted

## Context
Two real runs of the single-feature workflow (2026-09) found real defects at every review round and cost about a million output tokens and seven serial hours each. The causes were structural: the branch-name handoff let later stages run on stale code (issue #9); every fix re-ran the full smoke; the cheaper review ran after the expensive smoke and rejected more often than the smoke failed; the panel re-derived the whole diff after each fix; no stage read the codebase's own contracts before implementation; cleanup ran only on success; an exhausted CI quota paused the run instead of ending it.

## Options considered
- Keep the order, fix only the handoff (issue #9). Cheapest; leaves the cost profile.
- Drop the automated loop for daytime work; keep the panel and smoke as manual stages. Cheaper still; loses unattended runs.
- Re-sequence: design review first, commit-pinned handoffs in a run-owned worktree, gates before review before smoke, delta review and incremental re-smoke after a fix, cleanup on every exit, a clean finish on an exhausted quota. Keeps unattended runs; the panel and the smoke are unchanged in rigour.

## Decision
Re-sequence (spec `docs/specs/2026-09-09-workflow-resequencing-design.md`, D1–D8). Deterministic steps are mechanical agents because the DSL has no shell; every such prompt carries the pass and the commit because results are cached by prompt. The run never touches the main working tree.

## Consequences
Easier: a reject never discards a smoke; a fix costs a delta review and usually no smoke; stale-code rounds cannot happen; runs end cleanly on an exhausted quota; the run leaves no worktrees behind. Harder: more stages on the happy path; reviewers track finding ids across rounds; the federated run's budgets change. Riskier: a wrong `headSha` from an implementer escalates rather than continues, which is the intended failure mode. The run never moves a branch that the main working tree has checked out: the reconcile step refuses and escalates, so a human fast-forwards it themselves. The federated run's per-feature budgets are now the two independent ones (validate failures and review rejects, K=3 each, at most 2K passes), a stated behaviour change.

## Notes
Issue #9, PR #8, the ClaudeDevLifecycle Atlas (2026-09-09).
