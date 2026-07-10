# Installing `claude-home/` into `~/.claude`

The `claude-home/` folder is a **staged, reviewable copy** of the global Claude
Code config we designed in `ClaudeDevCycle` (see `docs/master-design-doc.md` and
`docs/specs/`). It mirrors the `~/.claude/` layout so it can be dropped in cleanly.
**Nothing in it has touched your live `~/.claude`** — applying it is a deliberate
manual step you take after reviewing the diff.

Everything was built and adversarially verified, then hand-tested (the git hooks
were executed in throwaway repos under macOS `/bin/bash` 3.2 — 19/19 cases pass).

---

## What's in here

```
claude-home/
  CLAUDE.md                      # constitution: your existing CLAUDE.md + the principle-lines + the load index  (OVERWRITES ~/.claude/CLAUDE.md)
  settings.json                  # your existing settings + branch-tier permissions + secret-protection lockout  (OVERWRITES ~/.claude/settings.json)
  rules/                         # PATH-SCOPED rules (auto-load only on matching files)
    code-style.md                #   + paths: source globs
    adr-format.md                #   + paths: docs/adr/**
  reference/                     # ON-DEMAND rules (read via the CLAUDE.md index when relevant)
    definition-of-done.md  no-shed.md  branch-lifecycle.md       # the rev-3 design rules
    architecture.md  documentation.md  testing.md  workflow.md  workflow-autonomy.md   # your existing process rules
  agents/
    adversarial-reviewer.md      # review panel: refute-first (shims / DoD honesty)
    correctness-reviewer.md      #   + correctness (real logic/edge bugs) — always-on
    security-reviewer.md         #   + security — opt-in per project (run's reviewers arg)
    performance-reviewer.md      #   + performance — opt-in per project
  workflows/
    single-feature-run.js        # D2 autonomous cycle as a workflow
    federated-run.js             # D4 federated multi-feature run
  git-hooks/
    pre-commit  pre-push         # global git hooks (enabled via core.hooksPath; enforcement opt-in per repo)
  hooks/
    bootstrap-check.sh           # your existing SessionStart hook (fixed a pre-existing heredoc/indentation bug)
  skills/
    bootstrap-permissions/SKILL.md   # your existing skill (carried forward unchanged)
```

(The ADR that records this decision is repo documentation, not part of the
payload — it lives at `docs/adr/0001-branch-tier-autonomy.md` and does **not**
ship into `~/.claude`.)

## What was deliberately EXCLUDED from `~/.claude` (and why)

These are machine-local runtime state, not portable config — copying them would be
noise or would clobber live state:

- `sessions/`, `tasks/`, `jobs/`, `daemon/`, `session-env/`, `shell-snapshots/`,
  `telemetry/`, `debug/`, `file-history/`, `paste-cache/`, `downloads/`, `cache/`,
  `backups/`, and the `.last-*` / `*-cache.json` dot-files — all transient.
- `projects/` and `memory/` — your accumulated per-project transcripts and personal
  memory. Personal data, not config; left untouched.
- `plugins/` — installed separately via the plugin manager (`enabledPlugins` in
  `settings.json` already lists them; the plugin payloads are managed, not copied).
- `skills/build-team`, `skills/excalidraw-skill` — existing skills not in scope for
  this change; only `bootstrap-permissions` was requested. They are untouched in
  your live config either way (a merge-copy of this folder does not remove them).

---

## How to apply (review first, then drop in)

1. **Back up your current config.**
   ```bash
   cp -a ~/.claude ~/.claude.bak.$(date +%Y%m%d)
   ```

2. **Review the two OVERWRITES** — `CLAUDE.md` and `settings.json` are built from
   YOUR current ones plus additions, so a copy replaces them. Diff before applying:
   ```bash
   diff ~/.claude/CLAUDE.md     claude-home/CLAUDE.md
   diff ~/.claude/settings.json claude-home/settings.json
   ```
   `settings.json` keeps every existing key. On top of the branch-tier
   `permissions` block it also adds the secret-protection layer: env/credential
   `Read` deny rules, a `sandbox` filesystem carve-out for `.env.example`, and a
   `PreToolUse` hook that blocks Bash commands referencing env files by name —
   see `docs/references/secret-protection.md`.
   `CLAUDE.md` keeps your existing text and adds the constitution principle-lines,
   the rule-load index, and the branch-tier section.

