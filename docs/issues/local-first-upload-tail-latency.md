# qualify the per-keystroke upload tail

live run `20261025-212216-4c293cc5ee65` on `b1b09675f` typed `B1111c418`
after `A` in a second tab. both rendered occurrences held the complete
`AB1111c418` immediately after typing, with the root editor focused. canonical
server snapshots advanced through `AB` at touch 2, then one more character per
roughly 1.2–1.5 seconds, reaching `AB1111c` at touch 7 when the ten-second
assertion expired. all touches used one replica; decoded states had no pending
yjs structs or deletes.

this proves input delivery and an incomplete upload tail at that deadline, not
swallowed keys or permanent loss. full eventual convergence and its elapsed time
were not observed. no per-key event or stable host-id trace exists for this run.

the causal redo/undo fixture will use one actual ui paste of its unique foreign
label, preserving its exact content and vector oracles. that isolates causal
coverage from typing/upload throughput. separately measure the complete local
and server prefixes after rapid typing before attributing a defect or changing
the upload owner; do not add input delays or silently redefine a latency budget.
