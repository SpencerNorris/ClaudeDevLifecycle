/*
 * single-feature-run.js — the autonomous single-feature dev cycle (D2 as a workflow).
 *
 * WHAT THIS IS
 *   The control-flow document's per-task discipline ("D2") has two execution
 *   modes (master-design-doc.md §5). In INTERACTIVE mode a human is the skeptic and
 *   the main loop holds the conversation. In AUTONOMOUS mode the same discipline
 *   is encoded HERE, as a workflow: the adversarial-reviewer AGENT is the skeptic
 *   (a mandatory stage — master-design-doc.md §8, spec §5), and every retry loop is
 *   capped + escalated in code (master-design-doc.md §9, spec §7). This file is the
 *   AUTONOMOUS execution of D2 for a single feature, dispatched after Gate A.
 *
 * THE FLOW (master-design-doc.md §5 diagram, autonomous portion)
 *   Gate A has already happened in the main loop (authorize: scope, budget,
 *   target dev branch, GH issue scaffolding). This workflow runs the interior:
 *
 *     1. IMPLEMENT  create the non-main branch; TDD (failing test -> implement
 *                   -> green -> refactor). Plan is either pre-approved (passed in
 *                   args) or drafted here when the surface is non-trivial.
 *     2. VALIDATE   unit + integration + regression + lint + type, THEN a smoke
 *                   test (happy path + every named edge + plausible failure
 *                   modes) per reference/definition-of-done.md. Produce the DoD
 *                   report. Failure loops back to IMPLEMENT (capped at K).
 *     3. REVIEW     adversarial-reviewer AGENT, fixed inputs (diff + DoD report +
 *                   test output), structured VERDICT. Reject -> hand the critique
 *                   back to an implementing agent and retry (capped at K). Pass ->
 *                   append the verdict to the DoD report as `## Reviewer Verdict`
 *                   (spec §5, verdict persistence).
 *     4. SHIP       push the non-main branch; open the dev->main PR via MCP, with
 *                   the DoD report (+ verdict) as the body.
 *     5. CI         poll GitHub Actions. Red -> read logs, fix, re-push, re-validate
 *                   as a delta (capped at K). Green -> return the PR URL.
 *
 *   Gate B (the human merging the dev->main PR) happens AFTER this workflow
 *   returns — it is a human touchpoint, not a workflow step.
 *
 * THE CIRCUIT BREAKER (master-design-doc.md §9, spec §7) — load-bearing, non-bypassable.
 *   Every retry loop is COUNTER-controlled with a hard cap K = 3. The counter is
 *   workflow code, not agent discretion: an agent cannot vote to loop again. On
 *   exhaustion we do NOT loop and do NOT shim. We:
 *     (a) dispatch a root-cause diagnosis,
 *     (b) have an agent post a structured summary comment to the feature's GH
 *         issue and add the `needs-human` label,
 *     (c) STOP the workflow (throw EscalationStop), leaving branch + PR in place.
 *   This is the only exit other than success. There is no "try forever" path.
 *
 * MODE: AUTONOMOUS. The human is not in this loop; the reviewer agent is the
 * skeptic and the caps are the safety rail.
 */

