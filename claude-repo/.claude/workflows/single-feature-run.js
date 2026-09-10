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
 *     0. DESIGN     one Opus pass over the issue, plan and the repo's stated
 *                   contracts; returns the constraints every later stage honours.
 *     1. IMPLEMENT  create the non-main branch; TDD (failing test -> implement
 *                   -> green -> refactor). Plan is either pre-approved (passed in
 *                   args) or drafted here when the surface is non-trivial.
 *     2. GATES      unit + lint + type-check in the run worktree at the pinned
 *                   commit (spec D2), before any reviewer or smoke spends money
 *                   on a red build. Failure loops back to IMPLEMENT (capped at K).
 *     3. REVIEW     the review panel (adversarial + correctness always; opt-in
 *                   security/performance), fixed inputs (diff + gate results),
 *                   structured VERDICT. The FIRST round reviews the full diff;
 *                   every later round is a DELTA review over just the previous
 *                   panel's own open findings (spec D3). Reject -> hand the
 *                   critique back to an implementing agent and retry (capped at
 *                   K). Pass -> append the verdict to the DoD report as
 *                   `## Reviewer Verdict` (spec §5, verdict persistence).
 *     4. VALIDATE   integration + regression, THEN a smoke test (happy path +
 *                   every named edge + plausible failure modes) per
 *                   reference/definition-of-done.md. A failure re-runs only the
 *                   failed cases plus anything touching the same files
 *                   (incremental smoke, spec D4) and re-enters review as a
 *                   delta. Produce the DoD report. Failure loops back to
 *                   IMPLEMENT (capped at K, its own budget from Review's).
 *     5. SHIP       push the non-main branch; open the dev->main PR via MCP, with
 *                   the DoD report (+ verdict) as the body.
 *     6. CI         poll GitHub Actions. Red -> read logs, fix, re-push, re-validate
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
    "Autonomous single-feature dev cycle (D2 as a workflow): design review -> TDD implement -> gates -> review -> validate + DoD report -> push + PR -> CI, with every retry loop capped at K=3 and escalation to the feature GitHub issue on exhaustion.",
  phases: [
    {
      title: "Design",
      detail:
        "One Opus pass over the issue, plan and the repo's stated contracts; returns the constraints the implementer and reviewers must honour.",
    },
    {
      title: "Implement",
      detail:
        "Create the non-main branch and do TDD: write a failing test, implement to green, refactor. Plan is pre-approved (from args) or drafted here for non-trivial surfaces.",
    },
    {
      title: "Gates",
      detail:
        "Run unit + lint + type-check in the run worktree at the pinned commit (spec D2), before any reviewer or smoke spends money on a red build. Failure loops back to Implement, capped at K=3.",
    },
    {
      title: "Review",
      detail:
        "Run the review panel (adversarial + correctness always; security/performance opt-in via reviewers) before the smoke: the first round reconstructs the full diff, every later round reviews only the delta over each seat's own open findings (spec D3). A reject hands the aggregated critique back to an implementing agent and retries, capped at K=3. Pass appends the verdicts to the DoD report.",
    },
    {
      title: "Validate",
      detail:
        "Once gates and review are green, run integration + regression, then a smoke test (happy path + every named edge + plausible failure modes) and produce a DoD report. A failure re-runs only the affected cases (incremental smoke, spec D4) and loops back to Implement, capped at K=3.",
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
          // Stable across rounds so a DELTA review can resolve it by id (spec D3).
          id: { type: "string" },
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
    // DELTA review only: the disposition of each of the seat's own prior open
    // findings (spec D3). Absent/empty on a full review.
    resolved: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "status"],
      properties: { id: { type: "string" }, status: { type: "string", enum: ["addressed", "partially", "unaddressed"] }, note: { type: "string" } } } },
    // The panel's judgment on each deferral the implementer claimed (no-shed):
    // an unaccepted deferral is itself a blocking finding.
    deferralVerdicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "accepted"],
      properties: { id: { type: "string" }, accepted: { type: "boolean" }, note: { type: "string" } } } },
  },
};

