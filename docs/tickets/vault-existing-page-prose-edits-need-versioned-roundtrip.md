status: open
origin: 2026-09-25 notes writing live proof
area: vault page imports

the vault exporter does not carry a body lane version. previously, importing
edited page prose overwrote newer canonical notes: the live stale export test
returned 200 and changed the note body. pr 1 now returns an explicit conflict
for changed existing page prose; unchanged round trips and new note creation
still work. the live stale case returns one conflict and preserves the newer
body. this temporarily removes editing existing page prose through the vault.

prerequisite: define a lossless editable subset. export note identity and body
version; compare both under the canonical body mutation transaction. reject
rich bodies that the current markdown parser cannot round trip without loss.

acceptance: current-version edits of supported plain page notes import once;
stale edits conflict without overwrite; rich bodies never lose marks or
structure; unchanged exports still round trip.
