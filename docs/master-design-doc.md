# Development Control Flow — rev 3

## Status
Revision 3. Synced with
`docs/specs/2026-05-31-branch-tier-autonomy-design.md` (rev 3) and
`docs/diagrams/branch-tier-autonomy.md`. This document lives in `docs/` as the
master reference for how we work together; the deployable config it describes is
staged in `claude-home/` for drop-in to `~/.claude` (see `INSTALL.md`).

**Rev 3:** the rules set is re-sorted by mechanism.
`single-tracker.md` deleted (invariant → pre-commit hook; principle →
constitution; practices → `branch-lifecycle.md`). `local-ci-parity.md` demoted
from a global rule to project reference (`docs/references/`). `no-shed` thinned.
The DoD / no-shed / tracker / CI principles are staged for the constitution
(§15). The mechanism model now treats the global `CLAUDE.md` as the always-on
*constitution* above two on-demand buckets — path-scoped `rules/` and
concept-triggered `reference/` (§1, D1). The spec is at rev 3 to match. **No global config touched — the constitution
additions are staged in §15 only, applied at promotion.**

**Diagram source of truth:** the mermaid blocks in
`docs/diagrams/branch-tier-autonomy.md`. The diagrams embedded here are copies for
readability. If they ever disagree, the diagrams file wins.

## Purpose
This is the network diagram of how we develop together. It defines:

1. **The mechanism model** — four mechanisms, each for a distinct kind of
   concern, filed by trust model.
2. **Architecture** — what components exist, where they live, which mechanism
   each one is.
3. **Control flow** — how a single unit of work moves through the system, in
   two execution modes (interactive and autonomous).
4. **Branch tiers** — `main` is protected; everything else is Claude's sandbox.
5. **Responsibility split** — who does what; where the two human gates sit.

If you can't trace what should happen for a given task by following this
document, the document has a gap. Flag it.

---

## 1 — The mechanism model (the backbone)

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

### The rules mechanism has three buckets

The single "Rules" mechanism splits by *when its content enters context*:

- **Constitution** — global (`~/.claude/CLAUDE.md`) + project (`<repo>/CLAUDE.md`).
  Always loaded, every session. Holds the short, universal *stances* you never
  want forgotten (the DoD principle, the no-shed principle, the single-tracker
  principle). Because it is always-on, it must stay short.
- **Path-scoped rules** — `~/.claude/rules/*.md` *with* `paths:` frontmatter.
  Claude Code auto-loads these, but only when the session touches a file matching
  the glob. For guidance tied to a **file type**: `code-style.md` (source globs),
  `adr-format.md` (`docs/adr/**`).
