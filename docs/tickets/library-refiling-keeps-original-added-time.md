# re-filing an entry keeps its original added time

status: open · origin: 2026-10-10 colrev journey baseline (defect 7, coordinator R4) · area: libraries / entries

removing a media from a library and filing it again shows it where it was first
added under "Newest added", not at the top. observed while building journey LE3
of the colrev harness (`nexus-web-campaign-artifacts/2026-10-09/colrev/harness/baseline.txt`,
"observation (not a journey)"); not asserted by any journey, and not pinned to a
view. likely source: the All (Default) listing orders "added" by the media's
creation (`services/library_entry_listing.py:420`, `md.created_at AS added_at`),
which a re-file cannot move; a named library uses the new row's `created_at`
(`:443`). reproduce in both before fixing.

this is not a list-paging defect; the collection-revision cut left it to the
libraries slice.

proposed fix: decide whether "added" means first-ever or latest filing; if
latest, take the order key from the current `library_entries` row.

acceptance: removing and re-filing a media puts it first under "Newest added",
asserted by a journey.
