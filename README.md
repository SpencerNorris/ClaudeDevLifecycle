# ClaudeDevCycle

Two things live here:

1. **The deliverable** — `claude-home/`, a drop-in copy of a Claude Code global
   config (`~/.claude`): the constitution, settings, git-hooks, agents, workflows,
   and rules that govern autonomous development. These are the files you actually
   install and use.
2. **The documentation** — `docs/`, everything that explains, justifies, and
   diagrams that deliverable. Read these to understand *why* the config is shaped
   the way it is; none of it ships into `~/.claude`.

There is no separate "draft" copy of the config. `claude-home/` is the real thing
and git history is the workshop — edit it directly.

## Layout

```
README.md                          This file.
INSTALL.md                         Runbook: how to deploy claude-home/ into ~/.claude.
claude-home/                       THE DELIVERABLE — drops into ~/.claude (see below).
docs/                              DOCUMENTATION about the deliverable:
  master-design-doc.md                    Master process doc — the four-mechanism model,
                                     branch tiers, the two human gates. Start here.
  diagrams/branch-tier-autonomy.md   Mermaid source of truth for diagrams D1–D4.
  specs/                             Design specs — intent, pre-build: what & why.
  adr/                               Architecture decision records.
  references/                        Durable as-built how-to (e.g. local-CI parity).
```

### Inside `claude-home/` (the deliverable)

```
CLAUDE.md          Always-on constitution: principle-lines + a load index.
settings.json      Settings + branch-tier permissions.
rules/             Path-scoped rules (auto-load on matching files): code-style, adr-format.
reference/         On-demand process rules (read when a trigger matches).
agents/            adversarial-reviewer — the refute-first review gate.
workflows/         single-feature-run.js (D2), federated-run.js (D4).
git-hooks/         pre-commit, pre-push — branch-tier enforcement, opt-in per repo.
hooks/             bootstrap-check.sh (SessionStart).
skills/            bootstrap-permissions.
```

## Activating it in a repo (opt-in)

Branch-tier enforcement is **opt-in per repo** — the global hooks do nothing until
a repo opts in, so installing the config can't surprise-break your other repos. In
a repo where you want `main` guarded:

```
mkdir -p .claude && touch .claude/branch-tier   # commit this marker to share the opt-in
```

That activates the `pre-commit`/`pre-push` hooks there: direct commits and pushes
to `main`/`master` are blocked (reach `main` via a reviewed PR) and forbidden
tracker files are rejected. (Alternatives: `git config claude.branchTier true`, or
`export CLAUDE_BRANCH_TIER=1`.)

GitHub **server-side branch protection** is the only *unbypassable* guarantee — set
it on `main` where your plan allows. Where it doesn't (e.g. private repos on free
plans), **these local hooks are your main-protection**, so opting in is the
load-bearing step, not a nicety — they stop *accidental* pushes to `main` (a
deliberate `--no-verify` still bypasses them). The `bootstrap-permissions` skill
sets all of this up in one shot on a new project.

## `docs/specs/` vs `docs/references/`

- **`docs/specs/`** — design *intent*, pre-build: what we intend to build and why.
- **`docs/references/`** — durable *as-built* how-to you read cold later.

Specs are the blueprint; references are the manual.

## Where to look next

- Understand the design → `docs/master-design-doc.md`, then `docs/specs/`.
- See the diagrams → `docs/diagrams/branch-tier-autonomy.md`.
- Deploy the config → `INSTALL.md`.
