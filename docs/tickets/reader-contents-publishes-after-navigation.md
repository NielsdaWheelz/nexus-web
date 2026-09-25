# reader contents publishes after navigation, briefly showing evidence

status: open · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: reader / inspector

reloading with the inspector open on Contents shows Evidence for ~120ms
(desktop 332 -> 449ms, mobile 299 -> 427ms) before Contents. the reader's first
inspector publication lacks Contents until `documentReader.navigation` is
ready, so the host projects the default. the remembered tab and final state are
correct (restore no longer rewrites them).

fix, if the flash matters: publish the media inspector once navigation is ready
or failed, at the cost of showing the header Inspector control later by the
same interval.

acceptance: a reload open on Contents never paints Evidence.
