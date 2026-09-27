status: open; final signed physical acceptance pending
origin: 2026-09-25 notes writing live acceptance; updated 2026-09-27 source-note integration
area: android writing webview

w2 composition, autocorrect, dictation, native selection and keyboard handoff
remain unverified on the final build. on a samsung sm-s906w, android 16,
webview 154.0.8037.57, debug apk sha256
`6108334f763367d174337af6f9d7598ee3839f205566ea6600162082af7340dc`,
the first tap opened the keyboard and a tapped keyboard key edited the note.
that development build's paced 100-note trace measured 82.9 ms p95 over 100
edits, versus 21.3 ms for a plain textarea in the same webview. this exceeds
the 50 ms w6 target, but does not qualify the final code or production web
build. the owner approved including the notes cutover after its checks. the
connected phone is the only offline device and is signed in, but no final apk
has been installed or accepted.
the only camera currently enumerated on this mac is its built-in camera;
avfoundation reports a 30 fps maximum for every format. no external optical
capture source is connected.

prerequisite: a signed apk from the exact released code and the production web
build, installed without clearing phone data. the existing desktop keydown-to-rAF
result is prepaint; frame metrics cannot identify the first frame with the edited
glyph. obtain an external optical contact-to-glyph recording or equivalent
validated measurement. any cadence suffices only if its conservative timing
upper bound can prove the strict threshold. rerun w2 and w6; profile and repair
the 100-note path at its owner if the latency remains above target.
see [frame timeline](https://perfetto.dev/docs/data-sources/frametimeline) and
[frame metrics](https://developer.android.com/reference/android/view/FrameMetrics)
for the scope of the available frame timestamps.

acceptance: physical android w2 writing/ime/selection/handoff cases pass and
100 attributable edits on a short annotation and a 100-note surface each have
conservative p95 input-to-visible-glyph below 50 ms, no network-gated paint,
and no save-induced focus or scroll jump. record exact installed build, web
revision, fixture and timing method; delete temporary probes and this ticket.
