# read paths spawn the authored helper per call

status: open · found 2026-11-12 by reading and one timing; rechecked at `09c14e68f` · area: backend / authored helper, search, resource items, librarian

`python/nexus/services/authored/helper.py:49-75` runs the shared kernel as a
one-shot node process for every call. an empty `project_excerpts` batch took
0.07–0.08 s on the build mac (three runs, `/opt/homebrew/bin/node`); the server is
unmeasured. read paths that pay it:

- search: `capture_project` (`services/search/project.py:416-437`) calls
  `capture_source_excerpts` on every result page; the excerpt owner
  (`services/source_excerpt.py:528`) runs `source_windows` once per distinct
  fragment (`:447`), then `excerpt_source_selections` (`:638`), `capture_excerpts`
  (`:729`) and `scope_excerpts`.
- librarian figure presentation no longer derives source words or starts the
  helper: `chat/references.py:present_attachments` only enriches annotations and
  bibliography. saved quotes removed `source_display_excerpts`, `reference_texts`
  and the display projection. generic passage/highlight item hydration can still
  reach the resource-item owner below. draft/send selection proof still uses
  `excerpt_capture_proofs` and table scoping before admission locks.
- resource items: rows without a stored preview go through `project_excerpts`
  (`services/resource_items/items.py:689`).
- the reader document map is recorded separately:
  [document map](document-map-recomputes-passage-text.md).

impact: search, generic resource-item excerpt hydration and reader-map work still
pay process startup. the chat presentation cost is removed; this does not prove
that a complete timeline or search request starts no process.

proposed fix: a long-lived helper worker per api process, or a native binding, so a
call costs its work alone. the one-shot isolation (`helper.py:1-7`) is deliberate;
changing it is its own decision. quote admission and the remaining read owners
need separate measured qualification; no cache or long-lived helper is introduced
by the saved-reference change.

resolved when a warm read that captures an excerpt starts no process, measured on
the server.