3. **Copy the folder contents into `~/.claude`** (merge; the excluded dirs above
   are simply not present here, so they're left alone):
   ```bash
   cp -a claude-home/CLAUDE.md      ~/.claude/CLAUDE.md
   cp -a claude-home/settings.json  ~/.claude/settings.json
   cp -a claude-home/rules/.        ~/.claude/rules/   # path-scoped (replaces code-style/adr-format with frontmatter'd versions)
   cp -a claude-home/reference      ~/.claude/         # NEW dir: on-demand process rules
   cp -a claude-home/agents         ~/.claude/         # NEW dir
   cp -a claude-home/workflows      ~/.claude/         # NEW dir
   cp -a claude-home/git-hooks      ~/.claude/         # NEW dir
   cp -a claude-home/hooks/bootstrap-check.sh                 ~/.claude/hooks/bootstrap-check.sh
   cp -a claude-home/skills/bootstrap-permissions            ~/.claude/skills/
   chmod +x ~/.claude/git-hooks/pre-commit ~/.claude/git-hooks/pre-push
   ```
   Note: your existing `~/.claude/rules/{code-style,adr-format}.md` will be replaced
   by the path-scoped versions, and the other five process rules move to
   `~/.claude/reference/`. **Remove the now-duplicated originals from `rules/`** so
   they don't keep auto-loading:
   ```bash
   rm ~/.claude/rules/workflow-autonomy.md ~/.claude/rules/architecture.md \
      ~/.claude/rules/documentation.md ~/.claude/rules/testing.md ~/.claude/rules/workflow.md
   ```

4. **Enable the global git hooks** (this is what makes the hooks active; without
   it they do nothing):
   ```bash
   git config --global core.hooksPath ~/.claude/git-hooks
   ```
   This is safe globally: the hooks are **transparent** in every repo until that
   repo opts in (next step). They only ever chain to a repo-local hook otherwise.
   If you already use a global `core.hooksPath`, merge instead of overwrite —
   these hooks chain to repo-local hooks but not to another global hooks dir.

5. **Opt a repo into branch-tier enforcement** (per repo where you want it):
   ```bash
   touch .claude/branch-tier      # or: export CLAUDE_BRANCH_TIER=1   # or: git config claude.branchTier true
   ```
   Only then do the hooks act — and only on *Claude-initiated* git: they block
   Claude's direct commits/pushes to `main` and tracker files in that repo. You,
   in your own terminal, commit and push to `main` freely (you're Gate B).

6. **Set GitHub branch protection on `main`** where your plan allows it — the only
   *unbypassable* layer (require a PR + ≥1 approval, block direct/force pushes;
   one-time, per repo, in the GitHub UI). Note: protected branches on *private*
   repos need a paid GitHub plan. **Where it isn't available, the opted-in local
   hooks (step 5) are your `main`-protection** — they stop accidental pushes to
   `main`, though a deliberate `--no-verify` bypasses them.

---

## Important: the one judgment call I made for you

**Branch-tier hook enforcement is OPT-IN per repo, not always-on.** The design spec
(§8) describes it as always-on, but a *global* `core.hooksPath` runs for **every**
repo on your machine — an always-on `main`-commit block would stop **you** from
committing to `main` in every unrelated repo. So enforcement activates only when a
repo opts in (step 5). This is documented in the hook headers and in the ADR. To
make it always-on instead, edit the two hooks to remove the `branch_tier_opted_in`
gate — but I'd recommend keeping the opt-in. Your call.

## Caveats worth knowing

- **`settings.json` permission patterns are best-effort.** Claude Code's Bash
  permission matcher is prefix/glob-based; the **deny** rules (block `main` + force
  pushes) are the safety-critical part and are robust, but verify the tier-push
  **allow** globs (`feat/*`, etc.) behave as you expect on your version.
- **The workflows are templates.** `single-feature-run.js` and `federated-run.js`
  are valid (`node --check` passes) and use the real Workflow DSL, but they invoke
  the GitHub MCP / `gh` and the review-panel agents at runtime and have
  not been run end-to-end against a live repo. Treat the first real run as a
  shakedown.
- **On-demand vs always-on is a tradeoff.** Moving the process rules to
  `reference/` means they load only when the model opens them. Their must-know
  stances are in the constitution (`CLAUDE.md`) so behavior is preserved, but if
  you want any specific rule always-on, move it back into `~/.claude/rules/`
  without `paths:` frontmatter.
- **bash version:** the hooks are POSIX-lowercase (work on bash 3.2 and 4+).

## Rollback
```bash
rm -rf ~/.claude && mv ~/.claude.bak.YYYYMMDD ~/.claude
git config --global --unset core.hooksPath
```
