# reader map needs operator accessibility acceptance

status: open; browser behavior verified, physical device review pending
origin: 2026-09-11 reader-map council; audits 2026-09-12 and 2026-09-22
area: reader interaction / accessibility

named position, return, mobile disclosure, section and dense-member controls are
implemented. hosted sensitivity `8b0b983d002cd181`, rail sensitivity
`00e6ce31846dcf19`, detail sensitivity `c6cbe7a83935ec23`, and phone witnesses
`933ea7a501a0bd64` prove exact arrivals, quiet navigation, pointer/keyboard
activation, focus return and bounded layout. input proof `9f9267423390484c`
also exercises trusted browser touch events, completed prose taps, one-finger
movement and zoom exclusion. these historical checks did not establish physical
touch or screen-reader usability.

manual assistive-technology review remains appropriate for these interaction
changes under `docs/local-rules/testing-standards.md`. none is recorded for this
cutover. oi-062's resolved geometry does not discharge this
remaining interaction review.

the 2026-09-22 interaction run first found the mobile map opener under nexus at
390x844. the repair places the control above the pane's existing
`--mobile-content-bottom-clearance`. a clean chromium 147 rerun measured its
box at `(339.39, 744, 42.61, 32)`, returned the button from its center, and
opened contents by pointer. every inspector target was at least 24px; a preview
followed a real 48px sheet translation within 0.31px, closed below a newer
nexus modal, stayed closed afterward, and left no popover when its sheet host
was removed. the matched durable-state snapshot was unchanged.

prerequisite: the candidate reader and a downloaded publication running on the
supported android/webview surface with touch and a screen reader available.

2026-09-24 reader-inspector-controls (`810dcff8c`) removed the rail `≡` and
mobile ribbon `map` openers. the mobile path to Contents and Evidence is now the
header `Inspector` control after More (48x48, `aria-expanded`, `aria-controls`
on the open sheet), which passes its actual trigger; the source-review concern
about the untriggered map opener no longer applies. observed in headless
chromium (390x844, 320x640, 200% zoom emulated) and in the handset webview
(samsung SM-S906W, android 16, webview 151, debug build at `2326faa4f`): pointer
and keyboard open, sheet close and Escape return focus to the visible,
interactive opener without moving the reading position; the ribbon is passive
and aria-hidden; the downloaded reader keeps its `document map` toggle. the
owner waived physical touch and screen-reader checks for that change, so this
review stays open.

proposed fix: perform and record the operator review; correct any defects at
the owning control. cover the live and downloaded readers, named map disclosure,
outline and coincident-member selection, current position, return,
focus/announcement order and dismissal.

acceptance: pointer, keyboard, touch and assistive-technology users reach every
available section/evidence destination and return to their exact origin without
hover or precision gestures. at 390x844 and supported neighboring viewport
sizes, hit testing the header inspector control returns that button throughout
its painted bounds. navigation alone records no reading/completion. retain candidate
sha, device/runtime, actions, observed announcements/focus and verdict.
screenshots or accessibility-tree inspection alone are insufficient.
