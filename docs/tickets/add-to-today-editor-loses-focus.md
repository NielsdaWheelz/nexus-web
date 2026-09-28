# the today editor drops focus ~150 ms after add to today

status: open · origin: 2026-09-28 nexus launcher rewrite review (size/nexus-launcher-web) · area: notes / daily page

on a phone viewport, Nexus "Add “text” to Today" hands focus to the Today editor through the
mobile quick-note handoff, and the editor claims it, but about 150 ms later focus falls to
`<body>` and the soft keyboard drops. Quick Note (empty text) keeps focus. the handoff side
(`MobileQuickNoteHandoff.tsx`) completes; the loss happens after the editor claims the
buffer, so it is likely in the daily editor's append path. present before the rewrite
(baseline xfail).

evidence: live harness 2026-09-28, launcher suite `test_add_to_today_editor_keeps_focus` (xfail): focus
samples end on `body`.

resolved when: on a phone viewport, focus stays in the Today editor for 1.5 s after tapping
Add to Today, as it does for Quick Note.
