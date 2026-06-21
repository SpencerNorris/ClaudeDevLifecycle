/*
 * federated-run.js — the autonomous federated multi-feature run (D4).
 *
 * WHAT THIS IS
 *   ONE Claude workflow (master-design-doc.md §7, diagram D4). Given a feature list and
 *   a target dev branch, it fans out one worktree-isolated agent PER feature that
 *   runs the D2 CORE (TDD implement -> validate -> DoD report), gates EACH feature
 *   with the adversarial-reviewer AGENT before it merges onto dev, integrates the
 *   reviewed-green features onto the dev branch, then pushes dev and opens ONE
 *   dev->main PR carrying ALL the DoD reports, and drives CI green.
 *
 *   Per §7 reading notes: D4 NESTS D3 (one "Work" iteration) and contains N CORES
 *   of D2 (implement -> validate -> DoD -> review) run CONCURRENTLY — not N full
 *   D2s. The push / PR / CI / Gate-B tail runs ONCE for the whole batch.
 *
 * THE CIRCUIT BREAKER (master-design-doc.md §9, spec §7) — load-bearing, non-bypassable.
 *   Every retry loop is COUNTER-controlled with a hard cap K = 3. The counter is
 *   workflow code, not agent discretion. On exhaustion we diagnose the root cause
 *   and post a structured escalation to the relevant GitHub issue + a needs-human
 *   label; we never loop again and never shim.
 *
 *   Federated nuance: a SINGLE feature exhausting its cap escalates THAT feature
 *   (posts to its issue, leaves its branch in place) and is EXCLUDED from the
 *   batch — the other features still ship. Only a BATCH-level failure (CI on the
 *   one dev->main PR) is terminal for the whole run (throws EscalationStop).
 *
 * DSL NOTE
 *   This uses the real Workflow DSL, the SAME one single-feature-run.js uses:
 *   agent(promptString, optsObject); parallel(arrayOfThunks) [barrier];
 *   pipeline(items, ...stageFns); phase(titleString) [side-effecting]; log(msg).
 *   The script BODY runs at module top level (there is no run() wrapper). No
 *   Date.now / Math.random / argless new Date(). meta is a pure literal.
 *
 *   We use parallel() (a barrier) for the fan-out — NOT pipeline() — because the
 *   Integrate phase legitimately needs ALL reviewed-green features at once: merges
 *   onto a single shared dev branch are inherently serial and the one batch PR
 *   must carry the full set. Each feature still calls phase via the agent opts
 *   (opts.phase), never the global phase(), to avoid racing the shared phase state
 *   inside parallel().
 */

export const meta = {
  name: "federated-run",
  description:
    "Autonomous federated multi-feature run (D4): fan out one worktree-isolated agent per feature (TDD -> validate -> DoD), gate each with the adversarial-reviewer agent before it merges onto dev, integrate, then push dev and open ONE dev->main PR with all DoD reports and drive CI green. Every retry loop capped at K=3; per-feature exhaustion escalates that feature, batch CI exhaustion is terminal.",
  phases: [
    { title: "Fan-out", detail: "One worktree-isolated agent per feature runs the D2 core: TDD implement -> validate -> DoD report. Runs concurrently." },
    { title: "Review", detail: "Gate each feature with the adversarial-reviewer agent before it merges onto dev. Reject retries that feature, capped K=3; exhaustion escalates that feature." },
    { title: "Integrate", detail: "Merge each reviewed-green feature onto the shared dev branch (serial, conflict-faithful)." },
    { title: "Ship", detail: "Push dev and open ONE dev->main PR aggregating all DoD reports." },
    { title: "CI", detail: "Drive the batch PR's CI green; on red, fix + re-push, capped K=3; exhaustion is terminal for the batch." },
  ],
};

// ---------------------------------------------------------------------------
// Constants. K is the hard retry cap (master-design-doc.md §9 / spec §7); it bounds
// EVERY loop here. NEEDS_HUMAN_LABEL is the escalation label.
// ---------------------------------------------------------------------------
const K = 3;
const NEEDS_HUMAN_LABEL = "needs-human";

// ---------------------------------------------------------------------------
// JSON Schemas (plain JS objects) forcing structured agent returns, so control
// flow branches on data rather than on free text an agent could fudge. These
// mirror single-feature-run.js (one shared contract across both workflows).
// ---------------------------------------------------------------------------

