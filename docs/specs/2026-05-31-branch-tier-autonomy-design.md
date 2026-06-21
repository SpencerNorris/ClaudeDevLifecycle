# Branch-Tier Autonomy + Mechanism Model — Design Spec

- **Date:** 2026-05-31, last revised 2026-06-18 (rev 3)
- **Status:** Draft — staged in `ClaudeDevCycle/` for review. Portable: the whole
  directory lifts out to its real home.
- **Rev-2 note:** Rev 1 leaned rules-centric (heading toward a 7th rule for
  adversarial review). That was a category error. Rev 2 introduced the
  **mechanism model**: safety-critical control is *mechanical* (hooks / agents /
  workflows), and standing **rules shrink back to lean judgment**.
- **Rev-3 note:** the "Rules" mechanism splits into three buckets — the always-on
  **constitution** (`CLAUDE.md`), the **path-scoped rules** (`rules/*.md` with
  `paths:` frontmatter, auto-loaded on a matching file), and the **on-demand
  reference** (`reference/*.md`, read via the constitution's index). The rule set
  is re-sorted by mechanism: `single-tracker` deleted, `local-ci-parity` demoted
  to a project reference, `no-shed` thinned, and the load-bearing *principles*
  elevated into the constitution. The two on-demand buckets exist because the
  trigger type differs — a file-path glob (`paths:`) vs. a conceptual trigger
  (lean index + Read) — see §9.

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
| **Rules** | Judgment / discipline (three buckets — see below) | constitution always-on; `rules/` on file-touch; `reference/` on-demand | guides a thinking agent (works with a human present) |
| **Agents** | Fixed-prompt specialists | **zero until invoked** | invoked by an orchestrator with fixed inputs — implementer can't game them |
| **Workflows** | Autonomous orchestration | **zero until dispatched** | deterministic control flow (caps, gates, fan-out) in code |

**Principle:** safety-critical control (main protection, shim-catching, retry
caps) lives in hooks / agents / workflows — **never** in rules. Rules are for
the judgment a thinking agent applies when a human is in the loop.

**The rules mechanism has three buckets (rev 3).** It splits by *when its content
enters context*:

- **Constitution** — global (`~/.claude/CLAUDE.md`) + project (`<repo>/CLAUDE.md`),
  always loaded. The short, universal *stances* you never want forgotten (the
  DoD, no-shed, and single-tracker principles). Must stay short.
- **Path-scoped rules** — `~/.claude/rules/*.md` *with* `paths:` frontmatter.
  Auto-loaded by Claude Code only when the session touches a matching file. For
  file-type guidance (`code-style` on source globs, `adr-format` on `docs/adr/**`).
- **On-demand reference** — `~/.claude/reference/*.md`, a plain folder that is
  *not* auto-loaded; the constitution indexes it and Claude reads a file when its
  conceptual trigger matches. For the process rules whose trigger is the kind of
  work, not a file path (see §9 for the mechanism).

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

- **`main` — protected** (by design; enforcement is layered and opt-in per repo —
  see §8). Never pushed/merged/committed-to directly; reached only via a PR the
  user merges.
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

## 8. Enforcement of `main` protection (layered; pick what your repo/plan allows)

Complementary layers — only the server-side one is unbypassable, and it alone
guards a *human's* accidental push. The local hook layer gates **Claude-initiated**
git only (a human is Gate B and pushes freely); even for Claude it's best-effort
(a deliberate `--no-verify` gets past it).

1. **GitHub server-side branch protection on `main`** — the only *unbypassable*
   layer: require PR + ≥1 approval; block direct/force pushes. Strongest **where
   the plan offers it** (protected branches on private repos need a paid plan).
2. **Global `pre-push` hook** (opted-in repos; **Claude-initiated** pushes only):
   rejects any push by Claude whose remote ref is `main`/`master`, in any command
   form — closes the bare-`git push` gap for the agent. **Where server-side
   protection is unavailable, this is the primary guard against Claude reaching
   `main`** (a human push is intentionally allowed).
3. **Global `settings.json`** (defense-in-depth): allow `git push origin <tier>/*`
   + `git merge`; deny `git push origin main`, `--force`, `-f`; pre-commit guard
   against committing on `main`. Can't catch a bare `git push`; that's layer 2.

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
enforcing the forbidden-tracker invariant; (b) reject commits while `main`/`master` is
checked out; then **chain to the repo-local pre-commit** (same mechanism: look
for `<repo>/.git/hooks/pre-commit`, execute if present, propagate exit code).

## 9. Rules — shrink, don't grow (rev 3: sorted by mechanism)

With mechanical concerns moved out and the constitution carrying the universal
*principles*, the standing process rules shrink to three:

- `definition-of-done.md` — **keep, lean.** The DoD report contract: smoke depth,
  surface-by-type playbook, report structure. Its one-line *stance* is elevated
  to the constitution; honesty is *also* enforced by the reviewer agent.
- `no-shed.md` — **keep, thin.** The orthogonality tests + the 5+-filings
  escalation. Its *principle* is elevated to the constitution; the shim taxonomy
  is *also* the reviewer agent's checklist.
- `branch-lifecycle.md` — **keep, lean.** + the three-bucket model; it also absorbs
  the cross-session resume anchor + docs-vs-tracking razor from the retired
  `single-tracker`.
- `single-tracker.md` — **deleted, redistributed.** Invariant (forbidden tracker
  filenames) → the pre-commit hook; principle → the constitution; practices →
  `branch-lifecycle.md`. A one-line rule file is pure always-on overhead.
- `local-ci-parity.md` — **demoted to project reference** (`docs/references/`).
  The `act` how-to is project-specific (only where GitHub Actions exists); its
  principle (expected-green first push, real CI is the gate) → the constitution.
- `workflow-dispatch.md` — **not a standing rule.** Folds into Gate-A
  authorization + workflow code.
- adversarial review — **not a rule.** It is the reviewer agent + a workflow stage.

**Net: 3 global rule files (`definition-of-done`, `no-shed`, `branch-lifecycle`),
down from 7.** The elevated principles live in the constitution; the demoted
`act` how-to lives in project `docs/`.

### On-demand loading (the concrete mechanism)

The shrink only pays off in tokens if the process rules load on-demand rather
than every session. In Claude Code, a `*.md` under `~/.claude/rules/` **without**
`paths:` frontmatter loads unconditionally at launch (same priority as
`CLAUDE.md`) — which is why all current rules are always in context. Two ways to
make them on-demand:

1. **Path-scoped rules** — add `paths:` glob frontmatter; the rule then loads
   only when Claude touches a matching file. Ideal for file-type-specific rules
   (e.g. `code-style` on source globs); a poor fit for whole-session process
   rules that aren't tied to a file pattern.
2. **Index + Read-on-demand** — keep the files out of the auto-load set and put a
   lean index in the constitution naming each file with a one-line "read when
   relevant" trigger. The index is a few always-on lines; the full file loads only
   when the model opens it. Best fit for the process/judgment rules here.

The deliverable uses **both**, as the two on-demand buckets: way 1 is `rules/`
(path-scoped — `code-style`, `adr-format`); way 2 is `reference/` (the process
rules, indexed by the constitution).

This is a **loading/config change to global `~/.claude/`**, applied at promotion
with the user's go-ahead — not done as part of this staging work.

## 10. `act` / local CI parity

Demoted from a gate to an optional cheap pre-check, and (rev 3) from a global
rule to a **project-level reference** (`docs/references/local-ci-parity.md`) —
the `act` how-to only matters where GitHub Actions exists. Autonomous dev work
iterates against **real CI** (read logs via MCP → fix → re-push, under the §7
cap). A green `act` run is still expected before opening the `dev→main` PR; that
surviving principle lives in the constitution.

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
  `pre-commit` hooks; `ClaudeDevCycle/docs/adr/0001-branch-tier-autonomy.md`.
- **Not creating** (category errors): a `workflow-dispatch.md` rule, an
  `adversarial-review.md` rule.
- **Constitution additions (rev 3):** the DoD / no-shed / single-tracker /
  local-CI principle-lines, staged for `~/.claude/CLAUDE.md` (see
  `master-design-doc.md` §15). Applied at promotion, not now.
- **Rule changes (rev 3):** `definition-of-done`, `no-shed` (thinned),
  `branch-lifecycle` (lean) kept (now in `reference/`); `single-tracker` **deleted**;
  `local-ci-parity` **moved** to `docs/references/`; `master-design-doc.md` carries
  the mechanism model + gate model + redrawn diagrams.
- **Loading (rev 3):** path-scoped rules use `paths:` frontmatter in `rules/`;
  process rules move to `reference/` and load via the constitution index — a
  global-config change applied at promotion.
- **Settings:** allow/deny migration to global `~/.claude/settings.json`.
- **Diagrams:** D1 updated with the three-bucket rules layer; D2/D4 redraw still per §13.

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
