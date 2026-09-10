// tests/workflow-flow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

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
  // A dead agent is modelled as `null` (the workflow has explicit null-handling
  // paths, e.g. requireAgentResult) — that is a valid result to hand back, not
  // a schema violation, so there is nothing to check against `schema.required`.
  if (value === null) return;
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
    // M14: `in` walks the prototype chain — a label matching an
    // Object.prototype property name (e.g. "constructor", "toString") would
    // otherwise resolve to that inherited method instead of throwing
    // "unmodelled agent label".
    if (Object.prototype.hasOwnProperty.call(scenario, label)) return scenario[label];
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
      // A null result models a dead agent (usage-limit kill, etc.) — the
      // caller's own null-handling path (requireAgentResult) is what's under
      // test then, not the schema.
      if (r !== null) checkSchema(opts && opts.schema, r, label);
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
  // `expected` entries are either a single label or a nested array describing
  // one parallel panel segment — its length in labels is not its length as an
  // `expected` entry, so count labels, not entries.
  const n = expected.reduce((a, e) => a + (Array.isArray(e) ? e.length : 1), 0);
  assert.equal(actual.length, n, `label count: ${actual.join(" > ")}`);
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

test("cache-collision guard: a cacheable entry does not trip the collision check", async () => {
  const scenario = { ...HAPPY, "implement-tdd": { cacheable: true, result: R.implement } };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  const impl = run.prompts.find((p) => p.label === "implement-tdd");
  assert.ok(impl, "implement-tdd never dispatched: " + (run.error && run.error.message));
  assert.ok(
    !(run.error && /cache collision/.test(run.error.message)),
    "a cacheable entry must never trigger the cache-collision guard: " + (run.error && run.error.message)
  );
});

test("single: design review runs first and its constraints reach the implementer", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  assert.equal(run.labels[0], "design-review");
  const impl = run.prompts.find((p) => p.label === "implement-tdd");
  assert.match(impl.prompt, /provenance writes use ON CONFLICT/);
  assert.match(impl.prompt, /CLAUDE\.md/);
});

test("single: the first implement is not preceded by a detach (no branch exists yet); reconcile detaches its own holder, then pins", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const i = run.labels.indexOf("implement-tdd");
  assert.ok(i > -1, "implement-tdd never dispatched: " + (run.error && run.error.message));
  assert.ok(!run.labels.slice(0, i).includes("detach-worktrees"), "no detach before the first implement");
  // reconcileBranch now detaches whatever worktree holds the freshly-created
  // branch (e.g. the implementer's own isolated worktree) before moving the
  // ref, and records that path for later cleanup — so "detach-worktrees" is
  // dispatched from inside reconcileBranch, ahead of its own mechanical step.
  assert.equal(run.labels[i + 1], "detach-worktrees");
  assert.equal(run.labels[i + 2], "reconcile-branch");
  assert.equal(run.labels[i + 3], "pin-run-worktree");
  const pin = run.prompts.find((p) => p.label === "pin-run-worktree");
  assert.match(pin.prompt, new RegExp(SHA_A));
  assert.match(pin.prompt, /pass 0/);
});

test("single: every reconcile-branch prompt guards against a branch checked out in the main working tree", async () => {
  // Fix round 1, IMPORTANT 3: git update-ref does not refuse a branch that is
  // currently checked out, so reconcileBranch must check for — and refuse to
  // touch — a branch the human has checked out in the MAIN working tree
  // before ever moving its ref. This must hold on every dispatch, not just
  // the first: assert it against the happy path's only reconcile-branch call.
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  assert.equal(run.error, null, run.error && run.error.stack);
  const reconciles = run.prompts.filter((p) => p.label === "reconcile-branch");
  assert.ok(reconciles.length > 0, "reconcile-branch never dispatched");
  for (const r of reconciles) {
    assert.match(r.prompt, /main working tree/, "reconcile-branch prompt missing the main-working-tree guard: " + r.prompt);
    assert.match(r.prompt, /feat\/dark-mode/, "reconcile-branch prompt missing the branch name");
  }
});

