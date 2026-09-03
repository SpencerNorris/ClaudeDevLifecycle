/*
 * single-feature-run.js — the autonomous single-feature dev cycle (D2 as a workflow).
 *
 * WHAT THIS IS
 *   The master design document's per-task discipline ("D2") has two execution
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
 * MODE: AUTONOMOUS. The human is not in this loop; the review panel is the
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
        "Run the review panel (adversarial + correctness always; security/performance opt-in via reviewers): each reviewer reconstructs the diff and re-runs tests vs the claimed results. A reject hands the aggregated critique back to an implementing agent and retries, capped at K=3. Pass appends the verdicts to the DoD report.",
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
// Blocker taxonomy (added 2026-09-03). Every structured agent return carries
// `blocker`. Only "code" (or "none") may re-enter a retry loop; every other
// value is an EXTERNAL condition no implementer can fix — a dead daemon, a
// revoked credential, a billing refusal, a usage-limit kill, an ambiguous
// spec. Those pause the run for a human immediately (pauseForHuman): no root-
// cause diagnosis, no reimplementation, no spending of the K budget. The
// control flow branches on this field, never on free-text sniffing.
// ---------------------------------------------------------------------------
const BLOCKER_ENUM = ["none", "code", "infra", "credentials", "billing", "usage_limit", "ambiguity"];
const BLOCKER_PROPS = {
  blocker: { type: "string", enum: BLOCKER_ENUM },
  blockerDetail: { type: "string" },
};
function isExternalBlocker(b) {
  return !!b && b !== "none" && b !== "code";
}

// ---------------------------------------------------------------------------
// Harness-boundary guards (#76).
//
// The Workflow harness can deliver `args` as a JSON STRING rather than a parsed
// object, or omit it entirely (undefined/null). Field reads off the raw string
// silently yield undefined; field reads off undefined throw a bare TypeError
// instead of the helpful Gate A error. Normalize once to an OBJECT; every
// reader below uses RUN_ARGS and missing inputs fail the input checks.
// ---------------------------------------------------------------------------
const RUN_ARGS = (typeof args === "string" ? JSON.parse(args) : args) || {};

// agent() returns null when a subagent dies on a terminal error (e.g. a
// usage-limit interruption). Dereferencing a null structured result crashes the
// whole workflow with a bare TypeError; guard every such site so the failure is
// explicit and the run stays cleanly resumable (#76).
function requireAgentResult(result, what) {
  if (!result) {
    throw new Error(what + " agent died without returning a result (likely a usage-limit interruption) — resume the run to retry.");
  }
  return result;
}

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
          // Free-form so any reviewer (shim / correctness / security / performance)
          // can use its own category vocabulary.
          category: { type: "string", minLength: 1 },
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
  required: ["gatesPass", "report", "tests", "smokeAllPass", "blocker"],
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
    ...BLOCKER_PROPS,
  },
};

// The implementer's structured result, so the workflow knows a branch exists and
// can name the diff handed to the reviewer.
const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["branch", "summary", "blocker"],
  properties: {
    branch: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    // Files touched, so the reviewer/validator can scope the diff.
    filesTouched: { type: "array", items: { type: "string" } },
    ...BLOCKER_PROPS,
  },
};

// ---------------------------------------------------------------------------
// REVIEW PANEL. The adversarial + correctness reviewers ALWAYS run; security and
// performance are DISCRETIONARY — opt in per project via args.reviewers (e.g.
// ["security"]), defaulted from the repo's CLAUDE.md. Each reviewer is handed the
// SAME independently-derived evidence and returns the shared VERDICT_SCHEMA, run in
// parallel. A feature passes review only when EVERY dispatched reviewer passes; on
// any reject, the aggregated critique becomes the retry context.
// ---------------------------------------------------------------------------
const ALWAYS_REVIEWERS = ["adversarial-reviewer", "correctness-reviewer"];
const OPTIONAL_REVIEWERS = { security: "security-reviewer", performance: "performance-reviewer" };

function selectedReviewers() {
  // Accept both array form (["performance"]) and string form ("+performance",
  // "security,performance") — a malformed value must never silently shrink
  // the panel (it did once: Stage 2's +performance string parsed to []).
  const raw = RUN_ARGS.reviewers;
  const extra = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[+,\s]+/).filter(Boolean)
      : [];
  const optional = extra
    .map((r) => OPTIONAL_REVIEWERS[String(r).toLowerCase()])
    .filter(Boolean);
  return ALWAYS_REVIEWERS.concat(optional).filter((v, i, a) => a.indexOf(v) === i);
}

function reviewFocus(agentType) {
  if (agentType === "adversarial-reviewer")
    return "You are the ADVERSARIAL reviewer. Refute-first: PROVE this is not actually done. Hunt for skipped/weakened tests, swallowed errors, hardcoded/stubbed returns, cast-to-None, narrowed assertions, unaddressed root cause, missing named edge cases, and dishonest DoD claims; re-run the suite/smoke yourself and compare to the CLAIMED results.";
  if (agentType === "correctness-reviewer")
    return "You are the CORRECTNESS reviewer. Trace the real code and find logic errors, bad boundary/edge handling, null/empty mishandling, mishandled error paths, races, and contract/invariant violations. Passing tests is not correctness.";
  if (agentType === "security-reviewer")
    return "You are the SECURITY reviewer. Trace untrusted-data flow and find real, exploitable defects (injection, broken authz/IDOR, secret/crypto misuse, missing validation/encoding, data exposure, unsafe config). Name the attack path.";
  if (agentType === "performance-reviewer")
    return "You are the PERFORMANCE reviewer. Find real defects that bite at realistic scale (accidental O(n^2), N+1/per-iteration I/O, unbounded growth, redundant work, resource leaks). Name the triggering scale.";
  return "Review this change and return the structured verdict.";
}

async function runReviewPanel(runLabel, branch, base, dod) {
  const evidence =
    "\n\nBranch under review: " + branch + "  (base: " + base + ")\n" +
    "DERIVE GROUND TRUTH YOURSELF — reconstruct the real diff with `git diff " + base +
    "...HEAD` on branch '" + branch + "' and read the actual code; do not trust any self-reported " +
    "file list. Where your lens needs test results, re-run them yourself and compare to the CLAIMED results.\n" +
    "CLAIMED test output (verify, do not trust): unit=" + dod.tests.unit + " | integration=" +
    dod.tests.integration + " | regression=" + dod.tests.regression + " | lint=" + dod.tests.lint +
    " | typecheck=" + dod.tests.typecheck + "\n\nCLAIMED DoD report:\n" + dod.report;

  const results = (
    await parallel(
      selectedReviewers().map((agentType) => () =>
        agent(
          runLabel + " REVIEW (master-design-doc.md §8, spec §5). " + reviewFocus(agentType) +
            " Return verdict 'pass' only if you found no blocking finding; otherwise 'reject' with specific " +
            "findings (each naming the triggering case/path and the required fix). On pass, return a short " +
            "`verdictSection` (markdown)." + evidence,
          { label: agentType, phase: "Review", agentType: agentType, model: "opus", schema: VERDICT_SCHEMA }
        ).then((v) => ({ agentType: agentType, v: v }))
      )
    )
  ).filter(Boolean);

  // An incomplete panel must never pass: a dead reviewer (null result) is not a
  // pass-by-absence. Without this, a panel whose reviewers all die (e.g. on a
  // usage-limit cap) has zero rejections and the feature vacuously "passes"
  // review that never happened (#76).
  const expected = selectedReviewers().length;
  const valid = results.filter((r) => r.v && r.v.verdict);
  if (valid.length < expected) {
    return {
      pass: false,
      incomplete: true,
      critique:
        "### review-infrastructure\nOnly " + valid.length + " of " + expected +
        " reviewers returned a verdict (reviewer agent death, likely a usage-limit interruption). " +
        "An incomplete panel can never pass; the panel must re-run.",
      rejectedBy: "incomplete-panel(" + valid.length + "/" + expected + ")",
    };
  }

  const rejected = valid.filter((r) => r.v.verdict === "reject");
  if (rejected.length === 0) {
    const verdictSection = valid
      .map((r) => (r.v && r.v.verdictSection) ? r.v.verdictSection : "## Reviewer Verdict\nPASS — " + r.agentType + ".")
      .join("\n\n");
    return { pass: true, verdictSection: verdictSection };
  }
  const critique = rejected
    .map((r) =>
      "### " + r.agentType + "\n" + (r.v.summary || "") + "\n" +
      (r.v.findings || [])
        .map((f) => "- [" + f.severity + "] " + f.category + (f.location ? " @ " + f.location : "") + ": " + f.detail)
        .join("\n")
    )
    .join("\n\n");
  return { pass: false, critique: critique, rejectedBy: rejected.map((r) => r.agentType).join(", ") };
}

// The ship result: the opened PR.
const SHIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pushed", "blocker"],
  properties: {
    prUrl: { type: "string" },
    pushed: { type: "boolean" },
    ...BLOCKER_PROPS,
  },
};

// One CI poll result.
const CI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "blocker"],
  properties: {
    // "green" = all checks passed; "red" = a check failed; "pending" = still running.
    status: { type: "string", enum: ["green", "red", "pending"] },
    failingJobs: { type: "array", items: { type: "string" } },
    logsExcerpt: { type: "string" },
    ...BLOCKER_PROPS,
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
      model: "opus",
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
      model: "sonnet",
    }
  );

  log(
    "Escalation posted to the GitHub issue and '" +
      NEEDS_HUMAN_LABEL +
      "' label added. Stopping the workflow — no further retries, no shim."
  );

  throw new EscalationStop(stage, attempts, diagnosis);
}

/**
 * pauseForHuman — the cheap terminal for EXTERNAL blockers (added 2026-09-03).
 *
 * A dead daemon, a revoked credential, a billing refusal, a usage-limit kill or
 * an unresolvable ambiguity is not a code defect: no implementer can fix it and
 * a root-cause diagnosis adds nothing. Post a short comment + the needs-human
 * label and stop at once, leaving branch/PR in place so the run resumes
 * (resumeFromRunId + a fresh resumeNonce) once the human has fixed it.
 * ALWAYS throws, like escalate().
 */
