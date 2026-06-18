# Branch-Tier Autonomy + Mechanism Model — Design Spec

- **Date:** 2026-05-31 (rev 2)
- **Status:** Draft — staged in `ClaudeDevCycle/` for review. Portable: the whole
  directory lifts out to its real home.
- **Rev-2 note:** Rev 1 leaned rules-centric (heading toward a 7th rule for
  adversarial review). That was a category error. This revision introduces the
  **mechanism model**: safety-critical control is *mechanical* (hooks / agents /
  workflows), and standing **rules shrink back to lean judgment**.

## Context

The overhaul began because of false-positive completion, bug-shedding/shims,
push-iterate CI cycles, tracker sprawl, and branch hairballs. Two later moves
reshaped the design:

1. **Branch-tier autonomy** (below) moved the human gates to the `main`
   boundary, leaving the per-task interior **gate-free** in autonomous mode.
2. The requirement for **adversarial review** exposed the core principle: a
   *rule* asks a thinking agent to behave; only a *hook / agent / workflow*
   **makes** it so. Trusting the implementing agent to summon and honestly
   report its own critic is fox-guards-henhouse. So review must be mechanical.

Together these revealed we were drifting toward rule-proliferation. The fix is
not more rules — it is filing each concern in the right mechanism.

## 1. The mechanism model (the backbone)

Four mechanisms, each for a distinct kind of concern:

| Mechanism | For | Session-context cost | Trust model |
|---|---|---|---|
| **Hooks** | Hard invariants | **zero** (always on) | mechanical — un-bypassable by a forgetful agent |
| **Rules** | Judgment / discipline | small (loaded every session) — keep **lean** | guides a thinking agent (works with a human present) |
| **Agents** | Fixed-prompt specialists | **zero until invoked** | invoked by an orchestrator with fixed inputs — implementer can't game them |
| **Workflows** | Autonomous orchestration | **zero until dispatched** | deterministic control flow (caps, gates, fan-out) in code |

**Principle:** safety-critical control (main protection, shim-catching, retry
caps) lives in hooks / agents / workflows — **never** in rules. Rules are for
the judgment a thinking agent applies when a human is in the loop.

## 2. The per-task discipline has two execution modes

The per-task control flow (diagram "D2") is a **spec of discipline** — not
itself a rule, not itself a workflow. It executes two ways:

- **Interactive / solo** (a single feature, human in the loop): the main loop
  follows the discipline conversationally; **the human is the skeptic** (plan
  approval, PR review). Governed by the lean rules. A workflow cannot hold this
  conversation, so this mode stays main-loop.
- **Autonomous** (the federated run "D4", and authorized single-feature runs):
  encoded as a **workflow**, dispatched after Gate A. The **adversarial-reviewer
  agent is the skeptic** (a mandatory stage); retry caps + escalation are
  enforced in workflow code.

This resolves "why isn't D2 a workflow?": its *autonomous* execution **is** one;
its *interactive* execution is the main loop. One discipline, two executions.

## 3. Branch tiers

- **`main` — protected.** Never pushed/merged/committed-to directly; reached
  only via a PR the user merges.
- **All non-`main` — Claude's sandbox** (`dev/feat/fix/chore/integration/*`):
  create, commit, push, merge-between, open PRs autonomously.
- **Invariant:** *nothing reaches `main` without the user's explicit PR merge.*

## 4. Gate model

Two routine human touchpoints, attached to the `main` boundary:

- **Gate A — Authorize** (up front): scope, feature set, budget, target dev
  branch. (The plan-approval gate, now also the autonomy authorization.)
  May include **plan pre-authorization** ("come up with your own plan, I trust
  you"), short-circuiting the plan-approval step in autonomous mode. Default is
  user review of the plan.
  Gate A also ensures **GitHub issue scaffolding** is in place: each feature
  being worked on must have a linked GitHub issue (provided by the user or
  created by the workflow). This gives escalation (§7) a durable, visible
  target.
- **Gate B — Merge** (end): review the `dev→main` PR (all DoD reports attached)
  and merge.

Plus one **exception** touchpoint: **escalation** when the circuit breaker
trips (§7). Routine = two touchpoints; you are pulled in mid-run only when
something is genuinely wrong.

## 5. Adversarial review (the autonomous skeptic)

- **What:** a fixed-prompt **agent** (`~/.claude/agents/adversarial-reviewer`).
  Refute-first. Input: the diff + the DoD report + test output. Output: a
  structured verdict (pass / fail + specific findings). Hunts for skipped or
  weakened tests, `try/except pass`, hardcoded returns, cast-to-`None`, narrowed
  assertions, unaddressed root cause, missing named edge cases, and **dishonest
  DoD claims** (does the report match the actual test output?).
- **Where:** a **mandatory stage in the autonomous workflow**, after validation
  + DoD report, before push/integrate. Reject → back to implementation **with
  the critique** (autonomous retry, subject to the cap). In the federated run it
  runs **per feature**, before that feature merges onto the dev branch.
- **Why mechanical, not a rule:** the implementer must not be trusted to summon
  and honestly report its own critic. The **workflow** invokes the reviewer with
  fixed inputs; the implementer cannot skip or game it.
- **Interactive mode:** the **human** plays this role at Gate B / PR review.
  (The agent may optionally be invoked as a courtesy pre-check, but when a human
  is present the human is the real reviewer.)
- **Verdict persistence:** reject verdicts are transient — passed directly to
  the implementing agent as retry context (the critique is the input). The
  **passing verdict** is appended to the DoD report as a `## Reviewer Verdict`
  section, traveling with the PR to Gate B.

## 6. Why this fills a real gap

Removing the mid-flow human DoD-acceptance gate (to enable autonomy) removed the
skeptic who used to catch shortcuts. Adversarial review is the autonomous
substitute for that skepticism. **Autonomy without it is an agent grading its
own homework.**

## 7. Circuit breaker (no insane loops, no shims)

- Every retry loop (validation, review-reject, CI) has a **hard cap of K
  iterations**, enforced in workflow code (a counter — not a rule a grinding
  agent can ignore).
- On exhaustion: dispatch a **root-cause diagnosis**; if still unresolved,
  **escalate to the user** — never loop again, never shim.
- `K` is configurable (default ~3). The cap defeats both compute-burning grind
  and the temptation to shortcut once "just make it pass" gets hard.
- **Escalation mechanism:** on exhaustion, the workflow posts a structured
  comment to the feature's **GitHub issue** (what failed, attempts made,
  root-cause diagnosis, branch/PR state), adds a `needs-human` label, and
  **exits**. The branch and PR are left in place for human inspection. To
  resume: the human investigates, fixes or directs, and re-authorizes via a
  new Gate A.

## 8. Enforcement of `main` protection (three layers)

1. **GitHub branch protection on `main`** (server-side, the real guarantee):
   require PR + ≥1 approval; block direct/force pushes. One-time admin setup.
2. **Global `pre-push` hook**: rejects any push whose remote ref is
   `main`/`master`, in any command form. Closes the bare-`git push` gap.
3. **Global `settings.json`**: allow `git push origin <tier>/*` + `git merge`;
   deny `git push origin main`, `--force`, `-f`; pre-commit guard against
   committing on `main`. Standing denies migrate from project-local to global.

### Hooks (intended logic; chaining to be finalized in the build)

**`pre-push`** — stdin is `<local-ref> <local-sha> <remote-ref> <remote-sha>`:
reject if `remote-ref` ∈ protected set (`${GIT_PROTECTED_BRANCHES:-main master}`,
per-repo override); then **chain to the repo-local hook**: look for
`<repo>/.git/hooks/pre-push`; if it exists, execute it with the same stdin and
arguments, and propagate its exit code (if the repo hook rejects, the push
fails). This is necessary because global `core.hooksPath` shadows repo-local
hooks — without explicit chaining, repo-specific checks (linters, custom
validations) would be silently skipped.

**`pre-commit`** — (a) reject staged forbidden tracker filenames
(`NEXT_STEPS|BACKLOG|TODO|PHASE_*`.md, `docs/issues-to-file.md`) — mechanically
enforcing the single-tracker rule; (b) reject commits while `main`/`master` is
checked out; then **chain to the repo-local pre-commit** (same mechanism: look
for `<repo>/.git/hooks/pre-commit`, execute if present, propagate exit code).

## 9. Rules — shrink, don't grow

With mechanical concerns moved out, standing rules shrink to lean judgment:

