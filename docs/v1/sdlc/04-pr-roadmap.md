# PR Roadmap

> **what**: how to decompose a slice spec into an ordered sequence of PRs.
> **who**: engineer starting work on a slice.
> **when**: after the slice spec is written, before writing individual PR specs.

---

## The Pattern

L1 decomposes L0 into slices. The PR roadmap decomposes L2 into PRs. Same job, smaller scope.

```
L0 (Constitution)  ──L1 breaks into──►  Slices
L2 (Slice Spec)    ──PR Roadmap──►      PRs
```

**Contains**:
- PR list with one-line goals
- Dependencies between PRs
- Acceptance criteria per PR (how do we know it's done?)

**Does NOT contain**:
- Full PR specs (that's [L3](./05-pr-spec-L3.md))
- Function signatures, test cases, file paths
- Implementation details

**Decision test**: If a PR is added, removed, or reordered, does this document change? If yes, it belongs here.

---

## The Layered Decomposition Strategy

The most common pattern: decompose bottom-up through the stack.

```
PR-01: Domain types (structs, enums, interfaces)
    │
    ▼
PR-02: Database schema and migrations
    │
    ▼
PR-03: Data access / repository layer
    │
    ▼
PR-04: Service / business logic layer
    │
    ▼
PR-05: API endpoints / route handlers
    │
    ▼
PR-06: CLI commands or UI components
```

Why this order works:
1. **Types** have zero dependencies — safest starting point
2. **Storage** depends only on types
3. **Business logic** depends on storage
4. **API** depends on business logic
5. **UI/CLI** depends on API

Each PR only depends on the PR above it. Each is independently testable and mergeable.

---

## What Goes in a PR Roadmap

For each PR:

1. **Name and Goal** (one sentence)
   - "PR-01: Add Run struct and RunState enum"
2. **Dependencies** (which PRs must be merged first?)
   - "None" or "Requires PR-01"
3. **Acceptance** (how do we know it's done?)
   - "Run struct compiles, RunState has all 5 variants, unit tests pass"

That's it. No function signatures, no test cases, no file paths. Those belong in the [individual PR spec](./05-pr-spec-L3.md).

---

## Example: Bookmark CRUD Slice

From the [Slice 2 spec](./examples/bookmark-manager/slice-2-bookmark-crud.md):

```
PR-01: Bookmark Model and Migration
  Goal: Add Bookmark type and create bookmarks table
  Dependencies: None (Slice 1 complete)
  Acceptance: Migration runs, types compile, row mapper tested

PR-02: Bookmark Repository
  Goal: Add database queries for CRUD operations
  Dependencies: PR-01
  Acceptance: All queries work against test database

PR-03: Bookmark Service
  Goal: Add business logic with validation and ownership checks
  Dependencies: PR-02
  Acceptance: Service functions handle all error cases from slice spec

PR-04: Bookmark API Routes
  Goal: Add REST endpoints wired to service layer
  Dependencies: PR-03
  Acceptance: All endpoints return correct status codes, integration tests pass
```

### Dependency Graph

```
PR-01: Model + Migration
    │
    ▼
PR-02: Repository
    │
    ▼
PR-03: Service
    │
    ▼
PR-04: API Routes
```

Linear chain — each PR builds on the previous. No parallelism possible here, but in larger slices you might have:

```
PR-01: Types
    │
    ├──────────────┐
    ▼              ▼
PR-02: Queries   PR-03: Validation helpers
    │              │
    └──────┬───────┘
           ▼
    PR-04: Service
           │
           ▼
    PR-05: Routes
```

PR-02 and PR-03 can be built in parallel since they only depend on PR-01.

---

## Decomposition Strategies

### Strategy 1: Layered (most common)
Types → Storage → Logic → API → UI. Works for most CRUD-style features.

### Strategy 2: Vertical Thin Slice
Build one complete path first, then add breadth.
- PR-01: Create bookmark (type + table + query + service + endpoint)
- PR-02: List bookmarks (query + service + endpoint)
- PR-03: Update bookmark (query + service + endpoint)
- PR-04: Delete bookmark (query + service + endpoint)

Trade-off: each PR touches more files, but you get a working feature sooner.

### Strategy 3: Contract-First
Start with the API contract, then fill in the implementation.
- PR-01: Route stubs returning hardcoded responses + types
- PR-02: Database schema + migrations
- PR-03: Real implementation replacing stubs

Good when frontend and backend teams need to work in parallel.

---

## Sizing PRs

Rules of thumb:
- Reviewable in 15 minutes (~400 lines changed max)
- One logical unit — not "add X and also refactor Y"
- Independently testable without other unmerged PRs
- Independently mergeable without breaking the build

**Too big**: "Implement bookmark CRUD" (that's the whole slice)
**Too small**: "Add import for uuid crate" (not meaningful alone)
**Right**: "Add Bookmark struct and database migration"

---

## Common Mistakes

**Mistake 1: PRs that depend on unmerged PRs**
Each PR should reference what's already merged, not what's in-flight. If PR-03 needs types from PR-01, PR-01 must be merged first.

**Mistake 2: No dependency information**
Without explicit dependencies, PRs get reviewed and merged in random order, causing conflicts and rework.

**Mistake 3: Mixing decomposition with specification**
The PR roadmap says *what PRs exist and in what order*. It does not say *what each PR contains in detail*. That's the PR spec's job.

**Mistake 4: Over-parallelizing**
More parallel PRs = more merge conflicts. Prefer a linear chain unless the slice is large enough to justify parallel work.

---

See also: [L2: Slice Spec](./03-slice-spec-L2.md) | Next: [L3: PR Spec](./05-pr-spec-L3.md)