async function pauseForHuman(stage, blocker, context) {
  log(
    "PAUSED FOR HUMAN at stage '" + stage + "': blocker=" + blocker + " — " +
      context.failureContext + " (no retries, no diagnosis)."
  );
  await agent(
    "Post a SHORT comment to the feature issue via the GitHub MCP server and add the '" +
      NEEDS_HUMAN_LABEL +
      "' label. Do NOT push, merge, or modify code.\n\nIssue: " +
      context.issue +
      "\nBranch: " +
      context.branch +
      "\nPR: " +
      (context.prUrl || "not opened") +
      "\n\nThe comment MUST contain, as labeled sections: " +
      "'Autonomous run paused — " + blocker + " blocker, not a code failure'; " +
      "'Stage: " + stage + "'; 'Blocker detail' (the text below, verbatim); and " +
      "'Next step: fix the condition, then resume the run (resumeFromRunId with a fresh resumeNonce) — no re-authorization needed.'\n\nBlocker detail:\n" +
      context.failureContext,
    { label: "pause-for-human", phase: stage, model: "sonnet", effort: "low" }
  );
  throw new EscalationStop(stage, 1, "PAUSED (" + blocker + "): " + context.failureContext);
}

// ===========================================================================
// MAIN FLOW
// ===========================================================================

