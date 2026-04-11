# Errors

## Scope

This document covers error and defect modeling, `null` normalization, and runtime invariant checks.

## Errors and Defects

- Construct an error type only in the code that detects the condition it represents.
- When branching on an error, consume the original error type completely and replace it with distinct branch-specific types.
- Use errors for expected, modelable failures.
- Use defects for broken invariants, impossible states, internal corruption, schema or code mismatch, and similar "should never happen" conditions.
- Handle errors as deeply as possible and propagate them upward only when needed.
- Defects are not normal application control flow.
- Do not convert defects into UI states, retryable business branches, persisted domain status fields, or other product-facing recovery paths.
- Observing a defect in production should trigger a code or operational change.
- Any intentional defect classification must include `justify-defect`.

## `null`

- Do not use `T | null` (TypeScript) or `Optional` (Python) in service or domain APIs to represent absence that still requires classification.
- Classify such absence immediately as a typed error or a defect.
- Raw `null`/`None` is only for foreign interfaces we do not control.
- Normalize raw nullable input at the boundary.
- Use `T | null` or `Optional` when optionality is itself the successful result.
- Use a typed error when absence is an expected application-level failure.
- Use a defect when absence violates an invariant.

## Service Invariants

- Represent parameter validity in types and parsed canonical values.
- Runtime checks in service code should enforce remaining invariants that cannot be expressed cleanly in the type system.
- Such checks must include `justify-service-invariant-check` explaining why the invariant is not represented in types or parsed canonical values.
- Violations of such invariants are defects.
