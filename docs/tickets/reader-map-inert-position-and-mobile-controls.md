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

2026-09-26 source-note work exercised actual hosted android touch: marker
activation opened the full evidence body, dismissal returned focus to the
marker, and the cursor did not move. talkback 15 was enabled and its native
touch/double-tap opened the pane. a dispatched linear swipe did not yield a
stable accessibility hierarchy (`could not get idle state`); spoken output and
linear focus order were not observed. this is bounded interaction evidence, not
screen-reader acceptance. these checks used the pre-rebase feature commit
`16099bdd84f4a20c443b6f066f23bc2a2334056e`. its installed apk and navigation receipts are in
[the reader verification](../reader-source-notes-verification.md).
the same installed artifact passed a post-freeze hosted compact touch
check 3/3: complete ordered source bodies opened, dismissal focused the exact
marker, and canonical cursor revision stayed unchanged. this still does not
establish spoken announcements or linear assistive focus.

2026-09-27 intermediate integrated debug apk sha256
`2506cb69aa27304ef1eea3ee6df50626d3b5f516f0562ad4b12b07098b61b0f7`
matched the installed emulator-5558 package. with no default network, emulator
touch events opened a verified downloaded pillow footnote and returned within
0.4 px. talkback bound as a spoken-feedback service; `uiautomator` exposed the
visible marker as a focusable, clickable link. the emulator recorder has no
audio option, and neither spoken output nor sequential focus traversal was
observed. talkback was returned to its original disabled state. operator
assistive-technology acceptance remains open.

the final debug apk sha256
`df2faeccf6aead2ecb651656db6d81da70ff2d1d2fe9bf13b730bf6b36e835c5`
matched the installed package on the same emulator. no-network touch again
opened the downloaded source note and returned within 0.4 px; accessibility
was disabled as at baseline. spoken and linear focus checks remain open.

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

2026-10-05: the reader rewrite (pr2) replaced the hosted rail with
`lib/documentReader/chrome/MapRail.tsx` (structure and evidence lanes; a crowded
group opens its first destination and names all of them in its title; the phone
gets the passive `PositionRibbon`). the witnesses above describe the old rail;
the operator review applies to the new one.
