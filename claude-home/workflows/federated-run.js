/*
 * federated-run.js — the autonomous federated multi-feature run (D4).
 *
 * WHAT THIS IS
 *   ONE Claude workflow (master-design-doc.md §7, diagram D4). Given a feature list and
 *   a target dev branch, it fans out one worktree-isolated CORE per feature — the
 *   SAME re-sequenced D2 core single-feature-run.js uses (design review -> TDD
 *   implement -> commit-pinned detach/reconcile/pin -> gates -> review panel ->
 *   incremental smoke/DoD) — run CONCURRENTLY, then integrates the reviewed-green
 *   features onto the dev branch, pushes dev, opens ONE dev->main PR carrying ALL
 *   the DoD reports, and drives CI green.
 *
 *   Per §7 reading notes: D4 NESTS D3 (one "Work" iteration) and contains N CORES
 *   of D2 run CONCURRENTLY — not N full D2s. The Integrate / Ship / CI / Gate-B
 *   tail runs ONCE for the whole batch, never per feature.
 *
 * PORT NOTE (2026-09-09, Task 10 of the workflow-resequencing plan)
 *   This file used to run one combined VALIDATE step per feature (gates+smoke in
 *   one agent call) with a single shared retry counter, and no design review or
 *   commit-pinning. It is now ported to single-feature-run.js's re-sequenced core
 *   verbatim (see that file's own header for the full rationale), helper bodies
 *   copied because the DSL has no imports, with exactly these adaptations:
 *
 *     - every per-feature label is prefixed "feat:<id>:" (ctx.tag) so concurrent
 *       features' agent() calls never collide, including the review panel seats
 *       (`feat:f1:adversarial-reviewer`, not `adversarial-reviewer`);
 *     - EscalationStop (single script's one non-success terminal) splits into
 *       FeatureStop, a non-fatal per-feature terminal caught inside
 *       processFeature and turned into an `escalated` outcome so the batch
 *       continues, and EscalationStop, kept for the one batch-level terminal
 *       (CI on the single dev->main PR);
 *     - each ctx (one per feature, one for the batch) carries its own `fail`
 *       function so the copied helpers (mechanical, reconcileBranch,
 *       pinRunWorktree, reimplement, runGates, runValidate, the loop's budget
 *       exhaustion) have one call to make regardless of which ctx they're
 *       running against: a feature ctx's fail() pauses/escalates just THAT
 *       feature (non-throwing — pauseFeatureForHuman / postEscalation) and
 *       excludes it from the batch; the batch ctx's fail() pauses/escalates the
 *       WHOLE run exactly as single-feature-run.js does (throwing);
 *     - the `cleaningUp` re-entrancy guard moves from a module-level flag to
 *       `ctx.cleaningUp` (concurrent features must not share one guard);
 *     - the per-feature cleanupWorktrees never runs `git worktree prune` — many
 *       features share one repository, so pruning is a BATCH-level step
 *       (cleanupBatchWorktrees) run once after the fan-out barrier and once
 *       more at each CI exit;
 *     - BEHAVIOUR CHANGE: processFeature moves from one shared attempt counter
 *       to the two independent budgets (validateFailures, reviewRejects, each
 *       capped K, at most 2K passes) single-feature-run.js has used since its
 *       own PR #8 — a feature that spent attempts getting Gates/Validate green
 *       still gets a full K-budget review loop, not a shared remainder.
 *
 *   The old ad-hoc "review panel incomplete -> batchPause" shortcut is retired:
 *   an incomplete panel is now just an external `usage_limit` blocker on THAT
 *   feature, routed through the same ctx.fail as every other blocker (it used
 *   to post to `issue: devBranch`, which is a branch name, not a GitHub issue —
 *   a latent bug). If every feature hits this at once (e.g. a real usage-limit
 *   kill), every feature is independently paused and the batch correctly ships
 *   nothing, which is at least as informative as the one broken batch comment
 *   it replaces.
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
 *   must carry the full set. Each per-feature agent() call passes phase EXPLICITLY
 *   in its opts (opts.phase) — never the global phase() — because features run
 *   concurrently and would otherwise race the shared phase state; the global
 *   phase() is reserved for the batch-level, strictly serial stages (Integrate,
 *   Ship, CI).
 */

export const meta = {
  name: "federated-run",
  description:
    "Autonomous federated multi-feature run (D4): fan out one worktree-isolated agent per feature running the re-sequenced D2 core (design review -> TDD implement -> commit-pinned detach/reconcile/pin -> gates -> review panel -> incremental smoke/DoD), each feature spending its own two independent K=3 budgets (validate failures, review rejects), then integrate the reviewed-green features, push dev and open ONE dev->main PR with all DoD reports and drive CI green. Per-feature exhaustion escalates that feature and excludes it from the batch; batch CI exhaustion is terminal.",
  phases: [
    { title: "Design", detail: "One Opus pass per feature over its issue, plan and the repo's stated contracts; returns the constraints that feature's implementer and reviewers must honour." },
    { title: "Implement", detail: "Create the feature's non-main branch and do TDD: a failing test, implement to green, refactor. Runs in a worktree-isolated agent, concurrently with every other feature." },
    { title: "Gates", detail: "Per feature: unit + lint + type-check in that feature's pinned run worktree, before any reviewer or smoke spends money on a red build. Failure loops back to Implement, capped K=3 (validateFailures)." },
    { title: "Review", detail: "Per feature: the review panel (adversarial + correctness always; security/performance opt-in), full diff on the first round then DELTA over each seat's own open findings (spec D3). Reject hands the critique back to an implementing agent, capped K=3 (reviewRejects)." },
    { title: "Validate", detail: "Per feature, once gates and review are both green: integration + regression, then a smoke test (happy path + every named edge + failure modes), producing a DoD report. A failure re-runs incrementally (spec D4) and loops back to Implement, capped K=3 (validateFailures, shared with Gates)." },
    { title: "Fan-out", detail: "Only reached if a feature's own dispatch throws something other than its normal pause/escalate outcome (e.g. a terminal API error): the fan-out wrapper best-effort escalates and cleans up that feature so it is still surfaced to a human, never silently dropped." },
    { title: "Integrate", detail: "Merge each reviewed-green feature branch onto the shared dev branch, one merge per feature, in order. Serial — runs once for the whole batch after the fan-out barrier." },
    { title: "Ship", detail: "Push the dev branch and open exactly ONE dev->main pull request via the GitHub MCP server, aggregating every reviewed-green feature's DoD report." },
    { title: "CI", detail: "Poll GitHub Actions for the one batch PR. On red, fix + re-push (reconciled like any implement, per the single script's own CI fix), capped K=3. Exhaustion is terminal for the whole batch." },
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
// (routed through that feature's ctx.fail -> pauseFeatureForHuman) excludes
// just that feature from the batch. A BATCH-level blocker (routed through the
// batch ctx's fail -> pauseForHuman/escalate) throws EscalationStop and stops
// the whole run — Integrate/Ship/CI run once for the whole batch, so there is
// no single feature to exclude at that point. Control flow branches on this
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

// M1: a gateCommands object missing (or emptying) one of the three keys
// runGates reads must never be used partially — that embeds the literal
// string "undefined" into the gates prompt. Fall back to the
// documented-commands branch instead, and say which key was missing.
function validGateCommands(gc) {
  if (!gc || typeof gc !== "object") return null;
  const missing = ["unit", "lint", "typecheck"].filter((k) => typeof gc[k] !== "string" || gc[k].length === 0);
  if (missing.length) {
    log("args.gateCommands is missing/empty key(s) " + missing.join(", ") + " — falling back to the repository's documented gate commands.");
    return null;
  }
  return gc;
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
// JSON Schemas (plain JS objects). Copied verbatim from single-feature-run.js
// (one shared contract across both workflows) so control flow branches on
// data, not on free text an agent could fudge.
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

const DETACH_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "detached"],
  properties: { ok: { type: "boolean" }, detached: { type: "array", items: { type: "string" } }, detail: { type: "string" } } };
const RECONCILE_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "sha", "detail"],
  properties: { ok: { type: "boolean" }, sha: { type: "string", pattern: "^[0-9a-f]{40}$" }, detail: { type: "string" } } };
