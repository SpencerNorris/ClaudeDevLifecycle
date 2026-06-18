# Local CI Parity

## Purpose
Run the CI workflow locally before requesting a push. The prior
default — push and iterate on CI failures — costs the user one push
per fix, often dozens per feature. The first push should be
expected-green.

## Tool

Use [`act`](https://github.com/nektos/act) to execute GitHub Actions
workflows locally inside Docker. It is the industry-standard local
runner for GitHub Actions.

## Required setup
- Install: `brew install act` (macOS), `winget install nektos.act`
  (Windows), or follow act's docs for Linux.
- Docker must be running.
- First run pulls the runner image (~1.5 GB, one-time).
- Recommend `--container-architecture linux/amd64` on Apple Silicon to
  match GitHub-hosted runners.

## Workflow

Before requesting a push for a branch that will run CI:

1. `act -l` to list the workflow jobs.
2. `act -j <job-name>` to run a specific job, or `act` to run all jobs
   for the default event.
3. If green → request push.
4. If red → fix locally, re-run, repeat. **Do not request a push of
   red code.**

For repositories with multiple workflows (e.g., `ci.yml`,
`integration.yml`), run each that the target branch would trigger.
List them explicitly in the smoke-test transcript.

## Caveats — `act` is not a perfect mirror

Known divergences from GitHub-hosted runners:

- Docker image differs. `act` uses `catthehacker/ubuntu`, not GitHub's
  `ubuntu-latest`. Some apt packages differ; some pre-installed tools
  are absent.
- Some marketplace actions don't run locally. `upload-artifact`,
  `cache`, anything that talks to the GitHub API as a side effect.
- Hardware differs. `act` uses the local CPU; GitHub runners are
  consistent within a job class.
- Secrets handling differs. `act` requires `--secret-file` or
  `--env-file`; secrets configured in GH UI are not auto-available.
- Network egress allowlists may differ — local can reach hosts that
  the GH runner cannot, and vice versa.

If CI fails after `act` was green, the diff is **real and worth
investigating**. Don't just retry. Document the divergence in the PR
description if it's a known limitation; file as a CI-infra issue if
it's chronic.

## When `act` is not feasible

Some workflows cannot be modeled by `act`:
- Matrix builds with parallelism that exceeds the local machine.
- GitHub-only APIs (deployment statuses, environment protection rules).
- GPU jobs.
- Self-hosted runner-specific setup.

Fallback: replicate the workflow's shell commands manually against the
local working directory. Note the divergence in the change report.
Treat it as best-effort parity, not full parity.

## Report

The Definition-of-Done smoke-test transcript includes the `act` result
for each targeted job:

```
## CI parity
- `act -j integration` → green (45s)
- `act -j lint` → green (8s)
- `act -j typecheck` → green (12s)
```

If `act` was skipped (infeasible for this workflow), state why and
how parity was otherwise verified:

```
## CI parity
- `act -j build` → SKIPPED (matrix exceeds local machine);
  ran `python -m build` directly, verified artifact contents.
- `act -j integration` → green (90s)
```

## Cost-of-iteration accounting

If a feature requires 3+ rounds of local-CI-red → fix → re-run, that
is a signal — either the change is bigger than expected (replan), or
the test environment is misconfigured (audit). Surface to the user
rather than grinding through silently.
