# immediate native input after return can disappear

on samsung `RFCT51J2MCH`, owned paired candidate `99feec0d2`, real gboard
return followed immediately by x and space is intermittent. run
`20261025-180923-dc9d8131d954` saved the exact rich body `X `; run
`20261025-181332-8ea4b2d35f89` created the successor but never displayed x.
only one insertText beforeinput/input pair reached the DOM. both captures show
the same keyboard and verified physical key targets. no composition was emitted.

return input was consumed at 5028.6 ms, the temporary input gained focus at
5043.5 ms, the sole text input arrived at 5137.2 ms, and canonical focus changed
again around 5629.8 ms. a DOM editing-host/InputConnection handoff is suspected;
the exact missing key and boundary are not yet proven. app persistence loss has
not been established for this failure.

retain passive focus/target metadata, host injection timestamps and failure-only
canonical rich snapshots. preserve the immediate physical sequence without
inter-key waits. repair input ownership at the responsible editor layer if
handoff is confirmed; do not hide it with keyboard delays or a second native edit
interpreter. resolve when repeated real return/typing and canonical rich-body
checks retain every key through the handoff, alongside undo and offline reopen.
