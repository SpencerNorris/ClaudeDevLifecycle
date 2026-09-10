import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const NEEDED = ["Bash(git worktree:*)", "Bash(git update-ref refs/heads/:*)", "Bash(git checkout --detach:*)", "Bash(git merge-base:*)", "Bash(git rev-parse:*)", "Bash(gh api:*)", "Bash(gh pr view:*)", "Bash(gh pr edit:*)"];
// I2: `Bash(git branch:*)` and `Bash(git worktree:*)` prefix-match the destructive
// forms they claim to exclude (`git branch -D`, `git worktree remove --force`) —
// deny wins over allow, so these must be explicitly denied.
const NEEDED_DENY = ["Bash(git branch -D:*)", "Bash(git branch --delete --force:*)", "Bash(git worktree remove --force:*)", "Bash(git worktree remove -f:*)"];
// I3: the `git -C <path> ...` forms the detach/pin mechanical steps run
// cannot be allow-listed narrowly (Bash rules match the whole command text,
// and a wildcard placed before the subcommand would also approve injected
// -c/--exec-path options) — so the destructive `git -C` forms are denied
// instead, and no `git -C` allow entry is ever added.
const NEEDED_DENY_GIT_C = ["Bash(git -C * push *)", "Bash(git -C * reset --hard *)", "Bash(git -C * branch -D *)", "Bash(git -C * branch --delete --force *)", "Bash(git -C * worktree remove --force *)", "Bash(git -C * worktree remove -f *)"];
for (const p of ["claude-home/settings.json", "claude-repo/.claude/settings.json"]) {
  test(`${p}: session links are disabled and the mechanical steps' commands are allowed`, async () => {
    const s = JSON.parse(await readFile(new URL(p, `file://${repoRoot}`), "utf8"));
    assert.equal(s.attribution && s.attribution.sessionUrl, false, "attribution.sessionUrl must be false");
    for (const n of NEEDED) assert.ok((s.permissions.allow || []).includes(n), `${p} allow-list lacks ${n}`);
    for (const n of NEEDED_DENY) assert.ok((s.permissions.deny || []).includes(n), `${p} deny-list lacks ${n}`);
    for (const n of NEEDED_DENY_GIT_C) assert.ok((s.permissions.deny || []).includes(n), `${p} deny-list lacks ${n}`);
    assert.ok(!(s.permissions.allow || []).some((a) => /branch -D|worktree remove --force|reset --hard/.test(a)), "destructive forms stay unlisted");
    assert.ok(!(s.permissions.allow || []).some((a) => a.startsWith("Bash(git -C")), `${p} must never allow-list a git -C form`);
  });
}