- **On-demand reference** — `~/.claude/reference/*.md`. A plain folder Claude Code
  does *not* auto-load; the constitution carries an index, and Claude opens the
  file with the Read tool when its **conceptual** trigger matches ("before
  non-trivial work", "when writing tests"). For procedural detail whose trigger is
  the *kind of work*, not a file path: DoD's surface-by-type playbook, no-shed's
  orthogonality tests, branch-lifecycle's cleanup commands, plus the process rules
  (testing, documentation, workflow, workflow-autonomy, architecture).

> **Why two on-demand buckets?** Because the *trigger type* differs. A rule that
> fires on a file path (`code-style` when you edit source) uses native `paths:`
> frontmatter and lives in `rules/`. A rule whose trigger is conceptual ("before
> declaring done") has no glob to match — put it in `rules/` without `paths:` and
> it auto-loads on *every* session, re-bloating context. So it lives in the plain
> `reference/` folder and is pulled in by judgment via the constitution's index.
> This resolves the rev-3 "auto-load everything" gap natively.

---

## 2 — Architecture (the network) — D1

What exists, where it lives, and which of the four mechanisms each piece is.

```mermaid
graph TB
    subgraph Actors
        U["User"]
        C["Claude session"]
    end

    subgraph GLOBAL["Global config — ~/.claude/ · THE FOUR MECHANISMS"]
        HOOKS["git hooks — HOOKS (invariants)<br/>pre-commit: forbidden trackers + no-main<br/>pre-push: reject main/master ref"]
        CONST["CLAUDE.md — CONSTITUTION (always-on)<br/>universal stances: DoD · no-shed · tracker<br/>(RULES mechanism · bucket 1)"]
        RULES["rules/*.md — PATH-SCOPED RULES<br/>code-style · adr-format (paths: frontmatter)<br/>(RULES mechanism · bucket 2 · auto-load on matching file)"]
        REF["reference/*.md — ON-DEMAND REFERENCE<br/>DoD detail · no-shed · branch-lifecycle · testing · …<br/>(RULES mechanism · bucket 3 · read via CLAUDE.md index)"]
        AGENTS["agents/*.md — AGENTS (specialists)<br/>adversarial-reviewer (fixed prompt)"]
        WF["workflows/*.js — WORKFLOWS<br/>autonomous federated run<br/>(invokes reviewer; caps in code)"]
        SETT["settings.json — allow/deny<br/>tier allows: push non-main + merge<br/>main denies: push main, --force"]
        MEM["memory/<br/>cross-session facts"]
    end

    subgraph PROJ["Per-project config"]
        PCM["&lt;repo&gt;/CLAUDE.md"]
        PPS["&lt;repo&gt;/.claude/settings.local.json"]
        PDOCS["&lt;repo&gt;/docs/ — ADRs, specs"]
    end

    subgraph EXT["External"]
        GH["GitHub — Issues + PRs<br/>branch protection on main"]
        ACT["GitHub Actions CI"]
        GHM["GitHub MCP server"]
        PWM["Playwright MCP server"]
    end

    U -->|"Gate A: authorize · Gate B: merge PR"| C
    HOOKS -.->|mechanically enforce| C
    SETT -.->|allow / deny| C
    CONST -.->|always guides| C
    RULES -.->|auto-load on matching file| C
    REF -.->|read on-demand via index| C
    AGENTS -.->|invoked by| C
    WF -.->|dispatched by| C
    MEM -.->|loaded into| C
    PCM -.-> C
    PPS -.-> C
    PDOCS -.-> C

    C -->|issue / PR ops| GHM
    C -->|UI smoke tests| PWM
    C -->|"git push (non-main)"| GH
    GHM <--> GH
    GH --> ACT
    ACT -.->|logs readable via| GHM

    classDef userAction fill:#e1f5ff,stroke:#0288d1,color:#000
    classDef claudeAction fill:#f3e5f5,stroke:#7b1fa2,color:#000
    classDef agent fill:#d0f0ed,stroke:#00897b,color:#000
    classDef wf fill:#e8f0fe,stroke:#3367d6,color:#000

    class U userAction
    class C claudeAction
    class AGENTS agent
    class WF wf
```

**Reading notes**

- The four mechanisms, by trust model: **hooks** make invariants un-bypassable
  (zero context, always on); **rules** guide a thinking agent in three buckets —
  the always-on *constitution* (`CLAUDE.md`), the path-scoped *rules* (`rules/*.md`
  with `paths:` frontmatter, auto-loaded on a matching file), and the on-demand
  *reference* (`reference/*.md`, read via the constitution index); **agents** are fixed-prompt
  specialists invoked with fixed inputs (zero context until invoked — the
  implementer can't game them); **workflows** encode autonomous orchestration
  with caps/gates in code.
- `settings.json` is the allow/deny layer that *works with* the pre-push hook to
  protect `main`; `memory/` is storage. Neither is one of the four mechanisms.
- The user has two routine action arrows into the world: **Gate A** (authorize a
  run) and **Gate B** (merge the `dev→main` PR). Push of non-`main` branches is
  now a Claude action.

---

## 3 — Branch tiers

- **`main` — protected.** Never pushed/merged/committed-to directly; reached
  only via a PR the user merges.
- **All non-`main` — Claude's sandbox** (`dev/feat/fix/chore/integration/*`):
  create, commit, push, merge-between, open PRs autonomously.
- **Invariant:** *nothing reaches `main` without the user's explicit PR merge.*

---

## 4 — Gate model

Two routine human touchpoints, attached to the `main` boundary:

| # | Gate | Trigger | Mechanism | If rejected |
|---|---|---|---|---|
| A | **Authorize** | Up front: scope, feature set, budget, target dev branch | User states task + authorizes | Re-scope |
| B | **Merge** | PR open and CI green | User reviews `dev→main` PR on GitHub, merges | Comments → Claude commits fixes |

Plus one **exception** touchpoint: **escalation** when the circuit breaker
trips (§9). Routine = two touchpoints; you are pulled in mid-run only when
something is genuinely wrong.

The rev-1 mid-flow **DoD-acceptance gate** is gone in autonomous mode — its
skepticism is now the adversarial-reviewer agent (§8). The rev-1 **push gate**
(user runs `git push`) is gone — Claude pushes non-`main` branches autonomously.

Gate A may include **plan pre-authorization** ("come up with your own plan, I
trust you"), short-circuiting the plan-approval step in autonomous mode. Default
is user review of the plan.

Gate A also ensures **GitHub issue scaffolding** is in place: each feature being
worked on must have a linked GitHub issue (provided by the user or created by
the workflow). This gives escalation (§9) a durable, visible target.

---

## 5 — Per-task discipline (two execution modes) — D2

The per-task control flow is a **spec of discipline** — not itself a rule, not
itself a workflow. It has two execution modes:

- **Interactive / solo** (a single feature, human in the loop): the main loop
  follows the discipline conversationally; **the human is the skeptic** (plan
  approval, PR review). A workflow cannot hold this conversation, so this mode
  stays main-loop.
- **Autonomous** (the federated run D4, and authorized single-feature runs):
  encoded as a **workflow**, dispatched after Gate A. The **adversarial-reviewer
  agent is the skeptic** (a mandatory stage); retry caps + escalation are
  enforced in workflow code.

The autonomous mode is drawn below. In interactive mode, the plan-approval gate
is always active (no short-circuit), the human replaces the reviewer agent at
Gate B / PR review, and the human may optionally invoke the reviewer agent as a
courtesy pre-check.

```mermaid
flowchart TD
    A(["User states task"]) --> GA{{"Gate A: authorize run<br/>scope · features · budget · dev branch"}}
    GA --> B{"Trivial?"}
    B -->|yes| D["Claude: create non-main branch<br/>dev/feat/fix/chore"]
    B -->|no| BR["brainstorm if<br/>solution space wide"]
    BR --> P["plan mode"]
    P --> PG{"† User approves<br/>plan?"}
    PG -->|"yes · or pre-authorized<br/>at Gate A"| D
    PG -->|changes| P

    D --> E["Claude: TDD implementation"]
    E --> F{"Bug discovered<br/>in scope?"}
    F -->|fix in PR| E
    F -->|orthogonal| G["File GH issue<br/>cross-link to PR"]
    G --> E
    F -->|none| H["Unit + integration<br/>+ lint + type"]

    H --> HG{"Green?"}
    HG -->|no| E
    HG -->|yes| I["act locally<br/>optional pre-check"]
    I --> J["Smoke: happy + named edges<br/>+ failure modes"]
    J --> JG{"All cases pass?"}
    JG -->|no| E
    JG -->|yes| K["Claude: DoD report<br/>with transcript"]

    K --> REV[["† Adversarial review (AGENT)<br/>refute shims · weakened tests ·<br/>cast-to-None · verify DoD honesty"]]
    REV -->|"reject + critique"| E
    REV -->|pass| L["Claude: push branch<br/>(non-main)"]

    L --> M["Open PR via MCP"]
    M --> N["GitHub Actions runs"]
    N --> NG{"CI green?"}
    NG -->|no| O["Read logs via MCP<br/>fix + re-push (autonomous)"]
    O --> N
    NG -->|yes| PR{{"Gate B: user reviews<br/>dev→main PR · merges"}}
    PR -->|changes| E
    PR -->|merge| CL["Claude: delete branch<br/>prune worktree · close issues"]
    CL --> Z(["Done"])

    CB["⚠ Circuit breaker — every loop<br/>capped at K tries → root-cause → ESCALATE to user"]
    REV -.->|cap| CB
    O -.->|cap| CB

    classDef userAction fill:#e1f5ff,stroke:#0288d1,color:#000
    classDef gate fill:#fff3e0,stroke:#f57c00,color:#000
    classDef claudeAction fill:#f3e5f5,stroke:#7b1fa2,color:#000
    classDef agent fill:#d0f0ed,stroke:#00897b,color:#000
    classDef breaker fill:#ffebee,stroke:#c62828,color:#000

    class A userAction
    class GA,PG,PR userAction
    class B,F,HG,JG,NG gate
    class D,E,G,H,I,J,K,L,M,O,CL claudeAction
    class REV agent
    class CB breaker
```

**Reading notes**

- **Two execution modes.** *Interactive / solo:* the main loop follows this same
  discipline conversationally, and **the human is the skeptic** (plan approval,
  PR review) — a workflow can't hold that conversation, so it stays main-loop.
  *Autonomous* (drawn here, and the federated run D4): encoded as a **workflow**;
  the **reviewer agent is the skeptic**; caps + escalation are in code.
- **Gate A** moves up front (authorize the run). The rev-1 mid-flow
  *DoD-acceptance* gate is **gone** in autonomous mode — its skepticism is now
  the teal reviewer agent. **Gate B** is the `dev→main` PR merge.
- The **plan-approval gate** defaults to user review. In autonomous mode, it can
  be **short-circuited** when the user pre-authorizes plan autonomy at Gate A
  ("come up with your own plan, I trust you"). Trivial tasks skip planning
  entirely.
- **Push is now a Claude action** for non-`main` branches (rev-1 made the human
  push). Nothing still reaches `main` without the user's Gate-B merge.
- The CI-red loop (read logs → fix → re-push) and the reviewer-reject loop
  (reviewer rejects → back to implementation) are **autonomous** but **capped at
  K** (default ~3). Exhaustion triggers root-cause diagnosis, then escalation —
  never an infinite loop, never a shim.
- **†** In **interactive mode**, these nodes change roles: the plan-approval gate
  is always human-reviewed (no short-circuit); the adversarial-reviewer agent is
  replaced by the human at Gate B / PR review.

---

## 6 — Session lifecycle — D3

The per-task flow runs *inside* a session. The work phase is now explicitly
either solo (D2) or federated (D4).

```mermaid
flowchart LR
    SS(["Session start"]) --> SL["Load memory<br/>~/.claude/memory/"]
    SL --> SG["Load lean rules<br/>~/.claude/rules/"]
    SG --> SP["Load project CLAUDE.md +<br/>.claude/settings.local.json"]
    SP --> WORK(["Work × N:<br/>solo (D2) or federated (D4)"])
    WORK --> SE["End-of-session:<br/>prune worktrees · list merged<br/>branches · consolidate memory"]
    SE --> SX(["Session end"])

    classDef terminal fill:#e1f5ff,stroke:#0288d1,color:#000
    classDef claudeAction fill:#f3e5f5,stroke:#7b1fa2,color:#000
    class SS,WORK,SX terminal
    class SL,SG,SP,SE claudeAction
```

- Memory facts are written **the moment they're learned** (durability against an
  abrupt end), then **consolidated** in the end-of-session sweep (tidiness).
- The work phase is N iterations of either the solo per-task flow (D2) or one
  federated multi-feature run (D4).

---

## 7 — Federated multi-feature run — D4

The capability branch-tier autonomy unlocks. **One workflow** fans out one
worktree-isolated agent per feature, gates each with the **reviewer agent**
before it merges onto the dev branch, then opens a single `dev→main` PR. Retry
caps + escalation live in the workflow code.

```mermaid
flowchart TD
    GA{{"Gate A: authorize federated run<br/>feature list · budget · dev branch"}} --> SPAWN["Workflow spawns N<br/>worktree-isolated agents"]

    SPAWN --> FA["feat A<br/>TDD · validate · DoD"]
    SPAWN --> FB["feat B<br/>TDD · validate · DoD"]
    SPAWN --> FC["feat C … ×N<br/>TDD · validate · DoD"]

    FA --> RA[["reviewer agent"]]
    FB --> RB[["reviewer agent"]]
    FC --> RC[["reviewer agent"]]

    RA -->|"reject + critique (cap K)"| FA
    RB -->|"reject + critique (cap K)"| FB
    RC -->|"reject + critique (cap K)"| FC

    RA -->|pass| MG["Merge each reviewed-green<br/>feature → dev branch"]
    RB -->|pass| MG
    RC -->|pass| MG

    MG --> PUSH["Push dev · open ONE<br/>dev→main PR (all DoD reports)"]
    PUSH --> CI["GitHub Actions runs"]
    CI --> CG{"CI green?"}
    CG -->|no| FIX["Autonomous fix + re-push<br/>(cap K → escalate)"]
    FIX --> CI
    CG -->|yes| GB{{"Gate B: user reviews<br/>dev→main PR · merges"}}
    GB --> DONE(["Merged to main"])

    classDef gate fill:#fff3e0,stroke:#f57c00,color:#000
    classDef claudeAction fill:#f3e5f5,stroke:#7b1fa2,color:#000
    classDef agent fill:#d0f0ed,stroke:#00897b,color:#000
    classDef decision fill:#fff3e0,stroke:#f57c00,color:#000
    classDef terminal fill:#e1f5ff,stroke:#0288d1,color:#000

    class GA,GB gate
    class SPAWN,FA,FB,FC,MG,PUSH,CI,FIX claudeAction
    class RA,RB,RC agent
    class CG decision
    class DONE terminal
```

**Reading notes**

- D4 **nests** D3 (it is one "Work" iteration) and contains N **cores** of D2
  (implement → validate → DoD → review) run concurrently — not N full D2s. The
  push / PR / CI / Gate-B tail happens **once** for the whole batch.
- The reviewer agent gates **each feature** before it merges onto dev, so a
  shimmed feature never reaches the shared branch.
- Two human touchpoints for the whole batch: **Gate A** (authorize) and **Gate
  B** (merge). Escalation only fires when a cap is exhausted.

---

## 8 — Adversarial review (the autonomous skeptic)

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

---

## 9 — Circuit breaker (no insane loops, no shims)

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

---

## 10 — Enforcement of `main` protection (three layers)

1. **GitHub branch protection on `main`** (server-side, the real guarantee):
   require PR + ≥1 approval; block direct/force pushes. One-time admin setup.
2. **Global `pre-push` hook**: rejects any push whose remote ref is
   `main`/`master`, in any command form. Closes the bare-`git push` gap. Chains
   to the repo-local pre-push hook (global `core.hooksPath` shadows it
   otherwise).
3. **Global `settings.json`**: allow `git push` for tier branches
   (`dev/*`, `feat/*`, `fix/*`, `chore/*`, `integration/*`); deny `git push
   origin main`, `--force`, `-f`; pre-commit guard against committing on `main`.

### Hooks (intended logic)

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

---

## 11 — Rules — shrink, don't grow

With mechanical concerns moved out, standing rules shrink to lean judgment:

| Rule | Disposition | Notes |
|---|---|---|
| `definition-of-done.md` | **keep, lean** | What "done" means; the DoD report contract. Stance elevated to the constitution; honesty is *also* enforced by the reviewer agent in autonomous mode. |
| `no-shed.md` | **keep, thin** | Principle elevated to the constitution; file keeps the orthogonality tests + the 5+-filings escalation. The shim taxonomy is *also* the reviewer agent's checklist. |
| `branch-lifecycle.md` | **keep, lean** | + the three-bucket model; absorbs the cross-session resume anchor + docs-vs-tracking razor from the retired `single-tracker.md`. |
| `local-ci-parity.md` | **demoted — project reference** | Moved to `docs/references/`; principle elevated to the constitution; the `act` how-to is project-specific (only where GitHub Actions exists). |
| `single-tracker.md` | **deleted — redistributed** | Invariant → pre-commit hook; principle → constitution; practices → `branch-lifecycle.md`. |

**Not created** (category errors): `workflow-dispatch.md` (folds into Gate-A +
workflow code), `adversarial-review.md` (it is the reviewer agent + a workflow
stage).

**Net of the rev-3 sort: 3 surviving design rules (`definition-of-done`, `no-shed`,
`branch-lifecycle`), down from 7. `single-tracker` deleted, `local-ci-parity`
demoted to project reference, and the load-bearing *principles* elevated to the
always-on constitution. In the deliverable these land in `reference/` alongside
the carried-over process rules; the file-type rules (`code-style`, `adr-format`)
stay path-scoped in `rules/`. Per-session context drops — realized by the bucket
split: `reference/` loads on-demand (see §1).**

**Constitution additions** (every elevated principle-line, staged for promotion —
**not applied to any live config**): see §15.

---

## 12 — Responsibility split

| Phase | Claude does | User does |
|---|---|---|
| Task definition | Listens, asks clarifying questions if scope ambiguous | States task (Gate A: authorizes scope, budget, branch) |
| Planning (non-trivial) | Drafts plan in plan mode | Approves plan (or pre-authorizes at Gate A) |
| Branching | Creates `dev/`, `feat/`, `fix/`, `chore/` branch | — |
| Implementation | TDD: write test → implement → green → refactor | — |
| Bug handling | Default: fix in-PR. Orthogonal: file GH issue + cross-link | Redirects if defer needed |
| Test validation | Runs unit, integration, regression, lint, type | — |
| Local CI pre-check | Optionally runs `act` | — |
| Smoke test | Playwright / curl / CLI exercise + named edges + failure modes | — |
| DoD report | Writes report with required transcript | — (autonomous) or reviews (interactive) |
| Adversarial review | Reviewer agent invoked with fixed inputs (autonomous) | Reviews PR at Gate B (interactive) |
| Push | Pushes non-`main` branch | — |
| PR open | Opens via GitHub MCP | — |
| CI monitoring | Reads logs via MCP, commits fixes (capped at K) | — |
| Merge | — (no main write privilege) | Reviews and merges `dev→main` PR (Gate B) |
| Cleanup | Deletes local + remote branch, prunes worktree, closes issues | Confirms if Claude asks |
| Memory update | Writes facts/preferences/feedback to `~/.claude/memory/` | — |

---

## 13 — Rule → enforcement-point mapping

Where each rule fires in the control flow:

| Rule | Enforced at | Mechanism |
|---|---|---|
| `definition-of-done.md` | DoD report (D2) + reviewer agent (autonomous) + Gate B (interactive) | Report structure required; reviewer agent verifies honesty; user verifies at merge |
| `no-shed.md` | Bug-discovered decision (D2) + reviewer agent checklist | Default-fix; orthogonal exception requires GH issue; reviewer catches shims |
| `branch-lifecycle.md` | Branch creation + cleanup (D2) | Naming convention at creation; mandatory delete at close |
| local-CI-parity *(project ref)* | Optional pre-check (D2) | `act` how-to now in project `docs/references/`; the expected-green principle in the constitution; real CI is the gate |
| forbidden-tracker invariant | pre-commit hook (commit time) | Forbidden filenames blocked at commit; principle in global `CLAUDE.md`; resume + docs-vs-tracking practices in `branch-lifecycle.md` |

---

## 14 — Resolved decisions

These were open questions during drafting; each is now decided.

1. **Trivial-task threshold** — ≤10 lines, single file, no behavior change (and
   no new import/dependency). Anything else goes through brainstorm/plan.

2. **Smoke test infeasible locally** — State it in the report, write the
   verification steps into the tracking GH issue (durable), and the user must
   explicitly accept the handoff.

3. **Multi-feature sessions** — One PR per logical feature, even small ones.

4. **Long-running tasks across sessions** — State carried by a branch +
   a GH issue with a live checklist (resume anchor) + a draft PR.

5. **Workflow templates** — The federated run (D4) is the primary workflow.
   Single-feature autonomous runs use D2 encoded as a workflow.

6. **CI-red diagnosis loop** — After a CI fix, re-run `act` + affected smoke
   cases, report as a delta. Full checking, abbreviated reporting.

7. **Memory writes during session** — Write immediately on learning
   (durability), then consolidate in the end-of-session sweep (tidiness).

8. **Cap on orthogonal-bug filings** — Soft surface at 5+ filings (status
   update; user redirects or confirms) — no hard stop.

9. **Named edge cases** — Stated acceptance criteria when they exist; otherwise
   derive from the surface and enumerate derived cases in the DoD report.

10. **Cross-project memory growth** — Deferred (memory hygiene, not dev control
    flow).

11. **Branch-tier autonomy** (rev 2) — `main` protected; all non-`main`
    branches are Claude's sandbox. Two routine gates (A: authorize, B: merge).

12. **Mechanism model** (rev 2) — Safety-critical control is mechanical (hooks /
    agents / workflows), not rules. Rules shrink to lean judgment.

13. **Adversarial review** (rev 2) — A fixed-prompt agent, not a rule. Mandatory
    workflow stage in autonomous mode; human plays this role in interactive mode.

14. **Plan approval short-circuit** (rev 2) — Plan approval defaults to user
    review. Can be pre-authorized at Gate A for autonomous runs.

15. **Three-bucket judgment layer** (rev 3) — the "Rules" mechanism splits into
    the always-on *constitution* (`CLAUDE.md`, global + project), the path-scoped
    *rules* (`rules/*.md` + `paths:` frontmatter, auto-load on matching files),
    and the on-demand *reference* (`reference/*.md`, read via the constitution
    index). Constitution holds short stances; rules/reference hold procedural detail.

16. **On-demand loading** (rev 3) — process rules must not be auto-injected every
    session. Resolved by the bucket split: file-type rules use native `paths:`
    frontmatter in `rules/`; concept-triggered rules live in the plain `reference/`
    folder (not auto-loaded) and are read via the constitution index. This is what
    turns the shrink into real token savings.

17. **Rule sort** (rev 3) — `single-tracker` deleted, `local-ci-parity` demoted
    to project reference (`docs/references/`), `no-shed` thinned, principles
    elevated to the constitution. Survivors sorted into `rules/` (path-scoped:
    code-style, adr-format) and `reference/` (on-demand process rules).

---

## 15 — Constitution — staged for promotion

These are the principle-lines to add to the **always-on constitution** at
promotion. They are **staged here only — not applied to any live config.** The
*global* lines go to `~/.claude/CLAUDE.md` (under "Global defaults"); copy them
in when the rules promote, with the user's explicit go-ahead.

**Definition of Done (principle):**
> A change is not done until it has been exercised against the running system
> and a smoke-test transcript is in the report. Passing unit/integration tests
> is necessary, not sufficient. (Detail: `rules/definition-of-done.md`.)

**No-shed (principle):**
> Bugs found while implementing get fixed in the same change. Filing as an issue
> is only for genuinely orthogonal scope, or explicit user deferral — never an
> escape hatch to declare done. (Detail: `rules/no-shed.md`.)

**Single tracker (principle):**
> GitHub Issues is the only persistent cross-session tracker — file bugs,
> features, and follow-ups as issues, never as ad-hoc markdown. Generate status
> snapshots on demand from the source of truth; never hand-maintain them.
> (Resume / lifecycle detail: `rules/branch-lifecycle.md`.)

**Local-CI parity (principle):**
> Aim for an expected-green first push; a cheap local pre-check (`act`) is worth
> it where CI exists, but real CI is the gate. (Project how-to:
> `docs/references/local-ci-parity.md`.)

---

## Iteration protocol

When you spot a gap or disagreement:

1. Drop a comment inline (or in chat) referencing the section number.
2. We discuss; if we change a rule or gate, the rule file is updated and this
   document's diagrams regenerate to match.
3. Once you sign off on the whole document, the rules promote to
   `~/.claude/rules/` and this document moves to its final home.
