# daily prepend anchor wiring is dormant

status: deferred. origin: 2026-10-04 source review. area: daily resource surface.

at `557aed14f1d88bdb2b1bc9856944ce433e38f115`, `lib/resourceSurface/dailySurfacePersistence.ts:36` declares optional `beforePrepend`. its sole caller is `components/resource-surface/ResourceSurfaceEditor.tsx:462–474`, passed at line 507. `useResourceSurfaceSession.ts` never reads or calls it. the callback alone fills `prependAnchorRef`; the consumer at lines 539–551 cannot receive a captured anchor through this wiring.

this retains unused callback/ref/effect ownership. no live prepend scroll defect is claimed; the evidence is source-only.

first confirm the current daily caller and scroll contract. retire the unused option, callback, ref and consumer together if no current owner requires them; otherwise repair the responsible admission path. acceptance: complete caller census plus an actual daily prepend preserving the intended visible anchor, with no dormant parallel wiring.