// Gate A inputs (master-design-doc.md §4). These come from the main loop that
// dispatched this workflow; the workflow does not re-authorize.
const featureDescription = RUN_ARGS.featureDescription || RUN_ARGS.feature || RUN_ARGS.issue;
const devBranch = RUN_ARGS.devBranch || RUN_ARGS.branch;
const issueRef = RUN_ARGS.issue || RUN_ARGS.issueRef; // durable escalation target (§4)
const preApprovedPlan = RUN_ARGS.plan || RUN_ARGS.preApprovedPlan || null;

// Resume support (added 2026-09-03): the harness caches a completed agent()
// result by (prompt, opts), so a resumed run would replay a failed validate
// verdict verbatim unless the prompt changes. The nonce is folded into the
// Validate prompt. `existingBranch` tells the implementer to continue a branch a
// previous (interrupted) attempt already created instead of starting fresh.
const resumeNonce = RUN_ARGS.resumeNonce ? String(RUN_ARGS.resumeNonce) : "";
const existingBranch = RUN_ARGS.existingBranch ? String(RUN_ARGS.existingBranch) : "";

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
    (existingBranch
      ? "A branch for this feature ALREADY EXISTS: '" + existingBranch + "'. Check it out in your worktree and CONTINUE from its tip — never create a fresh branch, never redo work already committed there.\n"
      : "") +
    "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle; never leave more than one task's work uncommitted — if you are interrupted, committed work is the only work that survives.\n" +
    "BLOCKERS: if you hit an external condition you cannot fix — a missing/invalid credential, a dead daemon or service, a billing refusal, or an issue/spec too ambiguous to derive acceptance criteria from — STOP and return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise return blocker='none'.\n" +
    "\nFeature: " +
    featureDescription +
    "\nLinked issue: " +
    issueRef +
    "\n\nReturn the branch name you created and a summary of the implementation.",
  {
    label: "implement-tdd",
    phase: "Implement",
    model: "sonnet",
    schema: IMPLEMENT_SCHEMA,
    isolation: "worktree",
  }
);