test("single: a resume with existingBranch detaches that branch's holders before the first implement", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, { ...BASE_ARGS, existingBranch: "feat/dark-mode" }, HAPPY);
  const i = run.labels.indexOf("implement-tdd");
  assert.ok(i > -1, "implement-tdd never dispatched: " + (run.error && run.error.message));
  assert.equal(run.labels[i - 1], "detach-worktrees");
  assert.match(run.prompts.find((p) => p.label === "detach-worktrees").prompt, /feat\/dark-mode/);
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

test("single: a dead cleanup agent during escalate does not recurse forever — it pauses once, no second terminal (M15)", async () => {
  // Mirrors the federated test's shape ("a dead batch cleanup agent does not
  // recurse forever"): a diverged reconcile drives escalate(), whose own
  // cleanupWorktrees call's mechanical "cleanup-worktrees" agent dies. That
  // routes through mechanical() -> pauseForHuman() directly (single script),
  // which short-circuits its own nested cleanupWorktrees call (the
  // module-level `cleaningUp` guard) and posts exactly one pause-for-human
  // comment before throwing. Per M6, escalate() rethrows that nested
  // EscalationStop instead of swallowing it and running its own root-cause
  // diagnosis + escalate-to-issue comment — a single dead cleanup agent must
  // yield exactly one cleanup-worktrees dispatch and one terminal, not two.
  const scenario = { ...HAPPY,
    "reconcile-branch": { ok: false, sha: SHA_B, detail: "feat/dark-mode is not an ancestor of " + SHA_B },
    "cleanup-worktrees": null,
    "pause-for-human": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop", run.error && run.error.stack);
  const cleanupCalls = run.prompts.filter((p) => p.label === "cleanup-worktrees");
  assert.equal(cleanupCalls.length, 1, "the guard must prevent a recursive second dispatch: " + cleanupCalls.length);
  assert.equal(run.labels.filter((l) => l === "pause-for-human").length, 1, "exactly one pause, not a cascade");
  assert.ok(!run.labels.includes("escalate-to-issue"), "escalate() must not post a second terminal after the nested pause already did");
  assert.ok(!run.labels.includes("root-cause-diagnosis"), "no root-cause diagnosis runs for an external usage-limit pause");
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

test("single: M7 — an ambiguity-blocked first implement pauses before reconcile ever runs", async () => {
  const scenario = { ...HAPPY,
    "implement-tdd": { ...R.implement, headSha: SHA_B, blocker: "ambiguity", blockerDetail: "cannot derive acceptance criteria" },
    "pause-for-human": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop", run.error && run.error.stack);
  assert.ok(!run.labels.includes("reconcile-branch"), "reconcile must never run for a blocked first implement");
  assert.ok(!run.labels.includes("escalate-to-issue"), "an external blocker must pause, not escalate with a root-cause diagnosis");
  assert.ok(run.labels.includes("pause-for-human"));
});

test("single: a dead mechanical agent pauses for a human instead of throwing raw", async () => {
  const scenario = { ...HAPPY, "pin-run-worktree": null, "pause-for-human": "posted" };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop");
  assert.ok(run.labels.includes("pause-for-human"));
});

test("single: a null ship result pauses for a human with cleanup instead of throwing raw (I4)", async () => {
  const scenario = { ...HAPPY, "push-and-open-pr": null, "pause-for-human": "posted" };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop", run.error && run.error.stack);
  const c = run.labels.indexOf("cleanup-worktrees");
  const p = run.labels.indexOf("pause-for-human");
  assert.ok(c > -1 && p > -1 && c < p, "cleanup runs before the pause comment: " + run.labels.join(", "));
});

test("single: gates helper runs in the run worktree at headSha with the pass number", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const g = run.prompts.find((p) => p.label === "gates");
  assert.ok(g, "gates never dispatched: " + (run.error && run.error.message));
  assert.match(g.prompt, new RegExp(SHA_A));
  assert.match(g.prompt, /run-feat-dark-mode/);
  assert.match(g.prompt, /pass 1/);
});

test("single: M1 — a gateCommands object missing a key falls back to the documented-commands branch (no literal 'undefined')", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, { ...BASE_ARGS, gateCommands: { unit: "x" } }, HAPPY);
  assert.equal(run.error, null, run.error && run.error.stack);
  const g = run.prompts.find((p) => p.label === "gates");
  assert.ok(g, "gates never dispatched");
  assert.doesNotMatch(g.prompt, /undefined/);
  assert.match(g.prompt, /repository's unit tests, lint and type-check/, "falls back to the documented-commands branch");
});

test("single: DoD schema requires per-case results with a carried flag", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  const v = run.prompts.find((p) => p.label === "validate-and-dod");
  assert.ok(v, "validate never dispatched: " + (run.error && run.error.message));
  assert.ok(v.opts.schema.required.includes("cases"));
  assert.equal(v.opts.schema.properties.cases.minItems, 1);
  assert.equal(v.opts.schema.properties.cases.items.properties.carried.type, "boolean");
});

test("single: reviewers receive the implementer's summary and files touched", async () => {
  const scenario = { ...HAPPY, "implement-tdd": { ...R.implement, filesTouched: ["src/a.js"] } };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  for (const label of ["adversarial-reviewer", "correctness-reviewer"]) {
    const p = run.prompts.find((pr) => pr.label === label);
    assert.ok(p, label + " never dispatched: " + (run.error && run.error.message));
    assert.match(p.prompt, /IMPLEMENTER'S CLAIMS/);
    assert.match(p.prompt, /summary: done/);
    assert.match(p.prompt, /src\/a\.js/);
  }
});

test("single: happy path label order", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, HAPPY);
  assert.equal(run.error, null, run.error && run.error.stack);
  assertSequence(run.labels, HAPPY_LABELS);
  assert.equal(run.result.prUrl, R.ship.prUrl);
  assert.equal(run.result.headSha, SHA_A);
});

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

