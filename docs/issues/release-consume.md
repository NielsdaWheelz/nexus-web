# release: consumption, owed owner checks

status: shipped; owner checks owed
origin: consumption history, read state, the lectern and suggestions; shipped in
`83459f1b8` and `fdd0a3e` (schema 0287, wire 2) on 2026-10-15
area: release / consumption

done: 0281 ran in the canonical release (book campaign
`coordinator/final83459/canonical-release/root-review.json`). the census found
zero cursor-kind mismatches (`coordinator/finalfdd0a3e/release-census/receipt.json`).
on the paired apk 0.3.2, the phone passed playback, background playback,
listened-through natural end and activity delivery
(`coordinator/finalfdd0a3e/usable-release-acceptance.json`). wire 10's case 9
moved a lectern row and kept the order across a reload (received status only,
see [wire10 evidence](wire10-qualification-evidence-not-retained.md)).

owed: no release record shows these in production.

- stats: switch the period (the prior-period line shows while it updates), use
  previous, today and next, the device and work filters, exclude a session and
  restore it, load more sessions.
- read a document and play an episode for a minute each. both appear in stats,
  web and phone. accepted delivery is not the stats view.
- lectern: add, play next, remove. mark finished, then undo.
- read to the end of a lectern document. take next on the lectern, then undo.
- reset progress with the reader open. it lands at the start, with no
  newer-spot prompt.
- natural end advances to the next lectern episode, on the web and on the phone.
  the phone check was not run: the episode had no eligible successor.
- add from quick reads and from suggestions. quick reads answered 504 in the
  wire-10 run ([slate plans](synapse-slate-query-plans-unmeasured.md)).

delete this file once the owner has run these or waived them.
