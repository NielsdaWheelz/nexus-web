# Correctness

## Scope

This document covers system abnormality classification and repository-wide correctness invariants.

## Abnormalities

- Expected system-level abnormalities must be modeled and handled in code.
- Unexpected abnormalities indicate a broken invariant and should trigger investigation.
- Expected abnormalities include server restarts and transient service failures within the applicable retry budget.
- Unexpected abnormalities include service failures that persist beyond the applicable retry budget.
- Retry budgets define the boundary between expected transient failure and unexpected persistent failure.
- See [retries.md](retries.md) for retry policies and exhaustion handling.

## Invariants

- If concurrent execution can produce an incorrect result, it is a bug.
- Every operation must correspond to some valid sequential ordering of all concurrent operations.
- Read-only operations that span multiple systems must handle transient inconsistency from concurrent modification.
- Prefer compile-time enforcement of correctness invariants where possible.

## Untrusted Data

- When input is not statically known, parse and validate it. Violations are defects.
- Normalize only at ingress. After the boundary, treat the value as trusted and canonical.
- If a trusted value is not canonical, that is a bug. Fail loudly instead of silently normalizing.
- Do not add redundant canonicalization across layers. Tighten the boundary, type, or persisted representation instead.
- Validate only the single expected type. Do not add speculative handling for alternative types. Coercion branches for "just in case" types are dead code that hides bugs.
