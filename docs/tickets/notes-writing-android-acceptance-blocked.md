status: deferred by owner for review of pr 1 and the stacked bullet pr
origin: 2026-09-25 notes writing live acceptance; updated 2026-09-26
area: android writing webview

w2 composition, autocorrect, dictation, native selection and keyboard handoff
remain unverified on the final build. on a samsung sm-s906w, android 16,
webview 154.0.8037.57, debug apk sha256
`6108334f763367d174337af6f9d7598ee3839f205566ea6600162082af7340dc`,
the first tap opened the keyboard and a tapped keyboard key edited the note.
that development build's paced 100-note trace measured 82.9 ms p95 over 100
edits, versus 21.3 ms for a plain textarea in the same webview. this exceeds
the 50 ms w6 target, but does not qualify the final code or production web
build. the phone disconnected before that production trace. the owner asked
to finish pr 1, review it, stack pr 2, then resume android checks.

prerequisite: physical phone access and an isolated build of the final stacked
code. rerun w2 and w6 on that exact production web build; profile and repair
the 100-note path at its owner if the latency remains above target. retain the
temporary probes and their receipts until acceptance is complete.

acceptance: physical android w2 writing/ime/selection/handoff cases pass and
the 100-edit, 100-note trace has p95 input-to-paint below 50 ms, no
network-gated paint, and no save-induced focus or scroll jump. record build
identity and timings; then delete this ticket.