export const meta = {
  name: "single-feature-run",
  description:
    "Autonomous single-feature dev cycle (D2 as a workflow): TDD implement -> validate + DoD report -> adversarial review -> push + PR -> CI, with every retry loop capped at K=3 and escalation to the feature GitHub issue on exhaustion.",
  phases: [
    {
      title: "Implement",
      detail:
        "Create the non-main branch and do TDD: write a failing test, implement to green, refactor. Plan is pre-approved (from args) or drafted here for non-trivial surfaces.",
    },
    {
      title: "Validate",
      detail:
        "Run unit + integration + regression + lint + type, then a smoke test (happy path + every named edge + plausible failure modes) and produce a DoD report. Failure loops back to Implement, capped at K=3.",
    },
    {
      title: "Review",
      detail:
        "Invoke the adversarial-reviewer agent with fixed inputs (diff + DoD report + test output). Reject hands the critique back to an implementing agent and retries, capped at K=3. Pass appends the verdict to the DoD report.",
    },
    {
      title: "Ship",
      detail:
        "Push the non-main branch and open the dev->main PR via the GitHub MCP server, with the DoD report (plus reviewer verdict) as the PR body.",
    },
    {
      title: "CI",
      detail:
        "Poll GitHub Actions. On red, read the logs, fix, re-push, and re-validate as a delta, capped at K=3. On green, return the PR URL.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Constants. K is the hard retry cap from master-design-doc.md §9 / spec §7. It caps
// EVERY loop in this file. Changing this changes the breaker for all phases.
// ---------------------------------------------------------------------------
const K = 3;
const NEEDS_HUMAN_LABEL = "needs-human";

// ---------------------------------------------------------------------------
// JSON Schemas (plain JS objects). Used to force structured returns from agents
// so the control flow branches on data, not on free-text the agent could fudge.
// ---------------------------------------------------------------------------

// The adversarial-reviewer's verdict (master-design-doc.md §8, spec §5). `findings`
// enumerate the specific refutations (weakened tests, try/except pass, hardcoded
// returns, cast-to-None, narrowed assertions, unaddressed root cause, missing
// named edges, dishonest DoD claims). On reject they become retry context.
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
    // The verdict text to persist into the DoD report on pass (spec §5).
    verdictSection: { type: "string" },
  },
};

// The DoD report payload (reference/definition-of-done.md report contract). The
// workflow branches on `gatesPass`; `report` is the markdown that travels to the PR.
const DOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gatesPass", "report", "tests", "smokeAllPass"],
  properties: {
    // True only when unit+integration+regression+lint+type all pass AND the
    // smoke test (happy + named edges + failure modes) all pass.
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
    // Reason a gate failed, fed back to the implementer as retry context.
    failureContext: { type: "string" },
    // The full DoD-report markdown (Changes / Tests / Smoke transcript / Docs /
    // Follow-ups) per reference/definition-of-done.md.
    report: { type: "string" },
  },
};

// The implementer's structured result, so the workflow knows a branch exists and
// can name the diff handed to the reviewer.
const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["branch", "summary"],
  properties: {
    branch: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    // Files touched, so the reviewer/validator can scope the diff.
    filesTouched: { type: "array", items: { type: "string" } },
  },
};

// The ship result: the opened PR.
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
    // "green" = all checks passed; "red" = a check failed; "pending" = still running.
    status: { type: "string", enum: ["green", "red", "pending"] },
    failingJobs: { type: "array", items: { type: "string" } },
    logsExcerpt: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// EscalationStop — the one non-success terminal of this workflow. Thrown after
// the escalation comment + label are posted. It is NOT caught anywhere in this
// file: throwing it ends the workflow. This is what makes "never loop forever,
// never shim" structural rather than a guideline.
// ---------------------------------------------------------------------------
class EscalationStop extends Error {
  constructor(stage, attempts, rootCause) {
    super(
      "Circuit breaker tripped at stage '" +
        stage +
        "' after " +
        attempts +
        " attempts (cap K=" +
        K +
        "). Escalated to the GitHub issue; workflow stopped. Root cause: " +
        rootCause
    );
    this.name = "EscalationStop";
    this.stage = stage;
    this.attempts = attempts;
    this.rootCause = rootCause;
  }
}

/**
 * escalate — the circuit breaker's terminal action (master-design-doc.md §9, spec §7).
 *
 * Runs a root-cause diagnosis, then dispatches an agent to post a structured
 * summary comment to the feature's GitHub issue (what failed, attempts made,
 * root-cause, branch/PR state) and add the `needs-human` label via the GitHub
 * MCP server. Then throws EscalationStop to end the workflow. The branch and PR
 * are deliberately left in place for human inspection.
 *
 * This function ALWAYS throws. It has no success return. Callers do not need a
 * `break` — control does not come back.
 */
