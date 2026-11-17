# deferred: press-and-slide pane selection

unapproved proposal from the 2026-11-15 thumb-index exploration: press the disc,
slide over an open-pane row and release to choose it. the existing tap path and
browser scrolling remain the accepted behavior; building the thumb index did
not authorize this gesture.

`apps/web/src/components/switchboard/NexusButton.tsx` commits at lift;
`Switchboard.module.css` gives vertical travel to browser panning. the sheet's
opening-click guard also rejects the opening touch's click. a scrub would need
a deliberate change to those ownership boundaries, not an extra handler that
competes with them. the related native issue remains
[post-drag menu reopening](android-webview-post-drag-menu-reopen.md).

owner decision required before implementation: is the gesture worth changing
the tap-only contract in `docs/modules/app-navigation.md`? if approved, preserve
ordinary tapping and scrolling and qualify cancellation/selection on a handset;
otherwise decline it and remove this record. haptics are a separate optional
product decision, not a prerequisite implied by this proposal.
