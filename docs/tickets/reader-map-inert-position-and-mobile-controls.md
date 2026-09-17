# reader map needs operator accessibility acceptance

status: open; software controls implemented, manual device review pending
origin: 2026-09-11 reader-map council; acceptance audit 2026-09-12
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

prerequisite: the candidate reader running on the supported android/webview
surface with touch and a screen reader available.

proposed fix: perform and record the operator review; correct any defects at
the owning control. cover named map disclosure, outline and coincident-member
selection, current position, return, focus/announcement order and dismissal.

acceptance: pointer, keyboard, touch and assistive-technology users reach every
available section/evidence destination and return to their exact origin without
hover or precision gestures. navigation alone records no reading/completion.
retain candidate sha, device/runtime, actions, observed announcements/focus and
verdict. screenshots or accessibility-tree inspection alone are insufficient.
