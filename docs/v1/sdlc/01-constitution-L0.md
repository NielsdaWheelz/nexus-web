# L0: Constitution

> **what**: how to write a system-level constitution that prevents project drift.
> **who**: architect, CTO, tech lead.
> **when**: project inception. updated almost never.

---

**Purpose**: Prevent project drift. Lock in irreversible decisions.

**Analogy**: A country's constitution. It doesn't tell you what laws to pass — it tells you what kinds of laws are allowed. It's very hard to change.

**Contains**:
- Goals and explicit non-goals (what we refuse to build)
- System boundaries (what talks to what)
- Trust model (what is trusted vs untrusted)
- Core abstractions (the 3-5 fundamental concepts)
- Irreversible technology choices (language, database, deployment model)
- Cross-cutting conventions (error handling style, logging format, testing patterns)

**Does NOT contain**:
- Specific endpoints
- Database table schemas
- UI flows
- Implementation details

**Decision test**: If this changes, does most of the codebase need to change?

---

## Sections of a Gold-Standard Constitution

### 1. Vision (The "What" and "Why")
- Problem: What pain does this solve? (1-2 sentences)
- Solution: What is this thing? (1-2 sentences)
- Scope: What's included in v1?
- Non-scope: What's explicitly excluded? (Critical — prevents drift)

### 2. Core Abstractions
- The 3-7 fundamental concepts that everything else builds on
- These become your ubiquitous language — everyone uses these exact terms
- Example for Agency: Run, Workspace, Runner, Session, Repo

### 3. Architecture
- Components (what are the major pieces?)
- Responsibilities (what does each piece own?)
- Communication (how do pieces talk to each other?)
- Trust boundaries (what trusts what?)

### 4. Hard Constraints
- Technology choices that cannot change (language, database, etc.)
- Deployment model (local, cloud, hybrid)
- Security model (who can do what)

### 5. Conventions
- Naming patterns
- Error handling style
- Logging format
- Testing patterns
- File/folder structure rules

### 6. Invariants
- Rules that must NEVER be violated, system-wide
- These are your "laws of physics"
- Example: "A run cannot be in state 'running' without an active tmux session"

---

## What Makes a Constitution Good vs Bad

**Bad constitution**:
```
We're building a tool to help developers. It will be fast and reliable.
We'll use modern best practices.
```
This constrains nothing. An engineer could build anything and claim it follows this.

**Good constitution**:
```
Problem: AI coding sessions create messy git state and are hard to track.

Solution: A local CLI that creates isolated worktrees for each AI session,
manages their lifecycle, and handles PR creation/merge.

Non-scope (v1):
- No cloud/remote features
- No sandboxing or containers
- No multi-repo coordination
- No automatic PR approval

Architecture:
- CLI binary (agency) - stateless, handles user commands
- Daemon binary (agencyd) - owns all state, single writer to SQLite
- Communication: Unix domain socket, JSON messages

Conventions:
- All errors: E_CATEGORY_NAME (e.g., E_RUN_NOT_FOUND)
- All timestamps: Unix milliseconds
- All IDs: ULIDs
- CLI always supports --json for machine output
```
This constrains heavily. An engineer cannot deviate without explicitly violating the document.

---

## The "Non-Scope" Section is the Most Important

Most constitutions fail because they don't say what they're NOT building.

Why non-scope matters:
1. Prevents scope creep ("but wouldn't it be nice if...")
2. Stops AI from hallucinating features
3. Forces hard prioritization decisions upfront
4. Makes "no" easy to say later ("it's in the non-scope")

Good non-scope examples:
- "No web UI in v1"
- "No Windows support in v1"
- "No automatic conflict resolution"
- "No integration with CI/CD systems"
- "No user accounts or authentication"

Each of these is a feature someone will ask for. Having them in non-scope means you've already decided.

---

## Invariants: Your System's Laws of Physics

Invariants are rules that must never be violated, no matter what.

Good invariants are:
- Testable (you can write code to check them)
- Universal (apply everywhere, not just one feature)
- Protective (violating them would cause serious bugs)

Examples:
- "A run in state 'completed' must have a non-null completed_at timestamp"
- "A workspace directory must not exist for a run in state 'archived'"
- "The daemon is the only process that writes to the database"
- "All API responses include an error_code field on failure"

Why invariants matter:
When debugging, you can check invariants first. If one is violated, you know exactly what category of bug you're looking at.

---

See also: [L0 Example — Bookmark Manager](./examples/bookmark-manager/constitution.md) | Next: [L1: Roadmap](./02-roadmap-L1.md)
