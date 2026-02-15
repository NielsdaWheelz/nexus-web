# LLM Context Engineering

> **what**: how to construct prompts from your doc hierarchy so AI produces exactly what you want.
> **who**: anyone using AI to implement specs.
> **when**: prompting an LLM to write code from a PR spec.

---

## The Fundamental Principle

An LLM is a completion engine. Given context, it generates the most probable continuation.

```
P(output | context)
```

Your job is to craft context such that the only probable output is exactly what you want.

- Too little context → LLM hallucinates, invents, guesses
- Too much context → LLM gets confused, contradicts itself, loses focus
- Wrong context → LLM produces confidently wrong output

The goal: **Minimum viable context that uniquely determines the correct output.**

---

## The Information Hierarchy

At each layer, you're constraining the layer below:

```
L0 (Constitution)     → Constrains all LLM interactions on this project
L1 (Roadmap)          → Constrains which work happens when
L2 (Slice Spec)       → Constrains all PRs in this slice
L3 (PR Spec)          → Constrains this specific generation
L4 (Prompt)           → The actual context window sent to the LLM
```

Key insight: Each layer is a compression of the layers above.

The LLM never sees L0, L1, L2 directly. It sees L4 (the prompt), which summarizes and references the relevant parts of L0-L3.

---

## The Prompt Architecture

```
┌─────────────────────────────────────────────────┐
│  IDENTITY: Who are you? What's your role?       │
├─────────────────────────────────────────────────┤
│  CONTEXT: What already exists? What are the     │
│  rules? What decisions are already made?        │
├─────────────────────────────────────────────────┤
│  TASK: What specifically should you produce?    │
├─────────────────────────────────────────────────┤
│  CONSTRAINTS: What must you NOT do?             │
├─────────────────────────────────────────────────┤
│  FORMAT: What shape should the output take?     │
├─────────────────────────────────────────────────┤
│  EXAMPLES: What does good output look like?     │
└─────────────────────────────────────────────────┘
```

Each section narrows the generation space.

---

## How Each Section Constrains

**IDENTITY** narrows: Who is speaking?

Bad:  "You are a helpful assistant."
Good: "You are a TypeScript backend engineer building a REST API.
       You write clean, type-safe code. You never use 'any'.
       You handle all errors explicitly with proper HTTP status codes."

**CONTEXT** narrows: What's the world state?

Bad:  "We're building a bookmark app."
Good: "You are working in a Node.js/Express project with this structure:
       src/
         models/        # TypeScript interfaces and DB mappers
         services/      # Business logic
         routes/        # Express route handlers
         middleware/    # Auth, validation, error handling

       The following types already exist in src/models/bookmark.model.ts:
       [paste exact type definitions]

       The following error types exist in src/errors/index.ts:
       [paste exact error definitions]

       Authentication middleware extracts userId from JWT:
       [paste middleware signature]"

**TASK** narrows: What's the output?

Bad:  "Add bookmark creation."
Good: "Create the file src/services/bookmark.service.ts containing:
       1. Function `createBookmark(input: CreateBookmarkInput): Promise<Bookmark>` that:
         - Validates URL is http/https
         - Checks for duplicate URL for this user
         - Inserts into database
         - Returns the created bookmark with generated ID
       2. Throws BookmarkError.DUPLICATE_URL if URL already exists
       3. Throws BookmarkError.INVALID_URL if URL is malformed"

**CONSTRAINTS** narrows: What's forbidden?

```
DO NOT:
  - Add any functions not listed above
  - Create any files not listed above
  - Add dependencies to Cargo.toml
  - Use .unwrap() or .expect() outside of tests
  - Add features for 'later' or 'future use'
  - Implement validation beyond what's specified
  - Add logging, metrics, or tracing
  - Refactor existing code
```

**FORMAT** narrows: What shape?

```
Output format:
  - Provide the complete file contents for each file
  - Use ```rust code blocks
  - Do not include explanatory text between files
  - Do not summarize what you did
  - Just output the code
```

**EXAMPLES** narrows: What does good look like?

```
Example of existing error pattern to follow:

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("E_NO_REPO: {0}")]
    NoRepo(String),
}