// The branch the implementer actually created is the real one from here on.
requireAgentResult(implementResult, "IMPLEMENT");
ctx.branch = implementResult.branch;
if (isExternalBlocker(implementResult.blocker)) {
  ctx.failureContext = implementResult.blockerDetail || ("blocker=" + implementResult.blocker);
  await pauseForHuman("Implement", implementResult.blocker, ctx);
}
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
    "AUTONOMOUS single-feature run, VALIDATE phase — attempt " + attempt + " of " + K +
      (resumeNonce ? ", resume " + resumeNonce : "") +
      " (master-design-doc.md §5, D2; reference/definition-of-done.md).\n" +
      "STEP 0 — PREFLIGHT, before running a single test. List every external resource the issue's acceptance criteria depend on and verify each with the cheapest possible check: an LLM key via ONE minimal call through the app's configured provider; the Docker daemon (`docker info` answers within 15 s) and the target services' health endpoints; at least 10 GB free on the volume holding Docker's data; GitHub reachability if the smoke needs it. If any check fails, STOP: return gatesPass=false, smokeAllPass=false, blocker = the matching kind ('infra' | 'credentials' | 'billing' | 'usage_limit') and blockerDetail = the exact error text. Never retry a preflight, never attempt host recovery, never enter or read credentials.\n" +
      "STEP 1 — GATES on branch '" + ctx.branch + "': unit + integration + regression + lint + type-check.\n" +
      "STEP 2 — SMOKE against the running system: the happy path, EVERY named edge case in the feature/issue/spec (or, if none are stated, derive them explicitly and list them), and the most plausible failure modes for the surface touched. If the stack is in the dev shape (bind-mounted source), do NOT rebuild images for code changes — rebuild only when dependencies, a Dockerfile, or the nginx template changed.\n" +
      "Set blocker='code' when a gate or smoke case fails because of the change; 'ambiguity' when the issue/spec is contradictory or under-specified and acceptance criteria cannot be derived; a preflight kind when an external resource failed mid-smoke; 'none' when everything passed.\n" +
      "Produce a DoD report with the exact structure from reference/definition-of-done.md " +
      "(## Changes / ## Tests / ## Smoke test transcript / ## Docs updated / ## Follow-ups), including the real transcript. " +
      "Be honest: gatesPass is true ONLY if every test gate AND every smoke case actually passed.\n\n" +
      "Feature: " + featureDescription + "\nLinked issue: " + issueRef,
    {
      label: "validate-and-dod",
      phase: "Validate",
      model: "sonnet",
      schema: DOD_SCHEMA,
    }
  );

  if (!dod) {
    ctx.failureContext = "VALIDATE agent died without returning a DoD result (usage-limit or harness interruption).";
    await pauseForHuman("Validate", "usage_limit", ctx);
  }
  if (isExternalBlocker(dod.blocker)) {
    ctx.failureContext = dod.blockerDetail || dod.failureContext || ("blocker=" + dod.blocker);
    await pauseForHuman("Validate", dod.blocker, ctx);
  }
  if (!dod.gatesPass || !dod.smokeAllPass) {
    // A genuine code failure — the ONLY kind that may spend the K budget.
    ctx.failureContext =
      "Validation/DoD failed on attempt " + attempt + ". " + (dod.failureContext || "Gates or smoke cases did not pass.");
    log("Validation failed on attempt " + attempt + ". " + ctx.failureContext);

    if (attempt === K) {
      // Cap reached on a validation failure — escalate, never loop again.
      await escalate("Validate", attempt, ctx);
    }

    // Hand the failure back to the implementer and spend the next attempt.
    implementResult = await agent(
      "AUTONOMOUS run, back to IMPLEMENT after a VALIDATE failure (master-design-doc.md §5). " +
        "Fix the root cause — do NOT weaken tests, skip cases, or shim. Keep TDD discipline.\n\n" +
        "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle; never leave more than one task's work uncommitted — if you are interrupted, committed work is the only work that survives.\n" +
        "BLOCKERS: if you hit an external condition you cannot fix — a missing/invalid credential, a dead daemon or service, a billing refusal, or an issue/spec too ambiguous to derive acceptance criteria from — STOP and return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise return blocker='none'.\n\n" +
        "Branch: " +
        ctx.branch +
        "\nWhat failed:\n" +
        ctx.failureContext,
      {
        label: "reimplement-after-validate",
        phase: "Implement",
        model: "sonnet",
        schema: IMPLEMENT_SCHEMA,
        isolation: "worktree",
      }
    );
    requireAgentResult(implementResult, "IMPLEMENT");
    ctx.branch = implementResult.branch;
    if (isExternalBlocker(implementResult.blocker)) {
      ctx.failureContext = implementResult.blockerDetail || ("blocker=" + implementResult.blocker);
      await pauseForHuman("Implement", implementResult.blocker, ctx);
    }
    continue; // counter-controlled: the for-condition decides if we loop
  }

  log("Validation + DoD report green on attempt " + attempt + ". Dispatching adversarial review.");

  // ---- PHASE 3: REVIEW PANEL (adversarial + correctness always; security/perf opt-in) ----
  phase("Review");
  const review = await runReviewPanel("AUTONOMOUS single-feature run,", ctx.branch, devBranch, dod);

  if (review.incomplete) {
    // Dead reviewers (usage-limit) are not a rejection: never hand this to an implementer.
    ctx.failureContext = review.critique;
    await pauseForHuman("Review", "usage_limit", ctx);
  }

  if (!review.pass) {
    // Reject is transient — the aggregated panel critique IS the retry context (spec §5).
    ctx.failureContext =
      "Review panel rejected on attempt " + attempt + " (by: " + review.rejectedBy + "):\n" + review.critique;
    log("Review REJECTED on attempt " + attempt + " by " + review.rejectedBy + ". Handing the critique back to implementation.");

    if (attempt === K) {
      // Cap reached on a reviewer reject — escalate, never loop again, never shim.
      await escalate("Review", attempt, ctx);
    }

    implementResult = await agent(
      "AUTONOMOUS run, back to IMPLEMENT after a REVIEW reject (master-design-doc.md §8). " +
        "Address EVERY blocking finding by fixing the ROOT CAUSE. Do NOT weaken tests or shim to satisfy a reviewer.\n\n" +
        "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle; never leave more than one task's work uncommitted — if you are interrupted, committed work is the only work that survives.\n" +
        "BLOCKERS: if you hit an external condition you cannot fix — a missing/invalid credential, a dead daemon or service, a billing refusal, or an issue/spec too ambiguous to derive acceptance criteria from — STOP and return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise return blocker='none'.\n\n" +
        "Branch: " +
        ctx.branch +
        "\nReviewer critique:\n" +
        review.critique,
      {
        label: "reimplement-after-review",
        phase: "Implement",
        model: "sonnet",
        schema: IMPLEMENT_SCHEMA,
        isolation: "worktree",
      }
    );
    requireAgentResult(implementResult, "IMPLEMENT");
    ctx.branch = implementResult.branch;
    if (isExternalBlocker(implementResult.blocker)) {
      ctx.failureContext = implementResult.blockerDetail || ("blocker=" + implementResult.blocker);
      await pauseForHuman("Implement", implementResult.blocker, ctx);
    }
    continue; // counter-controlled
  }

  // PASS — every dispatched reviewer passed. Persist their verdicts into the DoD
  // report so they travel with the PR to Gate B (spec §5, verdict persistence).
  dodReport = dod.report + "\n\n" + review.verdictSection;
  reviewed = true;
  log("Review panel PASSED on attempt " + attempt + ". Verdicts appended to the DoD report.");
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
const ship = requireAgentResult(await agent(
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
    "Return the PR URL. If the push or PR creation fails for an EXTERNAL reason (auth, network, GitHub billing/permissions), return pushed=false with blocker='credentials'|'infra'|'billing' and blockerDetail; otherwise blocker='none'.\n\nDoD report (PR body):\n" +
    dodReport,
  {
    label: "push-and-open-pr",
    phase: "Ship",
    model: "sonnet",
    schema: SHIP_SCHEMA,
  }
), "SHIP");
ctx.prUrl = ship.prUrl;
if (isExternalBlocker(ship.blocker) || !ship.pushed || !ship.prUrl) {
  ctx.failureContext =
    ship.blockerDetail ||
    (!ship.pushed ? "push did not complete" : "PR was not opened (no URL returned)");
  await pauseForHuman("Ship", isExternalBlocker(ship.blocker) ? ship.blocker : "infra", ctx);
}
log("Branch pushed and PR opened: " + ctx.prUrl);