// The DoD report payload (reference/definition-of-done.md report contract). The
// workflow branches on `gatesPass`; `report` is the markdown that travels to the PR.
const DOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gatesPass", "report", "tests", "smokeAllPass", "cases", "blocker"],
  properties: {
    // True only when the integration + regression suites at this commit pass
    // (unit, lint and type-check are the separate Gates stage — GATES_SCHEMA
    // — and are already green before Validate ever runs). `smokeAllPass`
    // covers the smoke test (happy path + named edges + failure modes).
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
    // Per-case smoke results (spec D4). Ids are stable across attempts so a
    // failed case can be re-run by name; `carried` marks a case NOT re-run in
    // an incremental smoke (its `pass` is the last real result).
    cases: {
      type: "array", minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["id", "name", "pass"],
        properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, pass: { type: "boolean" },
          carried: { type: "boolean" }, detail: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    },
    // Reason a gate failed, fed back to the implementer as retry context.
    failureContext: { type: "string" },
    // The full DoD-report markdown (Changes / Tests / Smoke transcript / Docs /
    // Follow-ups) per reference/definition-of-done.md.
    report: { type: "string" },
    ...BLOCKER_PROPS,
  },
};

// The gates result (spec D2): the deterministic checks, run in the run
// worktree at the pinned commit, before any reviewer or smoke spends money on
// a red build. Not a mechanical step: which commands to run is repository
// knowledge, so this is a low-effort agent, and args.gateCommands can pin them.
const GATES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["pass", "unit", "lint", "typecheck", "blocker"],
  properties: { pass: { type: "boolean" }, unit: { type: "string" }, lint: { type: "string" }, typecheck: { type: "string" }, failureContext: { type: "string" }, ...BLOCKER_PROPS },
};

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

// Shared by every implement prompt (spec D1).
const HEAD_SHA_CLAUSE =
  "BRANCH CONTRACT: work on the named branch. If git refuses to check it out because another worktree holds it, " +
  "commit on your worktree's own branch instead — never fail for this, never create any other branch — and report " +
  "that branch as `worktreeBranch`. In every case return `headSha` = the full 40-hex commit your work ends at " +
  "(`git rev-parse HEAD` after your last commit) and `branch` = the name you were given.\n";

