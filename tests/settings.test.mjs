import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const NEEDED = ["Bash(git worktree:*)", "Bash(git update-ref refs/heads/:*)", "Bash(git checkout --detach:*)", "Bash(git merge-base:*)", "Bash(git rev-parse:*)", "Bash(gh api:*)", "Bash(gh pr view:*)", "Bash(gh pr edit:*)"];
for (const p of ["claude-home/settings.json", "claude-repo/.claude/settings.json"]) {
  test(`${p}: session links are disabled and the mechanical steps' commands are allowed`, async () => {
    const s = JSON.parse(await readFile(new URL(p, `file://${repoRoot}`), "utf8"));
    assert.equal(s.attribution && s.attribution.sessionUrl, false, "attribution.sessionUrl must be false");
    for (const n of NEEDED) assert.ok((s.permissions.allow || []).includes(n), `${p} allow-list lacks ${n}`);
    assert.ok(!(s.permissions.allow || []).some((a) => /branch -D|worktree remove --force|reset --hard/.test(a)), "destructive forms stay unlisted");
  });
}