// The adversarial-reviewer's verdict (master-design-doc.md §8, spec §5).
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "summary"],
  properties: {
    verdict: { type: "string", enum: ["pass", "reject"] },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "severity", "detail"],
        properties: {
          category: {
            type: "string",
            enum: [
              "weakened-test",
              "skipped-test",
              "swallowed-exception",
              "hardcoded-return",
              "cast-to-none",
              "narrowed-assertion",
              "unaddressed-root-cause",
              "missing-edge-case",
              "dishonest-dod",
              "other",
            ],
          },
          severity: { type: "string", enum: ["blocking", "minor"] },
          detail: { type: "string", minLength: 1 },
          location: { type: "string" },
        },
      },
    },
    verdictSection: { type: "string" },
  },
};

// The DoD report payload (reference/definition-of-done.md report contract).
const DOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gatesPass", "report", "tests", "smokeAllPass"],
  properties: {
    gatesPass: { type: "boolean" },
    smokeAllPass: { type: "boolean" },
    tests: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "integration", "regression", "lint", "typecheck"],
      properties: {
        unit: { type: "string" },
        integration: { type: "string" },
        regression: { type: "string" },
        lint: { type: "string" },
        typecheck: { type: "string" },
      },
    },
    failureContext: { type: "string" },
    report: { type: "string" },
  },
};

// The implementer's structured result.
const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["branch", "summary"],
  properties: {
    branch: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    filesTouched: { type: "array", items: { type: "string" } },
  },
};

// The ship result: the one batch PR.
const SHIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prUrl", "pushed"],
  properties: {
    prUrl: { type: "string", minLength: 1 },
    pushed: { type: "boolean" },
  },
};

// One CI poll result.
const CI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["green", "red", "pending"] },
    failingJobs: { type: "array", items: { type: "string" } },
    logsExcerpt: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// EscalationStop — the terminal for a BATCH-level failure (CI on the one PR).
// Thrown after the escalation is posted; not caught anywhere, so it ends the
// workflow. Per-feature escalation does NOT throw (see postEscalation).
// ---------------------------------------------------------------------------
class EscalationStop extends Error {
  constructor(stage, attempts, rootCause) {
    super(
      "Circuit breaker tripped (terminal) at batch stage '" +
        stage +
        "' after " +
        attempts +
        " attempts (cap K=" +
        K +
        "). Escalated; workflow stopped. Root cause: " +
        rootCause
    );
    this.name = "EscalationStop";
    this.stage = stage;
    this.attempts = attempts;
    this.rootCause = rootCause;
  }
}

/**
 * postEscalation — the circuit breaker's terminal ACTION (master-design-doc.md §9,
 * spec §7). Runs a root-cause diagnosis, then posts a structured comment to the
 * relevant GitHub issue and adds the needs-human label. It does NOT throw — the
 * caller decides whether the failure is per-feature (continue the batch) or
 * batch-level (throw EscalationStop). Returns the diagnosis text.
 *
 * `ctx` carries { issue, branch, prUrl, failureContext } so the comment is
 * accurate. `label` is a short tag for the agent calls.
 */
