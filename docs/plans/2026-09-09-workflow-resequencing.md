# Workflow Re-sequencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the autonomous single-feature run pin every stage to a commit in a run-owned worktree, run its cheap gates before its expensive ones, re-check only what changed after a fix, clean up on every exit, keep private links out of git and GitHub, and finish cleanly when the Actions quota is spent.

**Architecture:** All changes live in the two workflow scripts (`single-feature-run.js`, `federated-run.js`), the reviewer agent definitions, and the deliverable's `settings.json`, mirrored byte-for-byte into `claude-repo/`. Because the Workflow DSL has no shell, every deterministic step (detach, reconcile, pin, cleanup, quota, scrub) is a *mechanical agent*: a fixed command list, `effort: "low"`, a JSON schema on the result, and a prompt that forbids improvisation. Every mechanical prompt carries a per-call discriminator (pass number and commit) because the harness caches results by prompt. Tests drive the scripts the way the harness does, with a recording stub that refuses a repeated prompt and checks results against the schema, and assert the sequence of stage labels.

**Tech Stack:** Claude Code Workflow DSL (`agent`, `parallel`, `phase`, `log`), plain JavaScript, `node --test`, `gh` CLI.

**Spec:** `docs/specs/2026-09-09-workflow-resequencing-design.md` (revision 2, same date)

## Global Constraints

- Base branch: `main` after PR #8 (independent validate and review budgets) is merged. Do not start until it is.
- `claude-home/` and `claude-repo/.claude/` copies of every touched file must stay byte-identical; `tests/workflow-args.test.mjs` enforces it for the scripts and Task 2 extends it to the agent definitions. Every task that edits a mirrored file ends by copying it.
- `export const meta` must remain a pure literal. No `Date.now`, `Math.random`, or argless `new Date()` anywhere in a script.
- Workflow scripts may call only `agent`, `parallel`, `pipeline`, `phase`, `log`. No imports, no `require`.
- **Cache rule:** `agent()` results are cached by `(prompt, opts)`. Every prompt that must run again on a later pass carries the pass number and the commit it acts on. A prompt that must *not* re-run on resume (the first implement) stays byte-identical.
- **Ownership rule:** the run touches only worktrees it created or detached itself (tracked in `ctx.ownedWorktrees`) and branches it created or was given (`ctx.branch`, `ctx.worktreeBranches`). Never the main working tree, never a worktree it did not touch, never `--force`.
- Every mechanical agent uses `model: "sonnet"`, `effort: "low"`, a schema, and a prompt beginning `MECHANICAL STEP — run exactly the commands below, in order. Do not improvise, do not fix anything, do not run any other command. Return only the structured result.`
- Commit trailer on every commit in this repo: exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never a `Claude-Session:` line, never a claude.ai URL, in commits, PR bodies, or issue comments.
- No-shed: a reviewer minor is fixed on the branch. A deferral is a claim the implementer makes with a reason, and the delta review judges it; an unjudged deferral is a shed.
- Commit after every task with the message given in the task; one task, one commit; every task's tests are green at its commit.

---

## File map

| File | Responsibility after this plan |
|---|---|
| `claude-home/workflows/single-feature-run.js` | The D2 loop in the new order, mechanical steps, schemas, terminals with cleanup, quota skip. |
| `claude-home/workflows/federated-run.js` | Same mechanisms per feature core (with independent budgets, an explicit behaviour change); shared quota and hygiene tail. |
| `claude-home/agents/adversarial-reviewer.md`, `correctness-reviewer.md` | Inputs rewritten for the pre-smoke position: diff at a commit, gate results, design constraints, the implementer's claims. |
| `claude-home/settings.json` | `attribution.sessionUrl: false`; allow-list entries for the mechanical steps' git and gh commands. |
| `claude-repo/.claude/settings.json` | Same keys. |
| `tests/workflow-flow.test.mjs` | New: label-sequence tests over both scripts with a cache-aware, schema-checking recording stub. |
| `tests/settings.test.mjs` | New: both settings files carry the attribution key and the allow-list entries. |
| `tests/workflow-args.test.mjs` | Extended: agent definitions are byte-identical across the two deliverables. |
| `docs/adr/0002-resequence-the-autonomous-loop.md` | The decision record. |
| `docs/master-design-doc.md` §5, §8, §9 | The diagram, the panel section, and the breaker section reflect the new order and the two budgets. |
| `claude-home/reference/definition-of-done.md` | The DoD report's smoke section gains a per-case table and a "carried forward" list. |

---

### Task 1: Land the base, verify the attribution setting, branch

**Files:**
- No source edits. Produces evidence recorded later in the PR body.

**Why the verification is first:** with the git hooks descoped, the whole of D7 rests on `attribution.sessionUrl: false` reaching subagents and workflow agents, which the documentation does not state. If it does not, D7 reduces to the ship-time PR scrub and the spec says so; find out before writing code that assumes it.

- [ ] **Step 1: Confirm PR #8 is merged**

Run: `gh pr view 8 -R SpencerNorris/ClaudeDevLifecycle --json state --jq '.state'`
Expected: `MERGED`. If `OPEN`, stop: the user merges it first.

- [ ] **Step 2: Confirm the setting is active in the session doing the verification**

Run: `jq .attribution ~/.claude/settings.json`
Expected: `{ "sessionUrl": false }`. If absent, the user adds it and starts a fresh session before continuing (the user's own `~/.claude/settings.json` is theirs to edit).

- [ ] **Step 3: Subagent commit**

In a scratch clone of this repository on a throwaway branch, dispatch one plain subagent (Agent tool, default type) with: "Create a file `probe.txt` containing `probe`, commit it with the message `chore: attribution probe` plus whatever trailer you are instructed to add, and return the output of `git log -1 --format=%B`."

Run in the scratch clone: `git log -1 --format=%B`
Expected: a `Co-Authored-By:` line, NO `Claude-Session:` line, NO `claude.ai/code` URL.

- [ ] **Step 4: Workflow-spawned agent commit**

Run the smallest possible workflow: a script whose body is one `agent()` call with `isolation: "worktree"` and the same instruction, on the scratch clone.
Expected: same as Step 3 in that agent's worktree.

- [ ] **Step 5: PR body**

Have the Step 3 subagent open a draft PR from the throwaway branch via the GitHub MCP server with a two-line body; read it back with `gh pr view <url> --json body --jq .body`.
Expected: no session link. Close the draft PR and delete the throwaway branch.

- [ ] **Step 6: Record and decide**

Write the three observations into `docs/specs/2026-09-09-workflow-resequencing-design.md` under a new heading `## Attribution verification (Task 1)`, each as pass or fail with the exact text seen. If any failed: D7's mechanism is the ship-time scrub alone; edit D7 to say so and raise the leak upstream as a Claude Code report. Either way the plan continues.

- [ ] **Step 7: Branch off main**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/workflow-resequencing
node --test tests/
```
Expected: all existing tests pass.

- [ ] **Step 8: Commit the spec note**

```bash
git add docs/specs/2026-09-09-workflow-resequencing-design.md
git commit -m "docs(spec): record the attribution.sessionUrl verification (spec D7)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Flow-test harness and the commit-pinned implement result (D1 part 1)

**Files:**
- Create: `tests/workflow-flow.test.mjs`
- Modify: `tests/workflow-args.test.mjs` (agent-definition mirror check)
- Modify: `claude-home/workflows/single-feature-run.js` — `IMPLEMENT_SCHEMA` (search for `const IMPLEMENT_SCHEMA`), `HEAD_SHA_CLAUSE` next to it, the first implement prompt (label `implement-tdd`), `ctx`
- Mirror: `claude-repo/.claude/workflows/single-feature-run.js`

**Interfaces:**
- Produces: `IMPLEMENT_SCHEMA.properties.headSha` (string, `^[0-9a-f]{40}$`, required), `worktreeBranch` (string, optional), `minorsDeferred` (array of `{id, reason}`, optional). `ctx.headSha` (string), `ctx.worktreeBranches` (string[]), `ctx.minorsDeferred` (array), `ctx.ownedWorktrees` (string[]).
- Produces for tests: `runWorkflowRecording(scriptPath, args, scenario)` → `{ labels, prompts, result, error }`; the stub throws on a repeated `(label, prompt)` unless the scenario entry is marked `{ cacheable: true, result }`, and checks every result against `opts.schema` (required keys, `enum`, `pattern`, `additionalProperties: false`).

- [ ] **Step 1: Write the harness and the first test**

```js
// tests/workflow-flow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const SCRIPTS = {
  single: "claude-home/workflows/single-feature-run.js",
  federated: "claude-home/workflows/federated-run.js",
};
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

/** Minimal schema check mirroring what the harness enforces on agent() results. */
function checkSchema(schema, value, label) {
  if (!schema) return;
  assert.equal(typeof value, "object", `${label}: result must be an object`);
  for (const k of schema.required || []) assert.ok(k in value, `${label}: result missing required "${k}"`);
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(value)) assert.ok(k in schema.properties, `${label}: result has unknown key "${k}"`);
  }
  for (const [k, def] of Object.entries(schema.properties || {})) {
    if (!(k in value)) continue;
    if (def.enum) assert.ok(def.enum.includes(value[k]), `${label}: ${k}=${value[k]} not in enum`);
    if (def.pattern) assert.match(String(value[k]), new RegExp(def.pattern), `${label}: ${k} fails pattern`);
    if (def.type === "array") assert.ok(Array.isArray(value[k]), `${label}: ${k} must be an array`);
    if (def.type === "boolean") assert.equal(typeof value[k], "boolean", `${label}: ${k} must be boolean`);
  }
}

/** Run a script with a recording agent() stub.
 * `scenario` maps a label (or "prefix*") to a result, a function
 * (prompt, opts, nthCallOfThisLabel) => result, or { cacheable: true, result }.
 * A repeated (label, prompt) throws unless the entry is cacheable: that is how
 * the tests catch a prompt that the real harness would serve from its cache. */
export async function runWorkflowRecording(scriptPath, args, scenario) {
  const source = await readFile(new URL(scriptPath, `file://${repoRoot}`), "utf8");
  const body = source.replace(/^export const meta/m, "const meta");
  const labels = [], prompts = [], seen = new Set(), counts = {};
  const pick = (label) => {
    if (label in scenario) return scenario[label];
    const prefix = Object.keys(scenario).find((k) => k.endsWith("*") && label.startsWith(k.slice(0, -1)));
    if (prefix) return scenario[prefix];
    throw new Error("unmodelled agent label: " + label);
  };
  const stubs = {
    agent: async (prompt, opts) => {
      const label = (opts && opts.label) || "(unlabelled)";
      let entry = pick(label);
      const cacheable = !!(entry && entry.cacheable);
      if (cacheable) entry = entry.result;
      const key = label + "\n" + prompt;
      if (seen.has(key) && !cacheable) throw new Error("cache collision: prompt for " + label + " repeated verbatim — the real harness would replay the first result");
      seen.add(key);
      labels.push(label);
      prompts.push({ label, prompt, opts });
      counts[label] = (counts[label] ?? -1) + 1;
      const r = typeof entry === "function" ? entry(prompt, opts, counts[label]) : entry;
      checkSchema(opts && opts.schema, r, label);
      return r;
    },
    parallel: async (thunks) => {
      const out = [];
      for (const t of thunks) out.push(await t());
      return out;
    },
    pipeline: async () => { throw new Error("pipeline() not modelled"); },
    workflow: async () => { throw new Error("workflow() not modelled"); },
    phase: () => {},
    log: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };
  const fn = new AsyncFunction("args", ...Object.keys(stubs), body);
  try {
    const result = await fn(args, ...Object.values(stubs));
    return { labels, prompts, result, error: null };
  } catch (error) {
    return { labels, prompts, result: null, error };
  }
}

