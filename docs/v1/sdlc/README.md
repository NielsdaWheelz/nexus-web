# Software Development Lifecycle

> specs give direction. code + tests prove correctness.

## hierarchy

```
┌──────────────────────────────────────────────────┐
│  l0  constitution     system-wide constraints     │
└─────────────────────┬────────────────────────────┘
                      ▼
      ┌──────────────────────────────────┐
      │  l1  slice roadmap   ordering    │
      └──────────────┬───────────────────┘
                     ▼
        ┌──────────────────────────────┐
        │  l2  slice plan              │
        │  (acceptance + pr briefs)    │
        └──────────┬───────────────────┘
                   ▼
              ┌──────────┐
              │   code   │
              │ + tests  │
              └──────────┘
```

l0 defines project constraints. l1 orders the work. l2 defines what each slice delivers and how it breaks into prs. code + tests are the source of truth.

## core rules

- specs are guides, not source of truth. code + passing tests are.
- never silently deviate from acceptance criteria without updating the plan.
- never leave scope boundaries implicit.
- every acceptance criterion must be testable.
- write tests first (red/green TDD). a pr is done when tests pass and code review approves.
- plan 1-2 prs at a time, not all upfront.

## dispatch logic

```
start:
  if no l0 exists           -> write l0
  if no l1 exists           -> write l1
  if next slice has no l2   -> write l2 (with first 1-2 pr briefs)
  if next pr has brief      -> implement pr (write tests first, then code)
  after pr merges           -> add next pr brief to l2, implement
  after slice complete      -> write l2 for next slice
```

## verification

the plan is the direction gate. code + tests are the proof gate.

**before implementation**: human reads slice plan + pr brief. short enough to read critically in under 5 minutes. approve direction or redirect.

**during implementation**: agent runs existing tests first to understand the codebase, then writes failing tests from acceptance criteria (red), then writes code to pass them (green).

**after implementation**: human reviews code + tests. this is the real quality gate. every pr must include:
1. **implementation** — a single, focused change.
2. **automated tests** — that fail if the implementation is reverted.
3. **manual test evidence** — terminal output or screenshots proving the feature works. passing tests alone are not enough.
4. **updated docs** — if the change affects user-facing behavior.

the human must understand the code they approve. if you can't explain what it does, don't merge it — that's how cognitive debt accumulates.

## escalation

| trigger | action |
|---|---|
| implementation diverges from plan | update plan to match reality, note why |
| slice plan needs revision | update l2, adjust upcoming pr briefs |
| l1 ordering is wrong | fix l1, update affected l2s |
| l0 constraint is wrong | full stop, revise l0, audit downstream |

divergence is expected. update the plan to match the code, not the other way around.

## examples

worked example:
- [l0: constitution](./examples/bookmark-manager/constitution.md)
- [l1: roadmap](./examples/bookmark-manager/roadmap.md)
- [l2: slice plan](./examples/bookmark-manager/slice-2-bookmark-crud.md)
