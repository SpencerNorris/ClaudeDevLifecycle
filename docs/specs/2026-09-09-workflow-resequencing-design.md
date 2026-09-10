# Workflow re-sequencing — design

**Status:** proposed, 2026-09-09, revision 2 (after one Opus review of the plan). Argued from two real runs of `single-feature-run.js` (Oversight #298 and #299) and the clickable atlas built from them.

## Problem

The autonomous loop finds real defects and is not efficient. Measured on the #298 run (17 agents, ~980k output tokens, ~7.5 h of serial agent time):

| Where the cost went | Share of output tokens |
|---|---|
| Sonnet implement and reimplement | 55 % |
| Sonnet validate, four full passes | 25 % |
| Opus review, six seats over two rounds | 19 % |

Five structural causes, all in `claude-home/workflows/single-feature-run.js` (and mirrored in `federated-run.js`):

1. **Branch-name handoff.** `IMPLEMENT_SCHEMA` carries a branch name, not a commit. Under `isolation: "worktree"` a second implementer cannot check out a branch another worktree holds, commits on a side branch, and reports the name it was told. The next validate and review run on the old tip. Filed as issue #9; bit the #298 run twice and the #299 run twice.
2. **Full re-validate per loop.** Any fix triggers a full smoke (image rebuild, seed, every acceptance criterion, ~30 min) because the DoD records one boolean, not per-case results.
3. **Review after smoke.** Review is cheaper (three parallel Opus seats, ~15 min) and rejected more often than the smoke failed (5 of 5 review rounds rejected across the two runs; 1 of 6 smokes failed on code). Each reject discards a smoke.
4. **No delta review.** After a fix the full panel re-derives the whole diff instead of checking its own findings.
5. **No design pass.** The findings are contracts the codebase already states (provenance rows need conflict handling; queue entries need a drainer) discovered at the most expensive point.

Plus three smaller ones: cleanup only on the success path; private session links reach commits and PR bodies because the harness's attribution reminder overrides the prompt; an exhausted Actions quota pauses the run when it should end it.

## Constraints

- The Workflow DSL exposes `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()` and nothing else. Workflow code cannot run git or gh. Every deterministic step is therefore a **mechanical agent**: a fixed list of commands, `effort: "low"`, a schema-checked result, and a prompt that forbids improvisation. A dead mechanical agent (null result) pauses for a human like every other stage.
- **Cache rule.** `agent()` results are cached by `(prompt, opts)`. Every prompt that must run again on a later pass carries the pass number and the commit it acts on; a constant prompt would replay its first result forever. The first implement prompt stays byte-identical so a resume replays it for free.
- **Ownership rule.** The run never touches the main working tree: the human works there. It works in a run-owned worktree pinned at the current commit, and cleanup removes only worktrees the run created or detached (tracked by path) and side branches it was told about. No `--force`; a refusal is reported, not overridden.
- `claude-home/` and `claude-repo/.claude/` copies must stay byte-identical (scripts today; agent definitions added by this change).
- No-shed stands: reviewer minors are fixed on the branch. A deferral is a claim with a reason that the review panel judges; an unjudged deferral is a shed.
- Base branch for the change is PR #8 (independent validate and review budgets), which lands first. The same two-budget shape is ported to the federated run, which is a behaviour change stated in the ADR.

## Decisions

### D1. Commit-pinned handoff in a run-owned worktree (issue #9)
`IMPLEMENT_SCHEMA` gains `headSha` (required, 40 hex) and `worktreeBranch` (optional). After every implement result: a mechanical **reconcile** step checks that the branch is an ancestor of `headSha`, detaches any worktree holding the branch, and moves the ref with `git update-ref`; a non-ancestor means the implementer diverged and the run escalates. Then a mechanical **pin** step checks `headSha` out, detached, in `.claude/worktrees/run-<branch-slug>`, creating it once and reusing it across passes so installed dependencies survive. Every later stage (gates, review, smoke, ship, CI fix) names that worktree and that commit. Before every implementer dispatch a mechanical **detach** step frees the branch, and the paths it touched become run-owned. The run owns a branch only after the first implement result; before that, detach and cleanup are no-ops.

### D2. Stage order: design → implement → gates → review → smoke → ship → CI
- **Design review** (new, Opus): reads the issue, the plan, the repo's `CLAUDE.md` and the modules the plan names; returns `constraints[]` each with a source. The implement prompt and every reviewer prompt carry them.
- **Gates** (new, low-effort agent in the run worktree): unit, lint, typecheck at `headSha`, using `args.gateCommands` when given. A failure is a code failure and goes back to implement without a smoke.
- **Review panel** moves before the smoke. Its evidence is the diff at `headSha` in the run worktree, the gate results, the design constraints, and the implementer's own claims (summary, files touched, deferrals). The reviewer agent definitions are rewritten for this position: they no longer expect a DoD report.
- **Smoke** (the validate stage) runs once the panel passes: preflight, integration and regression suites, the smoke with a per-case transcript, the DoD report.

### D3. Delta review with a per-seat ledger
Every finding carries an id from the first round on. The workflow keeps a ledger per reviewer seat. After any fix, the panel runs in delta mode: each seat receives **its own** open findings and `git diff <prevSha>..<headSha>`, returns a `resolved[]` status per finding plus new findings on the delta, and judges every deferral the implementer claimed (`deferralVerdicts[]`; a rejected deferral is a blocking finding). A full re-derivation happens only on the first round; a round after a smoke failure is a delta over the last reviewed commit.

### D4. Per-case smoke and incremental re-smoke
`DOD_SCHEMA` gains `cases[]` (`id`, `name`, `pass`, `carried`, `detail`, `files`). When the smoke fails on code, the failed cases are recorded. The next validate runs `git diff --name-only <lastSmokeSha>..<headSha>` first: if the delta touches a dependency manifest, a Dockerfile, a compose file, an nginx template, or a file no failed case names, it runs the full smoke and says why; otherwise it re-runs the failed cases and every case whose files overlap, marks the rest `carried: true` with their last real result, keeps the stack up, and renders carried cases in a separate list in the report so Gate B sees what was and was not re-run.

### D5. Blocking first, minors second, deferrals judged
The reimplement prompt orders the work: every blocking finding, committed; then every minor as its own commit; `minorsDeferred[]` (id + reason) only for an item the implementer judges out of scope. The deferrals reach the review packet and the DoD's follow-ups; the panel accepts or rejects each. A reimplement that produces no new commit is a code failure with an explicit message, never a silent re-loop on cached results.

### D6. Cleanup on every exit
A mechanical **cleanup** step removes the run's own worktrees by path, any worktree still on the feature branch, and reconciled side branches (`git branch -d`, merged only), then prunes. It runs before `escalate()` and `pauseForHuman()` throw, before the CI-skipped return, and before the CI-green return. The CI fix dispatch is reconciled and re-pinned like every other implement.

### D7. Session-link hygiene
- `claude-home/settings.json` and `claude-repo/.claude/settings.json` set `"attribution": { "sessionUrl": false }`. This is the mechanism: Claude Code builds the attribution reminder from it, at user or project scope, on every platform.
- Its reach into subagents and workflow-spawned agents is not documented, so the plan verifies it **first**, before any code (one subagent commit, one workflow-agent commit, one PR body), and records the result below. No git hook is added: a hook would duplicate the setting and add a bash dependency. If the verification shows a leak, D7 reduces to the post-ship scrub and the leak is reported upstream as a Claude Code defect.
- A mechanical post-ship step scrubs the PR body if the pattern appears anyway. It is an agent using `gh`, so it carries no platform dependency.
- The settings allow-list gains the exact git and gh commands the mechanical steps run, so they do not prompt in an unattended run, and the deny-list names the destructive forms (`branch -D`, `worktree remove --force`, `reset --hard`, and their `git -C` variants). Exception: the `git -C <worktree> …` forms the detach and pin steps run cannot be allow-listed narrowly — Claude Code matches Bash rules on the whole command text, and a wildcard placed before the subcommand would also approve injected `-c`/`--exec-path` options — so they run under the session's permission mode (auto mode approves them; a validating PreToolUse hook is the maintainer's opt-in, not shipped).

