# independent writing branches advance each other's expectations

at `95e4b8fa3`, `lib/notes/journal.ts:1463` advances an observed version from any
matching checked acknowledgement; settlement at line 1695 resolves every unsealed
row without an authored-branch relation. `texts.ts:284` admits ordinary body writes
with observed versions. paths are relative to `apps/web/src/`.

two tabs can author different bodies from version 1; after a's acknowledgement,
b's expectation may become 2 and silently overwrite a instead of conflicting.

preserve independent branches' original expectations. advance only explicit
causal dependencies or successive edits from the same authored branch. resolved
when the real two-tab case preserves the losing rich branch and reports conflict
while unrelated fifo work commits. source finding; runtime reproduction pending.

source repair preserves observed expectations and advances named results only
along the durable dependency graph with checked proofs. same-branch autosave
successors name their predecessor explicitly. live qualification remains pending.
