# Testing Rules

## Default expectation
- Generate tests alongside implementation by default.
- Do not treat tests as optional for production code changes.
- For bug fixes, add or update a test that would have caught the issue.

## What to test
- Prefer focused tests around the changed behavior.
- Cover:
  - expected behavior
  - key edge cases
  - regressions
  - failure paths where relevant
- Avoid brittle tests tightly coupled to internal implementation unless necessary.

## Test scope
- Start with the narrowest useful tests.
- Add broader integration coverage when behavior crosses component boundaries.
- If a change affects contracts between systems, test those contracts.

## If tests are missing
- If the repo has no test pattern yet, follow the lightest sensible convention.
- If adding a full test harness is too large for the task, add a minimal test plan and note the gap explicitly.

## Honesty
- Never claim tests passed unless they were actually run.
- If tests could not be run, say so clearly and state what should be verified.