async function postEscalation(stage, attempts, ctx, label) {
  log(
    "CIRCUIT BREAKER: '" +
      stage +
      "' exhausted " +
      attempts +
      "/" +
      K +
      " attempts (" +
      label +
      "). Diagnosing root cause, then escalating to the GitHub issue."
  );

  const diagnosis = await agent(
    "A capped retry loop in the autonomous federated run has been exhausted. " +
      "Do a root-cause diagnosis (master-design-doc.md §9 / spec §7): why did '" +
      stage +
      "' fail after " +
      attempts +
      " attempts? Do NOT propose a shim or a way to merely pass. Identify the " +
      "underlying cause as precisely as the evidence allows.\n\n" +
      "Issue: " +
      ctx.issue +
      "\nBranch: " +
      ctx.branch +
      "\nPR: " +
      (ctx.prUrl || "not yet opened") +
      "\nFailure context:\n" +
      ctx.failureContext,
    { label: "root-cause:" + label, phase: stage, effort: "high" }
  );

  await agent(
    "Escalate this exhausted autonomous run to the human (master-design-doc.md §9 / spec §7). " +
      "Using the GitHub MCP server, post a structured comment to the relevant issue and add the '" +
      NEEDS_HUMAN_LABEL +
      "' label. Do NOT push, merge, or modify code. Leave the branch and PR in place.\n\n" +
      "Issue: " +
      ctx.issue +
      "\n\nThe comment MUST contain, as clearly labeled sections:\n" +
      "- Stage that failed: " +
      stage +
      "\n- Attempts made: " +
      attempts +
      " of " +
      K +
      " (cap exhausted)\n- What failed (failure context below)\n" +
      "- Root-cause diagnosis (below)\n" +
      "- Branch / PR state: branch '" +
      ctx.branch +
      "', PR " +
      (ctx.prUrl || "not opened") +
      "\n- Next step: a human investigates, then re-authorizes via a new Gate A.\n\n" +
      "Failure context:\n" +
      ctx.failureContext +
      "\n\nRoot-cause diagnosis:\n" +
      diagnosis,
    { label: "escalate:" + label, phase: stage }
  );

  log("Escalation posted and '" + NEEDS_HUMAN_LABEL + "' label added for " + label + ".");
  return diagnosis;
}

/**
 * processFeature — the D2 CORE plus the mandatory adversarial-review gate for ONE
 * feature, run inside its own worktree. Counter-controlled implement/validate/
 * review loop, capped at K. On cap exhaustion it escalates THAT feature (posts to
 * its issue, non-throwing) and returns an `escalated` marker so the batch can ship
 * the other features. On success it returns the reviewed-green DoD report.
 *
 * All agent() calls pass opts.phase explicitly (never the global phase()) so that
 * concurrent features do not race the shared phase state inside parallel().
 *
 * Returns: { feature, branch, escalated: boolean, dodReport?: string, reason?: string }
 */
