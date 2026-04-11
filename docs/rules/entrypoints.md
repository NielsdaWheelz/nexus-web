# Entrypoints

## Scope

This document covers entrypoints and side effects.

## Rules

- Entrypoints should live in `bin` directories.
- Only entrypoints should have side effects.
- It is fine to colocate server and client helpers in one module as long as browser-facing imports use only browser-safe exports.
