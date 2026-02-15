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

## Orchestrator

You are the **orchestrator**. You decide which skill to invoke next, assemble its input context, and route its output downstream. You never write specs or code yourself — you dispatch to the right skill agent.

### Decision logic

```
START:
  if no L0 exists        → invoke L0 (architect)
  if no L1 exists        → invoke L1 (planner)
  if next slice has no L2 → invoke L2 (spec writer)
  if L2 has no L3         → invoke L3 (decomposer)
  if next PR has no L4    → invoke L4 (implementer's guide)
  if L4 exists            → implement PR, then:
      if more PRs in L3   → loop to L4
      if slice complete   → loop to L2 (next slice)
      if all slices done  → DONE
```

### Rules

- Never write code that isn't specified. Spec-first means edge cases surface during writing, not debugging.
- Never skip a layer. L0 → L1 → L2 → L3 → L4 → code. Every time.
- When assembling input for a skill, follow the handoff protocol below — extract minimum viable context, never dump entire upstream docs.

## Handoff protocol

Each skill passes context to the next. Never duplicate — always reference.

| From | To | What to pass |
|------|----|-------------|
| L0 → L1 | Constitution summary | Non-scope, core abstractions, architecture components |
| L1 → L2 | Roadmap entry | Slice goal, dependencies, acceptance criteria |
| L0 + L2 → L3 | Constitution + Slice spec | Conventions, schemas, APIs, state machines, error codes |
| L2 + L3 → L4 | Slice spec + PR roadmap entry | Relevant schemas, PR goal, dependencies, acceptance |

### Context assembly (for LLM invocations)

Goal: **minimum viable context that uniquely determines the correct output.** Too little → hallucination. Too much → confusion. Wrong context → confidently wrong.

**Include:**

| What | Why |
|------|-----|
| Exact type definitions from L2 | LLM matches them precisely |
| Exact function signatures from L4 | No room for invention |
| Exact error codes from L2 | Consistent error handling |
| Existing code patterns (paste one example) | LLM imitates style |
| Explicit non-goals from L4 | Prevents scope creep |
| L0 conventions as bullet points | Constrains naming, format, patterns |

**Exclude:**

| What | Why |
|------|-----|
| Full constitution | Too long, dilutes focus |
| Other slices' specs | Irrelevant, confusing |
| Historical context ("we used to...") | Noise |
| Justifications ("we chose X because...") | Doesn't help implementation |
| Future plans ("later we'll...") | Invites premature implementation |

**Validation — check output against each layer:**
1. **L0 check**: conventions followed? Naming correct? No forbidden patterns?
2. **L2 check**: schemas match exactly? State machine correct? All error codes present?
3. **L4 check**: all deliverables present? All tests present? No extra files or functions?

## Iteration protocol

Specs are hypotheses. Implementation reveals truth. When reality diverges from spec, feed back up — don't silently deviate.

| Trigger | Action | Cascade |
|---------|--------|---------|
| PR implementation reveals L4 spec was wrong | Fix L4, re-implement | None — L4 is disposable |
| PR reveals L2 schema/API needs to change | **Stop.** Update L2, then re-derive L3 and affected L4s | All unstarted PRs in this slice re-spec |
| Slice work reveals L1 ordering was wrong | Update L1, re-plan affected slices | Downstream L2/L3/L4 for reordered slices |
| Anything reveals L0 constraint was wrong | **Full stop.** Update L0, audit all downstream docs | Potentially everything — this is rare by design |

### Rules for feedback

1. **Never silently deviate.** If the code doesn't match the spec, either the code is wrong or the spec is wrong. Decide which, then fix the source of truth.
2. **Fix at the highest affected layer.** If the root cause is in L2, don't patch L4 — fix L2 and let changes cascade down.
3. **Re-derive, don't patch.** After updating a spec, re-run the downstream skill (don't hand-edit its output). The skill's process ensures consistency.
4. **Completed PRs are done.** Only re-open merged PRs if the L2 change invalidates their correctness. Otherwise, fix forward in new PRs.

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

## Structural validation

Each layer's output must pass these machine-checkable rules. A linter or review agent can verify them.

**L0 (Constitution):**
- Has all sections: Vision, Core Abstractions, Architecture, Hard Constraints, Conventions, Invariants
- Non-Scope lists >= 5 items
- Conventions contain copy-pasteable patterns (not prose descriptions)
- Contains no table schemas, API request/response bodies, or file paths

**L1 (Slice Roadmap):**
- Has a dependency graph (ASCII or list)
- Every slice has: Goal, Outcome, Dependencies, Acceptance
- Contains no schemas, endpoints, function names, or file paths
- Every L0 scope item maps to at least one slice

**L2 (Slice Spec):**
- Has all sections: Goal & Scope, Domain Models, State Machine (if stateful), API Contracts, Error Codes, Invariants, Acceptance Scenarios
- Every field definition has: name, type, constraints
- Every API contract has: method, path, request shape, response shape, error codes
- Every error has an `E_` prefixed code
- Contains no file paths, helper functions, or library choices

**L3 (PR Roadmap):**
- Has a dependency graph
- Every PR has: Goal, Dependencies, Acceptance
- Dependencies form a DAG (no cycles)
- Contains no function signatures, test cases, or file paths

**L4 (PR Spec):**
- Has all sections: Goal, Context, Deliverables, Acceptance Tests, Non-Goals, Constraints
- Goal is one sentence (no "and")
- Every deliverable has an exact file path
- Every test has exact inputs and exact expected outputs
- Non-Goals lists >= 3 items
- References only merged code, never unmerged PRs

## Examples

Complete worked example across all five layers: [Bookmark Manager](./examples/bookmark-manager/)

- [L0: Constitution](./examples/bookmark-manager/constitution.md)
- [L1: Roadmap](./examples/bookmark-manager/roadmap.md)
- [L2: Slice Spec](./examples/bookmark-manager/slice-2-bookmark-crud.md)
- [L3: PR Roadmap](./examples/bookmark-manager/pr-roadmap-slice-2.md)
- [L4: PR Spec](./examples/bookmark-manager/pr-01-bookmark-model.md)