/** Compare a label sequence where one segment (the parallel panel) is order-free. */
export function assertSequence(actual, expected) {
  assert.equal(actual.length, expected.length, `label count: ${actual.join(" > ")}`);
  let i = 0;
  for (const e of expected) {
    if (Array.isArray(e)) {
      const seg = actual.slice(i, i + e.length).sort();
      assert.deepEqual(seg, [...e].sort(), `panel segment at ${i}`);
      i += e.length;
    } else {
      assert.equal(actual[i], e, `label ${i}: ${actual.join(" > ")}`);
      i += 1;
    }
  }
}

export const BASE_ARGS = { featureDescription: "add dark mode", devBranch: "main", issue: "owner/repo#1", plan: "do the thing" };

/** The reconcile step's real contract: it returns the sha named in its prompt. */
export const reconcileEcho = (p) => ({ ok: true, sha: /[0-9a-f]{40}/.exec(p)[0], detail: "fast-forwarded" });
export const pinEcho = (p) => ({ ok: true, path: ".claude/worktrees/run-feat-dark-mode", sha: /[0-9a-f]{40}/.exec(p)[0] });

export const R = {
  design: { constraints: [{ text: "provenance writes use ON CONFLICT", source: "CLAUDE.md" }], risks: [], blocker: "none" },
  detach: { ok: true, detached: [] },
  implement: { branch: "feat/dark-mode", headSha: SHA_A, summary: "done", blocker: "none" },
  gatesPass: { pass: true, unit: "12 passed", lint: "clean", typecheck: "clean", blocker: "none" },
  reviewPass: { verdict: "pass", summary: "ok", findings: [], verdictSection: "## Reviewer Verdict\nPASS" },
  dodPass: {
    gatesPass: true, smokeAllPass: true, blocker: "none", report: "## Changes\n…",
    tests: { unit: "12 passed", integration: "3 passed", regression: "ok", lint: "clean", typecheck: "clean" },
    cases: [{ id: "AC1", name: "happy path", pass: true }],
  },
  ship: { pushed: true, prUrl: "https://github.com/owner/repo/pull/2", blocker: "none" },
  cleanup: { ok: true, removed: [] },
  scrub: { ok: true, changed: false },
  quotaOk: { quota: "ok", detail: "100/2000 minutes" },
  ciGreen: { status: "green", blocker: "none" },
};

export const HAPPY = {
  "design-review": R.design,
  "detach-worktrees": R.detach,
  "implement-tdd": R.implement,
  "reconcile-branch": reconcileEcho,
  "pin-run-worktree": pinEcho,
  "gates": R.gatesPass,
  "adversarial-reviewer": R.reviewPass,
  "correctness-reviewer": R.reviewPass,
  "validate-and-dod": R.dodPass,
  "push-and-open-pr": R.ship,
  "scrub-pr-body": R.scrub,
  "cleanup-worktrees": R.cleanup,
  "quota-check": R.quotaOk,
  "poll-ci": R.ciGreen,
};

export const HAPPY_LABELS = [
  "design-review",
  "implement-tdd", "detach-worktrees", "reconcile-branch", "pin-run-worktree",
  "gates",
  ["adversarial-reviewer", "correctness-reviewer"],
  "validate-and-dod",
  "push-and-open-pr", "scrub-pr-body",
  "quota-check", "poll-ci",
  "cleanup-worktrees",
];

test("single: implement prompt asks for headSha and the schema requires it", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const impl = run.prompts.find((p) => p.label === "implement-tdd");
  assert.ok(impl, "implement-tdd never dispatched: " + (run.error && run.error.message));
  assert.match(impl.prompt, /headSha/);
  assert.match(impl.prompt, /no-shed/);
  assert.equal(impl.opts.schema.required.includes("headSha"), true);
  assert.equal(impl.opts.schema.properties.headSha.pattern, "^[0-9a-f]{40}$");
});
```

Also add to `tests/workflow-args.test.mjs`, after the scripts loop:

```js
for (const name of ["adversarial-reviewer.md", "correctness-reviewer.md", "security-reviewer.md", "performance-reviewer.md"]) {
  test(`${name}: claude-home and claude-repo copies are byte-identical`, async () => {
    const home = await readFile(new URL(`claude-home/agents/${name}`, `file://${repoRoot}`), "utf8");
    const repo = await readFile(new URL(`claude-repo/.claude/agents/${name}`, `file://${repoRoot}`), "utf8");
    assert.equal(repo, home, `${name} drifted between claude-home/ and claude-repo/`);
  });
}
```

- [ ] **Step 2: Run to see the new test fail**

Run: `node --test tests/workflow-flow.test.mjs`
Expected: FAIL on the `headSha` or `no-shed` assertion (the old prompt has neither). `tests/workflow-args.test.mjs` should pass if the agent copies are already identical; if not, that is a pre-existing drift to fix in this task by copying `claude-home/agents/*` over `claude-repo/.claude/agents/*` and saying so in the commit body.

- [ ] **Step 3: Extend `IMPLEMENT_SCHEMA`, add the clause, extend `ctx`**

Replace `const IMPLEMENT_SCHEMA = { ... };` with:

```js
// The implementer's structured result. `headSha` is the commit the work ends
// at — the workflow pins every later stage to it (spec D1). `branch` is the
// name the implementer was told to use; `worktreeBranch` is the branch it
// actually committed on when the named branch was held by another worktree.
// `minorsDeferred` is a claim, not a permission: the delta review judges it.
const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["branch", "headSha", "summary", "blocker"],
  properties: {
    branch: { type: "string", minLength: 1 },
    headSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    worktreeBranch: { type: "string" },
    summary: { type: "string", minLength: 1 },
    filesTouched: { type: "array", items: { type: "string" } },
    minorsDeferred: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "reason"],
        properties: { id: { type: "string" }, reason: { type: "string" } },
      },
    },
    ...BLOCKER_PROPS,
  },
};

// Shared by every implement prompt (spec D1).
const HEAD_SHA_CLAUSE =
  "BRANCH CONTRACT: work on the named branch. If git refuses to check it out because another worktree holds it, " +
  "commit on your worktree's own branch instead — never fail for this, never create any other branch — and report " +
  "that branch as `worktreeBranch`. In every case return `headSha` = the full 40-hex commit your work ends at " +
  "(`git rev-parse HEAD` after your last commit) and `branch` = the name you were given.\n";
```

In the first implement prompt (label `implement-tdd`) insert `HEAD_SHA_CLAUSE +` immediately before the `"COMMIT DISCIPLINE ..."` line. Keep its existing no-shed sentence. Replace the `ctx` literal with:

```js
const ctx = {
  issue: issueRef,
  branch: existingBranch || devBranch, // the run's branch: the one it was given, else the dev branch until the first implement names one
  headSha: null,
  runWorktree: null,        // the run-owned checkout every later stage works in (spec D1)
  ownedWorktrees: [],       // paths this run created or detached — the only ones cleanup may remove
  worktreeBranches: [],     // side branches implementers reported
  minorsDeferred: [],
  constraints: [],
  gateSummary: "",
  failedCases: [],
  lastSmokeSha: null,
  prevReviewSha: null,
  findings: {},             // per reviewer seat: id -> finding, the delta-review ledger (spec D3)
  reviewVerdictSection: "",
  prUrl: null,
  failureContext: "",
};
```

After the first `requireAgentResult(implementResult, "IMPLEMENT");` add:

```js
ctx.headSha = implementResult.headSha;
if (implementResult.worktreeBranch) ctx.worktreeBranches.push(implementResult.worktreeBranch);
ctx.minorsDeferred = ctx.minorsDeferred.concat(implementResult.minorsDeferred || []);
```

- [ ] **Step 4: Run the test**

Run: `node --test tests/workflow-flow.test.mjs`
Expected: PASS (the test stops at the implement prompt; the run itself still errors on an unmodelled label, which the test tolerates).

- [ ] **Step 5: Mirror, check, commit**

```bash
cp claude-home/workflows/single-feature-run.js claude-repo/.claude/workflows/single-feature-run.js
node --check claude-home/workflows/single-feature-run.js && node --test tests/
git add tests/workflow-flow.test.mjs tests/workflow-args.test.mjs claude-home/workflows/single-feature-run.js claude-repo/.claude/workflows/single-feature-run.js
git commit -m "feat(workflow): implement results carry headSha, worktreeBranch and minorsDeferred; flow-test harness (spec D1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Mechanical steps: detach, reconcile, pin, cleanup; terminals clean up (D1 part 2, D6)

**Files:**
- Modify: `claude-home/workflows/single-feature-run.js` — helpers above `// MAIN FLOW`; the first implement site; `escalate()`; `pauseForHuman()`; the post-ship cleanup
- Test: `tests/workflow-flow.test.mjs`
- Mirror.

**Interfaces:**
- Produces: `mechanical(ctx, label, phaseName, commands, schema)`; `detachWorktrees(ctx, phaseName, pass)`; `reconcileBranch(ctx, implementResult, phaseName, pass)`; `pinRunWorktree(ctx, phaseName, pass)` which sets `ctx.runWorktree`; `cleanupWorktrees(ctx, phaseName, tag)`. Schemas `DETACH_SCHEMA`, `RECONCILE_SCHEMA`, `PIN_SCHEMA`, `CLEANUP_SCHEMA`.
- Every prompt embeds `pass` and the commit it acts on (cache rule). `mechanical` routes a null result to `pauseForHuman`.
- Reimplement sites are wired in Task 6 (they are rewritten there); this task wires only the first implement.

- [ ] **Step 1: Failing tests**

```js
test("single: a fresh run's first implement has no detach before it; a detach, reconcile and pin follow it", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const i = run.labels.indexOf("implement-tdd");
  assert.ok(i > -1, "implement-tdd never dispatched: " + (run.error && run.error.message));
  assert.ok(!run.labels.slice(0, i).includes("detach-worktrees"), "no detach before the first implement of a fresh run");
  assert.equal(run.labels[i + 1], "detach-worktrees", "the implementer's worktree holds the branch; reconcile frees it first");
  assert.equal(run.labels[i + 2], "reconcile-branch");
  assert.equal(run.labels[i + 3], "pin-run-worktree");
  const pin = run.prompts.find((p) => p.label === "pin-run-worktree");
  assert.match(pin.prompt, new RegExp(SHA_A));
  assert.match(pin.prompt, /pass 0/);
});

test("single: a diverged reconcile cleans up, then escalates; no later stage runs", async () => {
  const scenario = { ...HAPPY,
    "reconcile-branch": { ok: false, sha: SHA_B, detail: "feat/dark-mode is not an ancestor of " + SHA_B },
    "root-cause-diagnosis": "the implementer rebased onto a stale base",
    "escalate-to-issue": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop");
  const c = run.labels.indexOf("cleanup-worktrees"), d = run.labels.indexOf("root-cause-diagnosis");
  assert.ok(c > -1 && c < d, "cleanup runs before the diagnosis");
  assert.ok(!run.labels.includes("gates"));
});

test("single: a design-stage pause does not run cleanup (the run owns nothing yet)", async () => {
  const scenario = { ...HAPPY,
    "design-review": { ...R.design, blocker: "ambiguity", blockerDetail: "no acceptance criteria" },
    "pause-for-human": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop");
  assert.ok(!run.labels.includes("cleanup-worktrees"), "nothing to clean before the run owns a branch");
  assert.ok(!run.labels.includes("detach-worktrees"), "no detach before the run owns a branch");
});

test("single: a dead mechanical agent pauses for a human instead of throwing raw", async () => {
  const scenario = { ...HAPPY, "pin-run-worktree": null, "pause-for-human": "posted" };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop");
  assert.ok(run.labels.includes("pause-for-human"));
});
```

Note: the stub's schema check must skip `null` results (a dead agent); add `if (r === null) return r;` before `checkSchema` in the harness.

- [ ] **Step 2: Run, expect failures** (unmodelled labels, missing labels).

- [ ] **Step 3: Add the helpers** (insert above `// MAIN FLOW`)

```js
// ---------------------------------------------------------------------------
// Mechanical steps (spec: Constraints). The DSL has no shell, so every
// deterministic git/gh action is an agent with a fixed command list, low
// effort, and a schema. Each prompt embeds the pass and the commit it acts
// on, because the harness caches results by prompt (cache rule).
// ---------------------------------------------------------------------------
const MECHANICAL_PREAMBLE =
  "MECHANICAL STEP — run exactly the commands below, in order. Do not improvise, do not fix anything, " +
  "do not run any other command. Return only the structured result.\n\n";

async function mechanical(ctx, label, phaseName, commands, schema) {
  const r = await agent(MECHANICAL_PREAMBLE + commands, { label, phase: phaseName, model: "sonnet", effort: "low", schema });
  if (!r) {
    ctx.failureContext = label + " agent died without returning a result (usage-limit or harness interruption).";
    await pauseForHuman(phaseName, "usage_limit", ctx);
  }
  return r;
}

const DETACH_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "detached"],
  properties: { ok: { type: "boolean" }, detached: { type: "array", items: { type: "string" } }, detail: { type: "string" } } };
const RECONCILE_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "sha", "detail"],
  properties: { ok: { type: "boolean" }, sha: { type: "string", pattern: "^[0-9a-f]{40}$" }, detail: { type: "string" } } };
const PIN_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "path", "sha"],
  properties: { ok: { type: "boolean" }, path: { type: "string" }, sha: { type: "string", pattern: "^[0-9a-f]{40}$" }, detail: { type: "string" } } };
const CLEANUP_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "removed"],
  properties: { ok: { type: "boolean" }, removed: { type: "array", items: { type: "string" } }, detail: { type: "string" } } };

/** The run owns a branch when it works on a named feature branch: the one it
 * was given (existingBranch) or the one its first implement created (spec D1). */
