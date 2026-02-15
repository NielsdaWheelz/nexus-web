# L2: Slice Spec

> **what**: how to write a feature contract that multiple PRs must agree on.
> **who**: spec writer, senior engineer.
> **when**: starting work on a slice.

---

**Purpose**: Define what multiple PRs must agree on. Prevent parallel work from colliding.

**Analogy**: The electrical blueprint for one room. It shows where every outlet goes, what voltage, what wire gauge. Any electrician can wire it without asking questions.

**Contains**:
- Exact API contracts (request/response shapes)
- Exact database schema for tables touched by this slice
- State machines (what states exist, what transitions are legal)
- Error codes (what can go wrong, and how we report it)
- Invariants (rules that must never be violated)
- Acceptance scenarios (given X, when Y, then Z)

**Does NOT contain**:
- Internal helper function signatures
- Which files to create
- Implementation choices (like "use library X")

**Decision test**: If this changes, would multiple PRs break?

---

## Why Does L2 Exist?

Imagine two engineers working on the same slice:
- Engineer A builds the API endpoint
- Engineer B builds the database queries

If they don't agree on:
- What the table columns are called
- What the request/response shapes are
- What errors can occur
- What states are valid

...their code won't fit together.

L2 is the agreement. It's the contract that says "we will meet at this exact interface."

---

## Sections of a Gold-Standard Slice Spec

### 1. Goal & Scope

```
Goal: Enable users to create and manage AI coding sessions.

In Scope:
- Creating runs with worktrees
- Starting tmux sessions
- Launching runners
- Tracking run state

Out of Scope:
- GitHub integration (that's Slice 3)
- Viewing run history (that's Slice 2)
```

### 2. Domain Models

The exact data structures, with every field specified.

```
Run:
  id: TEXT (ULID, primary key)
  repo_id: TEXT (foreign key)
  state: TEXT (enum: queued | running | completed | failed | killed)
  title: TEXT (nullable)
  parent_branch: TEXT (not null)
  runner: TEXT (not null, e.g., "claude-code")
  created_at: INTEGER (unix ms, not null)
  started_at: INTEGER (unix ms, nullable)
  completed_at: INTEGER (unix ms, nullable)
  failure_reason: TEXT (nullable)
```

This is exact. Not "a run has some metadata." Every field, every type, every constraint.

### 3. State Machine

If your domain has states, specify every valid transition.

```
Run State Machine:

  ┌─────────┐
  │ queued  │
  └────┬────┘
        │ start()
        ▼
  ┌─────────┐
  │ running │
  └────┬────┘
        │
        ├── complete() ──► completed
        │
        ├── fail() ──────► failed
        │
        └── kill() ──────► killed

Illegal transitions:
- completed → running (cannot restart finished run)
- failed → completed (cannot succeed after failure)
- queued → completed (must go through running)
```

### 4. API Contracts

Every endpoint, fully specified.

```
POST /runs
  Auth: None (local daemon)

  Request:
    {
      "repo_path": string (required, absolute path),
      "title": string (optional),
      "runner": string (optional, defaults to config),
      "parent_branch": string (optional, defaults to current)
    }

  Response 200:
    {
      "run_id": string (ULID),
      "worktree_path": string,
      "state": "queued"
    }

  Response 400 (E_INVALID_REQUEST):
    { "error_code": "E_INVALID_REQUEST", "message": string }

  Response 404 (E_REPO_NOT_FOUND):
    { "error_code": "E_REPO_NOT_FOUND", "message": string }

  Response 409 (E_REPO_LOCKED):
    { "error_code": "E_REPO_LOCKED", "message": string }
```

### 5. Error Codes

Every error that can occur in this slice.

```
E_REPO_NOT_FOUND: repo_path does not exist or is not a git repo
E_NO_AGENCY_JSON: repo has no agency.json config file
E_INVALID_CONFIG: agency.json failed validation
E_PARENT_DIRTY: parent branch has uncommitted changes
E_WORKTREE_EXISTS: worktree already exists for this run
E_TMUX_FAILED: failed to create tmux session
E_RUNNER_FAILED: runner process exited unexpectedly
```

### 6. Invariants

Rules that must always hold within this slice.

- A run in state 'running' MUST have a non-null started_at
- A run in state 'running' MUST have an active tmux session
- A run in state 'completed' MUST have a non-null completed_at
- A run in state 'failed' MUST have a non-null failure_reason
- A worktree directory MUST NOT exist for a run in state 'killed'

### 7. Acceptance Scenarios

Concrete test cases at the slice level.

```
Scenario: Successful run creation
  Given: A valid repo with agency.json
  And: Parent branch is clean
  When: User calls `agency run --title "fix bug"`
  Then: A new run is created in state 'queued'
  And: A worktree is created at ~/.agency/worktrees/{repo}/{run_id}
  And: A tmux session is started
  And: The runner is launched inside the tmux session
  And: Run transitions to state 'running'

Scenario: Run creation with dirty parent
  Given: A valid repo with agency.json
  And: Parent branch has uncommitted changes
  When: User calls `agency run`
  Then: Error E_PARENT_DIRTY is returned
  And: No run is created
  And: No worktree is created
```

---

## What Does NOT Go in a Slice Spec

- Implementation details ("use library X")
- File paths ("put this in src/services/run.rs")
- Internal helper functions
- Performance optimizations
- Anything only one PR needs to know

---

## The "Multiple PRs" Test

For every item in your slice spec, ask:

"Do multiple PRs need to agree on this?"

- Table schema → Yes, the PR that creates the table and the PR that queries it must agree → **Include**
- Function signature for public API → Yes, caller and callee must agree → **Include**
- Internal helper function → No, only one file uses it → **Exclude**
- Error code → Yes, thrower and catcher must agree → **Include**
- Variable name inside a function → No → **Exclude**

---

## Common Slice Spec Mistakes

**Mistake 1: Duplicating the Constitution**
Don't restate "we use JSON for APIs." That's in [L0](./01-constitution-L0.md). Just follow it.

**Mistake 2: Over-specifying implementation**
Don't say "use a HashMap for caching." That's an implementation detail. Say "lookups must be O(1)" if performance matters.

**Mistake 3: Under-specifying errors**
"Returns an error on failure" is useless. What error? What code? When exactly?

**Mistake 4: Vague state machines**
"The run can be in various states" is not a spec. List every state and every legal transition.

**Mistake 5: Missing invariants**
If you don't write invariants, you'll discover them as bugs later.

---

See also: [L2 Example — Bookmark Manager](./examples/bookmark-manager/slice-2-bookmark-crud.md) | Next: [PR Roadmap](./04-pr-roadmap.md)
