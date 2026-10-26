# missing suffix during same-device peer typing

an ordinary second-tab note edit did not reach its expected canonical text in
live run `20261025-212216-4c293cc5ee65` on `b1b09675f`. the temporary
`same-replica-creation-undo.ts:76` typed `B1111c418` after `A`; server snapshots
remained `AB1111c` for the ten-second assertion. the touch advanced and exactly
one replica remained. this stopped the removed-predecessor control before its
resource deletion or undo/redo steps; it is not a causal-coverage verdict.

inspect the second tab's actual input, focus, rendered text and receipt events
in that run's trace before attributing the omission to persistence or host
replacement. no event-delivery claim is established yet. do not add typing delays
or weaken the exact text assertion. the incoming continuous-host editor must
preserve the complete literal text through commit and cross-tab delivery, then
complete the unchanged resource-delete/redo/undo control.