function runOwnsBranch(ctx) {
  return ctx.branch !== devBranch;
}

/** Detach every worktree that holds ctx.branch so the next implementer can
 * check it out; the detached paths become run-owned (spec D1, D6). */
async function detachWorktrees(ctx, phaseName, pass) {
  if (!runOwnsBranch(ctx)) return { ok: true, detached: [] };
  const r = await mechanical(ctx, "detach-worktrees", phaseName,
    "(pass " + pass + ", head " + (ctx.headSha || "none") + ")\n" +
      "1. `git worktree list --porcelain` — for every worktree whose `branch` line is `refs/heads/" + ctx.branch + "` " +
      "and whose path is NOT the main working tree, run `git -C <path> checkout --detach`.\n" +
      "2. Return ok=true and `detached` = the absolute paths you detached (empty if none).",
    DETACH_SCHEMA);
  for (const p of r.detached || []) if (!ctx.ownedWorktrees.includes(p)) ctx.ownedWorktrees.push(p);
  return r;
}

/** Move ctx.branch to the implementer's headSha, or escalate when the commit
 * does not descend from the branch (spec D1). Detaches any holder first so a
 * dirty holder cannot block the ref update. Sets ctx.headSha. */
async function reconcileBranch(ctx, implementResult, phaseName, pass) {
  const sha = implementResult.headSha;
  await detachWorktrees(ctx, phaseName, pass); // frees the holder and records it as run-owned
  const r = await mechanical(ctx, "reconcile-branch", phaseName,
    "(pass " + pass + ")\n" +
      "1. `git merge-base --is-ancestor " + ctx.branch + " " + sha + "`; if the exit code is non-zero return ok=false, sha=`" + sha + "`, detail='" + ctx.branch + " is not an ancestor of " + sha + "'.\n" +
      "2. `git update-ref refs/heads/" + ctx.branch + " " + sha + "`.\n" +
      "3. `git rev-parse " + ctx.branch + "` must print `" + sha + "`. Return ok=true, sha=that value, detail='fast-forwarded'.",
    RECONCILE_SCHEMA);
  if (!r.ok || r.sha !== sha) {
    ctx.failureContext = "Branch reconciliation failed: " + r.detail;
    await escalate(phaseName, 1, ctx);
  }
  ctx.headSha = sha;
  return sha;
}

/** Check headSha out, detached, in a run-owned worktree that every later
 * stage works in (spec D1). Never the main working tree: the human works there. */
async function pinRunWorktree(ctx, phaseName, pass) {
  const slug = ctx.branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const path = ".claude/worktrees/run-" + slug;
  const r = await mechanical(ctx, "pin-run-worktree", phaseName,
    "(pass " + pass + ")\n" +
      "1. If `" + path + "` exists and is a worktree (`git worktree list --porcelain` lists it): `git -C " + path + " status --porcelain --untracked-files=no`; if non-empty return ok=false with the output as detail; else `git -C " + path + " checkout --detach " + ctx.headSha + "`.\n" +
      "2. Otherwise: `git worktree add --detach " + path + " " + ctx.headSha + "`.\n" +
      "3. `git -C " + path + " rev-parse HEAD` must print `" + ctx.headSha + "`. Return ok=true, path=the absolute path of " + path + ", sha=that value.",
    PIN_SCHEMA);
  if (!r.ok) {
    ctx.failureContext = "Could not pin the run worktree at " + ctx.headSha + ": " + (r.detail || "");
    await escalate(phaseName, 1, ctx);
  }
  ctx.runWorktree = r.path;
  if (!ctx.ownedWorktrees.includes(r.path)) ctx.ownedWorktrees.push(r.path);
  return r;
}

/** Remove the run's own worktrees and reconciled side branches (spec D6).
 * Runs after ship and before either terminal throws. Never --force, never a
 * worktree the run did not create or detach, never ctx.branch. */
async function cleanupWorktrees(ctx, phaseName, tag) {
  if (!runOwnsBranch(ctx)) return { ok: true, removed: [] };
  const side = ctx.worktreeBranches.filter((b) => b && b !== ctx.branch);
  const owned = ctx.ownedWorktrees.slice();
  const r = await mechanical(ctx, "cleanup-worktrees", phaseName,
    "(" + tag + ", head " + (ctx.headSha || "none") + ")\n" +
      "1. `git worktree list --porcelain`. For every worktree that is NOT the main working tree and is EITHER one of these paths: " + (owned.length ? owned.join(", ") : "(none)") +
      " OR has `branch refs/heads/" + ctx.branch + "`" + (side.length ? " OR one of: " + side.map((b) => "refs/heads/" + b).join(", ") : "") +
      ": run `git worktree remove <path>` (no --force). If git refuses (dirty tree), leave it and list the path in `detail`.\n" +
      "2. `git worktree prune`.\n" +
      (side.length ? "3. For each of " + side.join(", ") + ": if `git merge-base --is-ancestor <name> " + ctx.branch + "` succeeds, run `git branch -d <name>`; otherwise leave it.\n" : "") +
      "Return ok=true and `removed` = the worktree paths removed. Never delete " + ctx.branch + ".",
    CLEANUP_SCHEMA);
  return r;
}
```

In `escalate(stage, attempts, context)`, as the first statement inside the function body, add:

```js
  try { await cleanupWorktrees(context, stage, "escalate " + stage); } catch (e) { log("cleanup before escalation failed: " + e.message); }
