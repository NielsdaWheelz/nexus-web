# android webview post-drag menu reopening

problem: reopening an action sheet after drag dismissal is not yet qualified on
api35/webview124. a real android touchscreen tap reaches the overflow glyph with
trusted pointer/touch down and up, but no click follows; preparation never starts.

evidence: source `5526e3df1`, isolated run `20261020-023439-d156e696b52e`, private
`artifacts/action-menus-webview/observed.json`. six preceding checks passed,
including native back/escape and normal/reduced-motion drag/cancel. final pointer10
ends at browser time10890.1ms with no click, busy state or fifth actions read
through26030.5ms. the preceding closing traversal ended at10765.3ms. the same
measured point emitted a click and read for pointer7. raw devtools touch input
also reproduced the missing-click boundary in earlier runs.

reproduce: fresh debug profile, open a real page menu, close with back and escape,
cancel then dismiss header drags in both motion modes, immediately reopen and use
the visible x. platform input uses actual native webview bounds; no inset guess,
dom activation or extra opening. physical handset/speech remain unavailable.

follow-up run `20261020-024336-18b9c17c38b1` confirms final pointer10 reaches window
bubble and next-task touchend at9550.1ms uncancelled, with the same connected node
and unchanged viewport. no script cancellation, replacement or menu invocation is
observed. both strict browser drag cases pass. native recognition cause remains
unknown; synchronous pointerup dismissal also exists at baseline `d9e7d86aa:69–74`
in `MobileSheet.tsx`, so regression causation is unproven.

do not add a second activation path or guessed delay. resolved when the same
strict native sequence reaches its final reopen/x assertion on the supported
handset/webview, or a demonstrated responsible-layer repair passes affected
qualification.
