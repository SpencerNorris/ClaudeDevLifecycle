# ADR-0001: Branch-tier autonomy and the four-mechanism model

## Status
Accepted

## Context
Our development process was failing in recurring, specific ways:

- **False-positive completion** — work declared "done" on green unit tests
  alone, never exercised against the running system.
- **Bug-shedding / shims** — bugs found mid-implementation papered over with
  `try/except pass`, hardcoded returns, cast-to-`None`, or weakened assertions
  instead of being fixed.
- **Push-iterate CI** — treating remote CI as the dev loop: push, watch it go
  red, patch, re-push, repeat.
- **Tracker sprawl** — ad-hoc `NEXT_STEPS.md` / `TODO.md` / `BACKLOG.md`
  markdown files competing with GitHub Issues as the source of truth.
- **Branch hairballs** — long-lived, unpruned branches with no clean `main`
  boundary.

Two moves reshaped the response. First, **branch-tier autonomy** pushes the
human gates out to the `main` boundary, leaving the per-task interior gate-free
in autonomous mode. But removing the mid-flow human DoD-acceptance gate removed
the *skeptic* who used to catch shortcuts. Second — the load-bearing insight —
the demand for adversarial review exposed a **category error**: a *rule* only
*asks* a thinking agent to behave; safety-critical control must be made
**mechanical**, because trusting the implementing agent to summon and honestly
report its own critic is fox-guards-henhouse. We were drifting toward
rule-proliferation (a 7th rule for review). The fix is not more rules — it is
filing each concern in the mechanism whose trust model fits it.

## Options considered
- **More rules** — add standing rules for adversarial review, workflow
  dispatch, main protection. Rejected: a rule cannot *make* a forgetful or
  motivated agent comply, and always-on rules cost session context for concerns
  that should be mechanical or on-demand.
- **The four-mechanism model** — sort every concern by trust model into hooks,
  rules, agents, or workflows; shrink standing rules to lean judgment. Chosen.
- **A pure-workflow approach** — encode the entire discipline as workflow code.
  Rejected: the interactive/solo mode is a human-in-the-loop conversation a
  workflow cannot hold; one discipline needs two executions.

## Decision
Adopt **branch-tier autonomy** plus the **four-mechanism model**, each
mechanism chosen for its trust model and context cost:

- **Hooks** — hard invariants, un-bypassable (`pre-push` rejects pushes to
  `main`/`master` and chains to repo-local hooks; `pre-commit` blocks forbidden
  tracker filenames and commits on `main`).
- **Rules** — lean judgment for a thinking agent, in **three buckets**: an
  always-on **constitution** (`CLAUDE.md`, global + project) holding short
  universal stances; **path-scoped rules** (`rules/*.md` with `paths:`
  frontmatter — `code-style`, `adr-format`) that auto-load only on a matching
  file; and **on-demand reference** (`reference/*.md` — the process rules) read
  via the constitution's index. The rev-3 sort left 3 surviving design rules
  (`definition-of-done`, `no-shed`, `branch-lifecycle`), down from 7.
- **Agents** — the fixed-prompt **review panel** (`adversarial-reviewer` +
  `correctness-reviewer` always-on; `security-reviewer` + `performance-reviewer`
  opt-in per project), invoked by the orchestrator with fixed inputs. Each reviewer
  independently reconstructs the diff (`git diff <base>...HEAD`) and re-runs tests
  against the claimed results, so the implementer cannot skip or game its critics.
- **Workflows** — autonomous orchestration with caps, gates, and fan-out in
  code (single-feature run; federated multi-feature run).

Supporting decisions:

- **Branch tiers** — `main` is protected; all non-`main` branches
  (`dev/feat/fix/chore/integration/*`) are Claude's sandbox.
- **Two gates** — **Gate A** (authorize the run: scope, budget, dev branch,
  issue scaffolding) and **Gate B** (review and merge the `dev→main` PR).
  Nothing reaches `main` without the user's explicit Gate-B merge.
- **Review panel** — a mandatory autonomous-workflow stage after validation + DoD
  report, before push/integrate (per feature in the federated run); a feature passes
  only when every dispatched reviewer passes. The human plays this role at Gate B in
  interactive mode.
- **Circuit breaker** — every retry loop (validation, review-reject, CI) capped
  at K iterations (default ~3) in workflow code; on exhaustion, root-cause
  diagnosis then escalation to the user via a `needs-human` GitHub issue
  comment — never an infinite loop, never a shim.

## Consequences
- **Easier:** autonomous multi-feature runs become safe (the review panel is
  the autonomous skeptic); `main` is protected by up to three layers (server-side
  branch protection where the plan allows, plus the local hook + settings); the
  standing rule set is smaller, so per-session
  context drops as the process rules move to on-demand reference.
- **Harder:** more moving parts spread across four mechanisms — a contributor
  must know which mechanism owns a concern; the federated workflow and reviewer
  prompt are non-trivial to build.
- **Riskier:** the review panel adds ≥2 parallel calls per feature (cheap insurance);
  global `core.hooksPath` shadows repo-local hooks, mitigated by explicit
  chaining; the on-demand-loading payoff depends on a global-config change
  applied at promotion, not yet realized.

## Notes
- Control flow and mechanism diagrams: `../master-design-doc.md`.
- Design rationale and verification plan:
  `../specs/2026-05-31-branch-tier-autonomy-design.md`.
- Constitution principle-lines staged for promotion: `../master-design-doc.md` §15.