```

In `pauseForHuman(stage, blocker, context)`, as the first statement inside the function body, add the same line with `"pause " + stage`. `mechanical` calls `pauseForHuman` only on a null result, and `cleanupWorktrees` calls `mechanical`; a null result from the cleanup agent itself would recurse once into `pauseForHuman` whose cleanup returns immediately because `runOwnsBranch` is still true — guard that: add a module-level `let cleaningUp = false;` and in `cleanupWorktrees` return `{ ok: true, removed: [] }` when `cleaningUp` is already true, setting it true for the duration of the call.

- [ ] **Step 4: Wire the first implement site and the post-ship cleanup**

Before `let implementResult = await agent(` (label `implement-tdd`): `await detachWorktrees(ctx, "Implement", 0);`. After the `ctx.minorsDeferred = ...` line from Task 2: `await reconcileBranch(ctx, implementResult, "Implement", 0); await pinRunWorktree(ctx, "Implement", 0);`. Replace the existing post-ship cleanup agent call (label `cleanup-worktree`) with nothing for now; Task 7 places `cleanupWorktrees` at the CI terminals.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/workflow-flow.test.mjs`
Expected: the four new tests pass (the run still stops at an unmodelled label later; those tests do not assert past the pin).

- [ ] **Step 6: Mirror, check, commit**

```bash
cp claude-home/workflows/single-feature-run.js claude-repo/.claude/workflows/single-feature-run.js
node --check claude-home/workflows/single-feature-run.js && node --test tests/
git add -A claude-home/workflows claude-repo/.claude/workflows tests/workflow-flow.test.mjs
git commit -m "feat(workflow): detach, reconcile, pin and cleanup as mechanical steps; terminals clean up only what the run owns (spec D1, D6)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Design review stage (D2, first stage)

**Files:**
- Modify: `claude-home/workflows/single-feature-run.js` — `DESIGN_SCHEMA`, `constraintsClause(ctx)`, the stage before `phase("Implement")`, `meta.phases`
- Test: `tests/workflow-flow.test.mjs`
- Mirror.

**Interfaces:**
- Produces: `ctx.constraints` (`{ text, source }[]`), `constraintsClause(ctx)` used by every implement prompt (this task, Task 6) and every reviewer prompt (Task 6).

- [ ] **Step 1: Failing test**

```js
test("single: design review runs first and its constraints reach the implementer", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  assert.equal(run.labels[0], "design-review");
  const impl = run.prompts.find((p) => p.label === "implement-tdd");
  assert.match(impl.prompt, /provenance writes use ON CONFLICT/);
  assert.match(impl.prompt, /CLAUDE\.md/);
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement** (schema next to `IMPLEMENT_SCHEMA`; clause next to `HEAD_SHA_CLAUSE`; stage before `phase("Implement")`)

```js
// The design reviewer's result (spec D2). Constraints are the codebase's own
// contracts that the change must honour; each names its source so the
// implementer and the reviewers can check it.
const DESIGN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["constraints", "risks", "blocker"],
  properties: {
    constraints: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "source"],
      properties: { text: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 } } } },
    risks: { type: "array", items: { type: "string" } },
    ...BLOCKER_PROPS,
  },
};

function constraintsClause(ctx) {
  if (!ctx.constraints.length) return "";
  return "DESIGN CONSTRAINTS (from the design review; each cites its source — honour every one, and say so if one cannot be honoured):\n" +
    ctx.constraints.map((c, i) => "  C" + (i + 1) + ". " + c.text + "  [" + c.source + "]").join("\n") + "\n";
}
```

```js
// ---------------------------------------------------------------------------
// PHASE 0 — DESIGN REVIEW (spec D2). One Opus pass over the issue, the plan
// and the repository's stated contracts, before any code. Its constraints
// travel into the implement prompt and every reviewer prompt.
// ---------------------------------------------------------------------------
phase("Design");
const design = requireAgentResult(await agent(
  "AUTONOMOUS single-feature run, DESIGN REVIEW (spec D2). Read the linked issue in full, the plan below if any, the repository's CLAUDE.md, " +
    "and the modules the issue and plan name. Return `constraints`: the codebase's existing contracts, invariants and patterns this change must honour " +
    "(write paths, locking, conflict handling on inserts, queue/drain contracts, naming, ontology rules), each with a `source` (file path or doc section). " +
    "Return `risks`: places where the plan is likely to violate one. Do not implement anything, do not write files. " +
    "If the issue is too ambiguous to derive acceptance criteria, return blocker='ambiguity' with blockerDetail.\n\n" +
    "Feature: " + featureDescription + "\nLinked issue: " + issueRef + "\nPlan:\n" + (preApprovedPlan || "(none)"),
  { label: "design-review", phase: "Design", model: "opus", schema: DESIGN_SCHEMA }
), "DESIGN");
if (isExternalBlocker(design.blocker)) {
  ctx.failureContext = design.blockerDetail || ("blocker=" + design.blocker);
  await pauseForHuman("Design", design.blocker, ctx);
}
ctx.constraints = design.constraints;
log("Design review: " + ctx.constraints.length + " constraints, " + design.risks.length + " risks.");
```

In the first implement prompt insert `constraintsClause(ctx) +` right after `planClause +`. Add `{ title: "Design", detail: "One Opus pass over the issue, plan and the repo's stated contracts; returns the constraints the implementer and reviewers must honour." }` as the first entry of `meta.phases`.

- [ ] **Step 4: Run tests, expect pass.**

- [ ] **Step 5: Mirror, check, commit**

```bash
cp claude-home/workflows/single-feature-run.js claude-repo/.claude/workflows/single-feature-run.js
node --check claude-home/workflows/single-feature-run.js && node --test tests/
git add -A claude-home/workflows claude-repo/.claude/workflows tests/workflow-flow.test.mjs
git commit -m "feat(workflow): design review stage feeds constraints to the implementer (spec D2)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Gates helper and per-case DoD schema (D2, D4 part 1)

**Files:**
- Modify: `claude-home/workflows/single-feature-run.js` — `GATES_SCHEMA`, `runGates(ctx, pass)`, `DOD_SCHEMA` (`cases`), `gateCommands` from `RUN_ARGS`
- Test: `tests/workflow-flow.test.mjs`
- Mirror.

**Interfaces:**
- Produces: `runGates(ctx, pass)` → `{ pass, unit, lint, typecheck, failureContext?, blocker }` (label `gates`), run in `ctx.runWorktree`; `gateCommands` (optional `RUN_ARGS.gateCommands = { unit, lint, typecheck }`, each a shell command string). `DOD_SCHEMA.properties.cases` (required, min 1: `{ id, name, pass, carried?, detail?, files? }`).
- This task only asserts what it delivers; the ordering assertion moves to Task 6.

- [ ] **Step 1: Failing tests**

```js
test("single: gates helper runs in the run worktree at headSha with the pass number", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const g = run.prompts.find((p) => p.label === "gates");
  assert.ok(g, "gates never dispatched: " + (run.error && run.error.message));
  assert.match(g.prompt, new RegExp(SHA_A));
  assert.match(g.prompt, /run-feat-dark-mode/);
  assert.match(g.prompt, /pass 1/);
});

test("single: DoD schema requires per-case results with a carried flag", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const v = run.prompts.find((p) => p.label === "validate-and-dod");
  assert.ok(v, "validate never dispatched: " + (run.error && run.error.message));
  assert.ok(v.opts.schema.required.includes("cases"));
  assert.equal(v.opts.schema.properties.cases.minItems, 1);
  assert.equal(v.opts.schema.properties.cases.items.properties.carried.type, "boolean");
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

Near `DOD_SCHEMA`:

```js
// The gates result (spec D2): the deterministic checks, run in the run
// worktree at the pinned commit, before any reviewer or smoke spends money on
// a red build. Not a mechanical step: which commands to run is repository
// knowledge, so this is a low-effort agent, and args.gateCommands can pin them.
const GATES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["pass", "unit", "lint", "typecheck", "blocker"],
  properties: { pass: { type: "boolean" }, unit: { type: "string" }, lint: { type: "string" }, typecheck: { type: "string" }, failureContext: { type: "string" }, ...BLOCKER_PROPS },
};
const gateCommands = RUN_ARGS.gateCommands && typeof RUN_ARGS.gateCommands === "object" ? RUN_ARGS.gateCommands : null;

async function runGates(ctx, pass) {
  const how = gateCommands
    ? "Run exactly these three commands: unit: `" + gateCommands.unit + "`; lint: `" + gateCommands.lint + "`; typecheck: `" + gateCommands.typecheck + "`."
    : "Run the repository's unit tests, lint and type-check exactly as its CLAUDE.md / README document them (no smoke, no integration services). If a language runtime or dependency install is needed in this worktree, do the documented install first.";
  const r = await agent(
    "AUTONOMOUS single-feature run, GATES (spec D2) — pass " + pass + ". Work ONLY in `" + ctx.runWorktree + "`, which is checked out at " + ctx.headSha + " (verify with `git rev-parse HEAD`; if it differs, return blocker='infra' with blockerDetail). " +
      how + " Return pass=true only if all three passed; put each command's one-line summary in `unit`, `lint`, `typecheck`; on failure put the failing output (trimmed) in `failureContext`. " +
      "If a tool is missing or a service is down that a unit test needs, return blocker='infra' with blockerDetail. Do not modify any file.",
    { label: "gates", phase: "Gates", model: "sonnet", effort: "low", schema: GATES_SCHEMA }
  );
  if (!r) {
    ctx.failureContext = "gates agent died without returning a result.";
    await pauseForHuman("Gates", "usage_limit", ctx);
  }
  return r;
}
```

`DOD_SCHEMA`: add `"cases"` to `required` and this property:

```js
    // Per-case smoke results (spec D4). Ids are stable across attempts so a
    // failed case can be re-run by name; `carried` marks a case NOT re-run in
    // an incremental smoke (its `pass` is the last real result).
    cases: {
      type: "array", minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["id", "name", "pass"],
        properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, pass: { type: "boolean" },
          carried: { type: "boolean" }, detail: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    },
```

To satisfy Step 1 in this task without the loop rewrite, call `runGates(ctx, 1)` once immediately after the pin in the first implement site and store `ctx.gateSummary = "unit: " + g.unit + "; lint: " + g.lint + "; typecheck: " + g.typecheck;` (Task 6 moves this call into the loop). Add to the existing validate prompt the `cases` instruction: after the STEP 2 sentence insert

```js
      "REPORT EVERY SMOKE CASE in `cases` with a stable id (AC1, AC2, … in the issue's order, then E1… for derived edges and F1… for failure modes), `pass`, a one-line `detail`, and the source files the case exercises in `files`.\n" +
```

- [ ] **Step 4: Run tests, expect pass** (both tests assert only the helper and the schema).

- [ ] **Step 5: Mirror, check, commit**

```bash
cp claude-home/workflows/single-feature-run.js claude-repo/.claude/workflows/single-feature-run.js
node --check claude-home/workflows/single-feature-run.js && node --test tests/
git add -A claude-home/workflows claude-repo/.claude/workflows tests/workflow-flow.test.mjs
git commit -m "feat(workflow): gates helper in the run worktree; per-case DoD results (spec D2, D4)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Reorder the loop: gates → review → smoke, delta review, incremental re-smoke, blocking-first reimplement (D2–D5)

> **As built (rulings applied during execution; the code is authoritative where the blocks below differ):**
> - `detachWorktrees(ctx, phaseName, pass, tag = "reconcile")`: the discriminator is `(pass N, <tag>, head <sha|none>)`; the pre-dispatch detach in `reimplement()` and at the first implement site passes `"before-implement"`, so the two detaches of one pass never share a prompt.
> - "No new commit": `reimplement()` sets `ctx.lastReimplementNote` and returns without reconcile or pin; the loop appends the note to `ctx.failureContext` and clears it immediately before every reimplement dispatch. The test scenario fails the gates while `n < 2` so a second reimplement exists.
> - The review evidence carries `(pass N)`. A commit the panel already rejected is never re-reviewed: when `ctx.prevReviewSha === ctx.headSha` and `ctx.lastCritique` is set, the standing critique counts as the reject (budget spent, escalation on the K-th) and the loop goes straight back to implement. `ctx.lastCritique` is set on a reject and cleared on a pass.
> - The review path hands `ctx.failureContext` (critique plus note) to `reimplement()`, like the validate sites.
> - A finding without an `id` gets one on ingest (`F<n>` continuing the seat's ledger). A rejected deferral is ledgered as `deferral-<id>` in both key and rendered id, so `resolved` can close it. Judged deferrals leave `ctx.minorsDeferred`; accepted ones go to `ctx.acceptedDeferrals` and `runValidate` renders them for the DoD's Follow-ups.
> - The temporary Task 5 `runGates(ctx, 1)` call is removed; `meta.description` names the Design stage; `implementResult` is `const`; `reimplement()` records `worktreeBranch` before the blocker check; the smoke-failure reason has a literal fallback.

**Files:**
- Modify: `claude-home/workflows/single-feature-run.js` — `VERDICT_SCHEMA`, `reviewFocus()`, `runReviewPanel(...)`, the loop, `reimplement()`, `runValidate()`; delete the old inline validate and reimplement agent calls
- Test: `tests/workflow-flow.test.mjs`
- Mirror.

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: `runReviewPanel(runLabel, ctx, base, evidence, mode)` with `mode = "full" | { prevSha }`, returns `{ pass, critique, rejectedBy, verdictSection, incomplete? }` and updates `ctx.findings[seat]`; `reimplement(label, why, context, pass)`; `runValidate(ctx, pass)`; `ctx.prevReviewSha`.

- [ ] **Step 1: Failing tests**

```js
test("single: happy path label order", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  assert.equal(run.error, null, run.error && run.error.stack);
  assertSequence(run.labels, HAPPY_LABELS);
  assert.equal(run.result.prUrl, R.ship.prUrl);
  assert.equal(run.result.headSha, SHA_A);
});

test("single: a gate failure goes back to implement without a smoke or a review", async () => {
  const scenario = { ...HAPPY,
    "gates": (p, o, n) => (n === 0 ? { ...R.gatesPass, pass: false, unit: "1 failed", failureContext: "test_x failed" } : R.gatesPass),
    "reimplement-after-validate": { ...R.implement, headSha: SHA_B },
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const l = run.labels;
  assert.equal(l.filter((x) => x === "gates").length, 2);
  assert.equal(l.filter((x) => x === "validate-and-dod").length, 1);
  assert.ok(l.indexOf("adversarial-reviewer") > l.lastIndexOf("gates"), "review waits for green gates");
  assert.ok(l.indexOf("pin-run-worktree", l.indexOf("reimplement-after-validate")) > -1, "the run worktree is re-pinned after a reimplement");
});

test("single: a review reject triggers reimplement, then a DELTA review with that seat's own findings, and one smoke", async () => {
  const reject = { verdict: "reject", summary: "bad", findings: [{ id: "F1", severity: "blocking", category: "correctness", detail: "no ON CONFLICT", location: "src/x.py:10" }] };
  const scenario = { ...HAPPY,
    "adversarial-reviewer": (p, o, n) => (n === 0 ? reject : { ...R.reviewPass, resolved: [{ id: "F1", status: "addressed", note: "ok" }] }),
    "reimplement-after-review": { ...R.implement, headSha: SHA_B, minorsDeferred: [{ id: "F9", reason: "out of scope: unrelated module" }] },
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const adv = run.prompts.filter((p) => p.label === "adversarial-reviewer");
  const cor = run.prompts.filter((p) => p.label === "correctness-reviewer");
  assert.match(adv[1].prompt, /DELTA REVIEW/);
  assert.match(adv[1].prompt, /F1 .*no ON CONFLICT/);
  assert.doesNotMatch(cor[1].prompt, /no ON CONFLICT/, "a seat sees only its own findings");
  assert.match(adv[1].prompt, new RegExp(SHA_A + "\\.\\." + SHA_B));
  assert.doesNotMatch(adv[1].prompt, /git diff main\.\.\./, "delta mode does not ask for the full diff");
  assert.match(adv[1].prompt, /DEFERRALS CLAIMED[\s\S]*F9/, "deferrals are judged by the panel");
  assert.equal(run.labels.filter((x) => x === "validate-and-dod").length, 1);
  const re = run.prompts.find((p) => p.label === "reimplement-after-review");
  assert.match(re.prompt, /every BLOCKING finding first/);
  assert.match(re.prompt, /no-shed/);
});

test("single: a smoke failure re-runs the failed cases and reviews the delta, not the full diff", async () => {
  const scenario = { ...HAPPY,
    "validate-and-dod": (p, o, n) => (n === 0
      ? { ...R.dodPass, smokeAllPass: false, failureContext: "AC3 failed", cases: [{ id: "AC1", name: "a", pass: true }, { id: "AC3", name: "fuseki down", pass: false, files: ["src/api/graph.py"] }] }
      : { ...R.dodPass, cases: [{ id: "AC1", name: "a", pass: true, carried: true }, { id: "AC3", name: "fuseki down", pass: true }] }),
    "reimplement-after-validate": { ...R.implement, headSha: SHA_B },
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const v = run.prompts.filter((p) => p.label === "validate-and-dod");
  assert.match(v[1].prompt, /INCREMENTAL SMOKE/);
  assert.match(v[1].prompt, /AC3/);
  assert.match(v[1].prompt, /src\/api\/graph\.py/);
  assert.match(v[1].prompt, /FULL smoke instead/i, "the fall-back rule is stated to the agent");
  const adv = run.prompts.filter((p) => p.label === "adversarial-reviewer");
  assert.equal(adv.length, 2, "the panel re-runs after a fix");
  assert.match(adv[1].prompt, /DELTA REVIEW/, "…in delta mode even though the previous round passed");
});

test("single: a reimplement that produces no new commit is a code failure, not a silent re-loop", async () => {
  const scenario = { ...HAPPY,
    "gates": (p, o, n) => (n === 0 ? { ...R.gatesPass, pass: false, unit: "1 failed", failureContext: "test_x failed" } : R.gatesPass),
    "reimplement-after-validate": (p, o, n) => (n === 0 ? R.implement /* same sha as before */ : { ...R.implement, headSha: SHA_B }),
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const re = run.prompts.filter((p) => p.label === "reimplement-after-validate");
  assert.equal(re.length, 2);
  assert.match(re[1].prompt, /produced no new commit/);
});
```

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Verdict schema, `reviewFocus`, and the panel**

`VERDICT_SCHEMA.properties.findings.items.properties` gains `id: { type: "string" }`; top level gains:

```js
    resolved: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "status"],
      properties: { id: { type: "string" }, status: { type: "string", enum: ["addressed", "partially", "unaddressed"] }, note: { type: "string" } } } },
    deferralVerdicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "accepted"],
      properties: { id: { type: "string" }, accepted: { type: "boolean" }, note: { type: "string" } } } },
