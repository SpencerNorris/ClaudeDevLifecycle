# Secret & Credential Protection

## Purpose
**Status: project-level reference, as-built (mirrors the live `~/.claude/settings.json`
hardening).** Three independent layers stop Claude from ever seeing the contents of
env files or common credential stores — not by asking nicely in a rule, but by
denying the tool calls that could read them. This is defense-in-depth: each layer
covers a different path a secret could leak through, and a gap in one is caught by
another.

## What it blocks

| Layer | Mechanism | Blocks |
|---|---|---|
| 1. Read tool | `permissions.deny` glob rules | The `Read` tool opening `.env`, `.env.*`, `.envrc` anywhere, and `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`, `~/.kube/**`, `~/.config/gcloud/**`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/Library/Keychains/**` |
| 2. Sandbox filesystem | `sandbox.filesystem` | Bash-tool sandboxed processes stat-ing/reading `.env`-shaped paths at the OS level (the `permissions.deny` env-file globs feed the sandbox's read-deny set, not just the `Read` tool) |
| 3. Bash command text | `hooks.PreToolUse` (matcher `Bash`) | Claude issuing a Bash command whose *text* references an env file — `cat .env`, `export $(cat .env.production)`, `source .envrc`, etc. — even when no `Read` tool call is involved |

Layer 1 stops the obvious path (Claude reads the file directly). Layer 3 stops
the path around it (Claude shells out to read/export/source the file instead).
Layer 2 is what makes layer 1 not leak through the sandbox's own filesystem
access — without it, a sandboxed Bash command could stat or cat an env file
even though the `Read` tool itself was denied.

## The `.env.example` carve-out

`permissions.deny`'s `Read(//**/.env.*)` glob is deliberately broad — it also
matches `.env.example`, a template file that's normally *tracked in git* (no
secrets, just key names). That's fine for the `Read` tool: Claude should never
open it via `Read` either, no exceptions, so it stays blocked there.

But the same glob feeding layer 2 (sandbox filesystem denial) broke something
unrelated: sandboxed `git status` needs to **stat** every tracked file to report
its state, including a tracked `.env.example`. With no carve-out, that stat was
denied and sandboxed `git status` failed on any repo that tracks a `.env.example`
template.

The fix is the top-level `sandbox` block:

```json
"sandbox": {
  "filesystem": {
    "allowRead": ["/**/.env.example"]
  }
}
```

This restores filesystem-level read access to `.env.example` specifically (layer
2 only) so ordinary sandboxed git/file operations work again — **the `Read` tool
stays blocked** on it (layer 1 is untouched). Layer 3 mirrors the same exception:
the hook strips the literal substring `.env.example` out of the command text
before pattern-matching, so `cat path/to/.env.example` is allowed to run while
`cat path/to/.env.production` is not.

## Layer 3 in detail — the `PreToolUse` hook

```json
"PreToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      {
        "type": "command",
        "command": "c=$(jq -r '.tool_input.command // empty'); c=${c//.env.example/}; if printf ' %s ' \"$c\" | grep -qE '[^A-Za-z0-9_]\\.env(rc|\\.[A-Za-z0-9._-]+)?[^A-Za-z0-9._-]'; then echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"User policy: .env files are off-limits to Claude. Ask the user for the specific value, or have them run the command themselves with the ! prefix.\"}}'; fi"
      }
    ]
  }
]
```

Design notes, preserved here because they're non-obvious from the regex alone:

- **Space-padded input.** The command text is wrapped in spaces
  (`printf ' %s ' "$c"`) before matching, because BSD `grep` (macOS's default)
  treats `^`/`$` as anchors only at the pattern's outer edges, not inside a
  group — there's no portable way to say "start or non-word-char" otherwise.
  Padding gives the regex real characters to anchor the boundary against.
- **`.env.example` is stripped first, unconditionally**, so it can never trip
  the match — this is the Bash-layer twin of the sandbox carve-out above.
- **Character-class boundaries** (`[^A-Za-z0-9_]` before, `[^A-Za-z0-9._-]`
  after) exist specifically to avoid false positives on tokens that merely
  *contain* `.env` as a substring: `process.env`, `.venv`, `python-dotenv`,
  `.env.example` (belt-and-suspenders once the strip above already removes it).
- **Verification after editing this string**: because it lives inside a JSON
  string value, every `\` in the shell regex must be doubled in the file
  (`\\.` in JSON decodes to `\.` at runtime). Confirm with `jq -r` on the
  `command` field and check the decoded value contains a single backslash
  before `.env`, not two.

## Workflow implication

Claude cannot read env files or credential stores by any tool path — directly,
through the sandbox, or by shelling out. When a task needs a value that lives in
one:

- **Claude asks the user** for the specific value instead of trying to read it.
- **The user runs the env-touching command themselves**, using the `!` prefix to
  bypass Claude's tool loop entirely, and pastes back only what's needed.

This is intentional friction, not a bug to route around — do not add a
narrower `Read` allow rule, a sandbox exemption, or a hook bypass to "fix" a
task that wants an env value. Ask the user instead.

## Where this is deployed

Both `claude-home/settings.json` (global, `~/.claude`) and
`claude-repo/.claude/settings.json` (per-repo, cloud-capable) carry the same
three layers, merged into their respective `permissions.deny`, `sandbox`, and
`hooks.PreToolUse` blocks alongside the branch-tier entries already documented
in `docs/master-design-doc.md` §10. This reference covers the secret-protection
layer only; see that document for the unrelated `main`-protection layer that
shares the same `settings.json` files.
