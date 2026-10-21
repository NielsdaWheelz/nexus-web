# stored carriage returns make their passages unmarkable

status: open (new ingests fixed; stored rows unexamined after 10-18)
origin: 2026-10-20 reader python ingest re-slice (spec L12)
area: reader python, html substrate (stored rows)

a `&#13;` character reference leaves a carriage return in sanitized html.
libxml2 splits text at the CR, so canonical text counts the whitespace around it
differently from the browser, whose html parser turns CR into LF; the reader's
cursor then disagrees with the stored offsets and the unit is unmarkable. since
the re-slice both sanitizer policies store LF (`_browser_newlines`,
`python/nexus/services/sanitize_html.py`). before it, the web path's apparatus
serialization already turned the reference into LF and the epub structural
capture refused such a book, so only rows from older code (or html sanitized
outside those paths) can hold one. stored rows are untouched (no backfill).

evidence: probe `2026-10-20/rpy/sketches/probes/q_cr.py`; the idpf
`epub30-spec` book and the generated `heur-cr.epub` (refused on main, import
since; harness journey L12). census C19 on the restored
8a67 backup (0292-era data, 10-18 00:09 utc): 0 fragments holding a CR in any
kind, 0 apparatus bodies, 0 x wrappers.

fix: none needed while the census stays 0. a stored row with a CR needs a
source-evidenced repair (re-prepare from its source), never a text rewrite.

resolved when C19 on the newest production backup (release preflight,
`release-reader-python-ingest.md`) is 0, or each counted row is repaired.
