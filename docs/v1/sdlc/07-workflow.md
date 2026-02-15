# Workflow: Spec-First Development

> **what**: how the doc layers flow together in practice.
> **who**: everyone.
> **when**: ongoing reference for the development lifecycle.

---

## The Lifecycle of a Feature

```
1. IDEA
    ↓
2. Update Constitution (if needed — rare)
    ↓
3. Add to Roadmap (create a new slice)
    ↓
4. Write Slice Spec
    ↓
5. Break into PRs (PR Roadmap)
    ↓
6. Write PR Specs
    ↓
7. Implement PRs
    ↓
8. Review & Merge
    ↓
9. Update docs if reality diverged from spec
```

---

## When Each Document Gets Created

| Document | Created When | By Whom |
|----------|-------------|---------|
| Constitution | Project inception | Tech lead / Architect |
| Roadmap | Project inception, updated per planning cycle | Product + Tech lead |
| Slice Spec | When starting work on a slice | Engineers on that slice |
| PR Spec | Immediately before implementation | Engineer doing the PR |

## When Each Document Gets Updated

| Document | Updated When |
|----------|-------------|
| Constitution | Almost never. Major pivots only. |
| Roadmap | When priorities shift (monthly/quarterly) |
| Slice Spec | When implementation reveals spec was wrong |
| PR Spec | Never. It's disposable. Deleted after merge. |

---

## The Spec-First Discipline

### The Golden Rule

**Never write code that isn't specified.**

This sounds rigid. It is. Here's why:

Without spec-first:
1. Start coding
2. Discover edge case
3. Make a decision on the spot
4. Forget the decision
5. Later, another engineer hits same edge case
6. Makes a different decision
7. System is now inconsistent
8. Bug reports
9. Nobody knows what the "correct" behavior is

With spec-first:
1. Write spec, including edge cases
2. Discover edge case while writing spec
3. Make a decision, document it
4. Implement according to spec
5. Later, another engineer hits same edge case
6. Reads spec, sees decision
7. Implements consistently
8. System is consistent

### The Spec Review

Before implementation, specs should be reviewed:

**Slice Spec Review** (by tech lead or senior engineer):
- Does this align with the constitution?
- Are the interfaces clean?
- Are all edge cases covered?
- Are error codes defined?
- Are invariants testable?

**PR Spec Review** (quick, often self-review):
- Does this implement part of the slice spec correctly?
- Are deliverables clear?
- Are tests specified?
- Are non-goals explicit?

---

## How Documents Reference Each Other

Documents form a dependency graph:

```
Constitution
    ↑ (references conventions from)
Slice Spec
    ↑ (references schemas/APIs from)
PR Spec
    ↑ (references deliverables from)
Code
```

### The Reference Rules

**Slice Spec references Constitution:**
```markdown
## Conventions (from Constitution)
- Errors follow E_CATEGORY_NAME pattern
- All IDs are ULIDs

## API Contract
POST /runs
  Error codes:
    E_REPO_NOT_FOUND (404)  ← follows E_CATEGORY_NAME convention
    E_INVALID_REQUEST (400)
```

**PR Spec references Slice Spec:**
```markdown
## Context
The runs table schema is defined in s1_spec.md section 3.2.
The Run state machine is defined in s1_spec.md section 4.1.

## Task
Implement the state transition function as specified.
```

**Code references PR Spec:**
```rust
/// Implements state transition per s1_pr03_spec.md
///
/// Valid transitions:
/// - queued → running
/// - running → completed | failed | killed
pub fn transition_state(run: &mut Run, new_state: RunState) -> Result<(), StateError> {
```

### Never Duplicate, Always Reference

**Bad** (subtle difference → future bugs):
```markdown
# Slice Spec
Error E_RUN_NOT_FOUND means the run doesn't exist.

# PR Spec
Error E_RUN_NOT_FOUND means the run ID was not found in the database.
```

**Good** (single source of truth):
```markdown
# Slice Spec
Error E_RUN_NOT_FOUND: The requested run_id does not exist in the runs table.

# PR Spec
Return E_RUN_NOT_FOUND as defined in s1_spec.md section 5.1.
```

---

See also: [Philosophy](./00-philosophy.md) | [Quick Reference](./08-quick-reference.md)