function constraintsClause(ctx) {
  if (!ctx.constraints.length) return "";
  return "DESIGN CONSTRAINTS (from the design review; each cites its source — honour every one, and say so if one cannot be honoured):\n" +
    ctx.constraints.map((c, i) => "  C" + (i + 1) + ". " + c.text + "  [" + c.source + "]").join("\n") + "\n";
}

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
    return "You are the ADVERSARIAL reviewer. Refute-first: PROVE this is not actually done. Hunt for skipped/weakened tests, swallowed errors, hardcoded/stubbed returns, cast-to-None, narrowed assertions, unaddressed root cause, missing named edge cases, and dishonest claims in the implementer's summary, filesTouched and deferrals; re-run the gates yourself in the run worktree and compare to the CLAIMED gate results.";
  if (agentType === "correctness-reviewer")
    return "You are the CORRECTNESS reviewer. Trace the real code and find logic errors, bad boundary/edge handling, null/empty mishandling, mishandled error paths, races, and contract/invariant violations. Passing tests is not correctness.";
  if (agentType === "security-reviewer")
    return "You are the SECURITY reviewer. Trace untrusted-data flow and find real, exploitable defects (injection, broken authz/IDOR, secret/crypto misuse, missing validation/encoding, data exposure, unsafe config). Name the attack path.";
  if (agentType === "performance-reviewer")
    return "You are the PERFORMANCE reviewer. Find real defects that bite at realistic scale (accidental O(n^2), N+1/per-iteration I/O, unbounded growth, redundant work, resource leaks). Name the triggering scale.";
  return "Review this change and return the structured verdict.";
}

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

  // An incomplete panel must never pass: a dead reviewer (null result) is not a
  // pass-by-absence. Without this, a panel whose reviewers all die (e.g. on a
  // usage-limit cap) has zero rejections and the feature vacuously "passes"
  // review that never happened (#76).
  const expected = selectedReviewers().length;
  const valid = results.filter((r) => r.v && r.v.verdict);
  if (valid.length < expected) {
    return { pass: false, incomplete: true, rejectedBy: "incomplete-panel(" + valid.length + "/" + expected + ")",
      critique: "### review-infrastructure\nOnly " + valid.length + " of " + expected + " reviewers returned a verdict. An incomplete panel can never pass; the panel must re-run." };
  }
  // Update each seat's ledger: new findings are opened, resolved ones are closed.
  for (const r of valid) {
    const ledger = ctx.findings[r.agentType] || (ctx.findings[r.agentType] = {});
    for (const f of r.v.findings || []) {
      // A finding without an id is still real — default one rather than drop it.
      const id = f.id || ("F" + (Object.keys(ledger).length + 1));
      ledger[id] = { ...f, id, status: "open" };
    }
    for (const x of r.v.resolved || []) if (ledger[x.id]) ledger[x.id].status = x.status;
    for (const d of r.v.deferralVerdicts || []) {
      // Store and render the SAME id ("deferral-" + d.id) so a later `resolved`
      // naming that rendered id actually matches this ledger entry.
      if (!d.accepted) ledger["deferral-" + d.id] = { id: "deferral-" + d.id, severity: "blocking", category: "no-shed", detail: "deferral rejected: " + (d.note || ""), status: "open" };
      const claim = ctx.minorsDeferred.find((m) => m.id === d.id);
      if (claim) {
        ctx.minorsDeferred = ctx.minorsDeferred.filter((m) => m.id !== d.id);
        if (d.accepted) ctx.acceptedDeferrals.push({ id: claim.id, reason: claim.reason, note: d.note });
      }
    }
  }
  const rejected = valid.filter((r) => r.v.verdict === "reject" || (r.v.deferralVerdicts || []).some((d) => !d.accepted));
  if (rejected.length === 0) {
    return { pass: true, verdictSection: valid.map((r) => r.v.verdictSection || ("## Reviewer Verdict\nPASS — " + r.agentType + ".")).join("\n\n") };
  }
  const critique = rejected.map((r) => "### " + r.agentType + "\n" + (r.v.summary || "") + "\n" +
    renderFindings(Object.values(ctx.findings[r.agentType]).filter((f) => f.status !== "addressed"))).join("\n\n");
  return { pass: false, critique, rejectedBy: rejected.map((r) => r.agentType).join(", ") };
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
  try { await cleanupWorktrees(context, stage, "escalate " + stage); } catch (e) { log("cleanup before escalation failed: " + e.message); }
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
  try { await cleanupWorktrees(context, stage, "pause " + stage); } catch (e) { log("cleanup before pause failed: " + e.message); }
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

// ---------------------------------------------------------------------------
// Mechanical steps (spec: Constraints). The DSL has no shell, so every
// deterministic git/gh action is an agent with a fixed command list, low
// effort, and a schema. Each prompt embeds the pass and the commit it acts
// on, because the harness caches results by prompt (cache rule).
// ---------------------------------------------------------------------------
const MECHANICAL_PREAMBLE =
  "MECHANICAL STEP — run exactly the commands below, in order. Do not improvise, do not fix anything, " +
  "do not run any other command. Return only the structured result.\n\n";

// Recursion guard: cleanupWorktrees calls mechanical(), which calls
// pauseForHuman() on a dead agent, which itself calls cleanupWorktrees() as
// its first statement. Without this guard a dead cleanup agent would recurse
// once into pauseForHuman's own cleanup call.
let cleaningUp = false;

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

