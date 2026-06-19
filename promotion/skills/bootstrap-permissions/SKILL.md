---
name: bootstrap-permissions
description: Use when entering a new project for the first time (no .claude/settings.local.json exists), or when the user asks to set up Claude Code permissions / allow-list for a project. Detects the project's stack from manifest files and proposes a permission allow-list covering standard test/lint/build/git commands, deliberately leaving destructive commands unapproved.
---

# Bootstrap Permissions Skill

## Purpose

Stop the "Claude waited all night for permission approval" failure mode on
new projects. Detects the stack, proposes an allow-list, and writes
`.claude/settings.local.json` after user confirmation.

## When to invoke

- User enters a new project and `.claude/settings.local.json` does not exist.
- User explicitly asks to bootstrap permissions, set up the allow-list, or
  "configure Claude Code" for a project.
- Before starting a multi-hour autonomous or overnight session on a project
  whose `settings.local.json` is missing or visibly stale (missing common
  commands for the detected stack).

## Step 1 — Detect the stack

Read in parallel any of these that exist:
- `package.json` — Node / JS / TS. Read `scripts`, `devDependencies` to infer
  test runner (jest/vitest/mocha), bundler (vite/webpack), linter
  (eslint/biome), formatter (prettier).
- `pyproject.toml`, `setup.py`, `requirements.txt`, `uv.lock`, `poetry.lock` —
  Python. Read `[tool.*]` sections to infer pytest, ruff, mypy, pyright, black.
- `go.mod` — Go.
- `Cargo.toml` — Rust.
- `Gemfile` — Ruby.
- `composer.json` — PHP.
- `Makefile`, `justfile`, `Taskfile.yml` — task runners. Extract target names.
- `docker-compose.yml`, `compose.yml`, `Dockerfile` — containers.
- `.github/workflows/*.yml`, `.circleci/config.yml` — CI hints for what
  commands the project actually runs.
- `CLAUDE.md`, `AGENTS.md`, `README.md` — often have a commands section listing
  canonical commands.

Note any existing `.claude/settings.local.json` or `.claude/settings.json`.

## Step 2 — Derive the allow-list

Always include:

```
Bash(git add:*)
Bash(git commit:*)
Bash(git diff:*)
Bash(git log:*)
Bash(git status:*)
Bash(git branch:*)
Bash(git switch:*)
Bash(git checkout:*)
Bash(git stash:*)
Bash(git merge:*)
Bash(git fetch:*)
Bash(git pull:*)
Bash(git show:*)
Bash(git blame:*)
Bash(git restore:*)
```

**Python** (if Python stack detected):
```
Bash(pytest:*)
Bash(python -m pytest:*)
Bash(python:*)
Bash(python3:*)
Bash(ruff:*)
Bash(mypy:*)
Bash(pyright:*)
Bash(black:*)
Bash(isort:*)
Bash(pip install:*)
Bash(pip list:*)
Bash(pip show:*)
```
Add `Bash(uv:*)` if `uv.lock` present. Add `Bash(poetry:*)` if `poetry.lock`
present. Add `Bash(pipenv:*)` if `Pipfile` present.

**Python virtualenv — use `env.PATH`, not `.venv/bin/*` globs.** If the repo
has a project-local virtualenv (`.venv/`, `venv/`, or `env/`), do NOT add a
pile of `Bash(.venv/bin/pytest:*)`, `Bash(.venv/bin/python:*)` style entries.
Instead, set the environment in `settings.local.json` so every Bash call
resolves bare commands (`pytest`, `python`, `ruff`, `mypy`, `pip`, `alembic`,
etc.) to the venv's binaries automatically.

**CRITICAL: Hardcode the full PATH. Do NOT use `${PATH}` expansion.**

Claude Code does **not** expand `${VAR}` substitutions in `env.PATH`. If you
write `"PATH": ".venv/bin:${PATH}"`, the literal string `${PATH}` ends up as
a path component, the system paths are lost, and the next session's startup
hooks fail with `bash: command not found` / `dirname: command not found`
because `/bin` and `/usr/bin` aren't on PATH anymore. Observed failure mode,
not theoretical.