async function escalate(stage, attempts, context) {
  log(
    "CIRCUIT BREAKER: stage '" +
      stage +
      "' exhausted " +
      attempts +
      "/" +
      K +
      " attempts. Diagnosing root cause, then escalating to the GitHub issue."
  );

  const diagnosis = await agent(
    "A capped retry loop in the autonomous single-feature run has been exhausted. " +
      "Do a root-cause diagnosis (master-design-doc.md §9 / spec §7): why did '" +
      stage +
      "' fail after " +
      attempts +
      " attempts? Do NOT propose a shim or a way to make it merely pass. " +
      "Identify the underlying cause as precisely as the evidence allows.\n\n" +
      "Issue: " +
      context.issue +
      "\nBranch: " +
      context.branch +
      "\nPR: " +
      (context.prUrl || "not yet opened") +
      "\nFailure context:\n" +
      context.failureContext,
    {
      label: "root-cause-diagnosis",
      phase: stage,
      effort: "high",
    }
  );

  await agent(
    "Escalate this exhausted autonomous run to the human (master-design-doc.md §9 / spec §7). " +
      "Using the GitHub MCP server, post a structured comment to the feature issue and add the '" +
      NEEDS_HUMAN_LABEL +
      "' label. Do NOT push, merge, or modify code. Leave the branch and PR in place.\n\n" +
      "Issue: " +
      context.issue +
      "\n\nThe comment MUST contain, as clearly labeled sections:\n" +
      "- Stage that failed: " +
      stage +
      "\n- Attempts made: " +
      attempts +
      " of " +
      K +
      " (cap exhausted)\n- What failed (the failure context below)\n" +
      "- Root-cause diagnosis (below)\n" +
      "- Branch / PR state: branch '" +
      context.branch +
      "', PR " +
      (context.prUrl || "not opened") +
      "\n- Next step: a human must investigate, then re-authorize via a new Gate A.\n\n" +
      "Failure context:\n" +
      context.failureContext +
      "\n\nRoot-cause diagnosis:\n" +
      diagnosis,
    {
      label: "escalate-to-issue",
      phase: stage,
    }
  );

  log(
    "Escalation posted to the GitHub issue and '" +
      NEEDS_HUMAN_LABEL +
      "' label added. Stopping the workflow — no further retries, no shim."
  );

  throw new EscalationStop(stage, attempts, diagnosis);
}

// ===========================================================================
// MAIN FLOW
// ===========================================================================

// Gate A inputs (master-design-doc.md §4). These come from the main loop that
// dispatched this workflow; the workflow does not re-authorize.
const featureDescription = args.featureDescription || args.feature || args.issue;
const devBranch = args.devBranch || args.branch;
const issueRef = args.issue || args.issueRef; // durable escalation target (§4)
const preApprovedPlan = args.plan || args.preApprovedPlan || null;

if (!featureDescription) {
  throw new Error(
    "single-feature-run requires args.featureDescription (the feature/issue to build)."
  );
}
if (!devBranch) {
  throw new Error(
    "single-feature-run requires args.devBranch (the target non-main dev branch)."
  );
}
if (!issueRef) {
  // Escalation (§9) needs a durable GitHub issue target. Gate A guarantees one.
  throw new Error(
    "single-feature-run requires args.issue (the feature's GitHub issue) so escalation has a durable target. Gate A must scaffold it."
  );
}

log(
  "Starting autonomous single-feature run (D2 as a workflow). Feature: " +
    featureDescription +
    " | dev branch: " +
    devBranch +
    " | issue: " +
    issueRef +
    " | retry cap K=" +
    K +
    (preApprovedPlan ? " | plan pre-approved at Gate A" : " | plan drafted in-flow")
);

// Shared mutable context handed to escalation so its comment is accurate.
const ctx = {
  issue: issueRef,
  branch: devBranch,
  prUrl: null,
  failureContext: "",
};

// ---------------------------------------------------------------------------
// PHASE 1+2+3 — Implement / Validate / Review.
//
// These three phases form ONE capped outer loop: a reviewer reject and a
// validation failure BOTH send control back to implementation, and both share
// the single K-cap as required by the diagram (master-design-doc.md §5: HG/JG/REV all
// loop back to E, "every loop capped at K"). We count every trip back to
// implementation. We never re-enter without spending an attempt; the counter is
// the only thing that decides whether we loop, never an agent.
// ---------------------------------------------------------------------------

phase("Implement");