```

Replace the adversarial line of `reviewFocus` with:

```js
  if (agentType === "adversarial-reviewer")
    return "You are the ADVERSARIAL reviewer. Refute-first: PROVE this is not actually done. Hunt for skipped/weakened tests, swallowed errors, hardcoded/stubbed returns, cast-to-None, narrowed assertions, unaddressed root cause, missing named edge cases, and dishonest claims in the implementer's summary, filesTouched and deferrals; re-run the gates yourself in the run worktree and compare to the CLAIMED gate results.";
```

Replace `runReviewPanel` with:

```js
function renderFindings(list) {
  return list.map((f) => "- " + f.id + " [" + f.severity + "] " + f.category + (f.location ? " @ " + f.location : "") + ": " + f.detail).join("\n");
}

async function runReviewPanel(runLabel, ctx, base, evidence, mode) {
  const delta = mode && mode.prevSha;
  const deferrals = ctx.minorsDeferred.length
    ? "\n\nDEFERRALS CLAIMED BY THE IMPLEMENTER (judge each against no-shed: accept only a genuinely orthogonal item; return `deferralVerdicts`):\n" +
      ctx.minorsDeferred.map((d) => "- " + d.id + ": " + d.reason).join("\n")
    : "";
  const diffInstruction = delta
    ? "Review ONLY `git diff " + mode.prevSha + ".." + ctx.headSha + "`, in the run worktree `" + ctx.runWorktree + "` (checked out at " + ctx.headSha + ")."
    : "DERIVE GROUND TRUTH YOURSELF — reconstruct the real diff with `git diff " + base + "..." + ctx.headSha + "` in the run worktree `" + ctx.runWorktree + "` and read the actual code; do not trust any self-reported file list.";
  const results = (await parallel(selectedReviewers().map((agentType) => () => {
    const open = Object.values(ctx.findings[agentType] || {}).filter((f) => f.status !== "addressed");
    const header = delta
      ? "DELTA REVIEW (spec D3): a previous panel reviewed commit " + mode.prevSha + ". Your own open findings are listed below with ids. " +
        "For every one return its `resolved` status (addressed | partially | unaddressed) with a note citing path:line. Report NEW findings only if the delta introduces them; continue the id numbering. " +
        "Return verdict 'pass' only if every open finding is addressed and the delta introduces nothing blocking.\n\nYOUR OPEN FINDINGS:\n" + (open.length ? renderFindings(open) : "(none)") + "\n\n"
      : "";
    return agent(
      header + runLabel + " REVIEW (master-design-doc.md §8, spec §5). " + reviewFocus(agentType) +
        " Give every finding a stable id (F1, F2, …). Return verdict 'pass' only if you found no blocking finding; otherwise 'reject' with specific findings (each naming the triggering case/path and the required fix). On pass, return a short `verdictSection` (markdown).\n\n" +
        "Branch under review: " + ctx.branch + " at commit " + ctx.headSha + " (base: " + base + ")\n" + diffInstruction + "\n" + constraintsClause(ctx) + "\n" + evidence + deferrals,
      { label: agentType, phase: "Review", agentType: agentType, model: "opus", schema: VERDICT_SCHEMA }
    ).then((v) => ({ agentType, v }));
  }))).filter(Boolean);

  const expected = selectedReviewers().length;
  const valid = results.filter((r) => r.v && r.v.verdict);
  if (valid.length < expected) {
    return { pass: false, incomplete: true, rejectedBy: "incomplete-panel(" + valid.length + "/" + expected + ")",
      critique: "### review-infrastructure\nOnly " + valid.length + " of " + expected + " reviewers returned a verdict. An incomplete panel can never pass; the panel must re-run." };
  }
  // Update each seat's ledger: new findings are opened, resolved ones are closed.
  for (const r of valid) {
    const ledger = ctx.findings[r.agentType] || (ctx.findings[r.agentType] = {});
    for (const f of r.v.findings || []) if (f.id) ledger[f.id] = { ...f, status: "open" };
    for (const x of r.v.resolved || []) if (ledger[x.id]) ledger[x.id].status = x.status;
    for (const d of r.v.deferralVerdicts || []) if (!d.accepted) ledger["deferral-" + d.id] = { id: d.id, severity: "blocking", category: "no-shed", detail: "deferral rejected: " + (d.note || ""), status: "open" };
  }
  const rejected = valid.filter((r) => r.v.verdict === "reject" || (r.v.deferralVerdicts || []).some((d) => !d.accepted));
  if (rejected.length === 0) {
    return { pass: true, verdictSection: valid.map((r) => r.v.verdictSection || ("## Reviewer Verdict\nPASS — " + r.agentType + ".")).join("\n\n") };
  }
  const critique = rejected.map((r) => "### " + r.agentType + "\n" + (r.v.summary || "") + "\n" +
    renderFindings(Object.values(ctx.findings[r.agentType]).filter((f) => f.status !== "addressed"))).join("\n\n");
  return { pass: false, critique, rejectedBy: rejected.map((r) => r.agentType).join(", ") };
}
```

- [ ] **Step 4: `reimplement()` and `runValidate()`** (above `// MAIN FLOW`, after the mechanical helpers)