**Correct form — macOS (Apple Silicon):**
```json
{
  "env": {
    "VIRTUAL_ENV": "/absolute/path/to/project/.venv",
    "PATH": "/absolute/path/to/project/.venv/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  },
  "permissions": { "allow": ["Bash(pytest:*)", "Bash(python:*)", ...] }
}
```

**macOS (Intel)** — replace `/opt/homebrew/*` with nothing, keep the rest:
`/abs/.venv/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`

**Linux** — typical default:
`/abs/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`

Before proposing the PATH, run `echo $PATH` in the current session and use
that as the baseline — then prepend `.venv/bin` to it. That captures the
user's actual setup (extra homebrew taps, `/usr/local/go/bin`, language
version managers, etc.) instead of guessing. Claude Code's plugin bin dirs
are appended automatically; you don't need to include them.

Why `env.PATH` beats the alternatives:
- `source .venv/bin/activate` doesn't persist — Claude Code's Bash tool runs
  each command in a fresh shell; shell state does not carry between calls.
- `.venv/bin/*` glob entries work but clutter the allow-list and don't extend
  to new tools the venv installs later.
- `env.PATH` is set once, stays stable, and keeps the allow-list using plain
  command names that match how the project's own docs and CI refer to them.

Detect a project-local venv via `ls` for `.venv/bin/`, `venv/bin/`, or
`env/bin/` — and also check the project's `README.md` / `CLAUDE.md` for a
documented venv path if it's non-standard. When you propose the settings
file, include the `env` block and call it out explicitly.

**Verification after restart (required before declaring success):**
After the user restarts Claude Code, run these and check the output:
```bash
echo $PATH              # Should contain .venv/bin and /bin, /usr/bin, /opt/homebrew/bin
which pytest            # Should point to .venv/bin/pytest
which bash              # Should point to /bin/bash or /usr/local/bin/bash
```
If `bash` or `dirname` are "not found," PATH is broken — the session's
startup hooks will also be failing. The user may need to fix the PATH line
manually if `Write/Edit(.claude/settings.local.json)` is in the deny list.

Note: `env` changes load on Claude Code restart (same as permissions). Mention
this in Step 6.

**Node / JS / TS** (if `package.json` detected):
```
Bash(npm install:*)
Bash(npm ci:*)
Bash(npm run:*)
Bash(npm test:*)
Bash(npm list:*)
Bash(npx:*)
Bash(tsc:*)
Bash(eslint:*)
Bash(prettier:*)
Bash(biome:*)
```
Add `Bash(pnpm:*)` if `pnpm-lock.yaml` present.
Add `Bash(yarn:*)` if `yarn.lock` present.
Add `Bash(bun:*)` if `bun.lockb` or `bunfig.toml` present.

**Go:**
```
Bash(go build:*)
Bash(go test:*)
Bash(go run:*)
Bash(go mod:*)
Bash(go vet:*)
Bash(gofmt:*)
Bash(golangci-lint:*)
```

**Rust:**
```
Bash(cargo:*)
Bash(rustc:*)
Bash(rustfmt:*)
Bash(clippy:*)
```

**Ruby:**
```
Bash(bundle:*)
Bash(rake:*)
Bash(rspec:*)
Bash(rubocop:*)
```

**Docker** (if `docker-compose.yml` or `Dockerfile` present):
```
Bash(docker compose:*)
Bash(docker ps:*)
Bash(docker logs:*)
Bash(docker exec:*)
Bash(docker build:*)
Bash(docker inspect:*)
```
Deliberately excluded: `docker system prune`, `docker rm`, `docker rmi`,
`docker volume rm`.

**Task runners** (per-file):
- `Makefile` present → `Bash(make:*)`
- `justfile` present → `Bash(just:*)`
- `Taskfile.yml` present → `Bash(task:*)`

