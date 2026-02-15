# Quick Reference

> **what**: lookup tables for the doc hierarchy.
> **who**: everyone.
> **when**: quick decisions about what goes where.

---

## Summary Table

| Level | Contains | Does NOT Contain | Changes When |
|-------|----------|------------------|--------------|
| **L0: Constitution** | Language, architecture, conventions, boundaries, non-goals | Schemas, APIs, file structure | Almost never |
| **L1: Roadmap** | Slice order, dependencies, milestones | How to build each slice | Priorities shift |
| **L2: Slice Spec** | Exact schemas, APIs, state machines, errors, invariants | Implementation details, file names | Learning during slice |
| **L3: PR Spec** | Exact functions, files, tests, constraints | Anything outside this PR | Never (deleted after merge) |

## Scope vs Content

| Level | Scope | Content Type |
|-------|-------|--------------|
| L0 | Whole system | Conventions, boundaries, architecture |
| L1 | Whole system | Ordering and dependencies (NO technical details) |
| L2 | One feature | Technical contracts (schemas, APIs, errors) |
| L3 | One PR | Exact implementation details |

## The Ownership Test

Who would need to approve a change?

| Level | Who Approves Changes? |
|-------|----------------------|
| Constitution | Whole team / tech lead (major discussion) |
| Slice Roadmap | Product + tech lead |
| Slice Spec | Engineers on that slice |
| PR Spec | The individual engineer |

## The Blast Radius Test

If you make a mistake at each level, how much do you redo?

| Level | Blast Radius of a Mistake |
|-------|--------------------------|
| Constitution | Entire project |
| Slice Roadmap | Timeline, possibly multiple slices |
| Slice Spec | Multiple PRs within the slice |
| PR Spec | One branch |

## Decision Tests

- **L0 vs L2**: Does this affect *all* features? → L0. Does this affect *one* feature? → L2.
- **L2 vs L3**: Do multiple PRs need to agree on this? → L2. Is this internal to one PR? → L3.
- **L1 is special**: It spans the whole system but contains *zero* technical specifications. Only "what order?" and "what depends on what?"

## Template Sizes

| Layer | Length | Key Sections |
|-------|--------|--------------|
| **L0** | 2-4 pages | Vision, Abstractions, Architecture, Constraints, Conventions, Invariants |
| **L1** | 1-2 pages | Slice list with Goal, Outcome, Dependencies, Acceptance |
| **L2** | 3-6 pages | Scope, Models, Schema, State Machines, Commands, Functions, Errors, Scenarios |
| **L3** | 1-3 pages | Goal, Deliverables (exact code), Tests (exact cases), Non-goals, Constraints |

## The Principle: Constrain the Generation Space

| Aspect | How It's Constrained |
|--------|---------------------|
| What files exist | Exact file paths listed |
| What types exist | Exact struct/enum definitions with all fields |
| What functions exist | Exact signatures with full doc comments |
| What the function does | Input → Output table, no ambiguity |
| What logic to use | Pseudocode showing exact steps |
| What tests exist | Exact test names, inputs, outputs |
| What NOT to do | Explicit non-goals |
| What rules to follow | Explicit constraints |
| When it's done | Explicit checklist |

---

See also: [Philosophy](./00-philosophy.md) | [Full docs index](./README.md)
