# Workflow Rules

## Implementation workflow
When completing a non-trivial task, prefer this order:
1. understand the existing code and patterns. Use documentation to support understanding.
2. identify whether docs or ADRs are needed
3. implement the smallest clean solution that is still correct and well-designed.
4. add or update tests
5. update related docs, comments, docstrings
6. summarize code changes, test status, and doc changes

## Standing preferences
- Favor maintainable structure over quick hacks.
- Favor explicitness over magic.
- Keep diffs focused and reviewable.
- Do not refactor unrelated areas without a clear reason.

## Documentation triggers
Create or update docs when:
- a new feature is added
- a subsystem boundary changes
- data flow changes
- a new external integration is introduced
- a recurring workflow would benefit from a written reference

## Output expectations
After making changes, report:
- what changed
- what tests were added or updated
- what docs were added or updated
- any follow-up gaps or risks
