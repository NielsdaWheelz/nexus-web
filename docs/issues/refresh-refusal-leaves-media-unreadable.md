# a refused refresh leaves a readable article unreadable

status: open
origin: 2026-10-20 reader python ingest re-slice (spec L4, harness journey F5)
area: ingest source lifecycle (owner of the fix)

a web or pdf refresh whose publication the apparatus store refuses
(`E_RESOURCE_CONFLICT`: a note another resource references would vanish, or an
ambiguous source correspondence; `E_INTERNAL` on an apparatus invariant) raises
inside the fenced publication. neither code is in `_TERMINAL_CODES`
(`python/nexus/services/source_runner.py:74-82`), so the queue retries the
deterministic refusal three times and the job goes dead.

user impact: the article that was readable before the refresh is now
`suspended` with `can_read` false (`mark_extracting`,
`python/nexus/services/media_processing_state.py:63-70`, ran when the refresh
was admitted; the dead job never settles it back). the previous publication's
rows are retained, so nothing is lost, but the reader cannot open the article;
the import offers "repair source", which fails the same way.

evidence: harness journey `F5.referenced-note-refresh-refusal-settles-L4`
(`2026-10-20/rpy/harness`): refresh attempt running; jobs dead/3/
`E_RESOURCE_CONFLICT`; media suspended, can_read false; import NeedsAttention
`RepairSource`; the referenced note item kept. refusals:
`python/nexus/services/reader_apparatus.py` `_reconcile_items` and
`replace_media_apparatus`.

fix (source lifecycle): settle a publication refusal at once as a typed, terminal
failure of the refresh attempt, and leave the media on its previous publication
(`ready_for_reading`), with no repair offer.

resolved when F5's intended check passes: the refused refresh settles failed
`E_RESOURCE_CONFLICT` after one job attempt, the media stays readable on its
previous publication, and no `RepairSource` is offered.