/** The run owns a branch when it works on a named feature branch — either the
 * one it was given to resume (`existingBranch`) or the one its first
 * implement created (spec D1). */
function runOwnsBranch(ctx) {
  return ctx.branch !== devBranch;
}

/** Detach every worktree that holds ctx.branch so the next implementer can
 * check it out; the detached paths become run-owned (spec D1, D6). `tag`
 * distinguishes an explicit pre-dispatch detach (e.g. reimplement's own call)
 * from the one reconcileBranch issues for itself, so two calls in the same
 * pass at the same head never produce a byte-identical, cache-colliding
 * prompt. */
async function detachWorktrees(ctx, phaseName, pass, tag = "reconcile") {
  if (!runOwnsBranch(ctx)) return { ok: true, detached: [] };
  const r = await mechanical(ctx, "detach-worktrees", phaseName,
    "(pass " + pass + ", " + tag + ", head " + (ctx.headSha || "none") + ")\n" +
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
  await detachWorktrees(ctx, phaseName, pass);
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
  if (cleaningUp) return { ok: true, removed: [] };
  cleaningUp = true;
  try {
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
  } finally {
    cleaningUp = false;
  }
}

/** One reimplement dispatch with its fixed surrounding steps: detach, the
 * implementer, reconcile, pin (spec D1, D5). Blocking findings first, minors
 * as separate commits; a deferral is a claim the panel judges (no-shed). */
async function reimplement(label, why, context, pass) {
  await detachWorktrees(ctx, "Implement", pass, "before-implement");
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
  // Record worktreeBranch BEFORE the blocker check: pauseForHuman() cleans up
  // worktrees immediately, and a blocked-but-committed implementer's side
  // branch must be registered first or cleanup never sees it (the
  // first-implement site already does this order).
  if (r.worktreeBranch) ctx.worktreeBranches.push(r.worktreeBranch);
  if (isExternalBlocker(r.blocker)) {
    ctx.failureContext = r.blockerDetail || ("blocker=" + r.blocker);
    await pauseForHuman("Implement", r.blocker, ctx);
  }
  ctx.minorsDeferred = ctx.minorsDeferred.concat(r.minorsDeferred || []);
  if (r.headSha === before) {
    // Nothing was committed: the next pass would replay cached gate results forever.
    ctx.lastReimplementNote = "reimplement produced no new commit at " + before + "; the previous failure stands";
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
      "ACCEPTED DEFERRALS (list each under ## Follow-ups): " + (ctx.acceptedDeferrals.length ? ctx.acceptedDeferrals.map((d) => d.id + ": " + d.reason).join("; ") : "none") + "\n" +
      "gatesPass is true ONLY if every suite passed; smokeAllPass ONLY if every case in `cases` has pass=true.\n\n" +
      "Feature: " + featureDescription + "\nLinked issue: " + issueRef,
    { label: "validate-and-dod", phase: "Validate", model: "sonnet", schema: DOD_SCHEMA }
  );
}

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
    "(PR " + ctx.prUrl + ", head " + ctx.headSha + (resumeNonce ? ", resume " + resumeNonce : "") + ")\n" +
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
  try { await cleanupWorktrees(ctx, "CI", "ci skipped"); } catch (e) { log("cleanup before CI-skip return failed: " + e.message); }
  log("CI skipped (" + why + "). PR awaits Gate B: " + ctx.prUrl);
  return { prUrl: ctx.prUrl, branch: ctx.branch, headSha: ctx.headSha, issue: issueRef, ciSkipped: "quota" };
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
const gateCommands = RUN_ARGS.gateCommands && typeof RUN_ARGS.gateCommands === "object" ? RUN_ARGS.gateCommands : null;

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
  branch: existingBranch || devBranch,        // becomes the feature branch after the first implement result
  headSha: null,
  runWorktree: null,        // the run-owned checkout every later stage works in (spec D1)
  ownedWorktrees: [],       // paths this run created or detached — the only ones cleanup may remove
  worktreeBranches: [],     // side branches implementers reported
  minorsDeferred: [],
  acceptedDeferrals: [],    // deferral claims a review panel accepted ({ id, reason, note })
  constraints: [],
  gateSummary: "",
  failedCases: [],
  lastSmokeSha: null,
  prevReviewSha: null,
  lastCritique: null,       // the standing critique when prevReviewSha === headSha (no new commit landed)
  findings: {},             // per reviewer seat: id -> finding, the delta-review ledger (spec D3)
  reviewVerdictSection: "",
  prUrl: null,
  failureContext: "",
  lastReimplementNote: null,
};

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

