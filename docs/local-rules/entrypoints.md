# Entrypoints

## Scope

Where nexus-web's entrypoints concretely live. The generic rules — entrypoints
live in explicit entrypoint directories, and only entrypoints perform startup
side effects — are owned by [../rules/codebase.md](../rules/codebase.md); this
document enumerates those entrypoints for this repo.

## Locations

- Entrypoints live in explicit bootstrap locations: `bin` directories, Next.js
  App Router `page.tsx` and `route.ts` files, FastAPI ASGI modules, worker
  bootstrap modules, and framework entrypoints declared in manifests.
- Android app entrypoints are Android framework components declared in
  `AndroidManifest.xml`.
- It is fine to colocate server and client helpers in one module as long as browser-facing imports use only browser-safe exports.
