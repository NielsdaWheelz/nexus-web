# TypeScript

## Scope

This document covers repository-wide TypeScript type-shape rules.

## Generic Type Parameters

- Constrain on composite types rather than decomposing their inner type parameters.
- Prefer `<S extends SomeType>` over separate type parameters for `SomeType`'s inner parts.
- Use indexed access such as `S["Type"]` to extract constituent types.
- Introduce separate type parameters only when callers need to specify or constrain them independently.
