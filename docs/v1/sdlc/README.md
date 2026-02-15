# Software Development Lifecycle

> Each layer constrains the next, narrowing the solution space until implementation becomes unambiguous.

## The hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│  L0  CONSTITUTION        system-wide constraints (rarely changes) │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
        ┌───────────────────────────────────────────┐
        │  L1  SLICE ROADMAP     ordered slices      │
        └───────────────────┬───────────────────────┘
                            ▼
              ┌─────────────────────────────┐
              │  L2  SLICE SPEC   contract  │
              └─────────┬───────────────────┘
                        ▼
                ┌───────────────────┐
                │  L3  PR ROADMAP   │
                └───────┬───────────┘
                        ▼
                  ┌───────────┐
                  │  L4  PR   │
                  │  SPEC     │
                  └─────┬─────┘
                        ▼
                    ┌──────┐
                    │ CODE │
                    └──────┘
```

Spec layers (L0, L2, L4) define contracts. Decomposition layers (L1, L3) break a contract into ordered children.

## Core principle

Each document exists to constrain the document below it. If it doesn't narrow the next layer's decisions, delete it. Explicitly state what is **not** in scope — negative space prevents drift and hallucination.

## Documents

| Layer | Skill doc | What | When |
|-------|-----------|------|------|
| L0 | [Constitution](./L0-constitution.md) | System-wide constraints, architecture, conventions | Project inception |
| L1 | [Slice Roadmap](./L1-slice-roadmap.md) | Ordered slices with dependencies | Planning cycles |
| L2 | [Slice Spec](./L2-slice-spec.md) | Feature contract: schemas, APIs, state machines | Starting a slice |
| L3 | [PR Roadmap](./L3-pr-roadmap.md) | Ordered PRs for one slice | After slice spec |
| L4 | [PR Spec](./L4-pr-spec.md) | Exact deliverables for one PR | Before writing code |

## Orchestration

```
1. Write or update L0 (Constitution)        — rare
2. Decompose L0 → slices (L1 Roadmap)       — per planning cycle
3. Write L2 (Slice Spec) for next slice      — per slice
4. Decompose L2 → PRs (L3 PR Roadmap)       — per slice
5. Write L4 (PR Spec) for next PR            — per PR
6. Implement PR                              — per PR
7. Review, merge, repeat from step 5
8. Update specs if reality diverged
```

Never write code that isn't specified. Spec-first means edge cases are discovered during writing, not during debugging.

## Handoff protocol

Each skill passes context to the next. Never duplicate — always reference.

| From | To | What to pass |
|------|----|-------------|
| L0 → L1 | Constitution summary | Non-scope, core abstractions, architecture components |
| L1 → L2 | Roadmap entry | Slice goal, dependencies, acceptance criteria |
| L0 + L2 → L3 | Constitution + Slice spec | Conventions, schemas, APIs, state machines, error codes |
| L2 + L3 → L4 | Slice spec + PR roadmap entry | Relevant schemas, PR goal, dependencies, acceptance |

When invoking an LLM: extract the minimum viable context from upstream layers that uniquely determines the correct output. Too little → hallucination. Too much → confusion. Wrong context → confidently wrong.

## Decision tests

| Question | Answer |
|----------|--------|
| Affects all features? | L0 |
| Orders work across the whole system? | L1 |
| Affects multiple PRs within one feature? | L2 |
| Orders PRs within one slice? | L3 |
| Internal to one branch? | L4 |
| If this changes, does most code change? | L0 |
| If this changes, does the timeline change? | L1 |
| If this changes, do multiple PRs break? | L2 |
| If this changes, does PR order change? | L3 |
| If this changes, does only this branch change? | L4 |

## Blast radius

| Layer | Mistake cost |
|-------|-------------|
| L0 | Entire project |
| L1 | Timeline, multiple slices |
| L2 | Multiple PRs within slice |
| L3 | PR ordering within slice |
| L4 | One branch |

## Examples

Complete worked example across all five layers: [Bookmark Manager](./examples/bookmark-manager/)

- [L0: Constitution](./examples/bookmark-manager/constitution.md)
- [L1: Roadmap](./examples/bookmark-manager/roadmap.md)
- [L2: Slice Spec](./examples/bookmark-manager/slice-2-bookmark-crud.md)
- [L3: PR Roadmap](./examples/bookmark-manager/pr-roadmap-slice-2.md)
- [L4: PR Spec](./examples/bookmark-manager/pr-01-bookmark-model.md)
