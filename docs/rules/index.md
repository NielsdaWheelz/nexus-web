# Docs

## Role

This directory is the canonical home for repository documentation.

## Goals

- MECE organization: documents are mutually exclusive and collectively exhaustive.
- Concision
- Clear boundaries

## Starting Points

- [tech-stack.md](tech-stack.md): runtime and tooling stack
- [codebase.md](codebase.md): repository structure, imports, and module boundaries
- [layers.md](layers.md): architectural layers and responsibilities
- [control-flow.md](control-flow.md): exhaustive branching and race-safety rules
- [database.md](database.md): DB schema, queries, transactions, and DB-specific conventions
- [concurrency.md](concurrency.md): locking, TOCTOU handling, and cross-system mutation ordering
- [errors.md](errors.md): error and defect modeling

## Placement Rules

- Each rule lives in exactly one document.
- Put content in the narrowest document that fully owns it.
- Link to related docs instead of restating them.
- If two docs need the same text, the split is wrong.
- If a document covers multiple unrelated topics, split it.
- Small docs are fine when they keep ownership and boundaries sharp.
- Keep repo-wide rule docs flat until a topic clearly needs its own directory.
- Use subdirectories for service-owned, module-owned, or feature-owned docs when that keeps them separate from repo-wide rules.
- Avoid over-categorized hierarchies and umbrella docs with weak boundaries.

## Rule Shape

- Prefer unconditional rules.
- Do not write soft rules with words like `usually`, `generally`, or `normally`.
- State the unconditional rule or the explicit exception.
- Prefer narrowing scope or splitting a rule over adding exceptions.
- If a rule needs many exceptions, the rule or the document boundary is probably wrong.

## Ownership

This file defines the documentation system itself: purpose and placement rules. It does not own product or codebase rules beyond that.
