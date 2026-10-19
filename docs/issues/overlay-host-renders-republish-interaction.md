# an open overlay host republishes interaction on every render

status: open; cost, not a defect · origin: resource references re-slice (N13), 2026-10-19 · area: overlays

`apps/web/src/lib/ui/overlay.ts:531-533` runs `notifyInteraction()` in a layout effect
with no dependency list while the overlay is open, so every render of an open host
notifies every interaction subscriber, whether or not anything changed.

impact: renders of an open menu or dialog fan out to all subscribers; no wrong state
observed.

resolved when: subscribers hear only changes to the interaction state (push, pop,
cover, expose), and the menu, dialog and Tab-exit journeys still pass.
