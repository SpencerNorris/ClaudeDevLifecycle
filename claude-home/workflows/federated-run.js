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
    "Autonomous federated multi-feature run (D4): fan out one worktree-isolated agent per feature (TDD -> validate -> DoD), gate each with the review panel (adversarial + correctness always; security/performance opt-in) before it merges onto dev, integrate, then push dev and open ONE dev->main PR with all DoD reports and drive CI green. Every retry loop capped at K=3; per-feature exhaustion escalates that feature, batch CI exhaustion is terminal.",
  phases: [
    { title: "Fan-out", detail: "One worktree-isolated agent per feature runs the D2 core: TDD implement -> validate -> DoD report. Runs concurrently." },
    { title: "Review", detail: "Gate each feature with the review panel (adversarial + correctness always; security/performance opt-in) before it merges onto dev. Reject retries that feature, capped K=3; exhaustion escalates that feature." },
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
// Blocker taxonomy (added 2026-09-03; mirrors single-feature-run.js). Every
// structured agent return carries `blocker`. Only "code" (or "none") may
// re-enter a retry loop; every other value is an EXTERNAL condition no
// implementer can fix — a dead daemon, a revoked credential, a billing
// refusal, a usage-limit kill, an ambiguous spec. A per-feature blocker
// (pauseFeatureForHuman) excludes just that feature from the batch, the same
// non-throwing outcome as cap exhaustion. A BATCH-level blocker (dead
// reviewers likely means the whole run hit a usage limit, not one feature;
// Ship/CI run once for the whole batch) throws EscalationStop via a
// batch-level pauseForHuman and stops the run. Control flow branches on this
// field, never on free-text sniffing.
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
          // Free-form so any reviewer (shim / correctness / security / performance)
          // can use its own category vocabulary.
          category: { type: "string", minLength: 1 },
          severity: { type: "string", enum: ["blocking", "minor"] },
          detail: { type: "string", minLength: 1 },
          location: { type: "string" },
        },
      },
    },
    verdictSection: { type: "string" },
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
  const extra = Array.isArray(RUN_ARGS.reviewers) ? RUN_ARGS.reviewers : [];
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
          { label: agentType, phase: "Review", agentType: agentType, schema: VERDICT_SCHEMA }
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

// The DoD report payload (reference/definition-of-done.md report contract).
const DOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gatesPass", "report", "tests", "smokeAllPass", "blocker"],
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
    ...BLOCKER_PROPS,
  },
};

// The implementer's structured result.
const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["branch", "summary", "blocker"],
  properties: {
    branch: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    filesTouched: { type: "array", items: { type: "string" } },
    ...BLOCKER_PROPS,
  },
};

// The ship result: the one batch PR.
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
    status: { type: "string", enum: ["green", "red", "pending"] },
    failingJobs: { type: "array", items: { type: "string" } },
    logsExcerpt: { type: "string" },
    ...BLOCKER_PROPS,
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
 * pauseFeatureForHuman — the cheap, non-throwing terminal for an EXTERNAL
 * blocker hit by ONE feature (added 2026-09-03). Mirrors pauseForHuman's short
 * comment + needs-human label, but does NOT throw: like cap exhaustion it
 * EXCLUDES this feature from the batch (the caller still returns the
 * `escalated: true` outcome) so the other features still ship. No root-cause
 * diagnosis — an external condition needs no diagnosing.
 */
async function pauseFeatureForHuman(feature, stage, blocker, ctx) {
  log(
    "PAUSED FOR HUMAN (feature " + feature.id + ") at stage '" + stage + "': blocker=" + blocker +
      " — " + ctx.failureContext + " (no retries, no diagnosis; feature excluded from the batch)."
  );
  await agent(
    "Post a SHORT comment to the feature issue via the GitHub MCP server and add the '" +
      NEEDS_HUMAN_LABEL +
      "' label. Do NOT push, merge, or modify code.\n\nIssue: " +
      ctx.issue +
      "\nBranch: " +
      (ctx.branch || "not yet created") +
      "\n\nThe comment MUST contain, as labeled sections: " +
      "'Autonomous federated run paused for this feature — " + blocker + " blocker, not a code failure'; " +
      "'Stage: " + stage + "'; 'Blocker detail' (the text below, verbatim); and " +
      "'Next step: fix the condition, then re-authorize this feature via a new Gate A — it was excluded from this batch.'\n\nBlocker detail:\n" +
      ctx.failureContext,
    { label: "pause-feature-for-human:" + feature.id, phase: stage, model: "sonnet", effort: "low" }
  );
}

