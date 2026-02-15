# L1: Slice Roadmap

> **what**: how to order work into vertical slices with clear dependencies.
> **who**: product + tech lead.
> **when**: project inception, updated per planning cycle.

---

**Purpose**: Order the work. Define dependencies.

**Analogy**: A construction schedule. "Foundation before walls. Walls before roof. Electrical before drywall."

**Contains**:
- Slices (chunks of user-visible value)
- Dependencies between slices
- Acceptance criteria per slice (how do we know it's done?)
- Risk spikes (unknowns we need to investigate early)

**Does NOT contain**:
- How to implement each slice
- Database schemas
- API designs

**Decision test**: If this changes, does the timeline change more than the code?

---

## What Is a Slice?

A slice is a vertical chunk of user-visible value that can be delivered independently.

Analogy: Slicing a cake vertically, not horizontally.

Horizontal (bad): "First build all the database tables. Then build all the APIs. Then build all the UI."
- Problem: Nothing works until everything works. No feedback until the end.

Vertical (good): "First build login (DB + API + UI). Then build posting (DB + API + UI). Then build search."
- Benefit: Each slice is usable. You get feedback early. You can ship incrementally.

---

## What Goes in a Roadmap

For each slice:

1. **Name and Goal** (one sentence)
   - "Slice 0: Bootstrap — User can initialize a repo and verify prerequisites"
2. **Outcome** (what's true when this slice is done?)
   - "User can run agency init and agency doctor successfully"
3. **Dependencies** (what must exist first?)
   - "None — this is the foundation"
   - or "Requires Slice 0 (config loading) and Slice 1 (run creation)"
4. **Acceptance Criteria** (how do we know it's done?)
   - "Running agency doctor checks for git, gh, tmux and reports status"
   - "Running agency init creates agency.json in repo root"
5. **Risk/Unknowns** (optional — things we need to investigate)
   - "Unknown: How to detect tmux version compatibility"

## What Does NOT Go in a Roadmap

- Database schemas
- API specifications
- Function signatures
- Implementation details
- File structures

The roadmap is purely about ordering and dependencies. All technical details belong in [L2 (Slice Spec)](./03-slice-spec-L2.md).

---

## The Dependency Graph

A good roadmap forms a DAG (Directed Acyclic Graph).

```
Slice 0: Bootstrap
    │
    ▼
Slice 1: Run ──────────┐
    │                  │
    ▼                  ▼
Slice 2: Observe    Slice 3: Push
    │                  │
    └────────┬─────────┘
              ▼
        Slice 4: Merge
```

This tells you:
- What can be parallelized (Slice 2 and 3 can be built simultaneously)
- What blocks what (can't build Slice 4 until both 2 and 3 are done)
- Where to start (Slice 0 has no dependencies)

---

## Slicing Strategies

**Strategy 1: User Journey**
Follow a user through the product. Each major milestone is a slice.
- Slice 0: User can set up
- Slice 1: User can start a session
- Slice 2: User can see what's running
- Slice 3: User can publish their work
- Slice 4: User can finish and clean up

**Strategy 2: Risk-First**
Put the scariest, most uncertain things early. If they fail, you fail fast.
- "We're not sure if the tmux integration will work — do that in Slice 1"

**Strategy 3: Value-First**
Put the most valuable features early. Ship value to users ASAP.
- "Users care most about starting sessions — that's Slice 1"

Usually you combine all three: Valuable + risky things go first. Easy + low-value things go last.

---

## Good vs Bad Roadmap

**Bad roadmap**:
```
Phase 1: Backend
Phase 2: Frontend
Phase 3: Testing
Phase 4: Polish
```

Problems:
- Horizontal, not vertical (nothing works until Phase 3)
- No acceptance criteria
- No dependencies specified
- "Polish" is not a slice, it's procrastination

**Good roadmap**:
```
Slice 0: Bootstrap
  Goal: User can initialize repo and verify prerequisites
  Outcome: `agency init` and `agency doctor` work
  Dependencies: None
  Acceptance:
    - `agency init` creates agency.json
    - `agency doctor` checks git, gh, tmux, reports pass/fail

Slice 1: Run
  Goal: User can create and enter an AI coding session
  Outcome: `agency run` creates worktree, starts tmux, launches runner
  Dependencies: Slice 0 (config must load)
  Acceptance:
    - `agency run` creates new worktree from parent branch
    - tmux session starts with runner inside
    - `agency attach` connects to session
```

---

## The "Walking Skeleton" Pattern

Build a walking skeleton first.

A walking skeleton is the thinnest possible end-to-end path through your system.

For Agency:
- Slice 0 creates config
- Slice 1 creates a worktree, starts tmux, runs a fake runner that just echoes "hello"
- Slice 3 pushes and creates a PR

This skeleton doesn't do anything useful, but it proves all the pieces connect. Then you flesh out each piece.

---

See also: [L1 Example — Bookmark Manager](./examples/bookmark-manager/roadmap.md) | Next: [L2: Slice Spec](./03-slice-spec-L2.md)