- `definition-of-done.md` — **keep, lean.** What "done" means; the DoD report
  contract. (Honesty is *also* enforced by the reviewer agent in autonomous mode.)
- `no-shed.md` — **keep, lean.** The no-shim / no-bug-shed philosophy. (The shim
  taxonomy is *also* the reviewer agent's checklist; the rule states the
  principle for interactive work.)
- `branch-lifecycle.md` — **keep, lean.** + the two-tier model.
- `local-ci-parity.md` — **shrink** to a short note (`act` demoted to an optional
  pre-check; expected-green still before the `dev→main` PR).
- `single-tracker.md` — **shrink** to a one-liner (the pre-commit hook enforces it).
- `workflow-dispatch.md` — **not a standing rule.** Folds into Gate-A
  authorization + workflow code + a brief process-doc note.
- adversarial review — **not a rule.** It is the reviewer agent + a workflow stage.

**Net: ~3 lean rules + 2 shrunk, instead of 7. Per-session context goes down.**

## 10. `act` / local CI parity

Demoted from a gate to an optional cheap pre-check. Autonomous dev work iterates
against **real CI** (read logs via MCP → fix → re-push, under the §7 cap). A
green `act` run is still expected before opening the `dev→main` PR.

## 11. Capability unlocked (deferred build): federated multi-feature run

A workflow that, given a feature list + dev branch: fans out one
worktree-isolated agent per feature (TDD + validation + DoD report) → **runs the
adversarial-reviewer agent per feature** → merges each *reviewed-green* feature
onto dev → pushes dev, opens one `dev→main` PR with all DoD reports, triggers CI
→ iterates under the §7 cap → returns the PR link. Authorize at Gate A, merge at
Gate B. Specced and built separately.

## 12. Impact — artifacts

- **New:** `~/.claude/agents/adversarial-reviewer` (fixed-prompt agent); the
  autonomous-run workflow(s) under `~/.claude/workflows/`; the `pre-push` +
  `pre-commit` hooks; `ClaudeDevCycle/adr/0001-branch-tier-autonomy.md`.
- **Not creating** (category errors): a `workflow-dispatch.md` rule, an
  `adversarial-review.md` rule.
- **Edit / shrink:** `definition-of-done`, `no-shed`, `branch-lifecycle` (lean);
  `local-ci-parity`, `single-tracker` (shrink); `control-flow.md` (add the
  mechanism model + the revised gate model + redrawn diagrams).
- **Settings:** allow/deny migration to global `~/.claude/settings.json`.
- **Diagrams (redraw to match — see §13).**

## 13. Diagrams (to redraw after this spec's shape is confirmed)

- **D2:** insert the adversarial-review **agent stage** (after DoD report, before
  push); mark the autonomous portion as "the autonomous workflow"; show the
  retry-cap + escalation on the loops.
- **D4:** per-feature adversarial review before merge-onto-dev; label the whole
  flow "one Claude workflow (invokes the reviewer agent; caps in code)"; show
  escalation.
- **D1:** note the reviewer in the agents box and the autonomous-run workflow in
  the workflows box.
- Redraw is deferred to one clean pass *after* you confirm this shape, to avoid
  drawing twice (and to avoid the Excalidraw duplicate-label churn).

## 14. Verification

`main`-protection tests (bare `git push`, `origin main`, `HEAD`, a `<tier>/*`
push, a server-side direct push, a commit on `main`) **plus**: the reviewer
rejects a planted shim (weakened test / cast-to-`None`); the circuit breaker
escalates after `K` failed iterations instead of looping.

## 15. Risks & mitigations

- **Global `core.hooksPath` shadows repo-local hooks** → the global hooks chain
  to repo-local ones; protect only `main`/`master`; per-repo override.
- **GitHub branch protection may be absent** → local hook + deny still hold the
  invariant; the run-authorization notes when server-side protection is missing.
- **Reviewer-agent cost** → one extra agent call per feature; cheap insurance,
  and only on authorized autonomous runs.
- **Budget** → Gate-A authorization covers it; the §7 cap bounds runaway loops.

## 16. Open questions / follow-ons

- The federated workflow **script** + the **reviewer-agent prompt** (separate
  build, after this spec is approved).
- Final hook **chaining** mechanism.
- Where the ADR / process docs **promote** to once `ClaudeDevCycle/` is lifted out.