```js
/** One reimplement dispatch with its fixed surrounding steps: detach, the
 * implementer, reconcile, pin (spec D1, D5). Blocking findings first, minors
 * as separate commits; a deferral is a claim the panel judges (no-shed). */
async function reimplement(label, why, context, pass) {
  await detachWorktrees(ctx, "Implement", pass);
  const before = ctx.headSha;
  const r = requireAgentResult(await agent(
    "AUTONOMOUS run, " + why + " (master-design-doc.md §5/§8) — pass " + pass + ". Fix the ROOT CAUSE — do NOT weaken tests, skip cases, or shim. " +
      "Fix in-scope bugs in this change (no-shed); file only genuinely orthogonal bugs as cross-linked GH issues.\n" +
      "ORDER OF WORK: every BLOCKING finding first, each fixed and committed; then every minor finding as its own commit. " +
      "List in `minorsDeferred` only an item you judge genuinely out of scope, with the reason; the review panel judges every deferral and rejects a shed.\n" +
      constraintsClause(ctx) + HEAD_SHA_CLAUSE +
      "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle.\n" +
      "BLOCKERS: for an external condition you cannot fix return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise blocker='none'.\n\n" +
      "Branch: " + ctx.branch + " at " + ctx.headSha + "\n" + context,
    { label, phase: "Implement", model: "sonnet", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
  ), "IMPLEMENT");
  if (isExternalBlocker(r.blocker)) {
    ctx.failureContext = r.blockerDetail || ("blocker=" + r.blocker);
    await pauseForHuman("Implement", r.blocker, ctx);
  }
  if (r.worktreeBranch) ctx.worktreeBranches.push(r.worktreeBranch);
  ctx.minorsDeferred = ctx.minorsDeferred.concat(r.minorsDeferred || []);
  if (r.headSha === before) {
    // Nothing was committed: the next pass would replay cached gate results forever.
    ctx.failureContext = "reimplement produced no new commit at " + before + "; the previous failure stands:\n" + context;
    return r;
  }
  await reconcileBranch(ctx, r, "Implement", pass);
  await pinRunWorktree(ctx, "Implement", pass);
  return r;
}

/** The validate stage in the run worktree: full on the first smoke of a
 * lineage; incremental after a smoke failure (spec D4). */
async function runValidate(ctx, pass) {
  const incremental = ctx.failedCases.length > 0 && ctx.lastSmokeSha;
  const scope = incremental
    ? "INCREMENTAL SMOKE (spec D4): the smoke at " + ctx.lastSmokeSha + " failed: " +
      ctx.failedCases.map((c) => c.id + " (" + c.name + (c.files && c.files.length ? "; files " + c.files.join(", ") : "") + ")").join("; ") + ". " +
      "First run `git diff --name-only " + ctx.lastSmokeSha + ".." + ctx.headSha + "`. If that list touches a dependency manifest, a Dockerfile, a compose file, an nginx template, or any file that no failed case names, run the FULL smoke instead and say why in the report. " +
      "Otherwise re-run the failed cases and every case whose `files` overlap the changed files, plus a health check of the stack; report every case in `cases` with the same ids, marking cases you did not re-run `carried: true` with their last real `pass` and detail 'carried from " + ctx.lastSmokeSha + "'. " +
      "Keep the stack up between attempts; rebuild images only if a dependency, Dockerfile or nginx template changed.\n"
    : "FULL SMOKE: ";
  return agent(
    "AUTONOMOUS single-feature run, VALIDATE phase — pass " + pass + (resumeNonce ? ", resume " + resumeNonce : "") + " (spec D4; reference/definition-of-done.md). " +
      "Work in the run worktree `" + ctx.runWorktree + "` at commit " + ctx.headSha + " (verify with `git rev-parse HEAD`). Never checkout, rebuild or write to the main working tree.\n" +
      "STEP 0 — PREFLIGHT, before running a single test: an LLM key via ONE minimal call; the Docker daemon (`docker info` within 15 s) and service health; at least 10 GB free on Docker's volume; GitHub reachability if the smoke needs it. On any failure STOP and return gatesPass=false, smokeAllPass=false, blocker = 'infra' | 'credentials' | 'billing' | 'usage_limit', blockerDetail = the exact error. Never retry a preflight, never attempt host recovery, never read credentials.\n" +
      "STEP 1 — integration + regression suites at this commit. Unit, lint and type-check already passed (" + ctx.gateSummary + "); copy those into `tests`.\n" +
      "STEP 2 — " + scope + "the happy path, EVERY named edge case in the issue/spec (or derive and list them), and the plausible failure modes for the surface touched, against the running system. " +
      "REPORT EVERY SMOKE CASE in `cases` with a stable id (AC1, AC2, … in the issue's order, then E1… for derived edges and F1… for failure modes), `pass`, a one-line `detail`, and the source files the case exercises in `files`.\n" +
      "Set blocker='code' when a case fails because of the change; 'ambiguity' when acceptance criteria cannot be derived; a preflight kind when a resource failed mid-smoke; 'none' when everything passed.\n" +
      "Produce the DoD report with the exact structure from reference/definition-of-done.md (## Changes / ## Tests / ## Smoke test transcript / ## Docs updated / ## Follow-ups). Under ## Smoke test transcript render the re-run cases as a table and, if any, a separate list 'Carried forward (not re-run this pass)'. Under ## Follow-ups list every accepted deferral from the review panel.\n" +
      "gatesPass is true ONLY if every suite passed; smokeAllPass ONLY if every case in `cases` has pass=true.\n\n" +
      "Feature: " + featureDescription + "\nLinked issue: " + issueRef,
    { label: "validate-and-dod", phase: "Validate", model: "sonnet", schema: DOD_SCHEMA }
  );
}
```

- [ ] **Step 5: Rewrite the loop**

Remove the temporary `runGates(ctx, 1)` call from Task 5. Replace everything from `let dodReport = null;` through the end of the old `for (let pass ...)` loop with:

```js
let dodReport = null;
let reviewed = false;
let validateFailures = 0; // gates or smoke failures on code (one budget)
let reviewRejects = 0;    // panel rejects (the other budget)
let reviewPassedAt = null; // the headSha the panel last passed
for (let pass = 1; pass <= 2 * K && !reviewed; pass++) {
  log("Pass " + pass + " (code failures " + validateFailures + "/" + K + ", review rejects " + reviewRejects + "/" + K + ") at " + ctx.headSha);

  // ---- GATES (spec D2) ----------------------------------------------------
  phase("Gates");
  const g = await runGates(ctx, pass);
  if (isExternalBlocker(g.blocker)) { ctx.failureContext = g.blockerDetail || ("blocker=" + g.blocker); await pauseForHuman("Gates", g.blocker, ctx); }
  if (!g.pass) {
    validateFailures++;
    ctx.failureContext = "Gates failed (code failure " + validateFailures + " of " + K + ", pass " + pass + "): " + (g.failureContext || "unit/lint/typecheck red");
    if (validateFailures === K) await escalate("Gates", validateFailures, ctx);
    await reimplement("reimplement-after-validate", "back to IMPLEMENT after a GATES failure", ctx.failureContext, pass);
    continue;
  }
  ctx.gateSummary = "unit: " + g.unit + "; lint: " + g.lint + "; typecheck: " + g.typecheck;

  // ---- REVIEW (spec D2/D3): before the smoke; delta mode whenever a prior round exists ----
  if (reviewPassedAt !== ctx.headSha) {
    phase("Review");
    const mode = ctx.prevReviewSha ? { prevSha: ctx.prevReviewSha } : "full";
    const review = await runReviewPanel("AUTONOMOUS single-feature run,", ctx, devBranch, "GATE RESULTS at " + ctx.headSha + ": " + ctx.gateSummary, mode);
    if (review.incomplete) { ctx.failureContext = review.critique; await pauseForHuman("Review", "usage_limit", ctx); }
    ctx.prevReviewSha = ctx.headSha; // any later round is a delta over this commit
    if (!review.pass) {
      reviewRejects++;
      ctx.failureContext = "Review panel rejected (reject " + reviewRejects + " of " + K + ", pass " + pass + ", by: " + review.rejectedBy + "):\n" + review.critique;
      if (reviewRejects === K) await escalate("Review", reviewRejects, ctx);
      await reimplement("reimplement-after-review", "back to IMPLEMENT after a REVIEW reject", "Reviewer critique:\n" + review.critique, pass);
      continue;
    }
    reviewPassedAt = ctx.headSha;
    ctx.reviewVerdictSection = review.verdictSection;
  }

  // ---- SMOKE (spec D4): once after review; incremental after a failure ----
  phase("Validate");
  const dod = await runValidate(ctx, pass);
  if (!dod) { ctx.failureContext = "VALIDATE agent died without returning a DoD result."; await pauseForHuman("Validate", "usage_limit", ctx); }
  if (isExternalBlocker(dod.blocker)) { ctx.failureContext = dod.blockerDetail || dod.failureContext || ("blocker=" + dod.blocker); await pauseForHuman("Validate", dod.blocker, ctx); }
  if (!dod.gatesPass || !dod.smokeAllPass) {
    validateFailures++;
    ctx.failedCases = (dod.cases || []).filter((c) => !c.pass);
    ctx.lastSmokeSha = ctx.headSha;
    ctx.failureContext = "Smoke failed (code failure " + validateFailures + " of " + K + ", pass " + pass + "): " + (dod.failureContext || ctx.failedCases.map((c) => c.id + " " + c.name).join(", "));
    if (validateFailures === K) await escalate("Validate", validateFailures, ctx);
    await reimplement("reimplement-after-validate", "back to IMPLEMENT after a SMOKE failure", ctx.failureContext, pass);
    continue;
  }
  dodReport = dod.report + "\n\n" + ctx.reviewVerdictSection;
  reviewed = true;
  log("Gates, review and smoke green at " + ctx.headSha + ".");
}
```