/**
 * pauseForHuman — the cheap terminal for a BATCH-level EXTERNAL blocker (added
 * 2026-09-03): dead reviewers (likely the whole run hit a usage limit, not one
 * feature) or a dead/blocked Ship or CI agent (both run ONCE for the whole
 * batch, so there is no single feature to exclude). No root-cause diagnosis —
 * post a short comment + needs-human label and stop the WHOLE run at once.
 * ALWAYS throws, like postEscalation's throwing counterpart for batch CI
 * exhaustion.
 */
async function pauseForHuman(stage, blocker, ctx) {
  log(
    "PAUSED FOR HUMAN (batch) at stage '" + stage + "': blocker=" + blocker + " — " +
      ctx.failureContext + " (no retries, no diagnosis)."
  );
  await agent(
    "Post a SHORT comment to the relevant issue via the GitHub MCP server and add the '" +
      NEEDS_HUMAN_LABEL +
      "' label. Do NOT push, merge, or modify code.\n\nIssue: " +
      ctx.issue +
      "\nBranch: " +
      ctx.branch +
      "\nPR: " +
      (ctx.prUrl || "not opened") +
      "\n\nThe comment MUST contain, as labeled sections: " +
      "'Autonomous federated run paused — " + blocker + " blocker, not a code failure'; " +
      "'Stage: " + stage + "'; 'Blocker detail' (the text below, verbatim); and " +
      "'Next step: fix the condition, then resume the run (resumeFromRunId with a fresh resumeNonce) — no re-authorization needed.'\n\nBlocker detail:\n" +
      ctx.failureContext,
    { label: "pause-for-human", phase: stage, model: "sonnet", effort: "low" }
  );
  throw new EscalationStop(stage, 1, "PAUSED (" + blocker + "): " + ctx.failureContext);
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
      "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle; never leave more than one task's work uncommitted — if you are interrupted, committed work is the only work that survives.\n" +
      "BLOCKERS: if you hit an external condition you cannot fix — a missing/invalid credential, a dead daemon or service, a billing refusal, or an issue/spec too ambiguous to derive acceptance criteria from — STOP and return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise return blocker='none'.\n\n" +
      "Linked issue: " +
      feature.issue +
      "\n\nReturn the branch you created and a summary.",
    { label: tag + ":implement", phase: "Fan-out", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
  );
  requireAgentResult(impl, "IMPLEMENT");
  ctx.branch = impl.branch;
  if (isExternalBlocker(impl.blocker)) {
    ctx.failureContext = impl.blockerDetail || ("blocker=" + impl.blocker);
    await pauseFeatureForHuman(feature, "Implement", impl.blocker, ctx);
    return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
  }

  let reviewed = false;
  let dodReport = null;

  // Two INDEPENDENT budgets (changed 2026-09-05, mirrors single-feature-run.js):
  // validate failures and reviewer rejects each get their own K, so a feature
  // that spent attempts getting Validate green still gets a full review loop.
  let validateFailures = 0;
  let reviewRejects = 0;
  for (let pass = 1; pass <= 2 * K && !reviewed; pass++) {
    const attempt = pass; // kept for the Validate prompt's cache-busting "attempt N"
    // ---- VALIDATE + DoD report --------------------------------------------
    const dod = await agent(
      "AUTONOMOUS federated run, VALIDATE for feature '" + feature.title + "' — attempt " + attempt + " of " + K +
        (resumeNonce ? ", resume " + resumeNonce : "") +
        " on branch '" + ctx.branch + "' (reference/definition-of-done.md).\n" +
        "STEP 0 — PREFLIGHT, before running a single test. List every external resource the issue's acceptance criteria depend on and verify each with the cheapest possible check: an LLM key via ONE minimal call through the app's configured provider; the Docker daemon (`docker info` answers within 15 s) and the target services' health endpoints; at least 10 GB free on the volume holding Docker's data; GitHub reachability if the smoke needs it. If any check fails, STOP: return gatesPass=false, smokeAllPass=false, blocker = the matching kind ('infra' | 'credentials' | 'billing' | 'usage_limit') and blockerDetail = the exact error text. Never retry a preflight, never attempt host recovery, never enter or read credentials.\n" +
        "STEP 1 — GATES: unit + integration + regression + lint + type-check.\n" +
        "STEP 2 — SMOKE against the running system: the happy path, EVERY named edge case (or derive + list them if none are stated), and the most plausible failure modes. If the stack is in the dev shape (bind-mounted source), do NOT rebuild images for code changes — rebuild only when dependencies, a Dockerfile, or the nginx template changed.\n" +
        "Set blocker='code' when a gate or smoke case fails because of the change; 'ambiguity' when the issue/spec is contradictory or under-specified and acceptance criteria cannot be derived; a preflight kind when an external resource failed mid-smoke; 'none' when everything passed.\n" +
        "Produce a DoD report with the exact structure from reference/definition-of-done.md including the real transcript. " +
        "gatesPass is true ONLY if every gate AND every smoke case actually passed.\n\n" +
        "Feature: " + feature.title + "\nLinked issue: " + feature.issue,
      { label: tag + ":validate", phase: "Fan-out", schema: DOD_SCHEMA }
    );

    if (!dod) {
      ctx.failureContext = "VALIDATE agent died without returning a DoD result (usage-limit or harness interruption).";
      await pauseFeatureForHuman(feature, "Validate", "usage_limit", ctx);
      return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
    }
    if (isExternalBlocker(dod.blocker)) {
      ctx.failureContext = dod.blockerDetail || dod.failureContext || ("blocker=" + dod.blocker);
      await pauseFeatureForHuman(feature, "Validate", dod.blocker, ctx);
      return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
    }
    if (!dod.gatesPass || !dod.smokeAllPass) {
      // A genuine code failure — the ONLY kind that may spend this feature's Validate budget.
      validateFailures++;
      ctx.failureContext =
        "Validation/DoD failed (validate failure " + validateFailures + " of " + K + ", pass " + pass + "). " +
        (dod.failureContext || "Gates or smoke cases did not pass.");
      log(tag + ": validation failed (" + validateFailures + "/" + K + ").");

      if (validateFailures === K) {
        await postEscalation("Fan-out", validateFailures, ctx, tag);
        return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
      }

      impl = await agent(
        "AUTONOMOUS federated run, back to IMPLEMENT for feature '" +
          feature.title +
          "' after a VALIDATE failure. Fix the ROOT CAUSE — do NOT weaken tests, skip cases, or shim. Keep TDD discipline.\n\n" +
          "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle; never leave more than one task's work uncommitted — if you are interrupted, committed work is the only work that survives.\n" +
          "BLOCKERS: if you hit an external condition you cannot fix — a missing/invalid credential, a dead daemon or service, a billing refusal, or an issue/spec too ambiguous to derive acceptance criteria from — STOP and return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise return blocker='none'.\n\n" +
          "Branch: " +
          ctx.branch +
          "\nWhat failed:\n" +
          ctx.failureContext,
        { label: tag + ":reimplement", phase: "Fan-out", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
      );
      requireAgentResult(impl, "IMPLEMENT");
      ctx.branch = impl.branch;
      if (isExternalBlocker(impl.blocker)) {
        ctx.failureContext = impl.blockerDetail || ("blocker=" + impl.blocker);
        await pauseFeatureForHuman(feature, "Implement", impl.blocker, ctx);
        return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
      }
      continue; // counter-controlled
    }

    // ---- REVIEW PANEL (adversarial + correctness always; security/perf opt-in) ----
    const review = await runReviewPanel(
      "AUTONOMOUS federated run, feature '" + feature.title + "',",
      ctx.branch,
      devBranch,
      dod
    );

    if (review.incomplete) {
      // Dead reviewers likely mean the WHOLE run hit a usage limit, not a
      // problem isolated to this feature. Do not spend this feature's K
      // budget retrying a panel that probably can't run anywhere right now —
      // signal a BATCH-level pause instead of excluding just this feature.
      ctx.failureContext = review.critique;
      log(tag + ": review panel INCOMPLETE on attempt " + attempt + " — signaling a batch-level pause.");
      return { feature, branch: ctx.branch, escalated: true, batchPause: true, blocker: "usage_limit", reason: ctx.failureContext };
    }

    if (!review.pass) {
      reviewRejects++;
      ctx.failureContext =
        "Review panel rejected (review reject " + reviewRejects + " of " + K + ", pass " + pass +
        "; by: " + review.rejectedBy + "):\n" + review.critique;
      log(tag + ": review REJECTED (" + reviewRejects + "/" + K + ") by " + review.rejectedBy + ".");

      if (reviewRejects === K) {
        await postEscalation("Review", reviewRejects, ctx, tag);
        return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
      }

      impl = await agent(
        "AUTONOMOUS federated run, back to IMPLEMENT for feature '" +
          feature.title +
          "' after a REVIEW reject. Address EVERY blocking finding by fixing the ROOT CAUSE. " +
          "Do NOT weaken tests or shim to satisfy a reviewer.\n\n" +
          "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle; never leave more than one task's work uncommitted — if you are interrupted, committed work is the only work that survives.\n" +
          "BLOCKERS: if you hit an external condition you cannot fix — a missing/invalid credential, a dead daemon or service, a billing refusal, or an issue/spec too ambiguous to derive acceptance criteria from — STOP and return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise return blocker='none'.\n\n" +
          "Branch: " +
          ctx.branch +
          "\nReviewer critique:\n" +
          review.critique,
        { label: tag + ":reimplement", phase: "Fan-out", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
      );
      requireAgentResult(impl, "IMPLEMENT");
      ctx.branch = impl.branch;
      if (isExternalBlocker(impl.blocker)) {
        ctx.failureContext = impl.blockerDetail || ("blocker=" + impl.blocker);
        await pauseFeatureForHuman(feature, "Implement", impl.blocker, ctx);
        return { feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext };
      }
      continue; // counter-controlled
    }

    // PASS — every dispatched reviewer passed. Persist their verdicts (spec §5).
    dodReport = dod.report + "\n\n" + review.verdictSection;
    reviewed = true;
    log(tag + ": review panel PASSED on pass " + pass + ". Reviewed-green.");
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

const features = RUN_ARGS.features;
const devBranch = RUN_ARGS.devBranch || RUN_ARGS.branch;

// Resume support (added 2026-09-03; mirrors single-feature-run.js): the harness
// caches a completed agent() result by (prompt, opts), so a resumed run would
// replay a failed validate verdict verbatim unless the prompt changes. The
// nonce is folded into every feature's Validate prompt.
const resumeNonce = RUN_ARGS.resumeNonce ? String(RUN_ARGS.resumeNonce) : "";

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

// A batch-level pause request (added 2026-09-03) — e.g. a feature's review
// panel died incomplete, which most likely means the whole run hit a usage
// limit, not a problem isolated to that one feature. Handled AFTER the
// parallel() barrier (never from inside a thunk: parallel() absorbs any throw
// from a thunk into a null result, so throwing EscalationStop there would
// never actually stop the batch) — stop before Integrate/Ship touch anything.
const batchPauseRequest = outcomes.find((o) => o && o.batchPause);
if (batchPauseRequest) {
  await pauseForHuman(batchPauseRequest.blocker === "usage_limit" ? "Review" : "Fan-out", batchPauseRequest.blocker, {
    issue: devBranch,
    branch: batchPauseRequest.branch,
    prUrl: null,
    failureContext:
      batchPauseRequest.reason +
      "\n\n(Feature outcomes so far: " + green.length + " reviewed-green, " + escalated.length + " escalated.)",
  });
}

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

requireAgentResult(await agent(
  "AUTONOMOUS federated run, INTEGRATE phase (master-design-doc.md §7). Merge each reviewed-green feature branch " +
    "onto the shared dev branch '" +
    devBranch +
    "', one merge per feature, in order. Resolve any merge conflicts FAITHFULLY — never by discarding a " +
    "feature's work. Only these reviewed-green features may be merged (a shimmed feature must never reach the " +
    "shared branch):\n" +
    integrationManifest +
    "\n\nDo NOT touch main. Do NOT open a PR yet (that is the Ship phase).",
  { label: "integrate", phase: "Integrate" }
), "INTEGRATE");

// ---- PHASE 4: Ship — ONCE for the whole batch ------------------------------
phase("Ship");
const combinedReports = green
  .map((o) => "### Feature: " + o.feature.title + " (" + o.feature.id + ")\n\n" + o.dodReport)
  .join("\n\n---\n\n");

const ship = requireAgentResult(await agent(
  "AUTONOMOUS federated run, SHIP phase (master-design-doc.md §7). Push the NON-MAIN dev branch '" +
    devBranch +
    "' (never push main — the pre-push hook + settings forbid it) and open exactly ONE dev->main pull request " +
    "via the GitHub MCP server. The PR body MUST aggregate ALL the reviewed-green features' DoD reports (each " +
    "with its appended Reviewer Verdict). Return the PR URL. If the push or PR creation fails for an EXTERNAL " +
    "reason (auth, network, GitHub billing/permissions), return pushed=false with blocker='credentials'|'infra'|'billing' " +
    "and blockerDetail; otherwise blocker='none'.\n\nAggregated DoD reports (PR body):\n" +
    combinedReports,
  { label: "push-and-open-pr", phase: "Ship", schema: SHIP_SCHEMA }
), "SHIP");

if (isExternalBlocker(ship.blocker) || !ship.pushed || !ship.prUrl) {
  await pauseForHuman("Ship", isExternalBlocker(ship.blocker) ? ship.blocker : "infra", {
    issue: devBranch,
    branch: devBranch,
    prUrl: ship.prUrl || null,
    failureContext:
      ship.blockerDetail ||
      (!ship.pushed ? "push did not complete" : "PR was not opened (no URL returned)"),
  });
}

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
        "failed (include failing job names + a short log excerpt), 'pending' if still running. " +
        "If the PR reports no checks at all (the repository has no CI configured), that counts as 'green' — " +
        "do not wait for checks that will never start. " +
        "If a job failed before any step ran with an annotation about account payments, billing, or a spending limit " +
        "(check `gh api repos/{owner}/{repo}/check-runs/{id}/annotations`), return status 'red', blocker 'billing', " +
        "logsExcerpt = that annotation verbatim. Otherwise blocker 'none' for green/pending and 'code' for a red caused by the change.",
      { label: "poll-ci", phase: "CI", schema: CI_SCHEMA }
    );
    if (!ci) {
      // The poll agent died (usage-limit / harness). Leave the loop; the
      // null check below pauses for a human instead of dereferencing null.
      break;
    }
    if (ci.status === "green" || ci.status === "red") {
      terminal = true;
    } else {
      log("Batch CI still pending (poll " + poll + "/" + pollBudget + ").");
    }
  }

  if (!ci) {
    batchCtx.failureContext = "Batch CI poll agent died without returning a status (usage-limit or harness interruption).";
    await pauseForHuman("CI", "usage_limit", batchCtx);
  }
  if (isExternalBlocker(ci.blocker)) {
    batchCtx.failureContext = ci.blockerDetail || ci.logsExcerpt || ("blocker=" + ci.blocker);
    await pauseForHuman("CI", ci.blocker, batchCtx);
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
