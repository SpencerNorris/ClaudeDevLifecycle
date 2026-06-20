# Documentation Rules

## General
- Documentation is part of the deliverable, not an afterthought.
- When implementing a non-trivial feature, update docs in the same change.
- Prefer short, specific markdown files over one giant catch-all document.

## Required documentation behavior
- If adding a new feature, consider whether `docs/features/<feature-name>.md` is needed.
- If changing how components interact, update the relevant system documentation.
- If making a meaningful technical decision, add an ADR in `docs/adr/`.

## Documentation style
- Keep docs concise and useful.
- Write for a future engineer opening the repo cold.
- Prefer:
  - what this is
  - why it exists
  - how it works
  - where to look next
- Avoid bloated prose and obvious restatements of code.

## Code-documentation alignment
- Do not leave docs stale after code changes.
- If docs are outdated relative to the task, update them as part of the work.
- If full documentation updates are out of scope, explicitly note what remains.