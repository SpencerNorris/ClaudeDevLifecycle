# Architecture Rules

## Architectural decision records
- Create an ADR for any meaningful architectural decision.
- Store ADRs in `docs/adr/`.
- Use lightweight ADRs: problem, options considered, decision, consequences.
- Create ADRs when changing:
  - system boundaries
  - data models used across services
  - storage choices
  - API contracts
  - deployment architecture
  - event/message flows
  - auth/authz design
  - major dependencies or frameworks

## System design documentation
- Prefer durable documentation over implicit knowledge.
- For non-trivial systems, maintain markdown docs explaining:
  - major components
  - data flow
  - external dependencies
  - operational assumptions
  - failure modes
- If a feature introduces a new subsystem, queue or integration, add or update a system doc.

## Feature documentation
- For meaningful product or engineering features, create a focused markdown file.
- Store feature docs in `docs/features/`.
- Each feature doc should briefly cover:
  - purpose
  - inputs/outputs
  - core logic
  - dependencies
  - edge cases
  - operational notes

## Change discipline
- Do not make major architectural changes silently.
- If a task implies a structural change, call it out explicitly and add or update the relevant ADR/doc.
- Prefer small, reviewable architectural increments over sweeping rewrites.