test("single: a red CI fix is reconciled like any implement (M8: the single CI fix does not pin), and the run cleans up on green", async () => {
  const scenario = { ...HAPPY,
    "poll-ci": (p, o, n) => (n === 0 ? { status: "red", blocker: "code", failingJobs: ["unit"], logsExcerpt: "1 failed" } : R.ciGreen),
    "fix-ci-and-repush": { ...R.implement, headSha: SHA_B },
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const f = run.labels.indexOf("fix-ci-and-repush");
  const r = run.labels.indexOf("reconcile-branch", f);
  // reconcileBranch's own detach (spec D1/D6, "as built") unconditionally
  // dispatches a "detach-worktrees" mechanical step ahead of its own
  // "reconcile-branch" step whenever the run owns a real feature branch —
  // exactly the same pattern reimplement() uses for every retry loop. So the
  // fix is reconciled with nothing else (no gates/review/smoke) in between:
  // only that detach may sit between the fix agent and its reconciliation.
  assert.ok(r > f, "reconcile-branch follows fix-ci-and-repush");
  assert.ok(run.labels.slice(f + 1, r).every((l) => l === "detach-worktrees"), "only reconcileBranch's own detach may sit between the fix and its reconciliation: " + run.labels.slice(f + 1, r).join(", "));
  assert.equal(run.result.headSha, SHA_B);
  assert.equal(run.labels[run.labels.length - 1], "cleanup-worktrees");
});

test("single: M4 — a stray worktreeBranch report of devBranch is never offered to cleanup's branch-delete step", async () => {
  const scenario = { ...HAPPY, "implement-tdd": { ...R.implement, worktreeBranch: "main" } };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const cleanup = run.prompts.find((p) => p.label === "cleanup-worktrees");
  assert.ok(cleanup, "cleanup-worktrees never dispatched");
  assert.doesNotMatch(cleanup.prompt, /refs\/heads\/main\b/, "devBranch must never appear as a side branch to delete: " + cleanup.prompt);
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

test("single: I9 — a resumed run's ship prompt carries the resume nonce (so a cached pushed:false is never replayed)", async () => {
  const run = await runWorkflowRecording(SCRIPTS.single, { ...BASE_ARGS, resumeNonce: "n1" }, HAPPY);
  assert.equal(run.error, null, run.error && run.error.stack);
  const ship = run.prompts.find((p) => p.label === "push-and-open-pr");
  assert.ok(ship, "push-and-open-pr never dispatched");
  assert.match(ship.prompt, /resume n1/);
});

test("single: a pending poll is not replayed as a cache collision; it resolves on the next poll", async () => {
  const scenario = { ...HAPPY,
    "poll-ci": (p, o, n) => (n === 0 ? { status: "pending", blocker: "none" } : R.ciGreen),
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  assert.equal(run.prompts.filter((p) => p.label === "poll-ci").length, 2);
  assert.equal(run.result.prUrl, R.ship.prUrl);
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

test("single: a seat that says 'pass' with a blocking finding in its own ledger is treated as a reject (I1)", async () => {
  const scenario = { ...HAPPY,
    "adversarial-reviewer": (p, o, n) => (n === 0
      ? { verdict: "pass", summary: "looks fine", findings: [{ id: "F1", severity: "blocking", category: "correctness", detail: "swallowed exception", location: "src/x.py:9" }] }
      : { ...R.reviewPass, resolved: [{ id: "F1", status: "addressed", note: "fixed" }] }),
    "reimplement-after-review": { ...R.implement, headSha: SHA_B },
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const adv = run.prompts.filter((p) => p.label === "adversarial-reviewer");
  assert.equal(adv.length, 2, "a self-contradicting 'pass' with an open blocking finding must still trigger a re-review");
  const re = run.prompts.find((p) => p.label === "reimplement-after-review");
  assert.ok(re, "reimplement-after-review never dispatched");
  assert.match(re.prompt, /F1/, "critique names the finding id");
  assert.equal(run.result.prUrl, R.ship.prUrl);
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
    "gates": (p, o, n) => (n < 2 ? { ...R.gatesPass, pass: false, unit: "1 failed", failureContext: "test_x failed" } : R.gatesPass),
    "reimplement-after-validate": (p, o, n) => (n === 0 ? R.implement /* same sha as before: nothing committed */ : { ...R.implement, headSha: SHA_B }),
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const re = run.prompts.filter((p) => p.label === "reimplement-after-validate");
  assert.equal(re.length, 2);
  assert.match(re[1].prompt, /produced no new commit/);
});

test("single: a reimplement that produces no new commit on the review path is a standing rejection, not a re-review", async () => {
  const reject = { verdict: "reject", summary: "bad", findings: [{ id: "F1", severity: "blocking", category: "correctness", detail: "no ON CONFLICT", location: "src/x.py:10" }] };
  const scenario = { ...HAPPY,
    // I1: a "pass" verdict must actually close the seat's own open finding
    // (resolved) — the earlier mock left F1 open and relied on the pre-fix
    // bug where a bare verdict:"pass" won regardless of the ledger.
    "adversarial-reviewer": (p, o, n) => (n === 0 ? reject : { ...R.reviewPass, resolved: [{ id: "F1", status: "addressed", note: "fixed" }] }),
    "reimplement-after-review": (p, o, n) => (n === 0 ? R.implement /* same sha as before: nothing committed */ : { ...R.implement, headSha: SHA_B }),
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const reimplIdx = run.labels.reduce((acc, l, i) => (l === "reimplement-after-review" ? acc.concat(i) : acc), []);
  assert.equal(reimplIdx.length, 2, "reimplement-after-review is dispatched twice");
  const advBeforeSecond = run.labels.slice(0, reimplIdx[1]).filter((l) => l === "adversarial-reviewer").length;
  assert.equal(advBeforeSecond, 1, "the panel was dispatched exactly once at SHA_A; it is never re-run on a commit it already rejected");
  const re = run.prompts.filter((p) => p.label === "reimplement-after-review");
  assert.match(re[1].prompt, /standing rejection/);
  assert.match(re[1].prompt, /produced no new commit/);
  const adv = run.prompts.filter((p) => p.label === "adversarial-reviewer");
  assert.equal(adv.length, 2, "the panel runs again once a new commit lands");
  assert.match(adv[1].prompt, /DELTA REVIEW/, "the post-fix round is a delta review");
  assert.equal(run.labels.filter((x) => x === "validate-and-dod").length, 1, "one smoke");
  assert.equal(run.result.prUrl, R.ship.prUrl, "ships");
});

test("single: a deferral a seat rejects becomes a closable finding under its own id", async () => {
  const scenario = { ...HAPPY,
    "implement-tdd": { ...R.implement, minorsDeferred: [{ id: "F9", reason: "out of scope: unrelated module" }] },
    "adversarial-reviewer": (p, o, n) => {
      if (n === 0) return { ...R.reviewPass, deferralVerdicts: [{ id: "F9", accepted: false, note: "not orthogonal" }] };
      if (n === 1) return { ...R.reviewPass, resolved: [{ id: "deferral-F9", status: "addressed", note: "fixed in-scope" }] };
      return R.reviewPass;
    },
    // I1: round 2 (n===2) must actually resolve C1 for the panel to pass —
    // the earlier mock left it open and relied on the pre-fix bug.
    "correctness-reviewer": (p, o, n) => {
      if (n === 1) return { verdict: "reject", summary: "separate issue", findings: [{ id: "C1", severity: "blocking", category: "correctness", detail: "off-by-one", location: "src/y.py:5" }] };
      if (n === 2) return { ...R.reviewPass, resolved: [{ id: "C1", status: "addressed", note: "fixed off-by-one" }] };
      return R.reviewPass;
    },
    "reimplement-after-review": (p, o, n) => ({ ...R.implement, headSha: n === 0 ? SHA_B : SHA_C }),
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const adv = run.prompts.filter((p) => p.label === "adversarial-reviewer");
  assert.equal(adv.length, 3);
  assert.match(adv[1].prompt, /deferral-F9 \[blocking\] no-shed/, "the rejected deferral renders under its own ledger id");
  assert.doesNotMatch(adv[2].prompt, /deferral-F9/, "resolved: [{ id: 'deferral-F9', ... }] closed it");
  assert.equal(run.result.prUrl, R.ship.prUrl);
});

test("single: M2 — a deferral accepted by one seat but rejected by another never reaches acceptedDeferrals, regardless of seat order", async () => {
  const scenario = { ...HAPPY,
    "implement-tdd": { ...R.implement, minorsDeferred: [{ id: "F9", reason: "out of scope: unrelated module" }] },
    "adversarial-reviewer": { ...R.reviewPass, deferralVerdicts: [{ id: "F9", accepted: true, note: "fine by me" }] },
    "correctness-reviewer": (p, o, n) => (n === 0
      ? { ...R.reviewPass, deferralVerdicts: [{ id: "F9", accepted: false, note: "not orthogonal" }] }
      : { ...R.reviewPass, resolved: [{ id: "deferral-F9", status: "addressed", note: "fixed in-scope" }] }),
    "reimplement-after-review": { ...R.implement, headSha: SHA_B },
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const v = run.prompts.find((p) => p.label === "validate-and-dod");
  assert.ok(v, "validate-and-dod never dispatched");
  assert.match(v.prompt, /ACCEPTED DEFERRALS \(list each under ## Follow-ups\): none/, "a seat's rejection vetoes the accept regardless of processing order");
  assert.equal(run.result.prUrl, R.ship.prUrl);
});

test("single: M3 — a defaulted finding id increments past a collision in a gapped ledger", async () => {
  const scenario = { ...HAPPY,
    "adversarial-reviewer": (p, o, n) => (n === 0
      ? { verdict: "reject", summary: "bad", findings: [{ id: "F2", severity: "blocking", category: "correctness", detail: "first issue", location: "src/a.py:1" }] }
      : { verdict: "reject", summary: "still bad", findings: [{ severity: "blocking", category: "correctness", detail: "a fresh, unrelated issue", location: "src/b.py:2" }] }),
    "reimplement-after-review": (p, o, n) => ({ ...R.implement, headSha: n === 0 ? SHA_B : SHA_C }),
    "root-cause-diagnosis": "diagnosed",
    "escalate-to-issue": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.single, BASE_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop", run.error && run.error.stack);
  const re = run.prompts.filter((p) => p.label === "reimplement-after-review");
  assert.ok(re.length >= 2, "expected at least two reimplement rounds");
  // The second round's critique must carry BOTH findings under distinct ids —
  // the old "F" + (size + 1) default would have collided the fresh, unnamed
  // finding onto "F2" and silently overwritten the first one.
  assert.match(re[1].prompt, /F2 \[blocking\].*first issue/);
  assert.match(re[1].prompt, /F3 \[blocking\].*fresh, unrelated issue/);
});

test("cache-collision guard: a genuine repeated (label, prompt) throws unless cacheable", async () => {
  // Neither workflow script repeats a verbatim prompt for the same label on
  // the happy path, so drive the stub directly with a synthetic script body
  // that calls agent() twice with the identical (label, prompt) pair — this
  // is exactly the case the real harness would silently serve from cache.
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-flow-test-"));
  const scriptPath = path.join(dir, "dup-prompt.mjs");
  try {
    await writeFile(
      scriptPath,
      'await agent("do the exact same thing", { label: "dup" });\n' +
        'await agent("do the exact same thing", { label: "dup" });\n'
    );
    const run = await runWorkflowRecording(scriptPath, {}, { dup: { ok: true } });
    assert.ok(run.error, "expected the second identical (label, prompt) call to throw");
    assert.match(run.error.message, /cache collision/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// federated-run.js (Task 10): the re-sequenced core (design -> implement ->
// detach/reconcile/pin -> gates -> review -> validate) ported per-feature,
// with labels prefixed "feat:<id>:" so concurrent features never collide.
// ---------------------------------------------------------------------------

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
  assertSequence(f.slice(0, 9), [T + "design-review", T + "implement", T + "detach-worktrees", T + "reconcile-branch", T + "pin-run-worktree", T + "gates", [T + "adversarial-reviewer", T + "correctness-reviewer"], T + "validate-and-dod"]);
});

test("federated: M7 — an ambiguity-blocked first implement pauses that feature before reconcile ever runs", async () => {
  const scenario = { ...FED_HAPPY,
    [T + "implement"]: { ...R.implement, headSha: SHA_B, blocker: "ambiguity", blockerDetail: "cannot derive acceptance criteria" },
    "pause-feature-for-human:f1": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.federated, FED_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  assert.ok(!run.labels.includes(T + "reconcile-branch"), "reconcile must never run for a blocked first implement");
  assert.ok(run.labels.includes("pause-feature-for-human:f1"));
  assert.equal(run.result.shipped, false);
  assert.equal(run.result.escalated[0].feature, "f1");
});

test("federated: a feature whose reconcile fails is excluded and the batch continues", async () => {
  const args2 = { devBranch: "main", features: [
    { id: "f1", title: "dark mode", issue: "owner/repo#1", plan: "do it" },
    { id: "f2", title: "light mode", issue: "owner/repo#2", plan: "do it" },
  ] };
  const T1 = "feat:f1:", T2 = "feat:f2:";
  const scenario = { ...HAPPY,
    [T1 + "design-review"]: R.design, [T1 + "detach-worktrees"]: R.detach, [T1 + "implement"]: R.implement, [T1 + "reconcile-branch"]: reconcileEcho,
    [T1 + "pin-run-worktree"]: pinEcho, [T1 + "gates"]: R.gatesPass, [T1 + "adversarial-reviewer"]: R.reviewPass, [T1 + "correctness-reviewer"]: R.reviewPass,
    [T1 + "validate-and-dod"]: R.dodPass, [T1 + "cleanup-worktrees"]: R.cleanup,
    [T2 + "design-review"]: R.design, [T2 + "detach-worktrees"]: R.detach,
    [T2 + "implement"]: { ...R.implement, branch: "feat/light-mode" },
    [T2 + "reconcile-branch"]: { ok: false, sha: SHA_B, detail: "feat/light-mode is not an ancestor of " + SHA_B },
    [T2 + "cleanup-worktrees"]: R.cleanup,
    "root-cause:*": "root cause diagnosed",
    "escalate:*": "posted",
    "pause-feature-for-human:*": "posted",
    "integrate": { merged: ["f1"], blocker: "none" },
  };
  const run = await runWorkflowRecording(SCRIPTS.federated, args2, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const cleanupF2 = run.prompts.find((p) => p.label === T2 + "cleanup-worktrees");
  assert.ok(cleanupF2, "feat:f2:cleanup-worktrees never dispatched: " + run.labels.join(", "));
  assert.match(cleanupF2.prompt, /feature escalation/);
  // A reconcile failure is a CODE failure (the branch does not descend from
  // the commit), not an external blocker — it must escalate, never pause.
  assert.ok(run.labels.includes("escalate:feat:f2"), "expected escalate:feat:f2 for f2: " + run.labels.join(", "));
  assert.ok(!run.labels.includes("pause-feature-for-human:f2"), "a code failure must escalate, not pause: " + run.labels.join(", "));
  assert.ok(!run.labels.includes("escalate:feat:f1"), "f1 must not be escalated");
  assert.ok(!run.labels.includes("pause-feature-for-human:f1"), "f1 must not be paused");
  assert.ok(run.labels.includes(T1 + "validate-and-dod"), "f1 should reach validate-and-dod: " + run.labels.join(", "));
  assert.ok(run.labels.includes("integrate"), "the batch should still integrate f1: " + run.labels.join(", "));
  const integratePrompt = run.prompts.find((p) => p.label === "integrate");
  assert.ok(integratePrompt, "integrate never dispatched: " + run.labels.join(", "));
  assert.doesNotMatch(integratePrompt.prompt, /light mode/, "only reviewed-green features may reach the integrate manifest — f2 never got there");
});

test("federated: a dead batch cleanup agent does not recurse forever — the nested pause wins, no second terminal (M6)", async () => {
  // Drive batch CI to red K=3 times so the last attempt calls batchCtx.fail
  // ("code") -> batchEscalate -> cleanupBatchWorktrees. The FIRST
  // cleanup-worktrees call (after the fan-out barrier) succeeds; only the
  // SECOND (inside batchEscalate) returns null. Without the ctx.cleaningUp
  // guard on cleanupBatchWorktrees, that null result's mechanical()->ctx.fail
  // ->pauseForHuman chain calls cleanupBatchWorktrees AGAIN before ever
  // throwing — recursing forever, since pauseForHuman calls it as its own
  // first statement, inside the still-open try. The guard must short-circuit
  // that nested call so exactly ONE more "cleanup-worktrees" prompt is never
  // dispatched for it. The nested pauseForHuman's EscalationStop then
  // propagates through batchEscalate's own cleanup call; per M6,
  // batchEscalate rethrows it instead of swallowing it and posting a SECOND
  // terminal — its own root-cause diagnosis and escalate:batch comment never run.
  const scenario = { ...FED_HAPPY,
    "poll-ci": { status: "red", blocker: "code", failingJobs: ["unit"], logsExcerpt: "boom" },
    "fix-ci-and-repush": { ...R.implement, headSha: SHA_B },
    "reconcile-branch": reconcileEcho,
    "cleanup-worktrees": (p, o, n) => (n === 0 ? R.cleanup : null),
    "root-cause:batch": "diagnosed",
    "escalate:batch": "posted",
    "pause-for-human": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.federated, FED_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop", run.error && run.error.stack);
  const cleanupCalls = run.prompts.filter((p) => p.label === "cleanup-worktrees");
  assert.equal(cleanupCalls.length, 2, "the guard must prevent a third (recursive) dispatch: " + cleanupCalls.length + " actual dispatches");
  assert.equal(run.labels.filter((l) => l === "pause-for-human").length, 1, "exactly one pause, not a cascade");
  assert.ok(!run.labels.includes("escalate:batch"), "batchEscalate must not post a second terminal after the nested pause already did");
  assert.ok(!run.labels.includes("root-cause:batch"), "no root-cause diagnosis runs for an external usage-limit pause");
});

test("federated: an unexpected throw from a feature's own dispatch still escalates and cleans up (fix round 1, MINOR 4)", async () => {
  // requireAgentResult throws a plain Error (not FeatureStop) when the design
  // agent dies — processFeature's own try/catch rethrows anything that is not
  // a FeatureStop, so this exercises the fan-out wrapper's OWN catch, not
  // ctx.fail. Before the fix, that catch only logged locally and never
  // touched the issue or the feature's worktrees, contradicting "never
  // silently drop work; always escalate".
  const args2 = { devBranch: "main", features: [{ id: "f1", title: "dark mode", issue: "owner/repo#1", plan: "do it" }] };
  const scenario = { ...HAPPY, "feat:f1:design-review": null, "root-cause:*": "diagnosed", "escalate:*": "posted" };
  const run = await runWorkflowRecording(SCRIPTS.federated, args2, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  assert.ok(run.labels.includes("escalate:feat:f1"), "the errored feature must still be escalated: " + run.labels.join(", "));
  assert.equal(run.result.shipped, false, "nothing reviewed-green — nothing to integrate or ship");
  assert.equal(run.result.escalated.length, 1);
  assert.equal(run.result.escalated[0].feature, "f1");
});

test("federated: M12 — postEscalation's root-cause agent runs on opus, matching the single script", async () => {
  const args2 = { devBranch: "main", features: [{ id: "f1", title: "dark mode", issue: "owner/repo#1", plan: "do it" }] };
  const scenario = { ...HAPPY, "feat:f1:design-review": null, "root-cause:*": "diagnosed", "escalate:*": "posted" };
  const run = await runWorkflowRecording(SCRIPTS.federated, args2, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const rc = run.prompts.find((p) => p.label === "root-cause:feat:f1");
  assert.ok(rc, "root-cause:feat:f1 never dispatched");
  assert.equal(rc.opts.model, "opus");
});

test("federated: M4 — a stray worktreeBranch report of devBranch is never offered to cleanupBatchWorktrees's branch-delete step", async () => {
  const scenario = { ...FED_HAPPY,
    "poll-ci": (p, o, n) => (n === 0 ? { status: "red", blocker: "code", failingJobs: ["unit"], logsExcerpt: "boom" } : R.ciGreen),
    "fix-ci-and-repush": { ...R.implement, headSha: SHA_B, worktreeBranch: "main" },
    "reconcile-branch": reconcileEcho,
  };
  const run = await runWorkflowRecording(SCRIPTS.federated, FED_ARGS, scenario);
  assert.equal(run.error, null, run.error && run.error.stack);
  const cleanupCalls = run.prompts.filter((p) => p.label === "cleanup-worktrees");
  assert.ok(cleanupCalls.length > 0, "cleanup-worktrees never dispatched");
  for (const c of cleanupCalls) {
    assert.doesNotMatch(c.prompt, /git branch -d/, "a devBranch-only worktreeBranch report must never produce a branch-delete step: " + c.prompt);
  }
});

test("federated: a batch-level pause falls back to the PR URL, then a plain note, when args.issue is absent (I6)", async () => {
  const scenario = { ...FED_HAPPY,
    "push-and-open-pr": { pushed: false, blocker: "infra", blockerDetail: "GitHub unreachable" },
    "pause-for-human": "posted",
  };
  const run = await runWorkflowRecording(SCRIPTS.federated, FED_ARGS, scenario);
  assert.equal(run.error && run.error.name, "EscalationStop", run.error && run.error.stack);
  const pause = run.prompts.find((p) => p.label === "pause-for-human");
  assert.ok(pause, "pause-for-human never dispatched");
  assert.match(pause.prompt, /no batch issue given/, "falls back to the plain note when both issue and prUrl are absent");
  assert.doesNotMatch(pause.prompt, /Issue: main\b/, "the dev branch name must never be posted as the issue");
});
