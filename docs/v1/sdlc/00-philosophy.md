# Philosophy: Why Layered Documentation

> **what**: the mental model behind the doc hierarchy.
> **who**: everyone — read this first.
> **when**: onboarding, starting a new project, questioning why docs exist.

---

## What Is Software?

Software is a machine that transforms inputs into outputs. Every program, no matter how complex, is:

```
INPUT → [transformation] → OUTPUT
```

Everything in between is just *how* that transformation happens.

## Why Documents?

Documents are blueprints. They exist so that:
1. **You** don't forget what you're building
2. **Others** (including AI) can help without misunderstanding
3. **Future you** can understand why decisions were made
4. **Changes** don't accidentally break things

## The Document Hierarchy

```
L0: CONSTITUTION (rarely changes)
    ↓ constrains
L1: SLICE ROADMAP (order of work)
    ↓ constrains
L2: SLICE SPECS (contracts per feature)
    ↓ constrains
L3: PR SPECS (exact work units)
    ↓ constrains
L4: CODE (the actual implementation)
```

Each level **narrows the possibilities** for the level below.

## The Visual Funnel

```
┌─────────────────────────────────────────────────────────────┐
│                     L0: CONSTITUTION                        │
│  "We're building a REST API + React SPA. PostgreSQL."      │
│  Constrains: Language, architecture, deployment model       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │           L1: SLICE ROADMAP             │
        │  "Auth first, then CRUD, then Search"   │
        │  Constrains: Order, dependencies        │
        └─────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │        L2: SLICE SPEC         │
              │  "bookmarks table, POST/GET,  │
              │   pagination, error codes"    │
              │  Constrains: Schemas, APIs,   │
              │  interfaces, invariants       │
              └───────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │    L3: PR SPEC    │
                    │  "Add Bookmark    │
                    │   model with      │
                    │   these tests"    │
                    │  Constrains:      │
                    │  Exact code       │
                    └───────────────────┘
                              │
                              ▼
                         ┌────────┐
                         │  CODE  │
                         └────────┘
```

## The Core Principle

Each document exists to **constrain** the document below it. A good document at level N makes the decisions at level N+1 obvious or at least bounded.

If a document doesn't constrain anything, it's not pulling its weight. Delete it.

---

Next: [L0: Constitution](./01-constitution-L0.md) | [Quick Reference](./08-quick-reference.md)