const PIN_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "path", "sha"],
  properties: { ok: { type: "boolean" }, path: { type: "string" }, sha: { type: "string", pattern: "^[0-9a-f]{40}$" }, detail: { type: "string" } } };
const CLEANUP_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "removed"],
  properties: { ok: { type: "boolean" }, removed: { type: "array", items: { type: "string" } }, detail: { type: "string" } } };
const SCRUB_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "changed"], properties: { ok: { type: "boolean" }, changed: { type: "boolean" }, detail: { type: "string" } } };
const QUOTA_SCHEMA = { type: "object", additionalProperties: false, required: ["quota", "detail"], properties: { quota: { type: "string", enum: ["ok", "exhausted", "unknown"] }, detail: { type: "string" } } };

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

/** Prefix an agent label with the ctx's feature tag ("feat:<id>:") so
 * concurrent features' agent() calls never collide. The batch ctx has no
 * `tag` — its labels (push-and-open-pr, scrub-pr-body, quota-check, poll-ci,
 * fix-ci-and-repush, cleanup-worktrees, detach-worktrees, reconcile-branch,
 * pin-run-worktree) stay unprefixed. */
function tagLabel(ctx, label) {
  return ctx && ctx.tag ? ctx.tag + ":" + label : label;
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

/** Run the review panel against ONE feature's ctx. Ported verbatim from
 * single-feature-run.js's runReviewPanel: full diff on the first round, DELTA
 * (each seat's own open findings) on every later round (spec D3); deferrals
 * are judged, not assumed (no-shed). The only adaptation is the reviewer
 * label, prefixed with ctx.tag so concurrent features' seats never collide. */
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
      { label: tagLabel(ctx, agentType), phase: "Review", agentType: agentType, model: "opus", schema: VERDICT_SCHEMA }
    ).then((v) => ({ agentType, v }));
  }))).filter(Boolean);

  // An incomplete panel must never pass: a dead reviewer (null result) is not a
  // pass-by-absence. Without this, a panel whose reviewers all die (e.g. on a
  // usage-limit cap) has zero rejections and the feature vacuously "passes"
  // review that never happened (#76). The caller treats an incomplete panel as
  // a `usage_limit` blocker on THIS feature (ctx.fail), not a batch-wide event.
  const expected = selectedReviewers().length;
  const valid = results.filter((r) => r.v && r.v.verdict);
  if (valid.length < expected) {
    return { pass: false, incomplete: true, rejectedBy: "incomplete-panel(" + valid.length + "/" + expected + ")",
      critique: "### review-infrastructure\nOnly " + valid.length + " of " + expected + " reviewers returned a verdict. An incomplete panel can never pass; the panel must re-run." };
  }
  // Update each seat's ledger: new findings are opened, resolved ones are closed.
  const deferralVerdictsById = {}; // M2: gathered across ALL seats before deciding acceptance
  for (const r of valid) {
    const ledger = ctx.findings[r.agentType] || (ctx.findings[r.agentType] = {});
    for (const f of r.v.findings || []) {
      // A finding without an id is still real — default one rather than drop
      // it. M3: increment past any id already used in THIS seat's ledger — a
      // gapped ledger (e.g. F1 closed, a later round opens a fresh F1-shaped
      // finding) must never let two findings collide on the same defaulted id.
      let id = f.id;
      if (!id) {
        let n = Object.keys(ledger).length + 1;
        id = "F" + n;
        while (ledger[id]) id = "F" + (++n);
      }
      ledger[id] = { ...f, id, status: "open" };
    }
    for (const x of r.v.resolved || []) if (ledger[x.id]) ledger[x.id].status = x.status;
    for (const d of r.v.deferralVerdicts || []) {
      // Store and render the SAME id ("deferral-" + d.id) so a later `resolved`
      // naming that rendered id actually matches this ledger entry.
      if (!d.accepted) ledger["deferral-" + d.id] = { id: "deferral-" + d.id, severity: "blocking", category: "no-shed", detail: "deferral rejected: " + (d.note || ""), status: "open" };
      (deferralVerdictsById[d.id] || (deferralVerdictsById[d.id] = [])).push(d);
    }
  }
  // M2: a rejection by ANY judging seat vetoes the accept — decide once every
  // seat's verdict on this deferral id is known, not seat-by-seat. The old
  // code let whichever seat processed first remove the claim from
  // ctx.minorsDeferred, so a later seat's rejection on the SAME id never
  // reached acceptedDeferrals (order-dependent when seats disagree).
  for (const [id, verdicts] of Object.entries(deferralVerdictsById)) {
    const claim = ctx.minorsDeferred.find((m) => m.id === id);
    if (!claim) continue;
    ctx.minorsDeferred = ctx.minorsDeferred.filter((m) => m.id !== id);
    if (verdicts.every((d) => d.accepted)) {
      ctx.acceptedDeferrals.push({ id: claim.id, reason: claim.reason, note: verdicts.map((d) => d.note).filter(Boolean).join("; ") });
    }
  }
  // A seat that says "pass" while its own ledger still holds a blocking,
  // unaddressed finding is not actually passing — the ledger merge above just
  // ran, so ctx.findings[r.agentType] already reflects this round's findings
  // and resolutions.
  const rejected = valid.filter((r) => r.v.verdict === "reject" || (r.v.deferralVerdicts || []).some((d) => !d.accepted) ||
    Object.values(ctx.findings[r.agentType] || {}).some((f) => f.severity === "blocking" && f.status !== "addressed"));
  if (rejected.length === 0) {
    return { pass: true, verdictSection: valid.map((r) => r.v.verdictSection || ("## Reviewer Verdict\nPASS — " + r.agentType + ".")).join("\n\n") };
  }
  const critique = rejected.map((r) => "### " + r.agentType + "\n" + (r.v.summary || "") + "\n" +
    renderFindings(Object.values(ctx.findings[r.agentType]).filter((f) => f.status !== "addressed"))).join("\n\n");
  return { pass: false, critique, rejectedBy: rejected.map((r) => r.agentType).join(", ") };
}

// ---------------------------------------------------------------------------
// EscalationStop — the ONE terminal for a BATCH-level failure (dead Ship/CI
// agent, or CI on the one dev->main PR exhausted). Thrown after the escalation
// is posted; not caught anywhere, so it ends the whole workflow. Per-feature
// failure never throws this — see FeatureStop.
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
 * FeatureStop — the non-fatal, per-feature counterpart of EscalationStop.
 * Thrown by a feature ctx's fail() after it has already posted the
 * pause/escalation comment and cleaned up that feature's own worktrees.
 * processFeature (and ONLY processFeature) catches it and returns its
 * `marker` as that feature's outcome — the batch continues with whatever
 * other features reached reviewed-green.
 */
