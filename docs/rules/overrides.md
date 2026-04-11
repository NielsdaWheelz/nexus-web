# Overrides

## Scope

This document covers justified escape hatches in source code: overrides, intentionally retained dead code, and type assertions.

## Overrides

- Every `// @ts-*` comment must include `justify-ts-override`.
- Every `// eslint-*` comment must include `justify-eslint-override`.
- Every `# noqa` or `# type: ignore` comment must include a justification.
- Every `# ruff: noqa` comment must include a justification.

## Dead Code

- Delete dead code by default.
- If an exported symbol is intentionally kept without current call sites because we expect to want it again soon, justify it with `justify-dead-code`.

## Type Assertions

- Every type assertion except `as const` (TypeScript) must include `justify-type-assertion`.
- Every `cast()` or `# type: ignore` (Python) must include a justification explaining why the cast is safe.