// Branch creation + first TDD pass. Plan handling per Gate A (§4): pre-approved
// short-circuits planning; otherwise the agent drafts a plan for non-trivial
// surfaces (trivial tasks skip planning, master-design-doc.md §14.1).
const planClause = preApprovedPlan
  ? "A plan was pre-approved at Gate A; follow it:\n" + preApprovedPlan + "\n"
  : "No plan was pre-approved. If the surface is non-trivial (anything beyond a <=10-line, single-file, no-behavior-change edit per master-design-doc.md §14.1), draft a short plan first, then implement it.\n";

let implementResult = await agent(
  "AUTONOMOUS single-feature run, IMPLEMENT phase (master-design-doc.md §5, D2).\n" +
    "Create a NON-MAIN branch off '" +
    devBranch +
    "' named per branch-lifecycle conventions (dev/feat/fix/chore/...). NEVER touch main. " +
    "Then do TDD: write a FAILING test that pins the desired behavior, implement until it is green, then refactor. " +
    "Fix in-scope bugs in this change (no-shed); file only genuinely orthogonal bugs as cross-linked GH issues.\n\n" +
    planClause +
    "\nFeature: " +
    featureDescription +
    "\nLinked issue: " +
    issueRef +
    "\n\nReturn the branch name you created and a summary of the implementation.",
  {
    label: "implement-tdd",
    phase: "Implement",
    schema: IMPLEMENT_SCHEMA,
    isolation: "worktree",
  }
);

// The branch the implementer actually created is the real one from here on.
ctx.branch = implementResult.branch;
log("Implementation branch: " + ctx.branch + ". Entering the validate/review loop (cap K=" + K + ").");

let dodReport = null; // the passing DoD report (with verdict appended) for the PR