**Read-only OS utilities** (always safe):
```
Bash(ls:*)
Bash(pwd:*)
Bash(which:*)
Bash(env:*)
```
(Avoid adding these if the project's Bash tool instructions discourage
using them in favor of Glob/Grep/Read — check the project's CLAUDE.md.)

## Step 3 — Deliberately exclude dangerous patterns

Never add to the allow-list:
- `Bash(git push:*)` — publishes work; always prompt.
- `Bash(git reset:*)`, `Bash(git reset --hard:*)` — destroys local work.
- `Bash(git rebase:*)` — rewrites history; often interactive.
- `Bash(git clean:*)` with `-f` — deletes untracked files.
- `Bash(git branch -D:*)` — force-delete branch.
- `Bash(rm:*)`, `Bash(rm -rf:*)` — deletion.
- `Bash(sudo:*)` — privilege escalation.
- `Bash(curl:*)` when piped to `sh` / `bash` — remote code execution.
- `Bash(wget:*)` — same concern as curl.
- `Bash(chmod:*)`, `Bash(chown:*)` — permission changes.
- `Bash(kill:*)`, `Bash(killall:*)`, `Bash(pkill:*)` — process termination.
- Any DROP / DELETE / TRUNCATE SQL patterns.
- `Bash(docker system prune:*)`, `Bash(docker rm:*)`, `Bash(docker rmi:*)`,
  `Bash(docker volume rm:*)`.
- Cloud CLI destructive commands: `Bash(aws * delete:*)`, `Bash(gcloud * delete:*)`,
  `Bash(az * delete:*)`, `Bash(terraform destroy:*)`, `Bash(terraform apply:*)`
  (apply is usually destructive enough to warrant a prompt).

If the user insists on adding any of these, do so on their explicit instruction
and mention the risk once.

## Step 3.5 — Use `permissions.deny` for hard blocks

Omitting from `allow` means "prompt for approval each time." That's usually
right — but for operations that should NEVER run silently (even via a misread
glob or a future allow-list addition), use `permissions.deny`. Deny overrides
allow and fires with no approval prompt.

**Always propose denying self-edits of the settings files.** Claude can modify
any file Write/Edit is allowed to touch, including `.claude/settings.local.json`
itself — which means it could theoretically widen its own allow-list in one
session that a future session then inherits. Deny that path unconditionally:

```json
"permissions": {
  "deny": [
    "Edit(.claude/settings.local.json)",
    "Write(.claude/settings.local.json)",
    "Edit(.claude/settings.json)",
    "Write(.claude/settings.json)"
  ]
}
```

**Also belt-and-braces the destructive patterns** from Step 3 when the project
is likely to have long autonomous or overnight sessions, where a sleepy future
allow-list edit could accidentally widen scope:

```json
"permissions": {
  "deny": [
    "Bash(git push:*)",
    "Bash(git reset --hard:*)",
    "Bash(git rebase:*)",
    "Bash(git clean -f:*)",
    "Bash(git clean -fd:*)",
    "Bash(git branch -D:*)",
    "Bash(rm:*)",
    "Bash(sudo:*)",
    "Bash(chmod:*)",
    "Bash(chown:*)",
    "Bash(kill:*)",
    "Bash(killall:*)",
    "Bash(pkill:*)",
    "Bash(docker system prune:*)",
    "Bash(docker rm:*)",
    "Bash(docker rmi:*)",
    "Bash(docker volume rm:*)"
  ]
}
```

Call these out in the proposal so the user understands deny is a hard block,
not a prompt gate.

**Chicken-and-egg warning:** Once `Edit/Write(.claude/settings.local.json)` is
denied, Claude cannot repair the settings file itself. If a bad entry gets in
(e.g., a malformed PATH, a typo in a glob), the user has to fix it manually.
Get the settings right on the first write. In particular:
- Validate the JSON is well-formed before writing.
- If setting `env.PATH`, follow the hardcoded-path guidance in Step 2 — never
  use `${PATH}` expansion.
- Mention this one-way-door property to the user when proposing the deny
  block. It's a feature (self-edit protection) with a cost (manual repairs).

If the user wants broader self-protection, offer `Edit(.claude/**)` and
`Write(.claude/**)` instead of the narrow variants — note the tradeoff that
this also blocks legitimate edits to agent definitions, team.md, and skills.

## Step 4 — Handle an existing settings file

If `.claude/settings.local.json` already exists:
1. Read the current allow-list.
2. Compute the *additions* — entries in the proposed list that aren't in the
   existing list.
3. Show only the additions for confirmation. Do not remove or reorder existing
   entries without explicit user request.
4. Preserve all other keys in the file (e.g. `env`, `hooks`, `permissions.deny`).

If `.claude/settings.json` (the shared, git-tracked variant) exists but
`.local.json` does not, read the shared file to understand what's already
approved team-wide, and propose additions in `.local.json` that complement it.

## Step 5 — Present the proposal

Output something like:

> **Detected stack:** Python (pyproject.toml, pytest, ruff, mypy, `.venv/`
> present) + Docker Compose + Makefile.
>
> **Proposed `.claude/settings.local.json`:**
> ```json
> {
>   "env": {
>     "VIRTUAL_ENV": "/abs/path/.venv",
>     "PATH": "/abs/path/.venv/bin:${PATH}"
>   },
>   "permissions": {
>     "allow": [
>       "Bash(pytest:*)",
>       "Bash(ruff:*)",
>       ...
>     ],
>     "deny": [
>       "Edit(.claude/settings.local.json)",
>       "Write(.claude/settings.local.json)",
>       "Edit(.claude/settings.json)",
>       "Write(.claude/settings.json)"
>     ]
>   }
> }
> ```
>
> **`env.PATH`** makes bare `pytest` / `python` / `ruff` resolve to the venv's
> binaries — no `.venv/bin/*` globs needed.
>
> **`deny`** hard-blocks Claude from silently widening its own allow-list by
> editing the settings files. Deny wins over allow; no approval prompt fires.
>
> **Deliberately excluded from `allow`** (these keep prompting):
> `git push`, `git reset --hard`, `rm`, `sudo`, `docker system prune`,
> `terraform apply`.
>
> Write this to `.claude/settings.local.json`?

If the existing file has other keys, show the merged result, not just the
additions, so the user can see the full post-write state.

## Step 6 — Write on confirmation

After the user confirms:
1. Write `.claude/settings.local.json`.
2. Ensure `.claude` exists and `.claude/settings.local.json` is gitignored.
   Check the repo's `.gitignore` for either `.claude/settings.local.json` or
   `.claude/settings.local.*`. If neither is present, append
   `.claude/settings.local.json` to `.gitignore` and mention the addition.
   Never add `.claude/settings.json` to `.gitignore` — that one is intentionally
   shared if it exists.
3. Remind the user that the new permissions load on next Claude Code restart,
   or with `/permissions reload` if available in their version.

## Key principles

- **Permissive for the reversible, strict for the destructive.** The prompt
  system exists to gate destructive operations. The allow-list exists to stop
  re-prompting for operations that are always safe.
- **One file per project.** Permissions are project-shaped. Don't try to share
  the list globally.
- **`.local.json`, not `.json`.** The `local` variant is gitignored by
  convention. Modifying a shared `settings.json` affects every contributor.
- **Conservative additions on updates.** On an existing file, add only. Don't
  remove entries you didn't write. Don't reorder.
- **Show before writing.** Always present the proposed JSON for confirmation.
  The user should be able to say "drop the docker entries" or "add
  `Bash(foo:*)`" and have you re-draft in-place.
- **Honest about what's not covered.** If the project has idiosyncratic
  commands (a custom shell script, a proprietary CLI), name them in the
  proposal and ask whether to include them.

## What this skill does NOT do

- Does not modify a shared `.claude/settings.json` without explicit request.
- Does not edit `.claude/agents/*.md` tool scopes — that's the job of the
  `build-team` skill or manual edit.
- Does not install hooks — hooks are a separate concern; mention them only if
  the user asks.
- Does not alter `~/.claude/settings.json` (user-global). Permissions are
  per-project.