async function processFeature(feature, devBranch) {
  const tag = "feat:" + feature.id;
  const ctx = { issue: feature.issue, branch: null, prUrl: null, failureContext: "" };

  // First TDD pass in a worktree-isolated agent.
  let impl = await agent(
    "AUTONOMOUS federated run, FAN-OUT/IMPLEMENT for feature '" +
      feature.title +
      "' (" +
      feature.id +
      ").\n" +
      "Create a NON-MAIN worktree branch off '" +
      devBranch +
      "' named per branch-lifecycle conventions (feat/fix/chore/...). NEVER touch main. " +
      "Do TDD: write a FAILING test pinning the behavior, implement to green, refactor. " +
      "Fix in-scope bugs here (no-shed); file only genuinely orthogonal bugs as cross-linked GH issues. " +
      "Do NOT push, do NOT open a PR, do NOT merge — integration is a later batch phase.\n\n" +
      "Linked issue: " +
      feature.issue +
      "\n\nReturn the branch you created and a summary.",
    { label: tag + ":implement", phase: "Fan-out", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
  );
  ctx.branch = impl.branch;

  let reviewed = false;
  let dodReport = null;

  for (let attempt = 1; attempt <= K && !reviewed; attempt++) {
    // ---- VALIDATE + DoD report --------------------------------------------
    const dod = await agent(
      "AUTONOMOUS federated run, VALIDATE for feature '" +
        feature.title +
        "' on branch '" +
        ctx.branch +
        "' (reference/definition-of-done.md).\n" +
        "Run unit + integration + regression + lint + type-check, THEN smoke-test the running system: " +
        "the happy path, EVERY named edge case (or derive + list them if none are stated), and the most " +
        "plausible failure modes. Produce a DoD report with the exact structure from " +
        "reference/definition-of-done.md including the real transcript. " +
        "gatesPass is true ONLY if every gate AND every smoke case actually passed.\n\n" +
        "Feature: " +
        feature.title +
        "\nLinked issue: " +
        feature.issue,
      { label: tag + ":validate", phase: "Fan-out", schema: DOD_SCHEMA }
    );

    if (!dod.gatesPass || !dod.smokeAllPass) {
      ctx.failureContext =
        "Validation/DoD failed on attempt " +
        attempt +
        ". " +
        (dod.failureContext || "Gates or smoke cases did not pass.");
      log(tag + ": validation failed on attempt " + attempt + ".");

      if (attempt === K) {
        await postEscalation("Fan-out", attempt, ctx, tag);
        return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
      }

      impl = await agent(
        "AUTONOMOUS federated run, back to IMPLEMENT for feature '" +
          feature.title +
          "' after a VALIDATE failure. Fix the ROOT CAUSE — do NOT weaken tests, skip cases, or shim. Keep TDD discipline.\n\n" +
          "Branch: " +
          ctx.branch +
          "\nWhat failed:\n" +
          ctx.failureContext,
        { label: tag + ":reimplement", phase: "Fan-out", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
      );
      ctx.branch = impl.branch;
      continue; // counter-controlled
    }

    // ---- ADVERSARIAL REVIEW (mandatory skeptic, per feature) --------------
    const verdict = await agent(
      "AUTONOMOUS federated run, REVIEW for feature '" +
        feature.title +
        "' (master-design-doc.md §8, spec §5). You are the adversarial reviewer. Refute-first: try to PROVE this " +
        "feature is not actually done. Hunt for skipped/weakened tests, try/except pass, hardcoded returns, " +
        "cast-to-None, narrowed assertions, unaddressed root cause, missing named edge cases, and dishonest DoD claims.\n\n" +
        "DERIVE GROUND TRUTH YOURSELF — do not trust the report's self-stated results:\n" +
        "  1. Reconstruct the real diff with `git diff " +
        devBranch +
        "...HEAD` on branch '" +
        ctx.branch +
        "'; review the REAL diff, not any self-reported file list.\n" +
        "  2. Re-run the suite (unit/integration/regression/lint/type-check) and the smoke steps yourself, and " +
        "COMPARE your observed output to the CLAIMED results below. Any mismatch is a `dishonest-dod` blocking finding.\n\n" +
        "Return verdict 'pass' only if you INDEPENDENTLY reproduced green AND found no blocking finding; " +
        "otherwise 'reject' with specific findings. On pass, return a verdictSection (markdown, stating WHAT you re-ran) to append to the DoD report.\n\n" +
        "Branch under review: " +
        ctx.branch +
        "  (base: " +
        devBranch +
        ")\nCLAIMED test output (the report's self-stated results — verify, do not trust):\n" +
        "  unit: " +
        dod.tests.unit +
        "\n  integration: " +
        dod.tests.integration +
        "\n  regression: " +
        dod.tests.regression +
        "\n  lint: " +
        dod.tests.lint +
        "\n  typecheck: " +
        dod.tests.typecheck +
        "\n\nCLAIMED DoD report:\n" +
        dod.report,
      { label: tag + ":review", phase: "Review", agentType: "adversarial-reviewer", schema: VERDICT_SCHEMA }
    );

    if (verdict.verdict === "reject") {
      const critique =
        verdict.summary +
        "\n" +
        verdict.findings
          .map(function (f) {
            return (
              "- [" + f.severity + "] " + f.category + (f.location ? " @ " + f.location : "") + ": " + f.detail
            );
          })
          .join("\n");
      ctx.failureContext = "Adversarial reviewer rejected on attempt " + attempt + ":\n" + critique;
      log(tag + ": reviewer REJECTED on attempt " + attempt + ".");

      if (attempt === K) {
        await postEscalation("Review", attempt, ctx, tag);
        return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
      }

      impl = await agent(
        "AUTONOMOUS federated run, back to IMPLEMENT for feature '" +
          feature.title +
          "' after an ADVERSARIAL-REVIEW reject. Address every blocking finding by fixing the ROOT CAUSE. " +
          "Do NOT weaken tests or shim to satisfy the reviewer.\n\n" +
          "Branch: " +
          ctx.branch +
          "\nReviewer critique:\n" +
          critique,
        { label: tag + ":reimplement", phase: "Fan-out", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
      );
      ctx.branch = impl.branch;
      continue; // counter-controlled
    }

    // PASS — persist the verdict into the DoD report (spec §5).
    const verdictSection =
      verdict.verdictSection ||
      "## Reviewer Verdict\n\nPASS — adversarial-reviewer.\n\n" + verdict.summary;
    dodReport = dod.report + "\n\n" + verdictSection;
    reviewed = true;
    log(tag + ": reviewer PASSED on attempt " + attempt + ". Reviewed-green.");
  }

  if (!reviewed || !dodReport) {
    // Unreachable: the loop either reviews-green or escalates-and-returns above.
    throw new Error("Internal invariant violated: feature '" + feature.id + "' ended without review or escalation.");
  }
  return { feature, branch: ctx.branch, escalated: false, dodReport: dodReport };
}

// ===========================================================================
// MAIN FLOW (module top level — no run() wrapper; the DSL executes the body).
// ===========================================================================

const features = args && args.features;
const devBranch = args && (args.devBranch || args.branch);

if (!features || !Array.isArray(features) || features.length === 0) {
  throw new Error("federated-run requires args.features (a non-empty array of { id, title, issue }).");
}
if (!devBranch) {
  throw new Error("federated-run requires args.devBranch (the target non-main dev branch all features integrate onto).");
}
for (const f of features) {
  if (!f || !f.id || !f.title || !f.issue) {
    throw new Error("Each feature needs { id, title, issue } (issue = the GitHub issue for escalation, per §4/§9).");
  }
}

log(
  "D4 federated run: " +
    features.length +
    " feature(s) -> " +
    devBranch +
    "; cap K=" +
    K +
    " on every retry loop."
);

// ---- PHASES 1+2: Fan-out + per-feature Review (concurrent, barrier) --------
// parallel() is the barrier: Integrate needs ALL reviewed-green features at once
// (serial merges onto one shared dev branch; one batch PR). processFeature does
// not throw for EXPECTED per-feature failures — it returns an `escalated` marker.
// But an UNEXPECTED throw (e.g. an agent() call rejecting on a terminal API error)
// would become a null and be silently dropped by .filter(Boolean) — the feature
// would vanish from the batch with no record, violating "never silently drop work;
// always escalate". So we wrap each thunk: any uncaught throw becomes an explicit
// escalated+errored outcome, so the feature is still surfaced to the human.
const outcomes = (
  await parallel(
    features.map((feature) => async () => {
      try {
        return await processFeature(feature, devBranch);
      } catch (err) {
        const reason =
          "processFeature threw (uncaught — a terminal error, not a normal " +
          "per-feature escalation): " +
          (err && err.message ? err.message : String(err));
        log("FEATURE ERRORED (uncaught throw): " + feature.id + " — " + reason);
        return { feature, branch: null, escalated: true, errored: true, reason: reason };
      }
    })
  )
).filter(Boolean);

const green = outcomes.filter((o) => o && !o.escalated);
const escalated = outcomes.filter((o) => o && o.escalated);

log(
  "Fan-out complete: " +
    green.length +
    " reviewed-green, " +
    escalated.length +
    " escalated (left for a human on their own branch + issue)."
);

if (green.length === 0) {
  // Nothing passed review — there is nothing to ship. Every feature has already
  // been escalated to its issue; stop here rather than open an empty PR.
  log("No feature reached reviewed-green; all were escalated. Stopping — nothing to integrate or ship.");
  return {
    prUrl: null,
    shipped: false,
    escalated: escalated.map((o) => ({ feature: o.feature.id, branch: o.branch, reason: o.reason })),
  };
}

// ---- PHASE 3: Integrate (serial merges onto dev) ---------------------------
phase("Integrate");
const integrationManifest = green
  .map((o) => "- " + o.feature.id + " (" + o.feature.title + ") on branch " + o.branch)
  .join("\n");

await agent(
  "AUTONOMOUS federated run, INTEGRATE phase (master-design-doc.md §7). Merge each reviewed-green feature branch " +
    "onto the shared dev branch '" +
    devBranch +
    "', one merge per feature, in order. Resolve any merge conflicts FAITHFULLY — never by discarding a " +
    "feature's work. Only these reviewed-green features may be merged (a shimmed feature must never reach the " +
    "shared branch):\n" +
    integrationManifest +
    "\n\nDo NOT touch main. Do NOT open a PR yet (that is the Ship phase).",
  { label: "integrate", phase: "Integrate" }
);

// ---- PHASE 4: Ship — ONCE for the whole batch ------------------------------
phase("Ship");
const combinedReports = green
  .map((o) => "### Feature: " + o.feature.title + " (" + o.feature.id + ")\n\n" + o.dodReport)
  .join("\n\n---\n\n");

const ship = await agent(
  "AUTONOMOUS federated run, SHIP phase (master-design-doc.md §7). Push the NON-MAIN dev branch '" +
    devBranch +
    "' (never push main — the pre-push hook + settings forbid it) and open exactly ONE dev->main pull request " +
    "via the GitHub MCP server. The PR body MUST aggregate ALL the reviewed-green features' DoD reports (each " +
    "with its appended Reviewer Verdict). Return the PR URL.\n\nAggregated DoD reports (PR body):\n" +
    combinedReports,
  { label: "push-and-open-pr", phase: "Ship", schema: SHIP_SCHEMA }
);

const batchCtx = { issue: devBranch, branch: devBranch, prUrl: ship.prUrl, failureContext: "" };
log("dev pushed and ONE dev->main PR opened for the batch: " + ship.prUrl);

// ---- PHASE 5: CI — batch loop, capped K (terminal on exhaustion) -----------
phase("CI");
let ciGreen = false;

for (let fixAttempt = 1; fixAttempt <= K && !ciGreen; fixAttempt++) {
  log("Batch CI fix window " + fixAttempt + " of " + K + ". Polling GitHub Actions.");

  const pollBudget = 30;
  let ci = null;
  let terminal = false;
  for (let poll = 1; poll <= pollBudget && !terminal; poll++) {
    ci = await agent(
      "AUTONOMOUS federated run, CI phase. Check the GitHub Actions status for the dev->main PR " +
        ship.prUrl +
        " (dev branch '" +
        devBranch +
        "') via the GitHub MCP server. Return 'green' if all required checks passed, 'red' if a required check " +
        "failed (include failing job names + a short log excerpt), 'pending' if still running.",
      { label: "poll-ci", phase: "CI", schema: CI_SCHEMA }
    );
    if (ci.status === "green" || ci.status === "red") {
      terminal = true;
    } else {
      log("Batch CI still pending (poll " + poll + "/" + pollBudget + ").");
    }
  }

  if (!ci || !terminal) {
    batchCtx.failureContext = "Batch CI did not reach a terminal state within the poll budget on fix attempt " + fixAttempt + ".";
    const rc = await postEscalation("CI", fixAttempt, batchCtx, "batch-ci");
    throw new EscalationStop("CI", fixAttempt, rc);
  }

  if (ci.status === "green") {
    ciGreen = true;
    log("Batch CI is GREEN. dev->main PR ready for Gate B (human merge): " + ship.prUrl);
    break;
  }

  // RED.
  batchCtx.failureContext =
    "Batch CI red on fix attempt " +
    fixAttempt +
    ". Failing jobs: " +
    (ci.failingJobs || []).join(", ") +
    "\nLogs excerpt:\n" +
    (ci.logsExcerpt || "(none provided)");
  log("Batch CI is RED on fix attempt " + fixAttempt + ".");

  if (fixAttempt === K) {
    const rc = await postEscalation("CI", fixAttempt, batchCtx, "batch-ci");
    throw new EscalationStop("CI", fixAttempt, rc);
  }

  await agent(
    "AUTONOMOUS federated run, CI-RED fix (reference/definition-of-done.md CI-red delta). On the dev branch '" +
      devBranch +
      "', read the failing CI logs via the GitHub MCP, fix the ROOT CAUSE (no shim, no weakened test, no skipped " +
      "check), re-validate the affected cases as a delta, then re-push the dev branch. Do NOT touch main.\n\n" +
      "Failure context:\n" +
      batchCtx.failureContext,
    { label: "fix-ci-and-repush", phase: "CI" }
  );
}

if (!ciGreen) {
  // Unreachable: every non-green path above escalates and throws.
  throw new Error("Internal invariant violated: batch CI ended without green and without escalation.");
}

log("Federated run complete. dev->main PR is green and awaiting Gate B (human merge): " + ship.prUrl);

// Success value: the batch PR URL, plus any features that escalated and were left
// for a human on their own branch/issue.
return {
  prUrl: ship.prUrl,
  shipped: true,
  shippedFeatures: green.map((o) => o.feature.id),
  escalated: escalated.map((o) => ({ feature: o.feature.id, branch: o.branch, reason: o.reason })),
};
