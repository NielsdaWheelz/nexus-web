# local highlight previews discard captured surroundings

problem: local authored previews omit retained prefix/suffix, making quotation
context depend on the presentation path rather than an explicit excerpt policy.

evidence: source audit at `58e135bf2958bab8ca12971cb3984f77c01c2e66`,
2026-10-28; no browser reproduction.
`apps/web/src/lib/notes/presentation.ts:14` sets both context fields to null for
every local highlight. `apps/web/src/components/resources/ResourceOutlineRow.tsx:225-228`
separately renders only `selection.quote_exact`. the capture already holds literal
prefix/suffix (`apps/web/src/lib/documentReader/annotations.ts:140-151`).

impact: picker/outline evidence can omit the surroundings needed to understand a
highlight, and richer capture alone will not fix these consumers. historical
quote substitution has its own record in
`historical-quotes-use-live-authored-resources.md`.

resolved when local and server-backed quotation views use the same retained
excerpt contract, including context and its structure. compact discovery labels
may remain abbreviated through an explicit presentation policy.
