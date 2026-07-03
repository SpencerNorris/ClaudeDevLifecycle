/*
 * workflow-args.test.mjs — args-boundary tests for the workflow scripts.
 *
 * The Workflow harness evaluates a script's body as an async function with
 * globals (args, agent, parallel, ...) injected. These tests replicate that
 * contract with stubs and pin down the harness-boundary behavior of the Gate A
 * input checks (#76):
 *
 *   - `args` may arrive as undefined, null, or a JSON STRING. Missing inputs
 *     must fail with the helpful "requires args.X" error — never a raw
 *     TypeError from dereferencing undefined.
 *   - Every stubbed agent/parallel/pipeline call throws, so a test that
 *     reaches one proves validation let bad args through.
 *
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = {
  single: "claude-home/workflows/single-feature-run.js",
  federated: "claude-home/workflows/federated-run.js",
};

/** Evaluate a workflow script the way the harness does: body as an async
 * function, harness globals stubbed. Every orchestration stub throws so the
 * script cannot get past its Gate A input checks unnoticed. */
async function runWorkflow(scriptPath, args) {
  const source = await readFile(new URL(scriptPath, `file://${repoRoot}`), "utf8");
  // The harness accepts the `export const meta` module form; a plain async
  // function body does not. Strip the one export keyword.
  const body = source.replace(/^export const meta/m, "const meta");
  const stubs = {
    agent: async () => {
      throw new Error("agent() reached — args validation did not throw");
    },
    parallel: async () => {
      throw new Error("parallel() reached — args validation did not throw");
    },
    pipeline: async () => {
      throw new Error("pipeline() reached — args validation did not throw");
    },
    workflow: async () => {
      throw new Error("workflow() reached — args validation did not throw");
    },
    phase: () => {},
    log: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };
  const fn = new AsyncFunction("args", ...Object.keys(stubs), body);
  return fn(args, ...Object.values(stubs));
}

/** Assert the script rejects with the helpful Gate A error — not a raw
 * TypeError from reading a field off undefined args. */
async function assertHelpfulError(scriptPath, args, messagePattern) {
  await assert.rejects(runWorkflow(scriptPath, args), (err) => {
    assert.ok(
      !(err instanceof TypeError),
      `raw TypeError leaked through args validation: ${err.message}`
    );
    assert.match(err.message, messagePattern);
    return true;
  });
}

for (const args of [undefined, null, {}]) {
  const shown = args === undefined ? "undefined" : JSON.stringify(args);

  test(`single-feature-run: args=${shown} -> helpful featureDescription error`, async () => {
    await assertHelpfulError(SCRIPTS.single, args, /requires args\.featureDescription/);
  });

  test(`federated-run: args=${shown} -> helpful features error`, async () => {
    await assertHelpfulError(SCRIPTS.federated, args, /requires args\.features/);
  });
}

test("single-feature-run: JSON-string args are parsed (fails on the NEXT missing field)", async () => {
  // featureDescription present in the string proves normalization ran; the
  // devBranch error proves the check sequence advanced past it.
  await assertHelpfulError(
    SCRIPTS.single,
    JSON.stringify({ featureDescription: "add dark mode" }),
    /requires args\.devBranch/
  );
});

test("federated-run: JSON-string args are parsed (fails on the NEXT missing field)", async () => {
  await assertHelpfulError(
    SCRIPTS.federated,
    JSON.stringify({ features: [{ id: "f1", title: "t", issue: "#1" }] }),
    /requires args\.devBranch/
  );
});

test('single-feature-run: JSON-string "null" normalizes like null args', async () => {
  await assertHelpfulError(SCRIPTS.single, "null", /requires args\.featureDescription/);
});

for (const [name, scriptPath] of Object.entries(SCRIPTS)) {
  test(`${name}: claude-home and claude-repo copies are byte-identical`, async () => {
    const base = scriptPath.split("/").pop();
    const home = await readFile(new URL(scriptPath, `file://${repoRoot}`), "utf8");
    const repo = await readFile(
      new URL(`claude-repo/.claude/workflows/${base}`, `file://${repoRoot}`),
      "utf8"
    );
    assert.equal(repo, home, `${base} drifted between claude-home/ and claude-repo/`);
  });
}
