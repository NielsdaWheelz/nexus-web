# JSON Values

## Scope

This document covers structured JSON values.

## Rules

- Keep semantically structured JSON as typed objects in code and API DTOs rather than stringifying it.
- Persist structural JSON in PostgreSQL `jsonb`, not `text`.
- At the PostgreSQL boundary, keep SQL `NULL` distinct from JSON `null`.
- Do not use `===`/`==` for potentially structural JSON values. Use deep equality when comparing objects.