// Cleanup (added 2026-09-03): the implementer's worktree has served its purpose
// once the branch is pushed. Leaving it locks the branch against checkout
// elsewhere and litters .claude/worktrees (28 accumulated once). Best-effort;
// the branch itself is never deleted here.
await agent(
  "Remove any git worktree whose checked-out branch is '" + ctx.branch +
    "' (`git worktree list`, then `git worktree remove --force <path>`, then `git worktree prune`). Do NOT delete the branch. If removal is refused, say why and stop — do not escalate.",
  { label: "cleanup-worktree", phase: "Ship", model: "sonnet", effort: "low" }
);

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
        "If the PR reports no checks at all (the repository has no CI configured), that counts as 'green' — " +
        "do not wait for checks that will never start. " +
        "On 'red', include the failing job names and a short excerpt of the failure logs. " +
        "If a job failed before any step ran with an annotation about account payments, billing, or a spending limit (check `gh api repos/{owner}/{repo}/check-runs/{id}/annotations`), return status 'red', blocker 'billing', logsExcerpt = that annotation verbatim. Otherwise blocker 'none' for green/pending and 'code' for a red caused by the change.",
      {
        label: "poll-ci",
        phase: "CI",
        model: "sonnet",
        schema: CI_SCHEMA,
      }
    );
    if (!ci) {
      // The poll agent died (usage-limit / harness). Leave the loop; the
      // null check below pauses for a human instead of dereferencing null.
      break;
    }
    if (ci.status === "green" || ci.status === "red") {
      terminal = true;
    } else {
      log("CI still pending (poll " + poll + "/" + pollBudget + ").");
    }
  }

  if (!ci) {
    ctx.failureContext = "CI poll agent died without returning a status (usage-limit or harness interruption).";
    await pauseForHuman("CI", "usage_limit", ctx);
  }
  if (isExternalBlocker(ci.blocker)) {
    ctx.failureContext = ci.blockerDetail || ci.logsExcerpt || ("blocker=" + ci.blocker);
    await pauseForHuman("CI", ci.blocker, ctx);
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
      model: "sonnet",
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
