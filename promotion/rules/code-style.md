# Code Style Rules

## General
- Write code for readability first.
- Follow existing repository conventions for formatting, naming, and file structure.
- Prefer simple, explicit code over clever abstractions.
- Conceptual clarity is paramount.

## Comments
- Use comments sparingly and only where they add real value.
- Comment the why, not the obvious what.
- Remove stale comments when changing code.
- Do not add noisy comments that merely restate the code.

## Docstrings
- Add docstrings to non-trivial public functions, classes, and modules.
- Keep docstrings concise, practical and aligned with industry standards for documentation.
- Explain purpose, important inputs/outputs, side effects, and notable constraints.
- For small private helpers, docstrings are optional unless behavior is non-obvious.

## Inline documentation
- When logic is subtle, add a short comment explaining the reasoning.
- When a workaround exists for framework, API, or platform behavior, document that clearly in code.
- If a function has important assumptions or failure modes, make them obvious in either the docstring or a nearby comment.

## Maintenance
- Keep comments and docstrings aligned with the code.
- When changing behavior, update related comments/docstrings in the same edit.
- Do not leave misleading documentation in place.