### D8. CI short-circuit on an exhausted quota
A mechanical **quota** step before polling reads `/users/<login>/settings/billing/actions`; with `total_minutes_used >= included_minutes` the CI phase is skipped, a one-line PR comment says so, cleanup runs, and the run returns `{ prUrl, branch, headSha, issue, ciSkipped: "quota" }`. Without the `user` scope the step returns `unknown` and polling proceeds; a poll result with `blocker: "billing"` takes the same skip path instead of pausing.

## Out of scope
The per-run ledger (tokens and minutes per stage, waste accounting) is a separate script and a separate plan.

## Success criteria
- `node --test tests/` passes: args boundary, byte-identical copies (scripts and agent definitions), the settings check, and the flow-walk tests (happy path, gate failure, review reject with a per-seat delta review and judged deferrals, smoke failure with incremental re-smoke and a delta review, no-commit reimplement, diverged reconcile, dead mechanical agent, design-stage pause without cleanup, quota skip, billing skip, reconciled CI fix).
- The attribution verification shows no session link, or D7 is reduced as described.
- A real run on a small issue shows: one full review round, one full smoke, every later validate incremental, no worktree or side branch left behind, no session link in any commit or PR body, and a clean `ciSkipped` finish while the quota is exhausted.

## Attribution verification (Task 1)
Pending. Needs the maintainer's own `~/.claude/settings.json` and fresh sessions (one subagent commit, one workflow-agent commit, one PR body). Record the result here; if a session link still appears, D7 reduces to the post-ship scrub and the leak is reported upstream as a Claude Code defect.
