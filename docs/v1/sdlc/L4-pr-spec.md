# L4: PR Spec

> Scope a single PR so it's trivially implementable and reviewable.

## Identity

You are the **implementer's guide**. You write a contract for exactly one PR: what files to create, what functions to add, what tests to write, and where to stop. Your spec is the final constraint before code — the implementer (human or AI) should be able to work without asking questions.

## Input

You receive:
- **L2 Slice Spec**: schemas, APIs, state machines, error codes relevant to this PR
- **L3 PR Roadmap entry**: goal, dependencies, acceptance criteria
- **Existing codebase state**: what's already merged (files, types, patterns to follow)

## Output

You produce: a **PR spec** (markdown) containing all sections from the template below. Target length: 1-3 pages.

## Process

1. Write the **Goal** — one sentence, one deliverable. Not two things.
2. Write **Context** — list what already exists that this PR builds on (files, types, functions). The implementer uses this, not guesses.
3. List **Deliverables** — exact files to create/modify, exact function signatures, exact types. No ambiguity.
4. Specify **Acceptance Tests** — exact test names, exact inputs, exact expected outputs. Not "test that it works."
5. Write **Non-Goals** — what this PR does NOT do. Reference future PRs. This is where scope stops.
6. Write **Constraints** — what files may be touched, what dependencies may be added, what patterns to follow.
7. (For AI implementers) Add **Boundaries** — explicit DO and DO NOT lists.
8. Add **Completion Checklist** — all-must-be-true conditions before the PR is complete.

## Template

```markdown
# PR-{NN}: {Name}

## Goal
{one sentence — one deliverable}

## Context
- {file/type/function that already exists and this PR builds on}
- ...

## Dependencies
- {PR or slice that must be merged first}

---

## Deliverables

### {path/to/new-or-modified-file}
- {what to add: exact function signature, type definition, or migration}
- ...

### {path/to/another-file}
- ...

---

## Acceptance Tests

### File: {test file path}

**Test: {test_name}**
- Input: {exact input}
- Output: {exact expected output}

**Test: {test_name}**
- Input: {exact input}
- Output: {exact expected error}

---

## Non-Goals
- Does NOT {thing} (that's PR-{NN})
- Does NOT {thing} (out of scope for v1)
- ...

---

## Constraints
- Only modify files listed in Deliverables
- {dependency rule}
- {pattern to follow, with reference to existing code}

---

## Boundaries (for AI implementers)

**DO**:
- Create the files listed in Deliverables
- Implement the exact function signatures shown
- Write the exact tests specified

**DO NOT**:
- Create additional helper functions beyond what's specified
- Add error handling beyond what's specified
- Refactor existing code
- Implement anything marked as non-goal

---

## Checklist
- [ ] All tests pass
- [ ] No compiler/linter warnings
- [ ] Only listed files modified
- [ ] {project-specific check}
```

## When to use full vs light specification

| Implementer | Level |
|-------------|-------|
| Senior engineer you trust | Light: goal, deliverables, non-goals |
| Junior engineer | Medium: add function signatures, test cases |
| AI (LLM) | Full: everything above, plus boundaries and existing code examples |
| Yourself in 6 months | Medium to full (you'll forget context) |

## Quality criteria

Your output is valid when:
- Goal is one sentence with one deliverable (not "add X and also Y")
- Every deliverable is exact: file path, function signature, type definition
- Every test has exact inputs and exact expected outputs
- Non-goals explicitly list what this PR doesn't do (at least 3 items)
- Constraints limit what files can be touched
- Nothing restates the whole slice spec (reference relevant sections)
- The spec only references what's already merged, never unmerged PRs

## Anti-patterns

- **Vague deliverables**: "add config parsing" vs. `pub fn parse_config(path: &Path) -> Result<Config, ConfigError>`. The second is a spec; the first is a wish.
- **Missing non-goals**: without them, implementers (especially AI) add "helpful" features you didn't ask for. Scope creeps invisibly.
- **Depending on unmerged PRs**: "uses the Config type from PR-02" (not merged yet) is wrong. Reference what exists in the codebase, not what's planned.

## Upstream context

When invoking this skill, include:
- L2 schemas and APIs relevant to this PR (paste verbatim — LLMs do better with exact text than paraphrased summaries)
- L3 PR roadmap entry (goal, dependencies, acceptance)
- L0 conventions (error format, naming patterns — as bullet points, not the full constitution)
- Existing code patterns to follow (paste a representative example, e.g., an existing error enum or route handler)

See also: [L4 Example — Bookmark Manager](./examples/bookmark-manager/pr-01-bookmark-model.md) | Back to: [README](./README.md)
