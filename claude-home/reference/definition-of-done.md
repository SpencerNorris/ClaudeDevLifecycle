# Definition of Done

## Purpose
Tests prove code correctness. The Definition of Done proves *feature*
correctness. A change is not "done" until the author has exercised
the feature against the running system and produced a transcript of
the exercise.

This rule exists because the prior default — "all unit and integration
tests pass" — has been observed to ship visibly broken features.

The one-line stance — *not done until exercised against the running system with
a transcript* — also lives in the constitution (`CLAUDE.md`). This file is the
detail: smoke depth, the surface-by-type playbook, and the report contract.

## Required for every "done" report

A change is "done" only when ALL of the following hold:

1. Unit + integration + regression tests pass (status reported).
2. Lint + type-check pass (status reported).
3. **A smoke-test transcript is included in the report** (see below).
4. Any bugs surfaced during the smoke test were resolved in the same
   change. See `no-shed.md`.

No transcript → not done. Restate the work as
"implementation complete, smoke test pending" rather than "done".

## Smoke test depth

Smoke testing is **not** a happy-path click-through. It is:

- The happy path, with the observed result.
- **Every named edge case in the feature description, issue, spec, or
  acceptance criteria.** If the issue lists 5 acceptance criteria, the
  transcript covers all 5.
- The most plausible failure modes for the surface area touched —
  empty input, missing dependency, permission denied, timeout, malformed
  payload, concurrent write, etc. Pick the ones a user would actually
  hit, not every theoretical edge.

If the issue/spec lists no acceptance criteria, derive them from the
surface itself: what would a user do that the implementer didn't
anticipate? What state transitions matter? What does graceful failure
look like? Then exercise each.

**When you derive rather than copy stated criteria, make the derivation
auditable.** The DoD report must enumerate the edge cases you derived
as an explicit list, and invite the user to add any you missed:

> No acceptance criteria were stated. I derived and tested these edge
> cases: `<list>`. If a case that matters is missing, name it and I'll
> cover it.

This converts silent narrow derivation — the failure mode this rule
guards against — into visible derivation the user can catch at the DoD
gate.

Cost is not an excuse. The marginal cost of one broken-on-arrival
feature is higher than the cost of a thorough smoke test.

## Smoke test surface by type

### Frontend / UI
- Drive with Playwright (`browser_navigate` → `browser_click` →
  `browser_type` etc.).
- Capture at least one screenshot per state transition.
- Verify console messages are clean (no errors, no unexpected warnings),
  network requests succeed.
- Transcript includes: URL navigated to, sequence of interactions,
  final-state screenshot reference, console message summary, network
  request summary.

### Backend / API
- Drive with `curl` (or equivalent) against the running service.
- Cover: representative payload, malformed payload, auth-missing case,
  every documented edge case.
- Transcript includes: command, response status, response body excerpt,
  observable side effect (DB row created, message emitted, file written).

### CLI / tools
- Run the actual command against representative input.
- Cover: happy path, `--help` output, error path.
- Transcript includes: command, stdout/stderr excerpt, exit code.

### Library / pure code
- Either a CLI driver or a Python session that exercises the public API.
- Cover: happy path + at least two edge cases drawn from the function's
  contract.
- Transcript includes: invocation, returned value, side effects.

## When the environment cannot be smoke-tested

If smoke testing requires infrastructure that cannot be spun up
locally (staging-only dependency, production-only data, hardware
the dev machine doesn't have), state this explicitly in the report:

> Implementation complete. Smoke test deferred — requires $ENV which is
> not reproducible locally. Verification steps for $ENV: <list>.

**Write the verification steps into the tracking GitHub issue, not just
this report.** The report scrolls out of the chat transcript; the issue
is durable and searchable, so whoever runs the verification later (the
user, or a verifier with $ENV access) finds the steps where they live.
Cross-link the issue in the handoff.

This is **not** "done." It is a clear handoff to a verifier who has
access to the required environment. The user must explicitly accept
this handoff for the work to be considered complete.

## Report structure

Every "done" report follows this structure:

```
## Changes
- <bullet list of code changes, by file>

## Tests
- unit: <pass/fail/count>
- integration: <pass/fail/count>
- regression: <pass/fail/count>
- lint: <pass/fail>
- type-check: <pass/fail>

## Smoke test transcript
<the actual transcript — commands, outputs, screenshots, edge cases covered>

## Docs updated
- <files>

## Follow-ups
- <only orthogonal-scope issues; see no-shed.md>
```

## Re-validation after CI failure (delta report)

When CI goes red after a push and the fix is committed locally
(`docs/references/local-ci-parity.md` covers why this happens despite local `act`),
the code must be re-validated before the next push — `act` and the
relevant smoke cases re-run against the fix. But the report does **not**
restate the full DoD. It is a **delta**:

```
## CI-red delta
- CI failed: <job> — <one-line cause, e.g. "missing env package X">
- Fix: <what changed, by file>
- Re-validation:
  - `act -j <job>` → green
  - smoke (affected cases only): <case> → pass
```

Full re-validation, low ceremony. The principle from the per-task flow
holds: no CI fix bypasses `act` and smoke. Only the *reporting* is
abbreviated, never the *checking*.

## Honesty
- Never claim a smoke test passed unless it was actually run.
- If a smoke step failed, fix it before reporting done. Filing it as
  an issue is not an option — see `no-shed.md`.
- If you cannot smoke-test, say so plainly; never disguise it as done.
