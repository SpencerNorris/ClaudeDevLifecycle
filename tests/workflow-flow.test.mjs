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
