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
  "detach-worktrees", "implement-tdd", "reconcile-branch", "pin-run-worktree",
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