Delete the old inline validate and reimplement `agent(` calls. Update `meta.phases` to Design, Implement, Gates, Review, Validate, Ship, CI with one-line details. Update the file header's THE FLOW block to the new order.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/workflow-flow.test.mjs`
Expected: all pass except the happy-path sequence, which still lacks `scrub-pr-body` and `quota-check` until Task 7. Keep `HAPPY_LABELS` as declared; mark the happy-path test `{ todo: "Task 7" }` for this commit and un-mark it in Task 7. The other tests must pass.

- [ ] **Step 7: Mirror, check, commit**

```bash
cp claude-home/workflows/single-feature-run.js claude-repo/.claude/workflows/single-feature-run.js
node --check claude-home/workflows/single-feature-run.js && node --test tests/
git add -A claude-home/workflows claude-repo/.claude/workflows tests/workflow-flow.test.mjs
git commit -m "feat(workflow): gates, then review, then smoke; delta review over each seat's own findings; incremental re-smoke; blocking-first reimplement with judged deferrals (spec D2–D5)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Ship names the commit; PR scrub; CI fix pinned; quota short-circuit; cleanup at every exit (D6, D7 part 3, D8)

> **As built:** `checkQuota(ctx)`; the CI fix dispatch is `detachWorktrees(ctx, "CI", 100 + fixAttempt, "before-implement")`, the fix agent, then `reconcileBranch(...)`, so the labels after `fix-ci-and-repush` are `detach-worktrees`, `reconcile-branch` (the test asserts reconcile is reached with only detach steps intervening). No cleanup between ship and CI; cleanup runs inside `finishWithoutCi` and before the CI-green return.

**Files:**
- Modify: `claude-home/workflows/single-feature-run.js` — the ship prompt; after `push-and-open-pr`; the CI phase (`fix-ci-and-repush`, both returns)
- Test: `tests/workflow-flow.test.mjs`
- Mirror.

**Interfaces:**
- Produces: `scrubPrBody(ctx)` (label `scrub-pr-body`); `checkQuota(ctx)` (label `quota-check`); `finishWithoutCi(ctx, why)` → `{ prUrl, branch, headSha, issue, ciSkipped: "quota" }`; success return `{ prUrl, branch, headSha, issue }`.

- [ ] **Step 1: Failing tests** (and un-mark the happy-path test)

```js
test("single: an exhausted quota skips CI, cleans up, and finishes with ciSkipped", async () => {
  const scenario = { ...HAPPY, "quota-check": { quota: "exhausted", detail: "2000/2000 minutes" }, "comment-ci-skipped": "posted" };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  assert.ok(!run.labels.includes("poll-ci"));
  assert.equal(run.result.ciSkipped, "quota");
  assert.equal(run.labels[run.labels.length - 1], "cleanup-worktrees");
});

