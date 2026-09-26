status: blocked
origin: 2026-09-25 notes writing live acceptance
area: android writing webview

w2 composition, dictation, selection and keyboard handoff remain unverified on
the target physical samsung device. an earlier build accepted first tap, ime
input, autocorrect and native selection handles, but its 100-note typing trace
measured 133.4 ms p95 against the 50 ms w6 target. the editor projection has
changed since that trace. another session then replaced the debug app with a
build using port 65230; the device is in use, so neither result qualifies the
current branch.

prerequisite: exclusive access to the phone and an isolated build of this
branch. rerun w2 and w6 on that exact build; repair any observed defect at its
owner. preserve the other session's app and data until access is granted.

acceptance: physical android w2 writing/ime/selection/handoff cases pass and
the 100-edit, 100-note trace has p95 input-to-paint below 50 ms, no
network-gated paint, and no save-induced focus or scroll jump. record build
identity and timings; then delete this ticket.
