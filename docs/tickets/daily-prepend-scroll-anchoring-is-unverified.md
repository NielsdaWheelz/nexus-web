# daily prepend scroll anchoring is unverified

status: deferred · origin: 2026-10-04 source review (as `daily-prepend-anchor-wiring-is-dormant`); narrowed 2026-10-09 web dead-code sweep (cleanup/web-dead-code, claude session) · area: daily resource surface

the dormant wiring is gone: on 2026-10-09 the never-called `beforePrepend`
option (`lib/resourceSurface/dailySurfacePersistence.ts`) and its callback, ref
and layout-effect consumer in `components/resource-surface/ResourceSurfaceEditor.tsx`
were deleted. they never ran, so behaviour did not change.

open question: no one has checked in a browser whether a daily prepend keeps the
visible row in place. nothing in the current code anchors the scroll position
across a prepend, so if the viewport jumps, the owner must decide whether that
is acceptable or add anchoring in the session admission path.

evidence: source only; `git show origin/main:docs/tickets/daily-prepend-anchor-wiring-is-dormant.md`.

resolved when: a daily prepend in a scrolled daily pane is exercised in a
browser and either the visible anchor holds, or a fix lands that makes it hold.