// ---------------------------------------------------------------------------
// PHASE 1+2+3+4 — Implement / Gates / Review / Validate.
//
// After the first implement, Gates, Review and Validate form ONE loop
// (reimplement()), reordered per spec D2-D5: gates run first so a red build
// never reaches a reviewer or a smoke; review runs before the smoke, in DELTA
// mode over each seat's own open findings from its second round on; the smoke
// only runs once gates AND review are both green for the current commit, and
// re-runs incrementally (spec D4) after a failure. A gates failure, a review
// reject, and a smoke failure all send control back to implementation via
// reimplement() — but they spend TWO INDEPENDENT budgets, not one:
// validateFailures (gates + smoke, both code failures) and reviewRejects
// (panel rejects), each capped at K. We never re-enter without spending an
// attempt; the counters are the only thing that decide whether we loop, never
// an agent.
// ---------------------------------------------------------------------------

phase("Implement");

// Branch creation + first TDD pass. Plan handling per Gate A (§4): pre-approved
// short-circuits planning; otherwise the agent drafts a plan for non-trivial
// surfaces (trivial tasks skip planning, master-design-doc.md §14.1).
const planClause = preApprovedPlan
  ? "A plan was pre-approved at Gate A; follow it:\n" + preApprovedPlan + "\n"
  : "No plan was pre-approved. If the surface is non-trivial (anything beyond a <=10-line, single-file, no-behavior-change edit per master-design-doc.md §14.1), draft a short plan first, then implement it.\n";

await detachWorktrees(ctx, "Implement", 0, "before-implement");

