# ClaudeDevCycle

Two things live here:

1. **The deliverable** — the governance config in two install forms:
   **`claude-home/`** (drops into your global `~/.claude` for local dev across all
   repos) and **`claude-repo/`** (commit into a single repo so it travels with the
   clone — required for cloud/remote runs). Constitution, settings, the review-panel
   agents, workflows, and rules. These are the files you actually install and use.
2. **The documentation** — `docs/`, everything that explains, justifies, and
   diagrams that deliverable. Read these to understand *why* the config is shaped
   the way it is; none of it ships into `~/.claude`.

There is no separate "draft" copy of the config. `claude-home/` is the real thing
and git history is the workshop — edit it directly.

## Layout

```
README.md                          This file.
INSTALL.md                         Runbook: how to deploy claude-home/ into ~/.claude.
claude-home/                       GLOBAL deliverable — drops into ~/.claude (local, all repos).
claude-repo/                       PER-REPO deliverable — commit into a repo (cloud-capable).
tests/                             Node test suite (no deps): `node --test` from the repo root.
                                   Pins the workflow scripts' args-boundary contract
                                   and that claude-home/ and claude-repo/ copies match.
docs/                              DOCUMENTATION about the deliverable:
  master-design-doc.md                    Master process doc — the four-mechanism model,
                                     branch tiers, the two human gates. Start here.
  diagrams/branch-tier-autonomy.md   Mermaid source of truth for diagrams D1–D4.
  specs/                             Design specs — intent, pre-build: what & why.
  adr/                               Architecture decision records.
  references/                        Durable as-built how-to (e.g. local-CI parity,
                                     secret & credential protection).
```

### Inside `claude-home/` (the deliverable)

```
CLAUDE.md          Always-on constitution: principle-lines + a load index.
settings.json      Settings + branch-tier permissions.
rules/             Path-scoped rules (auto-load on matching files): code-style, adr-format.
reference/         On-demand process rules (read when a trigger matches).
agents/            review panel: adversarial + correctness (always), security + performance (opt-in).
workflows/         single-feature-run.js (D2), federated-run.js (D4).
git-hooks/         pre-commit, pre-push — branch-tier enforcement, opt-in per repo.
hooks/             bootstrap-check.sh (SessionStart).
skills/            bootstrap-permissions.
```

## Installing

Two install forms, by where Claude runs.

### A — Global (`~/.claude`), for local dev across all your repos
Drop `claude-home/` into `~/.claude`. Full runbook (back up, diff the two
overwrites, copy, enable hooks, opt repos in): **`INSTALL.md`**.

### B — Per-repo (`claude-repo/`), self-contained and required for cloud/remote runs
A cloud/remote run starts from a *fresh clone* — your global `~/.claude` is not
there, so commit the project-scoped config into the repo. From a clone of THIS repo:

```bash
SRC=/path/to/ClaudeDevLifecycle     # this repo (where claude-repo/ lives)
DEST=/path/to/your-repo             # the repo you want to govern

cp -a "$SRC/claude-repo/CLAUDE.md"  "$DEST/CLAUDE.md"
cp -a "$SRC/claude-repo/.claude"    "$DEST/.claude"

cd "$DEST"
git add CLAUDE.md .claude
git commit -m "Add Claude Code governance config"
```

That commits the constitution + `.claude/` (settings/permissions, the review-panel
agents, workflows, rules, reference, a SessionStart hook). The **git-hooks are not
included** — they're local-only and don't run in cloud; there, `main`-protection is
the settings deny-list + GitHub server-side branch protection.

**Optional, recommended:**
- If you also did (A), activate the local git-hooks in this repo (Claude-only
  commit/push guard; ignored in cloud): `touch "$DEST/.claude/branch-tier"`, then commit it.
- Protect `main` server-side where your plan allows:
  ```bash
  gh api --method PUT repos/{owner}/{repo}/branches/main/protection --input - <<'JSON'
  { "required_pull_request_reviews": {"required_approving_review_count": 1},
    "required_status_checks": null, "enforce_admins": true, "restrictions": null }
  JSON
  ```

## `docs/specs/` vs `docs/references/`

- **`docs/specs/`** — design *intent*, pre-build: what we intend to build and why.
- **`docs/references/`** — durable *as-built* how-to you read cold later.

Specs are the blueprint; references are the manual.

## Where to look next

- Understand the design → `docs/master-design-doc.md`, then `docs/specs/`.
- See the diagrams → `docs/diagrams/branch-tier-autonomy.md`.
- Install globally → `INSTALL.md`; into a single repo → the **Installing** section above (or `claude-repo/README.md`).
- Understand the secret/credential lockout (env files, credential dirs, the
  `.env.example` carve-out) → `docs/references/secret-protection.md`.
