# Environment

## Scope

This document covers environment variable rules.

## Rules

- Keep `.env.example` in sync with every added, removed, or renamed environment variable.
- Every environment variable read by source code must appear in `.env.example`.
- Each environment variable in `.env.example` must state whether it is required or optional, and its default if it has one.