test("single: a billing-red poll takes the skip path instead of pausing", async () => {
  const scenario = { ...HAPPY,
    "quota-check": { quota: "unknown", detail: "no user scope" },
    "poll-ci": { status: "red", blocker: "billing", logsExcerpt: "The job was not started because recent account payments have failed or your spending limit needs to be increased." },
    "comment-ci-skipped": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  assert.equal(run.result.ciSkipped, "quota");
  assert.ok(!run.labels.includes("pause-for-human"));
});

test("single: a red CI fix is reconciled and pinned like any implement, and the run cleans up on green", async () => {
  const scenario = { ...HAPPY,
    "poll-ci": (p, o, n) => (n === 0 ? { status: "red", blocker: "code", failingJobs: ["unit"], logsExcerpt: "1 failed" } : R.ciGreen),
    "fix-ci-and-repush": { ...R.implement, headSha: SHA_B },
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const f = run.labels.indexOf("fix-ci-and-repush");
  assert.equal(run.labels[f + 1], "reconcile-branch");
  assert.equal(run.result.headSha, SHA_B);
  assert.equal(run.labels[run.labels.length - 1], "cleanup-worktrees");
});

test("single: ship and CI prompts name the commit; the PR body is scrubbed after ship", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const ship = run.prompts.find((p) => p.label === "push-and-open-pr");
  assert.match(ship.prompt, new RegExp(SHA_A));
  const i = run.labels.indexOf("push-and-open-pr");
  assert.equal(run.labels[i + 1], "scrub-pr-body");
  assert.match(run.prompts.find((p) => p.label === "scrub-pr-body").prompt, /Claude-Session/);
  assert.match(run.prompts.find((p) => p.label === "poll-ci").prompt, new RegExp(SHA_A));
});
```

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Implement**

Helpers above `// MAIN FLOW`:

```js
const SCRUB_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "changed"], properties: { ok: { type: "boolean" }, changed: { type: "boolean" }, detail: { type: "string" } } };
const QUOTA_SCHEMA = { type: "object", additionalProperties: false, required: ["quota", "detail"], properties: { quota: { type: "string", enum: ["ok", "exhausted", "unknown"] }, detail: { type: "string" } } };

/** Remove private session links from the PR body (spec D7): the outcome must
 * not depend on whether the ship agent obeyed its prompt. */
async function scrubPrBody(ctx) {
  return mechanical(ctx, "scrub-pr-body", "Ship",
    "(PR " + ctx.prUrl + ", head " + ctx.headSha + ")\n" +
      "1. `gh pr view " + ctx.prUrl + " --json body --jq .body` and save it to a temporary file.\n" +
      "2. If the body contains a line with `Claude-Session:` or the text `claude.ai/code/session_`, delete every such line and every line that consists only of such a link, then `gh pr edit " + ctx.prUrl + " --body-file <the file>` and return ok=true, changed=true.\n" +
      "3. Otherwise return ok=true, changed=false.",
    SCRUB_SCHEMA);
}

/** Read the account's Actions quota (spec D8). `unknown` without the `user`
 * scope; polling then decides from the run's own billing annotation. */
async function checkQuota(ctx) {
  return mechanical(ctx, "quota-check", "CI",
    "(PR " + ctx.prUrl + ")\n" +
      "1. `login=$(gh api user --jq .login)`; then `gh api /users/$login/settings/billing/actions`.\n" +
      "2. If the call fails (404 or a scope error), return quota='unknown' with the error text as detail.\n" +
      "3. Otherwise compare `total_minutes_used` with `included_minutes`: quota='exhausted' if used >= included, else 'ok'; detail = '<used>/<included> minutes'.",
    QUOTA_SCHEMA);
}

async function finishWithoutCi(ctx, why) {
  await agent(
    "Post ONE short comment on PR " + ctx.prUrl + " via the GitHub MCP server: 'CI was not run by the autonomous workflow: " + why + ". Gates, review panel and smoke passed at commit " + ctx.headSha + "; see the PR body.' Do not push, merge or modify code.",
    { label: "comment-ci-skipped", phase: "CI", model: "sonnet", effort: "low" }
  );
  await cleanupWorktrees(ctx, "CI", "ci skipped");
  log("CI skipped (" + why + "). PR awaits Gate B: " + ctx.prUrl);
  return { prUrl: ctx.prUrl, branch: ctx.branch, headSha: ctx.headSha, issue: issueRef, ciSkipped: "quota" };
}
```

Ship prompt: change `"Push the NON-MAIN branch '" + ctx.branch + "' to origin"` to `"Push the NON-MAIN branch '" + ctx.branch + "' (at commit " + ctx.headSha + "; verify with git rev-parse before pushing) to origin"`. After `log("Branch pushed and PR opened: " + ctx.prUrl);` insert `await scrubPrBody(ctx);`.

CI phase: before the `for (let fixAttempt ...)` loop:

```js
const quota = await checkQuota(ctx);
if (quota.quota === "exhausted") return await finishWithoutCi(ctx, "the GitHub Actions quota is exhausted (" + quota.detail + ")");
```

Poll prompt: add `" at commit " + ctx.headSha` after `(branch '" + ctx.branch + "')`. Replace the `if (isExternalBlocker(ci.blocker)) { ... }` block with:

```js
  if (ci.blocker === "billing") return await finishWithoutCi(ctx, "GitHub reported a billing/quota refusal: " + (ci.logsExcerpt || ci.blockerDetail || "").slice(0, 200));
  if (isExternalBlocker(ci.blocker)) { ctx.failureContext = ci.blockerDetail || ci.logsExcerpt || ("blocker=" + ci.blocker); await pauseForHuman("CI", ci.blocker, ctx); }
```

On green, before `break;`: `await cleanupWorktrees(ctx, "CI", "ci green");`. Replace the `fix-ci-and-repush` dispatch with a reconciled one:

```js
  await detachWorktrees(ctx, "CI", 100 + fixAttempt);
  const fix = requireAgentResult(await agent(
    "AUTONOMOUS run, CI-RED fix (master-design-doc.md §5; reference/definition-of-done.md CI-red delta) — fix attempt " + fixAttempt + ". " +
      "On branch '" + ctx.branch + "' at " + ctx.headSha + ", read the failing CI logs, fix the ROOT CAUSE (no shim, no weakened test, no skipped check), " +
      "re-validate the affected cases as a delta, then re-push the non-main branch. Do NOT touch main.\n" + HEAD_SHA_CLAUSE + "\nFailure context:\n" + ctx.failureContext,
    { label: "fix-ci-and-repush", phase: "CI", model: "sonnet", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
  ), "CI FIX");
  if (isExternalBlocker(fix.blocker)) { ctx.failureContext = fix.blockerDetail || ("blocker=" + fix.blocker); await pauseForHuman("CI", fix.blocker, ctx); }
  if (fix.worktreeBranch) ctx.worktreeBranches.push(fix.worktreeBranch);
  await reconcileBranch(ctx, fix, "CI", 100 + fixAttempt);
```

Final success return: `return { prUrl: prUrl, branch: ctx.branch, headSha: ctx.headSha, issue: issueRef };`.

- [ ] **Step 4: Run all tests, expect pass** (un-mark the happy-path test).

- [ ] **Step 5: Mirror, check, commit**

```bash
cp claude-home/workflows/single-feature-run.js claude-repo/.claude/workflows/single-feature-run.js
node --check claude-home/workflows/single-feature-run.js && node --test tests/
git add -A claude-home/workflows claude-repo/.claude/workflows tests/workflow-flow.test.mjs
git commit -m "feat(workflow): ship and CI pinned to the commit; PR body scrub; CI skipped cleanly on an exhausted quota; cleanup at every exit (spec D6–D8)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Reviewer agent definitions for the pre-smoke position (D2)

**Files:**
- Modify: `claude-home/agents/adversarial-reviewer.md`, `claude-home/agents/correctness-reviewer.md`
- Mirror: `claude-repo/.claude/agents/adversarial-reviewer.md`, `claude-repo/.claude/agents/correctness-reviewer.md`

**Why:** both definitions describe inputs that no longer exist at review time (the DoD report and its transcript). An agent whose system prompt demands an artifact it cannot have degrades unpredictably.

- [ ] **Step 1: Read both files fully.** Note every sentence that names the DoD report, the smoke transcript, or "after validation" as an input or a timing.

- [ ] **Step 2: Rewrite the inputs section of `adversarial-reviewer.md`** to:

```markdown
## Your inputs (fixed by the workflow; you cannot expand them)
1. The diff under review: `git diff <base>...<headSha>` on the first round, `git diff <prevSha>..<headSha>` on a delta round, in the run worktree the prompt names.
2. The gate results the workflow recorded (unit, lint, typecheck) and the implementer's own claims: its summary, files touched, and any deferrals.
3. The design constraints from the design review, each with its source.
4. On a delta round: your own open findings from the previous round, by id.

The smoke and its DoD report come AFTER you pass. You are refuting the code and the implementer's claims, not a transcript.
```

Change the frontmatter `description` to say the reviewer gates a feature **after the gates and before the smoke**. Re-point the "dishonest DoD claims" reject category at "dishonest claims: a summary, file list or deferral that the diff contradicts; a gate result you cannot reproduce". Make the same input change in `correctness-reviewer.md` (its focus paragraph is unchanged). Do not touch the security or performance definitions beyond the same inputs section if they have one.

- [ ] **Step 3: Mirror and test**

```bash
cp claude-home/agents/adversarial-reviewer.md claude-repo/.claude/agents/adversarial-reviewer.md
cp claude-home/agents/correctness-reviewer.md claude-repo/.claude/agents/correctness-reviewer.md
node --test tests/
```

- [ ] **Step 4: Commit**

```bash
git add claude-home/agents claude-repo/.claude/agents
git commit -m "docs(agents): reviewer inputs for the pre-smoke position — diff at a commit, gate results, constraints, the implementer's claims (spec D2)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Settings: attribution and the allow-list for mechanical steps (D7 part 1)

**Files:**
- Modify: `claude-home/settings.json`, `claude-repo/.claude/settings.json`
- Test: `tests/settings.test.mjs` (new)

- [ ] **Step 1: Failing test**

```js
// tests/settings.test.mjs
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
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Edit both files.** Add the top-level key `"attribution": { "sessionUrl": false }` and append the eight `NEEDED` entries to `permissions.allow`. Read `claude-repo/.claude/settings.json` first; it has its own shape, so add to what is there. `git branch -d` (lowercase, merged-only) is intentionally left to prompt.

- [ ] **Step 4: Run tests, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add claude-home/settings.json claude-repo/.claude/settings.json tests/settings.test.mjs
git commit -m "feat(settings): disable session links in attribution; allow the mechanical steps' git and gh commands (spec D7)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Port D1–D8 to `federated-run.js` (explicit behaviour change: independent budgets per feature)

**Files:**
- Modify: `claude-home/workflows/federated-run.js`
- Test: `tests/workflow-flow.test.mjs`
- Mirror: `claude-repo/.claude/workflows/federated-run.js`

**Interfaces:**
- Consumes: the helper bodies from Tasks 3–7, copied verbatim (the scripts cannot share code) with labels prefixed by the feature tag. Read `processFeature` first: the tag is `"feat:" + feature.id`, so labels are `feat:f1:implement`, and reviewer labels must become `tag + ":" + agentType` to avoid collisions across concurrent features.
- Behaviour change to state in the commit body and ADR: `processFeature` moves from one shared attempt counter to the two independent budgets and `2 * K` passes, matching the single-feature script after PR #8. Per-feature `ctx` starts with `branch: null`; `runOwnsBranch` must treat a null branch as not owned.
- `pauseFeatureForHuman` is non-throwing: call `cleanupWorktrees(ctx, stage, "feature pause")` inside it before returning the marker.
- Mechanical git steps of concurrent features share one repository. Serialize `git worktree add/remove/prune` and `update-ref` by giving each feature its own worktree path (`run-<slug>` already does) and by never running `git worktree prune` inside a feature core; prune once in the batch-level cleanup after the barrier.

- [ ] **Step 1: Failing test**

```js
const FED_ARGS = { devBranch: "main", features: [{ id: "f1", title: "dark mode", issue: "owner/repo#1", plan: "do it" }] };
const T = "feat:f1:";
const FED_HAPPY = { ...HAPPY,
  [T + "design-review"]: R.design, [T + "detach-worktrees"]: R.detach, [T + "implement"]: R.implement, [T + "reconcile-branch"]: reconcileEcho,
  [T + "pin-run-worktree"]: pinEcho, [T + "gates"]: R.gatesPass, [T + "adversarial-reviewer"]: R.reviewPass, [T + "correctness-reviewer"]: R.reviewPass,
  [T + "validate-and-dod"]: R.dodPass, [T + "cleanup-worktrees"]: R.cleanup,
  "integrate": { merged: ["f1"], blocker: "none" },
};

test("federated: each feature core runs design, implement, reconcile, pin, gates, review, smoke in that order", async () => {
  const run = await runWorkflowRecording(SCRIPTS.federated, FED_ARGS, FED_HAPPY);
  assert.equal(run.error, null, run.error && run.error.stack);
  const f = run.labels.filter((l) => l.startsWith(T));
  assertSequence(f.slice(0, 9), [T + "design-review", T + "detach-worktrees", T + "implement", T + "reconcile-branch", T + "pin-run-worktree", T + "gates", [T + "adversarial-reviewer", T + "correctness-reviewer"], T + "validate-and-dod"]);
});
```

Adjust the `integrate` result shape to whatever `federated-run.js` actually returns from its integrate agent (read the schema there first).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Port.** Copy `MECHANICAL_PREAMBLE`, `mechanical`, the schemas, `runOwnsBranch`, `detachWorktrees`, `reconcileBranch`, `pinRunWorktree`, `cleanupWorktrees`, `constraintsClause`, `renderFindings`, `runGates`, `runReviewPanel`, `reimplement`, `runValidate`, `scrubPrBody`, `checkQuota`, `finishWithoutCi` from `single-feature-run.js`, adapting label prefixes and the per-feature `ctx`. Rewrite `processFeature`'s loop in Task 6's shape with the two budgets. Add the design review as its first step. Add `scrubPrBody` after the batch PR opens and `checkQuota` before the CI loop with the same skip path; the CI fix gets the same reconciled dispatch as Task 7.

- [ ] **Step 4: Run all tests, expect pass.**

- [ ] **Step 5: Mirror, check, commit**

```bash
cp claude-home/workflows/federated-run.js claude-repo/.claude/workflows/federated-run.js
node --check claude-home/workflows/federated-run.js && node --test tests/
git add -A claude-home/workflows claude-repo/.claude/workflows tests/workflow-flow.test.mjs
git commit -m "feat(workflow): port the re-sequenced core, pinned worktrees, mechanical steps and CI skip to the federated run; independent budgets per feature (spec D1–D8)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: ADR, design doc, DoD reference

**Files:**
- Create: `docs/adr/0002-resequence-the-autonomous-loop.md`
- Modify: `docs/master-design-doc.md` §5 (mermaid: a Design node before D; a Gates node before REV; REV before J; a delta-review loop edge from REV to E; a "CI skipped (quota)" edge from N to PR), §8 ("Where": after the gates, before the smoke; delta mode; inputs), §9 (two independent budgets, pinned commits, cleanup on every exit)
- Modify: `claude-home/reference/definition-of-done.md` — the smoke section gains the per-case table and the "Carried forward (not re-run this pass)" list; mirror to `claude-repo/.claude/reference/definition-of-done.md`

- [ ] **Step 1: Write the ADR** (format per `claude-home/rules/adr-format.md`)

```markdown
# ADR-0002: Re-sequence the autonomous loop

## Status
Accepted

## Context
Two real runs of the single-feature workflow (2026-09) found real defects at every review round and cost about a million output tokens and seven serial hours each. The causes were structural: the branch-name handoff let later stages run on stale code (issue #9); every fix re-ran the full smoke; the cheaper review ran after the expensive smoke and rejected more often than the smoke failed; the panel re-derived the whole diff after each fix; no stage read the codebase's own contracts before implementation; cleanup ran only on success; an exhausted CI quota paused the run instead of ending it.

## Options considered
- Keep the order, fix only the handoff (issue #9). Cheapest; leaves the cost profile.
- Drop the automated loop for daytime work; keep the panel and smoke as manual stages. Cheaper still; loses unattended runs.
- Re-sequence: design review first, commit-pinned handoffs in a run-owned worktree, gates before review before smoke, delta review and incremental re-smoke after a fix, cleanup on every exit, a clean finish on an exhausted quota. Keeps unattended runs; the panel and the smoke are unchanged in rigour.

## Decision
Re-sequence (spec `docs/specs/2026-09-09-workflow-resequencing-design.md`, D1–D8). Deterministic steps are mechanical agents because the DSL has no shell; every such prompt carries the pass and the commit because results are cached by prompt. The run never touches the main working tree.

## Consequences
Easier: a reject never discards a smoke; a fix costs a delta review and usually no smoke; stale-code rounds cannot happen; runs end cleanly on an exhausted quota; the run leaves no worktrees behind. Harder: more stages on the happy path; reviewers track finding ids across rounds; the federated run's budgets change. Riskier: a wrong `headSha` from an implementer escalates rather than continues, which is the intended failure mode.

## Notes
Issue #9, PR #8, the ClaudeDevLifecycle Atlas (2026-09-09).
```

- [ ] **Step 2: Update §5, §8, §9 and the DoD reference** as listed in Files.

- [ ] **Step 3: Mirror and commit**

```bash
cp claude-home/reference/definition-of-done.md claude-repo/.claude/reference/definition-of-done.md
git add docs/adr/0002-resequence-the-autonomous-loop.md docs/master-design-doc.md claude-home/reference/definition-of-done.md claude-repo/.claude/reference/definition-of-done.md
git commit -m "docs: ADR-0002 re-sequence the autonomous loop; design doc §5/§8/§9; DoD per-case smoke table" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Verification and the pull request

- [ ] **Step 1: Full test run and syntax checks**

```bash
node --test tests/
node --check claude-home/workflows/single-feature-run.js claude-home/workflows/federated-run.js
```
Expected: all pass.

- [ ] **Step 2: Sync the local masters** (the user's `~/.claude`) per `INSTALL.md`: copy `claude-home/workflows/*.js` and `claude-home/agents/*.md`, and merge the `attribution` key and the allow-list entries into `~/.claude/settings.json`. This step is the user's; list the commands in the PR body.

- [ ] **Step 3: Open the PR**

Body: the spec's Problem and Decisions condensed; the test list; the Task 1 attribution verification; the federated budget change stated plainly; the sync commands; `Closes #9`. End with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and nothing after it.

- [ ] **Step 4: First real run** (after merge, user's Gate A): a small issue on a governed repo, with `gateCommands` passed explicitly. Expect: one full review round, one full smoke, every later validate incremental, no worktree or side branch left, no session link, and a clean `ciSkipped` finish while the quota is exhausted.
