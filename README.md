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

## `docs/specs/` vs `docs/references/`

- **`docs/specs/`** — design *intent*, pre-build: what we intend to build and why.
- **`docs/references/`** — durable *as-built* how-to you read cold later.

Specs are the blueprint; references are the manual.

## Where to look next

- Understand the design → `docs/master-design-doc.md`, then `docs/specs/`.
- See the diagrams → `docs/diagrams/branch-tier-autonomy.md`.
- Deploy the config → `INSTALL.md`.
