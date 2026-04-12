# Software Development Lifecycle

Specs set direction. Code plus tests prove behavior.

## Layers

1. `L0` constitution: system-wide constraints.
2. `L1` slice roadmap: slice ordering.
3. `L2` slice spec: acceptance criteria and key decisions.
4. `L3` PR roadmap: near-term PR ordering.
5. `L4` PR brief: one PR scope.
6. Implementation: tests first, then code.

## Core Rules

- Code and passing tests are the source of truth.
- Keep boundaries explicit at every layer.
- Every acceptance criterion must be testable.
- Plan only the next one to two PRs in detail.
- If implementation diverges from plan, update the owning doc.

## Dispatch Order

After each step, restart from the top:

1. No `L0` -> write `L0`.
2. No `L1` -> write `L1`.
3. Next slice missing `L2` -> write `L2`.
4. Missing/stale `L3` -> update `L3`.
5. Next PR missing `L4` -> write `L4`.
6. `L4` exists -> implement with tests-first flow.
7. All `L2` criteria complete -> close slice, return to step 1 for next slice.

## Verification Gates

Before implementation:

- Human reviews `L2` + `L4` for direction.

During implementation:

- Run existing tests.
- Add failing tests for new criteria.
- Implement until green.

After implementation:

- Human reviews code + tests.
- Include focused implementation, automated tests, manual evidence, and doc updates if behavior changed.

## Use the Full Pipeline When

- Building a new capability or slice.

For small bug fixes/refactors, use only the minimum layer needed to remove ambiguity.

## Docs

- [L0](./L0-constitution.md)
- [L1](./L1-slice-roadmap.md)
- [L2](./L2-slice-spec.md)
- [L3](./L3-pr-roadmap.md)
- [L4](./L4-pr-brief.md)

Worked example:

- [L0 example](./examples/bookmark-manager/constitution.md)
- [L1 example](./examples/bookmark-manager/roadmap.md)
- [L2 example](./examples/bookmark-manager/slice-2-spec.md)
- [L3 example](./examples/bookmark-manager/slice-2-roadmap.md)
- [L4 example](./examples/bookmark-manager/slice-2-pr01.md)