Your ConfigError should follow this exact pattern.
```

---

## The Layer-by-Layer Application

### L0 (Constitution) → System Prompt / Persistent Context

Extract the relevant conventions and constraints. Include them in every prompt as "project rules." Never make the LLM read the whole constitution.

```
Project Rules (from Constitution):
- Language: Rust, edition 2021
- All errors use pattern E_CATEGORY_NAME
- All timestamps are Unix milliseconds
- No panics in production code
- CLI supports --json flag on all commands
```

### L1 (Roadmap) → Not directly sent to LLM

The roadmap is for humans. The LLM doesn't need to know "Slice 2 comes after Slice 1." It just needs to know what to build right now.

### L2 (Slice Spec) → Reference Material

Extract the exact schemas, APIs, state machines relevant to this PR. Paste them verbatim (don't paraphrase — LLMs do better with exact text). Say "implement according to this spec."

```
From Slice Spec (implement exactly):

Run State Machine:
  queued → running (on start)
  running → completed (on success)
  running → failed (on error)
  running → killed (on kill signal)

Table Schema:
  runs (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','killed')),
    created_at INTEGER NOT NULL,
    ...
  )
```

### L3 (PR Spec) → The Core of the Prompt

This is the main content. Paste the full PR spec or its key sections.

### L4 (Prompt) → The Assembled Context

The prompt is the assembly of relevant pieces from all layers:

```
[Identity]
You are a Rust backend engineer working on the Agency project.

[Project Rules — from L0]
- All errors use E_CATEGORY_NAME pattern
- No unwrap() in production code
- ...

[Current State — from codebase]
These files already exist:
- crates/agency-core/src/lib.rs
- crates/agency-core/src/errors.rs (contents: ...)
- crates/agency-core/src/types.rs (contents: ...)

[Spec to Implement — from L2/L3]
[Paste the schema, API contract, etc.]

[Task — from L3]
Create these files with these exact contents...

[Constraints — from L3]
DO NOT...

[Format]
Output only the code, no explanations.

[Checklist]
Verify before responding:
- [ ] All files match spec exactly
- [ ] All tests are included
- [ ] No extra code beyond spec
```

---

## The Art of Context Selection

**What to include:**

| Include | Why |
|---------|-----|
| Exact type definitions | LLM will match them precisely |
| Exact function signatures | No room for invention |
| Exact error codes | Consistent error handling |
| Example code patterns | LLM imitates style |
| Explicit non-goals | Prevents scope creep |
| Explicit constraints | Prevents bad patterns |

**What to exclude:**

| Exclude | Why |
|---------|-----|
| Full constitution | Too long, dilutes focus |
| Other slices' specs | Irrelevant, confusing |
| Historical context | "We used to do X" is noise |
| Justifications | "We chose Rust because..." doesn't help implementation |
| Future plans | "Later we'll add..." invites premature implementation |

---

## The Reference Pattern

Don't make the LLM read everything. Extract and paste the relevant parts.

Bad:
"Read the constitution at docs/v1/constitution.md and follow all conventions."
(LLM might not have access, might misinterpret, might get lost)

Good:
"Follow these conventions (from project constitution):
  1. Errors: E_CATEGORY_NAME pattern
  2. Timestamps: Unix milliseconds
  3. IDs: ULIDs
  4. No panics in production"
(Exact rules, inline, no ambiguity)

---

## The Layered Validation Pattern

After generation, validate at each layer:

**L0 Check**: Does it follow conventions?
  - Error patterns correct?
  - Naming patterns correct?
  - No forbidden patterns (panics, unwrap)?

**L2 Check**: Does it match the slice spec?
  - Schema matches exactly?
  - State machine implemented correctly?
  - All error codes present?

**L3 Check**: Does it match the PR spec?
  - All deliverables present?
  - All tests present?
  - No extra files?
  - No extra functions?

---

## The Gold-Standard Prompt Template

```
# Context

You are implementing PR-{N} for the {Project} project.

## Project Conventions
{Extract from L0 — 5-10 bullet points max}

## Existing Code
{Paste relevant existing files or excerpts}

## Specification
{Paste from L2 — exact schemas, state machines, APIs}

---

# Task

{Paste from L3 — exact deliverables}

---

# Constraints

DO:
{List of requirements}

DO NOT:
{List of prohibitions}

---

# Output Format

{Exact format requirements}

---

# Verification

Before outputting, verify:
{Checklist}
```

---

## The Meta-Principle

Every piece of context should either:
1. **Narrow** what the LLM can output, or
2. **Provide information** required to produce correct output

If a piece of context does neither, remove it. It's noise.

---

See also: [L3: PR Spec](./05-pr-spec-L3.md) | Next: [Workflow](./07-workflow.md)