const implementResult = await agent(
  "AUTONOMOUS single-feature run, IMPLEMENT phase (master-design-doc.md §5, D2).\n" +
    "Create a NON-MAIN branch off '" +
    devBranch +
    "' named per branch-lifecycle conventions (dev/feat/fix/chore/...). NEVER touch main. " +
    "Then do TDD: write a FAILING test that pins the desired behavior, implement until it is green, then refactor. " +
    "Fix in-scope bugs in this change (no-shed); file only genuinely orthogonal bugs as cross-linked GH issues.\n\n" +
    planClause +
    constraintsClause(ctx) +
    (existingBranch
      ? "A branch for this feature ALREADY EXISTS: '" + existingBranch + "'. Check it out in your worktree and CONTINUE from its tip — never create a fresh branch, never redo work already committed there.\n"
      : "") +
    HEAD_SHA_CLAUSE +
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
ctx.headSha = implementResult.headSha;
if (implementResult.worktreeBranch) ctx.worktreeBranches.push(implementResult.worktreeBranch);
ctx.minorsDeferred = ctx.minorsDeferred.concat(implementResult.minorsDeferred || []);
await reconcileBranch(ctx, implementResult, "Implement", 0);
await pinRunWorktree(ctx, "Implement", 0);
if (isExternalBlocker(implementResult.blocker)) {
  ctx.failureContext = implementResult.blockerDetail || ("blocker=" + implementResult.blocker);
  await pauseForHuman("Implement", implementResult.blocker, ctx);
}
log("Implementation branch: " + ctx.branch + ". Entering the validate/review loop (cap K=" + K + ").");

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
    if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
    await reimplement("reimplement-after-validate", "back to IMPLEMENT after a GATES failure", ctx.failureContext, pass);
    continue;
  }
  ctx.gateSummary = "unit: " + g.unit + "; lint: " + g.lint + "; typecheck: " + g.typecheck;

  // ---- REVIEW (spec D2/D3): before the smoke; delta mode whenever a prior round exists ----
  if (reviewPassedAt !== ctx.headSha) {
    phase("Review");
    if (ctx.prevReviewSha === ctx.headSha && ctx.lastCritique) {
      // The standing critique is the verdict: nothing new to review — the last
      // reimplement produced no new commit, so re-dispatching the panel here
      // would be a byte-identical prompt (cache collision) reviewing a
      // degenerate `git diff SHA..SHA`. The prior rejection still stands.
      reviewRejects++;
      ctx.failureContext = "Review panel's standing rejection at " + ctx.headSha + " (reject " + reviewRejects + " of " + K + ", pass " + pass + "):\n" + ctx.lastCritique;
      if (reviewRejects === K) await escalate("Review", reviewRejects, ctx);
      if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
      await reimplement("reimplement-after-review", "back to IMPLEMENT after a REVIEW reject", ctx.failureContext, pass);
      continue;
    }
    const mode = ctx.prevReviewSha ? { prevSha: ctx.prevReviewSha } : "full";
    const review = await runReviewPanel("AUTONOMOUS single-feature run,", ctx, devBranch, "GATE RESULTS at " + ctx.headSha + " (pass " + pass + "): " + ctx.gateSummary, mode);
    if (review.incomplete) { ctx.failureContext = review.critique; await pauseForHuman("Review", "usage_limit", ctx); }
    ctx.prevReviewSha = ctx.headSha; // any later round is a delta over this commit
    if (!review.pass) {
      reviewRejects++;
      ctx.failureContext = "Review panel rejected (reject " + reviewRejects + " of " + K + ", pass " + pass + ", by: " + review.rejectedBy + "):\n" + review.critique;
      ctx.lastCritique = review.critique;
      if (reviewRejects === K) await escalate("Review", reviewRejects, ctx);
      if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
      await reimplement("reimplement-after-review", "back to IMPLEMENT after a REVIEW reject", ctx.failureContext, pass);
      continue;
    }
    ctx.lastCritique = null;
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
    ctx.failureContext = "Smoke failed (code failure " + validateFailures + " of " + K + ", pass " + pass + "): " + (dod.failureContext || ctx.failedCases.map((c) => c.id + " " + c.name).join(", ") || "integration or regression suites did not pass");
    if (validateFailures === K) await escalate("Validate", validateFailures, ctx);
    if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
    await reimplement("reimplement-after-validate", "back to IMPLEMENT after a SMOKE failure", ctx.failureContext, pass);
    continue;
  }
  dodReport = dod.report + "\n\n" + ctx.reviewVerdictSection;
  reviewed = true;
  log("Gates, review and smoke green at " + ctx.headSha + ".");
}

// If the loop exited without a review pass and without escalating, that is a bug
// in the cap logic — fail loud rather than ship unreviewed work.
if (!reviewed || !dodReport) {
  throw new Error(
    "Internal invariant violated: validate/review loop ended without a passing review and without escalation."
  );
}

