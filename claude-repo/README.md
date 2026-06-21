# claude-repo — project-scoped governance (for cloud / remote runs)

`claude-home/` installs into your **global** `~/.claude` and governs **local** runs
across all your repos. But a **cloud / remote** Claude Code run (claude.ai/code,
cloud sandboxes, remote agents) starts from a *fresh clone* — your global
`~/.claude` is not there. Only what's **committed to the repo** travels.

This folder is the project-scoped variant: drop it into any repo you'll run in the
cloud (or want self-contained, shareable governance for) and commit it.

## Layout

```
claude-repo/
  CLAUDE.md                 -> <repo>/CLAUDE.md   (the constitution; carries the principles)
  .claude/
    settings.json           permissions (deny main/force; allow tier pushes) + SessionStart hook
    agents/                 adversarial-reviewer
    workflows/              single-feature-run.js, federated-run.js
    rules/                  path-scoped: code-style, adr-format
    reference/              on-demand process rules (indexed by CLAUDE.md)
    hooks/                  session-start.sh (re-asserts branch-tier discipline)
```

## How to use

Copy into the target repo and commit:

```bash
cp -a claude-repo/CLAUDE.md  <repo>/CLAUDE.md
cp -a claude-repo/.claude    <repo>/.claude
cd <repo>
git add CLAUDE.md .claude && git commit -m "Add Claude Code governance config"
```

Then set GitHub server-side branch protection on `main` where your plan allows it
(the unbypassable layer — see below).

## What travels vs. what doesn't

**Works in cloud (all committed):**
- `CLAUDE.md` — the constitution (essential: the global one does not travel).
- `.claude/settings.json` — **the permissions deny-list still enforces against
  Claude in cloud** (blocks `git push origin main`, force pushes, `reset --hard`).
- `.claude/agents/`, `.claude/workflows/`, `.claude/rules/`, `.claude/reference/`.
- `.claude/hooks/session-start.sh` — SessionStart hooks run in cloud.

**Does NOT travel — the one real gap:**
- The branch-tier **git hooks** (`pre-commit`/`pre-push`) are a *local-only*
  mechanism (global `core.hooksPath`); they do not run in cloud. There, the
  bare-`git push` ref-inspection is gone. `main`-protection in cloud = the
  settings deny-list (above) **+ GitHub server-side branch protection**. The
  SessionStart hook re-asserts the discipline as a reminder.

**Left out by design:**
- Personal prefs (model, voice, effort) and your personal plugin set — those are
  user-global, not project policy. Put them in a gitignored
  `.claude/settings.local.json` if you want them for your own cloud runs.
- The `bootstrap-permissions` skill — a global authoring tool for *new* projects;
  a repo that already ships this config doesn't need it.

## Note on the workflows

`single-feature-run.js` / `federated-run.js` cite the design doc by name
(`master-design-doc.md §N`); that doc lives in the ClaudeDevLifecycle repo, not in
the target repo, so those are bibliographic references, not runtime dependencies.
Project `.claude/workflows/*.js` are invocable by name (`/single-feature-run`)
locally; verify one run in the cloud before relying on them there.
