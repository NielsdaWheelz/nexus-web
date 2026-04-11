# Function Parameters

## Scope

This document covers parameter shape rules.

## Rules

- Config, builder, and boundary APIs should take a single object parameter (TypeScript) or keyword arguments (Python).
- Prefer collapsing multiple business fields into a single payload object rather than adding more positional parameters.
- Optional parameters should always live in an object parameter (TypeScript) or be keyword-only (Python).
- Prefer shallow object shapes by default.
- Keep fields nested when they belong to a real named sub-concern, phase, or subsystem.
- Small pure helpers and primitives may remain positional when the arguments are obvious and tightly coupled.
