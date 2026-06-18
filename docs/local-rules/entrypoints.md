# Entrypoints

## Scope

This document covers entrypoints and side effects.

## Rules

- Entrypoints live in explicit bootstrap locations: `bin` directories, Next.js
  App Router `page.tsx` and `route.ts` files, FastAPI ASGI modules, worker
  bootstrap modules, and framework entrypoints declared in manifests.
- Android app entrypoints are Android framework components declared in
  `AndroidManifest.xml`.
- Only entrypoints should have side effects.
- It is fine to colocate server and client helpers in one module as long as browser-facing imports use only browser-safe exports.