class FeatureStop extends Error {
  constructor(marker) {
    super("feature '" + (marker && marker.feature && marker.feature.id) + "' stopped: " + (marker && marker.reason));
    this.name = "FeatureStop";
    this.marker = marker;
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
 * accurate. `label` is a short tag for the agent calls (a feature's tag, or
 * "batch").
 */
async function postEscalation(stage, attempts, ctx, label) {
  // I6: ctx.issue can be null for the batch ctx (args.issue is optional) — fall
  // back to the PR URL, then to a plain note, rather than posting "Issue: null"
  // or (the prior bug) the dev branch name mistaken for an issue.
  const issueLine = ctx.issue || ctx.prUrl || "(no batch issue given — see the run log)";
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
      issueLine +
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
      issueLine +
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
 * blocker hit by ONE feature (added 2026-09-03). Mirrors single-feature-run.js's
 * pauseForHuman (cleans up FIRST, then posts) but does NOT throw: like cap
 * exhaustion it EXCLUDES this feature from the batch (the caller still returns
 * the `escalated: true` outcome via FeatureStop) so the other features still
 * ship. No root-cause diagnosis — an external condition needs no diagnosing.
 */
async function pauseFeatureForHuman(feature, stage, blocker, ctx) {
  try { await cleanupWorktrees(ctx, stage, "feature pause"); } catch (e) { log("cleanup before feature pause failed: " + e.message); }
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
 * 2026-09-03; cleanup added Task 10): dead reviewers, or a dead/blocked
 * Ship/CI agent (both run ONCE for the whole batch, so there is no single
 * feature to exclude). Cleans up FIRST (mirrors single-feature-run.js), then
 * posts a short comment + needs-human label and stops the WHOLE run. ALWAYS
 * throws, like batchEscalate's throwing counterpart for batch CI exhaustion.
 */
async function pauseForHuman(stage, blocker, ctx) {
  // M6: deliberately keep the swallow here, unlike batchEscalate(). A nested
  // EscalationStop means the pause comment for the cleanup agent's own death
  // was already posted by the inner call, and THIS call still needs to post
  // its own pause comment for the original failure either way — there is no
  // expensive root-cause diagnosis step to double up on (that is what makes
  // batchEscalate()'s duplicate worth rethrowing to avoid).
  try { await cleanupBatchWorktrees(ctx, stage, "pause " + stage); } catch (e) { log("cleanup before batch pause failed: " + e.message); }
  log(
    "PAUSED FOR HUMAN (batch) at stage '" + stage + "': blocker=" + blocker + " — " +
      ctx.failureContext + " (no retries, no diagnosis)."
  );
  // I6: fall back to the PR URL, then a plain note, when args.issue was not given.
  const issueLine = ctx.issue || ctx.prUrl || "(no batch issue given — see the run log)";
  await agent(
    "Post a SHORT comment to the relevant issue via the GitHub MCP server and add the '" +
      NEEDS_HUMAN_LABEL +
      "' label. Do NOT push, merge, or modify code.\n\nIssue: " +
      issueLine +
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

/** batchEscalate — the throwing counterpart of postEscalation for the batch
 * ctx (mirrors single-feature-run.js's escalate(): clean up FIRST, diagnose +
 * post, then throw). Always throws EscalationStop; never returns. */
async function batchEscalate(stage, attempts, ctx) {
  // M6: a dead cleanup agent routes through mechanical() -> ctx.fail() ->
  // pauseForHuman(), which already posts its own terminal comment and throws
  // EscalationStop. Swallowing that here and continuing to this function's
  // OWN diagnosis + escalation comment would post a SECOND terminal for one
  // failure. Rethrow instead; any other (non-EscalationStop) cleanup error is
  // still just logged, since escalation must proceed either way.
  try { await cleanupBatchWorktrees(ctx, stage, "escalate " + stage); } catch (e) { if (e instanceof EscalationStop) throw e; log("cleanup before batch escalation failed: " + e.message); }
  const rootCause = await postEscalation(stage, attempts, ctx, "batch");
  throw new EscalationStop(stage, attempts, rootCause);
}

// ---------------------------------------------------------------------------
// Mechanical steps (spec: Constraints). The DSL has no shell, so every
// deterministic git/gh action is an agent with a fixed command list, low
// effort, and a schema. Each prompt embeds the pass and the commit it acts
// on, because the harness caches results by prompt (cache rule). Labels are
// tag-prefixed per feature (tagLabel); the batch ctx has no tag.
// ---------------------------------------------------------------------------
const MECHANICAL_PREAMBLE =
  "MECHANICAL STEP — run exactly the commands below, in order. Do not improvise, do not fix anything, " +
  "do not run any other command. Return only the structured result.\n\n";

async function mechanical(ctx, label, phaseName, commands, schema) {
  const fullLabel = tagLabel(ctx, label);
  const r = await agent(MECHANICAL_PREAMBLE + commands, { label: fullLabel, phase: phaseName, model: "sonnet", effort: "low", schema });
  if (!r) {
    ctx.failureContext = fullLabel + " agent died without returning a result (usage-limit or harness interruption).";
    await ctx.fail(phaseName, "usage_limit", ctx.failureContext);
  }
  return r;
}

/** The run owns a branch when ctx.branch names a real feature branch — never
 * null (no branch created yet) and never devBranch itself (the batch ctx
 * manages devBranch directly; it never "owns" it the way a feature owns its
 * own branch, so detach/cleanup must not touch whatever holds devBranch — the
 * human's own working tree, most likely). */
function runOwnsBranch(ctx) {
  return Boolean(ctx.branch) && ctx.branch !== devBranch;
}

/** Detach every worktree that holds ctx.branch so the next implementer can
 * check it out; the detached paths become run-owned (spec D1, D6). `tag`
 * distinguishes an explicit pre-dispatch detach (e.g. reimplement's own call)
 * from the one reconcileBranch issues for itself, so two calls in the same
 * pass at the same head never produce a byte-identical, cache-colliding
 * prompt. A no-op (no agent dispatched) when !runOwnsBranch — this is why the
 * FIRST implement of a feature (ctx.branch still null) is never preceded by a
 * detach, and why the batch's own detach on devBranch never fires either. */
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

/** Move ctx.branch to the implementer's headSha, or fail when the commit does
 * not descend from the branch (spec D1). Detaches any holder first so a dirty
 * holder cannot block the ref update.
 *
 * Task 10 addition: a feature's implementer creates its branch inside its OWN
 * isolation worktree, so the ref is not guaranteed to already exist in the
 * shared repo by the time this runs. Step 1 checks for the ref first; if it
 * is missing, the ancestor check (step 2) is skipped and `git update-ref`
 * creates it fresh at headSha (update-ref creates missing refs).
 *
 * Fix round 1 (2026-09-10): step 0 guards against a latent hazard shared with
 * single-feature-run.js — `git update-ref` does not refuse a branch that is
 * currently checked out, so without this check the batch's own CI-fix
 * reconcile (called on devBranch, where runOwnsBranch is false and so never
 * detaches anything) could silently repoint devBranch out from under the
 * human's main working tree. Escalate instead and let the human fast-forward
 * it themselves.
 *
 * Sets ctx.headSha. */
async function reconcileBranch(ctx, implementResult, phaseName, pass) {
  const sha = implementResult.headSha;
  await detachWorktrees(ctx, phaseName, pass);
  const r = await mechanical(ctx, "reconcile-branch", phaseName,
    "(pass " + pass + ")\n" +
      "0. `git worktree list --porcelain`; if the FIRST entry (the main working tree) has `branch refs/heads/" + ctx.branch + "`, return ok=false, sha=`" + sha + "`, detail='" + ctx.branch + " is checked out in the main working tree at <path>; the run never touches it — fast-forward it to " + sha + " yourself, then resume' (fill in <path> with that entry's worktree path).\n" +
      "1. `git rev-parse --verify --quiet refs/heads/" + ctx.branch + "`; if that fails, the ref does not exist yet — skip step 2's ancestor check entirely (git update-ref will create it in step 3).\n" +
      "2. Otherwise: `git merge-base --is-ancestor " + ctx.branch + " " + sha + "`; if the exit code is non-zero return ok=false, sha=`" + sha + "`, detail='" + ctx.branch + " is not an ancestor of " + sha + "'.\n" +
      "3. `git update-ref refs/heads/" + ctx.branch + " " + sha + "`.\n" +
      "4. `git rev-parse " + ctx.branch + "` must print `" + sha + "`. Return ok=true, sha=that value, detail='fast-forwarded'.",
    RECONCILE_SCHEMA);
  if (!r.ok || r.sha !== sha) {
    ctx.failureContext = "Branch reconciliation failed: " + r.detail;
    await ctx.fail(phaseName, "code", ctx.failureContext, 1);
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
    await ctx.fail(phaseName, "code", ctx.failureContext, 1);
  }
  ctx.runWorktree = r.path;
  if (!ctx.ownedWorktrees.includes(r.path)) ctx.ownedWorktrees.push(r.path);
  return r;
}

/** Remove ONE feature's own worktree(s) and reconciled side branches (spec
 * D6). Never --force, never a worktree the run did not create or detach,
 * never ctx.branch. Re-entrancy-guarded on ctx.cleaningUp — Task 10 moves
 * this from a module-level flag to per-ctx, since concurrent features must
 * not share one guard.
 *
 * Task 10: NEVER runs `git worktree prune` here — many features share one
 * repository, and pruning while a sibling feature is mid `git worktree
 * add`/`remove` is a race. Pruning is a BATCH-level step
 * (cleanupBatchWorktrees), run once after the fan-out barrier and once more
 * at each CI exit. */
async function cleanupWorktrees(ctx, phaseName, tag) {
  if (!runOwnsBranch(ctx)) return { ok: true, removed: [] };
  if (ctx.cleaningUp) return { ok: true, removed: [] };
  ctx.cleaningUp = true;
  try {
    const side = ctx.worktreeBranches.filter((b) => b && b !== ctx.branch);
    const owned = ctx.ownedWorktrees.slice();
    const r = await mechanical(ctx, "cleanup-worktrees", phaseName,
      "(" + tag + ", head " + (ctx.headSha || "none") + ")\n" +
        "1. `git worktree list --porcelain`. For every worktree that is NOT the main working tree and is EITHER one of these paths: " + (owned.length ? owned.join(", ") : "(none)") +
        " OR has `branch refs/heads/" + ctx.branch + "`" + (side.length ? " OR one of: " + side.map((b) => "refs/heads/" + b).join(", ") : "") +
        ": run `git worktree remove <path>` (no --force). If git refuses (dirty tree), leave it and list the path in `detail`.\n" +
        (side.length ? "2. For each of " + side.join(", ") + ": if `git merge-base --is-ancestor <name> " + ctx.branch + "` succeeds, run `git branch -d <name>`; otherwise leave it.\n" : "") +
        "Return ok=true and `removed` = the worktree paths removed. Never delete " + ctx.branch + ". Do NOT run `git worktree prune` here — pruning is a batch-level step run once after all features finish (other features may still be mid worktree add/remove).",
      CLEANUP_SCHEMA);
    return r;
  } finally {
    ctx.cleaningUp = false;
  }
}

/** BATCH-level cleanup (Task 10): the one place `git worktree prune` runs,
 * once after the fan-out barrier and once more at each CI exit (green,
 * exhausted, and the quota-skip exit). `tag` keeps each call's prompt unique
 * (cache rule) since the label itself is always the unprefixed
 * "cleanup-worktrees".
 *
 * Fix round 1 (2026-09-10):
 *   - Re-entrancy-guarded on ctx.cleaningUp, exactly like the per-feature
 *     cleanupWorktrees (IMPORTANT 1). Without this, a dead cleanup agent
 *     recurses forever: mechanical's null-result branch calls ctx.fail,
 *     whose external-blocker path is pauseForHuman, which calls
 *     cleanupBatchWorktrees again as its own first statement — before this
 *     guard, the recursion happened inside the still-open try block, ahead
 *     of any throw.
 *   - Actually cleans (IMPORTANT 2): the earlier version only pruned and
 *     always returned `removed: []`, so ANY worktree or side branch this run
 *     recorded on the batch ctx (batchCtx.ownedWorktrees / .worktreeBranches
 *     — populated by detachWorktrees/pinRunWorktree/the CI fix's
 *     worktreeBranch report) was never actually removed — a real leak. It is
 *     NOT true that "per-feature worktrees are removed by each feature's own
 *     cleanup" covers this: that is only true for a feature that reached
 *     reviewed-green or was itself paused/escalated (both call
 *     cleanupWorktrees) — an ERRORED feature did not, until this same fix
 *     round's MINOR 4 change. */
async function cleanupBatchWorktrees(ctx, phaseName, tag) {
  if (ctx.cleaningUp) return { ok: true, removed: [] };
  ctx.cleaningUp = true;
  try {
    const owned = ctx.ownedWorktrees.slice();
    // M4: exclude devBranch in code, not only in the prompt text below — a
    // stray worktreeBranch report of devBranch is normally an ancestor of
    // devBranch itself (trivially true) and must never even be OFFERED to
    // the `git branch -d` step.
    const sideBranches = ctx.worktreeBranches.filter((b) => b && b !== devBranch);
    const r = await mechanical(ctx, "cleanup-worktrees", phaseName,
      "(" + tag + ")\n" +
        "1. For each of these paths: " + (owned.length ? owned.join(", ") : "(none)") + " — if `git worktree list --porcelain` lists it and it is NOT the main working tree, run `git worktree remove <path>` (no --force). If git refuses (dirty tree), leave it and list the path in `detail`.\n" +
        (sideBranches.length ? "2. For each of " + sideBranches.join(", ") + ": if `git merge-base --is-ancestor <name> " + devBranch + "` succeeds (merged into " + devBranch + "), run `git branch -d <name>` (never -D, and never delete " + devBranch + " itself); otherwise leave it.\n" : "") +
        (sideBranches.length ? "3" : "2") + ". `git worktree prune`.\n" +
        "Return ok=true and `removed` = the worktree paths actually removed in step 1.",
      CLEANUP_SCHEMA);
    return r;
  } finally {
    ctx.cleaningUp = false;
  }
}

/** One reimplement dispatch with its fixed surrounding steps: detach, the
 * implementer, reconcile, pin (spec D1, D5). Blocking findings first, minors
 * as separate commits; a deferral is a claim the panel judges (no-shed).
 * `ctx` is explicit (unlike single-feature-run.js, where it closes over a
 * module-level `ctx`) because each feature has its own. */
async function reimplement(ctx, label, why, context, pass) {
  await detachWorktrees(ctx, "Implement", pass, "before-implement");
  const before = ctx.headSha;
  const r = requireAgentResult(await agent(
    "AUTONOMOUS federated run, feature '" + ctx.title + "' (" + ctx.issue + "), " + why + " (master-design-doc.md §5/§8) — pass " + pass + ". Fix the ROOT CAUSE — do NOT weaken tests, skip cases, or shim. " +
      "Fix in-scope bugs in this change (no-shed); file only genuinely orthogonal bugs as cross-linked GH issues.\n" +
      "ORDER OF WORK: every BLOCKING finding first, each fixed and committed; then every minor finding as its own commit. " +
      "List in `minorsDeferred` only an item you judge genuinely out of scope, with the reason; the review panel judges every deferral and rejects a shed.\n" +
      constraintsClause(ctx) + HEAD_SHA_CLAUSE +
      "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle.\n" +
      "BLOCKERS: for an external condition you cannot fix return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise blocker='none'.\n\n" +
      "Branch: " + ctx.branch + " at " + ctx.headSha + "\n" + context,
    { label: tagLabel(ctx, label), phase: "Implement", model: "sonnet", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
  ), "IMPLEMENT");
  ctx.lastImplementSummary = r.summary || "";
  ctx.lastFilesTouched = r.filesTouched || [];
  // Record worktreeBranch BEFORE the blocker check: a blocked-but-committed
  // implementer's side branch must be registered first or cleanup (fired by
  // ctx.fail on the blocker path) never sees it.
  if (r.worktreeBranch) ctx.worktreeBranches.push(r.worktreeBranch);
  if (isExternalBlocker(r.blocker)) {
    await ctx.fail("Implement", r.blocker, r.blockerDetail || ("blocker=" + r.blocker));
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

/** The gates result (spec D2), run in ONE feature's pinned run worktree. */
async function runGates(ctx, pass) {
  const how = gateCommands
    ? "Run exactly these three commands: unit: `" + gateCommands.unit + "`; lint: `" + gateCommands.lint + "`; typecheck: `" + gateCommands.typecheck + "`."
    : "Run the repository's unit tests, lint and type-check exactly as its CLAUDE.md / README document them (no smoke, no integration services). If a language runtime or dependency install is needed in this worktree, do the documented install first.";
  const r = await agent(
    "AUTONOMOUS federated run, GATES (spec D2) for feature '" + ctx.title + "' — pass " + pass + ". Work ONLY in `" + ctx.runWorktree + "`, which is checked out at " + ctx.headSha + " (verify with `git rev-parse HEAD`; if it differs, return blocker='infra' with blockerDetail). " +
      how + " Return pass=true only if all three passed; put each command's one-line summary in `unit`, `lint`, `typecheck`; on failure put the failing output (trimmed) in `failureContext`. " +
      "If a tool is missing or a service is down that a unit test needs, return blocker='infra' with blockerDetail. Do not modify any file.",
    { label: tagLabel(ctx, "gates"), phase: "Gates", model: "sonnet", effort: "low", schema: GATES_SCHEMA }
  );
  if (!r) {
    await ctx.fail("Gates", "usage_limit", "gates agent died without returning a result.");
  }
  return r;
}

/** The validate stage in ONE feature's run worktree: full on the first smoke
 * of a lineage; incremental after a smoke failure (spec D4). */
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
    "AUTONOMOUS federated run, VALIDATE phase for feature '" + ctx.title + "' — pass " + pass + (resumeNonce ? ", resume " + resumeNonce : "") + " (spec D4; reference/definition-of-done.md). " +
      "Work in the run worktree `" + ctx.runWorktree + "` at commit " + ctx.headSha + " (verify with `git rev-parse HEAD`). Never checkout, rebuild or write to the main working tree.\n" +
      "STEP 0 — PREFLIGHT, before running a single test: an LLM key via ONE minimal call; the Docker daemon (`docker info` within 15 s) and service health; at least 10 GB free on Docker's volume; GitHub reachability if the smoke needs it. On any failure STOP and return gatesPass=false, smokeAllPass=false, blocker = 'infra' | 'credentials' | 'billing' | 'usage_limit', blockerDetail = the exact error. Never retry a preflight, never attempt host recovery, never read credentials.\n" +
      "STEP 1 — integration + regression suites at this commit. Unit, lint and type-check already passed (" + ctx.gateSummary + "); copy those into `tests`.\n" +
      "STEP 2 — " + scope + "the happy path, EVERY named edge case in the issue/spec (or derive and list them), and the plausible failure modes for the surface touched, against the running system. " +
      "REPORT EVERY SMOKE CASE in `cases` with a stable id (AC1, AC2, … in the issue's order, then E1… for derived edges and F1… for failure modes), `pass`, a one-line `detail`, and the source files the case exercises in `files`.\n" +
      "Set blocker='code' when a case fails because of the change; 'ambiguity' when acceptance criteria cannot be derived; a preflight kind when a resource failed mid-smoke; 'none' when everything passed.\n" +
      "Produce the DoD report with the exact structure from reference/definition-of-done.md (## Changes / ## Tests / ## Smoke test transcript / ## Docs updated / ## Follow-ups). Under ## Smoke test transcript render the re-run cases as a table and, if any, a separate list 'Carried forward (not re-run this pass)'. Under ## Follow-ups list every accepted deferral from the review panel.\n" +
      "ACCEPTED DEFERRALS (list each under ## Follow-ups): " + (ctx.acceptedDeferrals.length ? ctx.acceptedDeferrals.map((d) => d.id + ": " + d.reason).join("; ") : "none") + "\n" +
      "gatesPass is true ONLY if every suite passed; smokeAllPass ONLY if every case in `cases` has pass=true.\n\n" +
      "Feature: " + ctx.title + "\nLinked issue: " + ctx.issue,
    { label: tagLabel(ctx, "validate-and-dod"), phase: "Validate", model: "sonnet", schema: DOD_SCHEMA }
  );
}

/** Remove private session links from the batch PR body (spec D7): the outcome
 * must not depend on whether the ship agent obeyed its prompt. */
async function scrubPrBody(ctx) {
  return mechanical(ctx, "scrub-pr-body", "Ship",
    "(PR " + ctx.prUrl + ")\n" +
      "1. `gh pr view " + ctx.prUrl + " --json body --jq .body` and save it to a temporary file.\n" +
      "2. If the body contains a line with `Claude-Session:` or the text `claude.ai/code/session_`, delete every such line and every line that consists only of such a link, then `gh pr edit " + ctx.prUrl + " --body-file <the file>` and return ok=true, changed=true.\n" +
      "3. Otherwise return ok=true, changed=false.",
    SCRUB_SCHEMA);
}

/** Read the account's Actions quota (spec D8). `unknown` without the `user`
 * scope; polling then decides from the run's own billing annotation. */
async function checkQuota(ctx) {
  return mechanical(ctx, "quota-check", "CI",
    "(PR " + ctx.prUrl + (resumeNonce ? ", resume " + resumeNonce : "") + ")\n" +
      "1. `login=$(gh api user --jq .login)`; then `gh api /users/$login/settings/billing/actions`.\n" +
      "2. If the call fails (404 or a scope error), return quota='unknown' with the error text as detail.\n" +
      "3. Otherwise compare `total_minutes_used` with `included_minutes`: quota='exhausted' if used >= included, else 'ok'; detail = '<used>/<included> minutes'.",
    QUOTA_SCHEMA);
}

/** `outcomes` is passed explicitly (fix round 1, MINOR 8) rather than closed
 * over as the module-level `green`/`escalated` consts: those are declared
 * ~300 lines below this function in the main flow, so a closure over them
 * would be a TDZ hazard if this were ever called earlier (e.g. by a future
 * caller before the fan-out barrier runs). */
async function finishWithoutCi(ctx, why, outcomes) {
  await agent(
    "Post ONE short comment on PR " + ctx.prUrl + " via the GitHub MCP server: 'CI was not run by the autonomous workflow: " + why + ". All reviewed-green features passed gates, review panel and smoke; see the PR body.' Do not push, merge or modify code.",
    { label: "comment-ci-skipped", phase: "CI", model: "sonnet", effort: "low" }
  );
  try { await cleanupBatchWorktrees(ctx, "CI", "ci skipped"); } catch (e) { log("cleanup before CI-skip return failed: " + e.message); }
  log("CI skipped (" + why + "). PR awaits Gate B: " + ctx.prUrl);
  const green = outcomes.filter((o) => o && !o.escalated);
  const escalated = outcomes.filter((o) => o && o.escalated);
  return {
    prUrl: ctx.prUrl,
    shipped: true,
    ciSkipped: "quota",
    shippedFeatures: green.map((o) => o.feature.id),
    escalated: escalated.map((o) => ({ feature: o.feature.id, branch: o.branch, reason: o.reason })),
  };
}

/** Build a fresh per-feature ctx. Every mutable field single-feature-run.js's
 * module-level ctx starts with is duplicated here — per feature, not shared —
 * plus `tag` (the label prefix) and `fail` (this feature's non-throwing
 * pause/escalate terminal). */
function makeFeatureCtx(feature) {
  const tag = "feat:" + feature.id;
  const ctx = {
    tag,
    issue: feature.issue,
    title: feature.title,
    branch: null,             // becomes the feature branch after the first implement result
    headSha: null,
    runWorktree: null,        // the run-owned checkout every later stage works in (spec D1)
    ownedWorktrees: [],       // paths this run created or detached — the only ones cleanup may remove
    worktreeBranches: [],     // side branches implementers reported
    minorsDeferred: [],
    acceptedDeferrals: [],    // deferral claims a review panel accepted ({ id, reason, note })
    constraints: [],
    gateSummary: "",
    lastImplementSummary: "", // the implementer's own claim, relayed verbatim to every reviewer seat
    lastFilesTouched: [],     // the implementer's own claimed file list, relayed the same way
    failedCases: [],
    lastSmokeSha: null,
    prevReviewSha: null,
    lastCritique: null,       // the standing critique when prevReviewSha === headSha (no new commit landed)
    findings: {},             // per reviewer seat: id -> finding, the delta-review ledger (spec D3)
    reviewVerdictSection: "",
    prUrl: null,              // a feature never opens its own PR; kept so postEscalation's prompt reads uniformly across ctx shapes
    failureContext: "",
    lastReimplementNote: null,
    cleaningUp: false,        // per-ctx re-entrancy guard (Task 10: was module-level in single-feature-run.js)
  };
  ctx.fail = async (stage, kind, detail, attempts) => {
    ctx.failureContext = detail;
    if (isExternalBlocker(kind)) {
      // pauseFeatureForHuman cleans up internally — do not clean up twice.
      await pauseFeatureForHuman(feature, stage, kind, ctx);
    } else {
      try { await cleanupWorktrees(ctx, stage, "feature escalation"); } catch (e) { log(tag + ": cleanup before feature escalation failed: " + e.message); }
      await postEscalation(stage, attempts || K, ctx, tag);
    }
    throw new FeatureStop({ feature, branch: ctx.branch, escalated: true, reason: ctx.failureContext });
  };
  return ctx;
}

/**
 * processFeature — the re-sequenced D2 core (design review -> TDD implement
 * -> detach/reconcile/pin -> gates -> review panel -> incremental smoke/DoD)
 * for ONE feature, run inside its own worktree-isolated agents. Ported
 * verbatim from single-feature-run.js's own top-level flow (Task 10), with
 * ctx made explicit (each feature has its own) and every failure routed
 * through ctx.fail (non-throwing pause/escalate that excludes just this
 * feature, via FeatureStop) instead of the throwing module-level helpers.
 *
 * BEHAVIOUR CHANGE (this task): the gates/review/smoke loop now spends TWO
 * INDEPENDENT budgets — validateFailures (Gates + Validate, both code
 * failures) and reviewRejects (panel rejects) — each capped at K, for up to
 * 2*K passes, matching single-feature-run.js since its own PR #8. A feature
 * that spent attempts getting Gates green still gets a full K-budget review
 * loop, not a shared remainder.
 *
 * All agent() calls pass opts.phase explicitly (never the global phase())
 * so concurrent features never race the shared phase state.
 *
 * `ctx` is built by the CALLER (the fan-out wrapper, via makeFeatureCtx) and
 * passed in rather than created here (fix round 1, MINOR 4): the wrapper's
 * own catch block needs the SAME ctx object to best-effort escalate + clean
 * up a feature whose processFeature call threw something other than
 * FeatureStop, so the ctx must exist and be shared before this function's
 * try starts, not be scoped inside it.
 *
 * Returns: { feature, branch, escalated: boolean, dodReport?: string, reason?: string }
 */
async function processFeature(feature, ctx, devBranchName) {
  try {
    // ---- PHASE 0: DESIGN REVIEW (spec D2) ---------------------------------
    const design = requireAgentResult(await agent(
      "AUTONOMOUS federated run, DESIGN REVIEW (spec D2) for feature '" + feature.title + "' (" + feature.id + "). Read the linked issue in full, the plan below if any, " +
        "the repository's CLAUDE.md, and the modules the issue and plan name. Return `constraints`: the codebase's existing contracts, invariants and patterns this change must honour " +
        "(write paths, locking, conflict handling on inserts, queue/drain contracts, naming, ontology rules), each with a `source` (file path or doc section). " +
        "Return `risks`: places where the plan is likely to violate one. Do not implement anything, do not write files. " +
        "If the issue is too ambiguous to derive acceptance criteria, return blocker='ambiguity' with blockerDetail.\n\n" +
        "Feature: " + feature.title + "\nLinked issue: " + feature.issue + "\nPlan:\n" + (feature.plan || feature.title),
      { label: tagLabel(ctx, "design-review"), phase: "Design", model: "opus", schema: DESIGN_SCHEMA }
    ), "DESIGN");
    if (isExternalBlocker(design.blocker)) {
      await ctx.fail("Design", design.blocker, design.blockerDetail || ("blocker=" + design.blocker));
    }
    ctx.constraints = design.constraints;

    // ---- PHASE 1: FIRST IMPLEMENT ------------------------------------------
    // No branch exists yet (ctx.branch is null): this detach is a guaranteed
    // no-op (runOwnsBranch is false), matching single-feature-run.js's "no
    // detach before the first implement" — reconcileBranch below does its own
    // detach once the branch actually exists.
    await detachWorktrees(ctx, "Implement", 0, "before-implement");

    // The FIRST implement prompt carries no pass number (cache rule): it must
    // stay byte-identical across a resumed run.
    const implementResult = await agent(
      "AUTONOMOUS federated run, IMPLEMENT phase for feature '" + feature.title + "' (" + feature.id + ") (master-design-doc.md §5, D2).\n" +
        "Create a NON-MAIN branch off '" + devBranchName + "' named per branch-lifecycle conventions (feat/fix/chore/...). NEVER touch main. " +
        "Then do TDD: write a FAILING test that pins the desired behavior, implement until it is green, then refactor. " +
        "Fix in-scope bugs in this change (no-shed); file only genuinely orthogonal bugs as cross-linked GH issues.\n\n" +
        constraintsClause(ctx) +
        HEAD_SHA_CLAUSE +
        "COMMIT DISCIPLINE (reference/workflow-autonomy.md): commit after every green test cycle; never leave more than one task's work uncommitted — if you are interrupted, committed work is the only work that survives.\n" +
        "BLOCKERS: if you hit an external condition you cannot fix — a missing/invalid credential, a dead daemon or service, a billing refusal, or an issue/spec too ambiguous to derive acceptance criteria from — STOP and return blocker='credentials'|'infra'|'billing'|'ambiguity' with blockerDetail; otherwise return blocker='none'.\n" +
        "Do NOT push, do NOT open a PR, do NOT merge — integration is a later batch phase.\n" +
        "\nFeature: " + feature.title + "\nLinked issue: " + feature.issue +
        "\n\nReturn the branch name you created and a summary of the implementation.",
      { label: tagLabel(ctx, "implement"), phase: "Implement", model: "sonnet", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
    );
    requireAgentResult(implementResult, "IMPLEMENT");
    ctx.branch = implementResult.branch;
    ctx.headSha = implementResult.headSha;
    ctx.lastImplementSummary = implementResult.summary || "";
    ctx.lastFilesTouched = implementResult.filesTouched || [];
    if (implementResult.worktreeBranch) ctx.worktreeBranches.push(implementResult.worktreeBranch);
    ctx.minorsDeferred = ctx.minorsDeferred.concat(implementResult.minorsDeferred || []);
    await reconcileBranch(ctx, implementResult, "Implement", 0);
    await pinRunWorktree(ctx, "Implement", 0);
    if (isExternalBlocker(implementResult.blocker)) {
      await ctx.fail("Implement", implementResult.blocker, implementResult.blockerDetail || ("blocker=" + implementResult.blocker));
    }

    // ---- PHASES 2+3+4: GATES / REVIEW / VALIDATE, two independent budgets --
    let dodReport = null;
    let reviewed = false;
    let validateFailures = 0; // gates or smoke failures on code (one budget)
    let reviewRejects = 0;    // panel rejects (the other budget)
    let reviewPassedAt = null; // the headSha the panel last passed
    for (let pass = 1; pass <= 2 * K && !reviewed; pass++) {
      log(ctx.tag + ": pass " + pass + " (code failures " + validateFailures + "/" + K + ", review rejects " + reviewRejects + "/" + K + ") at " + ctx.headSha);

      // ---- GATES (spec D2) -------------------------------------------------
      const g = await runGates(ctx, pass);
      if (isExternalBlocker(g.blocker)) await ctx.fail("Gates", g.blocker, g.blockerDetail || ("blocker=" + g.blocker));
      if (!g.pass) {
        validateFailures++;
        ctx.failureContext = "Gates failed (code failure " + validateFailures + " of " + K + ", pass " + pass + "): " + (g.failureContext || "unit/lint/typecheck red");
        if (validateFailures === K) await ctx.fail("Gates", "code", ctx.failureContext, validateFailures);
        if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
        await reimplement(ctx, "reimplement-after-validate", "back to IMPLEMENT after a GATES failure", ctx.failureContext, pass);
        continue;
      }
      ctx.gateSummary = "unit: " + g.unit + "; lint: " + g.lint + "; typecheck: " + g.typecheck;

      // ---- REVIEW (spec D2/D3): before the smoke; delta mode whenever a prior round exists ----
      if (reviewPassedAt !== ctx.headSha) {
        if (ctx.prevReviewSha === ctx.headSha && ctx.lastCritique) {
          // The standing critique is the verdict: nothing new to review — the
          // last reimplement produced no new commit, so re-dispatching the
          // panel here would be a byte-identical prompt (cache collision)
          // reviewing a degenerate `git diff SHA..SHA`. The prior rejection
          // still stands.
          reviewRejects++;
          ctx.failureContext = "Review panel's standing rejection at " + ctx.headSha + " (reject " + reviewRejects + " of " + K + ", pass " + pass + "):\n" + ctx.lastCritique;
          if (reviewRejects === K) await ctx.fail("Review", "code", ctx.failureContext, reviewRejects);
          if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
          await reimplement(ctx, "reimplement-after-review", "back to IMPLEMENT after a REVIEW reject", ctx.failureContext, pass);
          continue;
        }
        const mode = ctx.prevReviewSha ? { prevSha: ctx.prevReviewSha } : "full";
        const review = await runReviewPanel("AUTONOMOUS federated run, feature '" + feature.title + "',", ctx, devBranchName,
          "GATE RESULTS at " + ctx.headSha + " (pass " + pass + "): " + ctx.gateSummary +
            "\nIMPLEMENTER'S CLAIMS (verify against the diff): summary: " + ctx.lastImplementSummary +
            "; files touched: " + (ctx.lastFilesTouched.length ? ctx.lastFilesTouched.join(", ") : "(none reported)"),
          mode);
        if (review.incomplete) {
          // Dead reviewers most likely mean the run's usage budget is
          // exhausted — but that's an external condition on THIS feature, not
          // grounds to spend its K budget retrying a panel that probably
          // can't run right now. Excludes just this feature.
          await ctx.fail("Review", "usage_limit", review.critique);
        }
        ctx.prevReviewSha = ctx.headSha; // any later round is a delta over this commit
        if (!review.pass) {
          reviewRejects++;
          ctx.failureContext = "Review panel rejected (reject " + reviewRejects + " of " + K + ", pass " + pass + ", by: " + review.rejectedBy + "):\n" + review.critique;
          ctx.lastCritique = review.critique;
          if (reviewRejects === K) await ctx.fail("Review", "code", ctx.failureContext, reviewRejects);
          if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
          await reimplement(ctx, "reimplement-after-review", "back to IMPLEMENT after a REVIEW reject", ctx.failureContext, pass);
          continue;
        }
        ctx.lastCritique = null;
        reviewPassedAt = ctx.headSha;
        ctx.reviewVerdictSection = review.verdictSection;
      }

      // ---- SMOKE (spec D4): once after review; incremental after a failure ----
      const dod = await runValidate(ctx, pass);
      if (!dod) await ctx.fail("Validate", "usage_limit", "VALIDATE agent died without returning a DoD result.");
      if (isExternalBlocker(dod.blocker)) await ctx.fail("Validate", dod.blocker, dod.blockerDetail || dod.failureContext || ("blocker=" + dod.blocker));
      if (!dod.gatesPass || !dod.smokeAllPass) {
        validateFailures++;
        ctx.failedCases = (dod.cases || []).filter((c) => !c.pass);
        ctx.lastSmokeSha = ctx.headSha;
        ctx.failureContext = "Smoke failed (code failure " + validateFailures + " of " + K + ", pass " + pass + "): " + (dod.failureContext || ctx.failedCases.map((c) => c.id + " " + c.name).join(", ") || "integration or regression suites did not pass");
        if (validateFailures === K) await ctx.fail("Validate", "code", ctx.failureContext, validateFailures);
        if (ctx.lastReimplementNote) { ctx.failureContext += "\n" + ctx.lastReimplementNote; ctx.lastReimplementNote = null; }
        await reimplement(ctx, "reimplement-after-validate", "back to IMPLEMENT after a SMOKE failure", ctx.failureContext, pass);
        continue;
      }
      dodReport = dod.report + "\n\n" + ctx.reviewVerdictSection;
      reviewed = true;
      log(ctx.tag + ": gates, review and smoke green at " + ctx.headSha + ".");
    }

    // If the loop exited without a review pass and without a FeatureStop, that
    // is a bug in the cap logic — fail loud rather than ship unreviewed work.
    if (!reviewed || !dodReport) {
      throw new Error("Internal invariant violated: feature '" + feature.id + "' ended without a passing review and without escalation.");
    }

    // Reviewed-green: this feature's remaining work is a git merge in the
    // batch Integrate phase, not the worktree — release it now (the branch
    // itself is untouched; cleanupWorktrees never deletes ctx.branch).
    try { await cleanupWorktrees(ctx, "Validate", "feature done"); } catch (e) { log(ctx.tag + ": cleanup after review-green failed: " + e.message); }

    return { feature, branch: ctx.branch, escalated: false, dodReport };
  } catch (e) {
    if (e instanceof FeatureStop) return e.marker;
    throw e;
  }
}

// ===========================================================================
// MAIN FLOW (module top level — no run() wrapper; the DSL executes the body).
// ===========================================================================

const features = RUN_ARGS.features;
const devBranch = RUN_ARGS.devBranch || RUN_ARGS.branch;
const gateCommands = validGateCommands(RUN_ARGS.gateCommands);
// args.issue (or args.batchIssue) — OPTIONAL (I6): a GitHub issue for the
// BATCH itself (Integrate/Ship/CI escalations), distinct from each feature's
// own required `issue`. When not given, a batch-level escalation posts to the
// PR instead (see postEscalation/pauseForHuman's issueLine fallback).

// Resume support (added 2026-09-03; mirrors single-feature-run.js): the harness
// caches a completed agent() result by (prompt, opts), so a resumed run would
// replay a failed validate verdict verbatim unless the prompt changes. The
// nonce is folded into every feature's Validate prompt and the batch's quota check.
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
    " on every retry loop (two independent budgets per feature)."
);

// The batch ctx: shared mutable state for the strictly serial Integrate/Ship/CI
// tail. Its `branch` is devBranch itself (never a side branch it "owns" the
// way a feature owns its own — see runOwnsBranch), so its own detach/cleanup
// calls are no-ops by design; only reconcile/pin (used by the CI-fix
// reconciled dispatch) actually run against it.
const batchCtx = {
  // I6: devBranch is a branch name, not a GitHub issue — a batch-level
  // escalation with nowhere else to post used to name the branch as its
  // "issue". args.issue (or args.batchIssue) is the batch's own optional
  // issue; postEscalation/pauseForHuman fall back to the PR URL, then to a
  // plain "no issue" note, when it is not given.
  issue: RUN_ARGS.issue || RUN_ARGS.batchIssue || null,
  branch: devBranch,
  headSha: null,
  runWorktree: null,
  ownedWorktrees: [],
  worktreeBranches: [],
  prUrl: null,
  failureContext: "",
  cleaningUp: false,
};
batchCtx.fail = async (stage, kind, detail, attempts) => {
  batchCtx.failureContext = detail;
  if (isExternalBlocker(kind)) {
    await pauseForHuman(stage, kind, batchCtx); // throws
  } else {
    await batchEscalate(stage, attempts || K, batchCtx); // throws
  }
};

// ---- PHASES 0-4 (per feature): fan-out, concurrent, barrier ----------------
// parallel() is the barrier: Integrate needs ALL reviewed-green features at once
// (serial merges onto one shared dev branch; one batch PR). processFeature does
// not throw for EXPECTED per-feature failures — it returns an `escalated` marker.
// But an UNEXPECTED throw (e.g. an agent() call rejecting on a terminal API error)
// would become a null and be silently dropped by .filter(Boolean) — the feature
// would vanish from the batch with no record, violating "never silently drop work;
// always escalate". So we wrap each thunk: any uncaught throw becomes an explicit
// escalated+errored outcome, so the feature is still surfaced to the human — fix
// round 1 (MINOR 4) makes this literally true: the wrapper builds the feature's
// ctx itself (so it is available even though processFeature never got past its
// own try), and best-effort posts a real escalation comment + runs cleanup,
// exactly like any other per-feature failure, instead of just logging locally.
const outcomes = (
  await parallel(
    features.map((feature) => async () => {
      const ctx = makeFeatureCtx(feature);
      try {
        return await processFeature(feature, ctx, devBranch);
      } catch (err) {
        const reason = "unexpected error: " + (err && err.message ? err.message : String(err));
        log("FEATURE ERRORED (uncaught throw): " + feature.id + " — " + reason);
        ctx.failureContext = reason;
        try { await cleanupWorktrees(ctx, "Fan-out", "feature error"); } catch (e2) { log(ctx.tag + ": best-effort cleanup for the errored feature failed: " + e2.message); }
        try { await postEscalation("Fan-out", 1, ctx, ctx.tag); } catch (e2) { log(ctx.tag + ": best-effort escalation for the errored feature failed: " + e2.message); }
        return { feature, branch: ctx.branch, escalated: true, errored: true, reason: reason };
      }
    })
  )
).filter(Boolean);

const green = outcomes.filter((o) => o && !o.escalated);
const escalated = outcomes.filter((o) => o && o.escalated);

// Batch-level prune, once after every feature has finished with the shared repo.
try { await cleanupBatchWorktrees(batchCtx, "Integrate", "after fan-out"); } catch (e) { log("batch cleanup after fan-out failed: " + e.message); }

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

// ---- PHASE 5: Integrate (serial merges onto dev) ---------------------------
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

// ---- PHASE 6: Ship — ONCE for the whole batch ------------------------------
phase("Ship");
const combinedReports = green
  .map((o) => "### Feature: " + o.feature.title + " (" + o.feature.id + ")\n\n" + o.dodReport)
  .join("\n\n---\n\n");

const ship = await agent(
  "AUTONOMOUS federated run, SHIP phase (master-design-doc.md §7)" + (resumeNonce ? " (resume " + resumeNonce + ")" : "") + ". Push the NON-MAIN dev branch '" +
    devBranch +
    "' (never push main — the pre-push hook + settings forbid it) and open exactly ONE dev->main pull request " +
    "via the GitHub MCP server. The PR body MUST aggregate ALL the reviewed-green features' DoD reports (each " +
    "with its appended Reviewer Verdict). Return the PR URL. If the push or PR creation fails for an EXTERNAL " +
    "reason (auth, network, GitHub billing/permissions), return pushed=false with blocker='credentials'|'infra'|'billing' " +
    "and blockerDetail; otherwise blocker='none'.\n\nAggregated DoD reports (PR body):\n" +
    combinedReports,
  { label: "push-and-open-pr", phase: "Ship", schema: SHIP_SCHEMA }
);
if (!ship) {
  // I4: requireAgentResult used to throw a plain Error here — route the
  // BATCH ship's dead-agent case through batchCtx.fail like every other
  // batch-level blocker (the per-feature sites are already covered by the
  // fan-out wrapper).
  await batchCtx.fail("Ship", "usage_limit", "Ship agent returned no result (usage limit or kill)");
}

batchCtx.prUrl = ship.prUrl;
if (isExternalBlocker(ship.blocker) || !ship.pushed || !ship.prUrl) {
  await batchCtx.fail(
    "Ship",
    isExternalBlocker(ship.blocker) ? ship.blocker : "infra",
    ship.blockerDetail || (!ship.pushed ? "push did not complete" : "PR was not opened (no URL returned)")
  );
}
log("dev pushed and ONE dev->main PR opened for the batch: " + ship.prUrl);
await scrubPrBody(batchCtx);

// ---- PHASE 7: CI — batch loop, capped K (terminal on exhaustion) -----------
phase("CI");
let ciGreen = false;

const quota = await checkQuota(batchCtx);
if (quota.quota === "exhausted") return await finishWithoutCi(batchCtx, "the GitHub Actions quota is exhausted (" + quota.detail + ")", outcomes);

for (let fixAttempt = 1; fixAttempt <= K && !ciGreen; fixAttempt++) {
  log("Batch CI fix window " + fixAttempt + " of " + K + ". Polling GitHub Actions.");

  // Bounded poll for a terminal (green/red) status. Counter-controlled, not
  // open-ended: a never-finishing pipeline cannot trap us.
  const pollBudget = 30;
  let ci = null;
  let terminal = false;
  for (let poll = 1; poll <= pollBudget && !terminal; poll++) {
    ci = await agent(
      "AUTONOMOUS federated run, CI phase. Check the GitHub Actions status for the dev->main PR " +
        ship.prUrl +
        " (dev branch '" +
        devBranch +
        "') at commit " + (batchCtx.headSha || "the pushed tip") +
        " via the GitHub MCP server. Return 'green' if all required checks passed, 'red' if a required check " +
        "failed (include failing job names + a short log excerpt), 'pending' if still running. " +
        "If the PR reports no checks at all (the repository has no CI configured), that counts as 'green' — " +
        "do not wait for checks that will never start. " +
        "If a job failed before any step ran with an annotation about account payments, billing, or a spending limit " +
        "(check `gh api repos/{owner}/{repo}/check-runs/{id}/annotations`), return status 'red', blocker 'billing', " +
        "logsExcerpt = that annotation verbatim. Otherwise blocker 'none' for green/pending and 'code' for a red caused by the change." +
        " (poll " + poll + "/" + pollBudget + ", fix attempt " + fixAttempt + ")",
      { label: "poll-ci", phase: "CI", schema: CI_SCHEMA }
    );
    if (!ci) {
      // The poll agent died (usage-limit / harness). Leave the loop; the
      // null check below routes to batchCtx.fail instead of dereferencing null.
      break;
    }
    if (ci.status === "green" || ci.status === "red") {
      terminal = true;
    } else {
      log("Batch CI still pending (poll " + poll + "/" + pollBudget + ").");
    }
  }

  if (!ci) {
    await batchCtx.fail("CI", "usage_limit", "Batch CI poll agent died without returning a status (usage-limit or harness interruption).");
  }
  if (ci.blocker === "billing") return await finishWithoutCi(batchCtx, "GitHub reported a billing/quota refusal: " + (ci.logsExcerpt || ci.blockerDetail || "").slice(0, 200), outcomes);
  if (isExternalBlocker(ci.blocker)) await batchCtx.fail("CI", ci.blocker, ci.blockerDetail || ci.logsExcerpt || ("blocker=" + ci.blocker));

  // M5: the preceding `if (!ci)` above always throws (batchCtx.fail never
  // returns), so `ci` is guaranteed non-null here — the `!ci` disjunct was dead.
  if (!terminal) {
    await batchCtx.fail("CI", "code", "Batch CI did not reach a terminal state within the poll budget on fix attempt " + fixAttempt + ".", fixAttempt);
  }

  if (ci.status === "green") {
    ciGreen = true;
    log("Batch CI is GREEN. dev->main PR ready for Gate B (human merge): " + ship.prUrl);
    try { await cleanupBatchWorktrees(batchCtx, "CI", "ci green"); } catch (e) { log("cleanup before CI-green return failed: " + e.message); }
    break;
  }

  // RED. Read logs, fix, re-push, and re-validate as a delta — but capped.
  batchCtx.failureContext =
    "Batch CI red on fix attempt " +
    fixAttempt +
    ". Failing jobs: " +
    (ci.failingJobs || []).join(", ") +
    "\nLogs excerpt:\n" +
    (ci.logsExcerpt || "(none provided)");
  log("Batch CI is RED on fix attempt " + fixAttempt + ". " + batchCtx.failureContext);

  if (fixAttempt === K) {
    // Cap reached on CI — escalate, never loop again.
    await batchCtx.fail("CI", "code", batchCtx.failureContext, fixAttempt);
  }

  // The CI-red fix gets the SAME reconciled dispatch as the single script's
  // as-built CI fix (detach -> fix agent -> reconcile; no pin — fix round 1,
  // IMPORTANT 2: an earlier version also pinned here, which is not what
  // single-feature-run.js does for its own CI fix and left batchCtx.runWorktree
  // referencing a worktree nothing ever reads or cleans). detach is a no-op
  // here (runOwnsBranch(batchCtx) is false — devBranch is never "owned"), but
  // reconcile runs for real: it moves devBranch's ref to the fix's headSha.
  await detachWorktrees(batchCtx, "CI", 100 + fixAttempt, "before-implement");
  const fix = await agent(
    "AUTONOMOUS federated run, CI-RED fix (reference/definition-of-done.md CI-red delta) — fix attempt " + fixAttempt + ". " +
      "On the dev branch '" + devBranch + "' at " + (batchCtx.headSha || "the pushed tip") + ", read the failing CI logs via the GitHub MCP, fix the ROOT CAUSE (no shim, no weakened test, no skipped " +
      "check), re-validate the affected cases as a delta, then re-push the dev branch. Do NOT touch main.\n" + HEAD_SHA_CLAUSE + "\nFailure context:\n" + batchCtx.failureContext,
    { label: "fix-ci-and-repush", phase: "CI", model: "sonnet", schema: IMPLEMENT_SCHEMA, isolation: "worktree" }
  );
  if (!fix) {
    // I4: requireAgentResult used to throw a plain Error here — route the
    // BATCH CI fix's dead-agent case through batchCtx.fail like every other
    // batch-level blocker.
    await batchCtx.fail("CI", "usage_limit", "CI agent returned no result (usage limit or kill)");
  }
  if (fix.worktreeBranch) batchCtx.worktreeBranches.push(fix.worktreeBranch);
  if (isExternalBlocker(fix.blocker)) await batchCtx.fail("CI", fix.blocker, fix.blockerDetail || ("blocker=" + fix.blocker));
  await reconcileBranch(batchCtx, fix, "CI", 100 + fixAttempt);
  // Loop: the for-condition re-polls. Counter-controlled.
}

if (!ciGreen) {
  // Should be unreachable: every non-green CI path escalates (which throws).
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
