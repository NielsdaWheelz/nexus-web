# library chooser integration contract

status: blocked on owner choice
origin: 2026-10-15 library chooser pr/merge request
area: libraries / recovery

the qualified branch starts at `367da80e0`; main advanced to `7bc7c8a13`.
`9235e4b2b` deliberately replaced placement with request → reread and rewrote
the chooser/imports. `6df3515ab` deleted `resource_mutation_replay.py` and
`resource_mutations` in migration 0286. the approved chooser specification
requires same-tab intent recovery and immutable historical receipts; its
implementation depends on that deleted ledger. merging unchanged is incorrect.

prerequisite: decide whether approved recovery or main's online-only contract
wins. recommendation: preserve approved behavior with library-owned receipts,
adapt to the current library/wire/extension owners, add the necessary migration
and repeat affected live qualification. do not restore the retired generic
ledger or silently downgrade the approved guarantees.

acceptance: one coherent contract on current main; static gate and affected
browser → api → database journeys pass; qualification accurately names its head.