// Counter-controlled outer loop. `attempt` increments on EVERY pass; the loop is
// structurally bounded by K. There is no agent-controlled `continue`.
let reviewed = false;
for (let attempt = 1; attempt <= K && !reviewed; attempt++) {
  log("Validate/review attempt " + attempt + " of " + K + ".");

  // ---- PHASE 2: VALIDATE + DoD report -----------------------------------
  phase("Validate");
  const dod = await agent(
    "AUTONOMOUS single-feature run, VALIDATE phase (master-design-doc.md §5, D2; reference/definition-of-done.md).\n" +
      "On branch '" +
      ctx.branch +
      "', run the full validation: unit + integration + regression + lint + type-check. " +
      "THEN smoke-test against the running system: the happy path, EVERY named edge case in the feature/issue/spec " +
      "(or, if none are stated, derive them explicitly and list them), and the most plausible failure modes for the surface touched. " +
      "Produce a DoD report with the exact structure from reference/definition-of-done.md " +
      "(## Changes / ## Tests / ## Smoke test transcript / ## Docs updated / ## Follow-ups), including the real transcript. " +
      "Be honest: gatesPass is true ONLY if every test gate AND every smoke case actually passed.\n\n" +
      "Feature: " +
      featureDescription +
      "\nLinked issue: " +
      issueRef,
    {
      label: "validate-and-dod",
      phase: "Validate",
      schema: DOD_SCHEMA,
    }
  );

  if (!dod.gatesPass || !dod.smokeAllPass) {
    ctx.failureContext =
      "Validation/DoD failed on attempt " +
      attempt +
      ". " +
      (dod.failureContext || "Gates or smoke cases did not pass.");
    log("Validation failed on attempt " + attempt + ". " + ctx.failureContext);

    if (attempt === K) {
      // Cap reached on a validation failure — escalate, never loop again.
      await escalate("Validate", attempt, ctx);
    }

    // Hand the failure back to the implementer and spend the next attempt.
    implementResult = await agent(
      "AUTONOMOUS run, back to IMPLEMENT after a VALIDATE failure (master-design-doc.md §5). " +
        "Fix the root cause — do NOT weaken tests, skip cases, or shim. Keep TDD discipline.\n\n" +
        "Branch: " +
        ctx.branch +
        "\nWhat failed:\n" +
        ctx.failureContext,
      {
        label: "reimplement-after-validate",
        phase: "Implement",
        schema: IMPLEMENT_SCHEMA,
        isolation: "worktree",
      }
    );
    ctx.branch = implementResult.branch;
    continue; // counter-controlled: the for-condition decides if we loop
  }

  log("Validation + DoD report green on attempt " + attempt + ". Dispatching adversarial review.");

  // ---- PHASE 3: ADVERSARIAL REVIEW (the mandatory skeptic) --------------
  phase("Review");
  const verdict = await agent(
    "AUTONOMOUS single-feature run, REVIEW phase (master-design-doc.md §8, spec §5). " +
      "You are the adversarial reviewer. Refute-first: try to PROVE this change is not actually done. " +
      "Hunt for skipped or weakened tests, try/except pass, hardcoded returns, cast-to-None, narrowed assertions, " +
      "unaddressed root cause, missing named edge cases, and dishonest DoD claims (does the report match the real test output?). " +
      "Inputs are the diff on the branch, the DoD report, and the test output below. " +
      "Return verdict 'pass' only if you cannot substantiate a blocking finding; otherwise 'reject' with specific findings. " +
      "On pass, also return a `verdictSection` (markdown) to append to the DoD report.\n\n" +
      "Branch (diff source): " +
      ctx.branch +
      "\nFiles touched: " +
      (implementResult.filesTouched || []).join(", ") +
      "\n\nDoD report:\n" +
      dod.report,
    {
      label: "adversarial-review",
      phase: "Review",
      agentType: "adversarial-reviewer",
      schema: VERDICT_SCHEMA,
    }
  );

  if (verdict.verdict === "reject") {
    // Reject verdicts are transient — the critique IS the retry context (spec §5).
    const critique =
      verdict.summary +
      "\n" +
      verdict.findings
        .map(function (f) {
          return (
            "- [" +
            f.severity +
            "] " +
            f.category +
            (f.location ? " @ " + f.location : "") +
            ": " +
            f.detail
          );
        })
        .join("\n");
    ctx.failureContext = "Adversarial reviewer rejected on attempt " + attempt + ":\n" + critique;
    log("Reviewer REJECTED on attempt " + attempt + ". Handing the critique back to implementation.");

    if (attempt === K) {
      // Cap reached on a reviewer reject — escalate, never loop again, never shim.
      await escalate("Review", attempt, ctx);
    }

    implementResult = await agent(
      "AUTONOMOUS run, back to IMPLEMENT after an ADVERSARIAL-REVIEW reject (master-design-doc.md §8). " +
        "Address every blocking finding by fixing the ROOT CAUSE. Do NOT weaken tests or shim to satisfy the reviewer.\n\n" +
        "Branch: " +
        ctx.branch +
        "\nReviewer critique:\n" +
        critique,
      {
        label: "reimplement-after-review",
        phase: "Implement",
        schema: IMPLEMENT_SCHEMA,
        isolation: "worktree",
      }
    );
    ctx.branch = implementResult.branch;
    continue; // counter-controlled
  }

  // PASS. Persist the verdict into the DoD report (spec §5, verdict persistence)
  // so it travels with the PR to Gate B.
  const verdictSection =
    verdict.verdictSection ||
    "## Reviewer Verdict\n\nPASS — adversarial-reviewer.\n\n" + verdict.summary;
  dodReport = dod.report + "\n\n" + verdictSection;
  reviewed = true;
  log("Adversarial reviewer PASSED on attempt " + attempt + ". Verdict appended to the DoD report.");
}

// If the loop exited without a review pass and without escalating, that is a bug
// in the cap logic — fail loud rather than ship unreviewed work.
if (!reviewed || !dodReport) {
  throw new Error(
    "Internal invariant violated: validate/review loop ended without a passing review and without escalation."
  );
}

// ---------------------------------------------------------------------------
// PHASE 4 — SHIP. Push the non-main branch and open the dev->main PR.
// ---------------------------------------------------------------------------
phase("Ship");
const ship = await agent(
  "AUTONOMOUS single-feature run, SHIP phase (master-design-doc.md §5, D2). " +
    "Push the NON-MAIN branch '" +
    ctx.branch +
    "' to origin (the pre-push hook + settings allow tier branches; main is forbidden). " +
    "Then open a PR from '" +
    ctx.branch +
    "' into '" +
    devBranch +
    "' via the GitHub MCP server, linking issue " +
    issueRef +
    ". Use the DoD report (with the appended reviewer verdict) below as the PR body. " +
    "Return the PR URL.\n\nDoD report (PR body):\n" +
    dodReport,
  {
    label: "push-and-open-pr",
    phase: "Ship",
    schema: SHIP_SCHEMA,
  }
);
ctx.prUrl = ship.prUrl;
log("Branch pushed and PR opened: " + ctx.prUrl);