// ---------------------------------------------------------------------------
// PHASE 5 — SHIP. Push the non-main branch and open the dev->main PR.
// ---------------------------------------------------------------------------
phase("Ship");
const ship = requireAgentResult(await agent(
  "AUTONOMOUS single-feature run, SHIP phase (master-design-doc.md §5, D2). " +
    "Push the NON-MAIN branch '" +
    ctx.branch +
    "' (at commit " + ctx.headSha + "; verify with `git rev-parse " + ctx.branch + "` that the branch points at " + ctx.headSha + " before pushing) to origin (the pre-push hook + settings allow tier branches; main is forbidden). " +
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
await scrubPrBody(ctx);

// ---------------------------------------------------------------------------
// PHASE 6 — CI. Poll GitHub Actions; on red, fix + re-push, capped at K.
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

const quota = await checkQuota(ctx);
if (quota.quota === "exhausted") return await finishWithoutCi(ctx, "the GitHub Actions quota is exhausted (" + quota.detail + ")");

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
        "')" + " at commit " + ctx.headSha +
        " via the GitHub MCP server. " +
        "Return status 'green' if all required checks passed, 'red' if a required check failed, 'pending' if still running. " +
        "If the PR reports no checks at all (the repository has no CI configured), that counts as 'green' — " +
        "do not wait for checks that will never start. " +
        "On 'red', include the failing job names and a short excerpt of the failure logs. " +
        "If a job failed before any step ran with an annotation about account payments, billing, or a spending limit (check `gh api repos/{owner}/{repo}/check-runs/{id}/annotations`), return status 'red', blocker 'billing', logsExcerpt = that annotation verbatim. Otherwise blocker 'none' for green/pending and 'code' for a red caused by the change." +
        " (poll " + poll + "/" + pollBudget + ", fix attempt " + fixAttempt + ")",
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
  if (ci.blocker === "billing") return await finishWithoutCi(ctx, "GitHub reported a billing/quota refusal: " + (ci.logsExcerpt || ci.blockerDetail || "").slice(0, 200));
  if (isExternalBlocker(ci.blocker)) { ctx.failureContext = ci.blockerDetail || ci.logsExcerpt || ("blocker=" + ci.blocker); await pauseForHuman("CI", ci.blocker, ctx); }

  if (!ci || !terminal) {
    ctx.failureContext =
      "CI did not reach a terminal state within the poll budget on fix attempt " + fixAttempt + ".";
    await escalate("CI", fixAttempt, ctx);
  }

  if (ci.status === "green") {
    ciGreen = true;
    prUrl = ctx.prUrl;
    log("CI is GREEN. PR ready for Gate B (human merge): " + prUrl);
    try { await cleanupWorktrees(ctx, "CI", "ci green"); } catch (e) { log("cleanup before CI-green return failed: " + e.message); }
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

  await detachWorktrees(ctx, "CI", 100 + fixAttempt, "before-implement");
  const fix = requireAgentResult(await agent(
    "AUTONOMOUS run, CI-RED fix (master-design-doc.md §5; reference/definition-of-done.md CI-red delta) — fix attempt " + fixAttempt + ". " +
      "On branch '" + ctx.branch + "' at " + ctx.headSha + ", read the failing CI logs, fix the ROOT CAUSE (no shim, no weakened test, no skipped check), " +
      "re-validate the affected cases as a delta, then re-push the non-main branch. Do NOT touch main.\n" + HEAD_SHA_CLAUSE + "\nFailure context:\n" + ctx.failureContext,
    { label: "fix-ci-and-repush", phase: "CI", model: "sonnet", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
  ), "CI FIX");
  // Record worktreeBranch BEFORE the blocker check: pauseForHuman() cleans up worktrees immediately, and a blocked-but-committed fix's side branch must be registered first or cleanup never sees it (same order as reimplement() and the first-implement site).
  if (fix.worktreeBranch) ctx.worktreeBranches.push(fix.worktreeBranch);
  if (isExternalBlocker(fix.blocker)) { ctx.failureContext = fix.blockerDetail || ("blocker=" + fix.blocker); await pauseForHuman("CI", fix.blocker, ctx); }
  await reconcileBranch(ctx, fix, "CI", 100 + fixAttempt);
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
return { prUrl: prUrl, branch: ctx.branch, headSha: ctx.headSha, issue: issueRef };
