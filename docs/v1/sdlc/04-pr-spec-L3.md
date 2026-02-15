# L3: PR Spec

> **what**: how to scope and specify a single PR so it's trivially reviewable.
> **who**: implementer (human or AI).
> **when**: immediately before writing code.

---

**Purpose**: Make one PR trivially reviewable and low-risk.

**Analogy**: A single work order. "Install outlet #3 at position (x,y). Use 12-gauge wire. Connect to circuit B. Test with multimeter."

**Contains**:
- Goal (one sentence)
- Exact public surface being added (function signature, endpoint, table column)
- Acceptance tests (specific inputs → expected outputs)
- Constraints (what files may be touched)
- Non-goals (what this PR explicitly does NOT do)

**Does NOT contain**:
- Restating the whole slice spec
- Architecture decisions
- Long explanations

**Decision test**: If this changes, does it only invalidate this branch?

---

## Why Not Just Write Code?

Because without a PR spec:
- You might build more than needed (scope creep)
- You might build less than needed (incomplete)
- You might build the wrong thing (misunderstanding)
- An AI will hallucinate features
- Reviewers don't know what to check

A PR spec is a contract with yourself (or with an AI) about exactly what this PR delivers.

---

## Sections of a Gold-Standard PR Spec

### 1. Goal (one sentence)

```
Goal: Add the `parse_config` function that loads and validates agency.json.
```

Not two things. Not vague. One specific deliverable.

### 2. Context (what already exists)

```
Context:
- Config schema is defined in s0_spec.md
- Error types E_NO_AGENCY_JSON and E_INVALID_CONFIG exist in errors.rs
- Paths module exists with `config_path()` function
```

This tells the implementer what they can use.

### 3. Deliverables (exact outputs)

```
Deliverables:
- New file: crates/agency-core/src/config.rs
- New function: pub fn parse_config(path: &Path) -> Result<Config, ConfigError>
- New struct: pub struct Config { ... } matching schema in s0_spec.md
- New enum: pub enum ConfigError { NotFound, Invalid(String) }
- Re-export from lib.rs
```

Exact files. Exact function signatures. Exact types.

### 4. Acceptance Tests (exact inputs → outputs)

```
Tests (in crates/agency-core/tests/config_test.rs):

Test: parse_config_valid
  Input: valid agency.json with all required fields
  Output: Ok(Config { version: "1", ... })

Test: parse_config_missing_file
  Input: path to non-existent file
  Output: Err(ConfigError::NotFound)

Test: parse_config_invalid_json
  Input: file containing "not json"
  Output: Err(ConfigError::Invalid(_))

Test: parse_config_missing_required_field
  Input: agency.json without "version" field
  Output: Err(ConfigError::Invalid("missing field: version"))
```

These are exact. Not "test that it works." Exact inputs, exact outputs.

### 5. Non-Goals (what this PR does NOT do)

```
Non-goals:
- Does NOT implement config file creation (that's PR-03)
- Does NOT implement config migration (out of scope for v1)
- Does NOT validate runner configurations (that's PR-04)
- Does NOT watch for config changes (not needed)
```

This is critical. It tells the implementer where to stop.

### 6. Constraints (rules to follow)

```
Constraints:
- Only modify files in crates/agency-core/
- Do not add new dependencies
- Follow existing error pattern (see errors.rs)
- No panics — all errors must be Result
```

This limits what the implementer can do.

---

## The Art of Scoping a PR

How big should a PR be?

Rules of thumb:
- Reviewable in 15 minutes (under 400 lines changed)
- One logical unit (not "add X and also refactor Y")
- Independently testable (can write tests without other PRs)
- Independently deployable (ideally — won't break if merged alone)

**Too big:**
```
PR: Implement the run command
```
This is a whole slice, not a PR.

**Too small:**
```
PR: Add import statement for serde
```
This isn't meaningful on its own.

**Just right:**
```
PR: Add Run struct and state transition methods
PR: Add runs table schema and migrations
PR: Add create_run service function
PR: Add POST /runs endpoint
```

Each is one logical unit. Each is testable. Each builds on the previous.

---

## PR Dependency Chains

PRs within a slice often form a chain:

```
PR-01: Add domain types (Run, RunState, etc.)
    │
    ▼
PR-02: Add database schema and queries
    │
    ▼
PR-03: Add service layer (create_run, get_run, etc.)
    │
    ▼
PR-04: Add API endpoints (POST /runs, GET /runs/:id)
    │
    ▼
PR-05: Add CLI commands (agency run, agency show)
```

This is a layered approach:
1. Types (no dependencies)
2. Storage (depends on types)
3. Business logic (depends on storage)
4. API (depends on business logic)
5. UI/CLI (depends on API)

Each layer only depends on the layer above it.

---

## PR Specs for AI (Claude)

When writing a PR spec for an AI to implement, add:

**Explicit boundaries:**
```
DO:
- Create the files listed in Deliverables
- Implement the exact function signatures shown
- Write the exact tests specified

DO NOT:
- Create additional helper functions beyond what's specified
- Add error handling beyond what's specified
- Refactor existing code
- Add documentation beyond basic doc comments
- Implement anything marked as non-goal
```

**Example of existing code** (if relevant):
```
Reference — existing error pattern in errors.rs:

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("E_NO_REPO: {0}")]
    NoRepo(String),
}

Follow this exact pattern for ConfigError.
```

**Completion checklist:**
```
Checklist (all must be true before PR is complete):
- [ ] All tests pass
- [ ] No compiler warnings
- [ ] cargo fmt has been run
- [ ] cargo clippy shows no errors
- [ ] Only files in Deliverables were modified
```

---

## Common PR Spec Mistakes

**Mistake 1: Vague deliverables**
Bad: "Add config parsing functionality"
Good: "Add `pub fn parse_config(path: &Path) -> Result<Config, ConfigError>`"

**Mistake 2: Missing test cases**
Bad: "Add tests"
Good: "Test: input X → output Y; Test: input A → error B"

**Mistake 3: No non-goals**
Without non-goals, scope creeps. The implementer adds "helpful" features you didn't want.

**Mistake 4: Depending on unmerged PRs**
Bad: "Uses the Config type from PR-02" (PR-02 not merged yet)
Good: "Uses the Config type from config.rs" (already exists)

PR specs should reference what exists, not what's planned.

**Mistake 5: Multiple unrelated changes**
Bad: "Add config parsing and also fix the logging format"
Good: "Add config parsing" (logging fix is a separate PR)

---

## When to Use Full vs Light Specification

| Implementer | Specification Level |
|-------------|---------------------|
| Senior engineer you trust | Light (goal, deliverables, non-goals) |
| Junior engineer | Medium (add function signatures, test cases) |
| AI (Claude, etc.) | Full (everything above) |
| Yourself in 6 months | Medium to Full (you'll forget context) |

---

## The Critical Insight: Negative Space

What you explicitly exclude is as important as what you include.

Every document should answer:
1. What is this responsible for? (positive scope)
2. What is this NOT responsible for? (negative scope)

Why? Because without negative scope:
- Engineers invent features you didn't ask for
- AI hallucinates behavior
- Scope creeps invisibly
- When something breaks, nobody knows whose fault it is

Example of good negative scope:
"This subsystem handles authentication. It does NOT handle authorization (that's handled by the permissions subsystem)."

Now if there's a bug where users can access resources they shouldn't, you know immediately: it's not an auth bug, it's a permissions bug.

---

See also: [L3 Example — Bookmark Manager](./examples/bookmark-manager/pr-01-bookmark-model.md) | Next: [LLM Context Engineering](./05-llm-context-engineering.md)