// ---------------------------------------------------------------------------
// PHASE 5 — CI. Poll GitHub Actions; on red, fix + re-push, capped at K.
//
// Two counters here, both bounded by K:
//   - `fixAttempt` caps how many times we fix-and-re-push a RED pipeline.
//   - the inner poll loop is itself capped (`pollBudget`) so a stuck "pending"
//     CI cannot spin forever; exhausting polls without a terminal status is
//     treated as a failure to converge and escalates.
// ---------------------------------------------------------------------------
phase("CI");
let prUrl = null;
let ciGreen = false;

for (let fixAttempt = 1; fixAttempt <= K && !ciGreen; fixAttempt++) {
  log("CI fix attempt window " + fixAttempt + " of " + K + ". Polling GitHub Actions.");

  // Bounded poll for a terminal (green/red) status. Counter-controlled, not
  // open-ended: a never-finishing pipeline cannot trap us.
  const pollBudget = 30;
  let ci = null;
  let terminal = false;
  for (let poll = 1; poll <= pollBudget && !terminal; poll++) {
    ci = await agent(
      "AUTONOMOUS single-feature run, CI phase (master-design-doc.md §5, D2). " +
        "Check the GitHub Actions status for PR " +
        ctx.prUrl +
        " (branch '" +
        ctx.branch +
        "') via the GitHub MCP server. " +
        "Return status 'green' if all required checks passed, 'red' if a required check failed, 'pending' if still running. " +
        "On 'red', include the failing job names and a short excerpt of the failure logs.",
      {
        label: "poll-ci",
        phase: "CI",
        schema: CI_SCHEMA,
      }
    );
    if (ci.status === "green" || ci.status === "red") {
      terminal = true;
    } else {
      log("CI still pending (poll " + poll + "/" + pollBudget + ").");
    }
  }

  if (!ci || !terminal) {
    ctx.failureContext =
      "CI did not reach a terminal state within the poll budget on fix attempt " + fixAttempt + ".";
    await escalate("CI", fixAttempt, ctx);
  }

  if (ci.status === "green") {
    ciGreen = true;
    prUrl = ctx.prUrl;
    log("CI is GREEN. PR ready for Gate B (human merge): " + prUrl);
    break;
  }

  // RED. Read logs, fix, re-push, and re-validate as a delta — but capped.
  ctx.failureContext =
    "CI red on fix attempt " +
    fixAttempt +
    ". Failing jobs: " +
    (ci.failingJobs || []).join(", ") +
    "\nLogs excerpt:\n" +
    (ci.logsExcerpt || "(none provided)");
  log("CI is RED on fix attempt " + fixAttempt + ". " + ctx.failureContext);

  if (fixAttempt === K) {
    // Cap reached on CI — escalate, never loop again.
    await escalate("CI", fixAttempt, ctx);
  }

  await agent(
    "AUTONOMOUS run, CI-RED fix (master-design-doc.md §5; reference/definition-of-done.md CI-red delta). " +
      "On branch '" +
      ctx.branch +
      "', read the failing CI logs, fix the ROOT CAUSE (no shim, no weakened test, no skipped check), " +
      "re-validate the affected cases as a delta (act + the affected smoke cases), then re-push the non-main branch. " +
      "Do NOT touch main.\n\nFailure context:\n" +
      ctx.failureContext,
    {
      label: "fix-ci-and-repush",
      phase: "CI",
      isolation: "worktree",
    }
  );
  // Loop: the for-condition re-polls. Counter-controlled.
}

if (!ciGreen || !prUrl) {
  // Should be unreachable: every non-green CI path escalates (which throws).
  throw new Error(
    "Internal invariant violated: CI phase ended without green and without escalation."
  );
}

log(
  "Autonomous single-feature run complete. PR is green and awaiting Gate B (human merge): " + prUrl
);

// The workflow's success value: the green PR URL for the human's Gate-B merge.
return { prUrl: prUrl, branch: ctx.branch, issue: issueRef };
