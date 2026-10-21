# parsoid-shaped note markers in an epub stay unclassified

status: open (low: no corpus epub has this shape)
origin: 2026-10-21 ingest follow-ups (item 3)
area: reader python, apparatus (epub)

web articles classify wikipedia's parsoid markers since the follow-ups: a note's
backlink may name the `sup` that wraps the marker link, which carries an id of its
own (`_external_target_has_backlink`, `python/nexus/services/html_apparatus.py`).
an epub indexes its markers first (`collect_html_apparatus_marker_backlinks`) and
names each by `_source_element_id`, the link's own id, so the same markup in an epub
chapter finds no reciprocal backlink and no note classifies.

impact: an epub built from parsoid html (wikipedia's own exports, for one) reads
without its footnotes in the evidence pane. no book in the campaign corpus has this
shape.

evidence: `2026-10-21/ingfix/corpus/generated-06-ingfix/wiki-parsoid.epub` (the web
fixture's markup in one chapter): 0 apparatus items on main `631dba5dc` and on the
branch, while `wiki-parsoid.html` publishes 5 markers and 4 notes
(`2026-10-21/ingfix/harness/runs/offline/identity-gen06-c3.txt`).

proposed fix: let the epub index try the wrapping `sup`'s id as the marker id when
the link's own id has no reciprocal backlink, keeping its repeated-id refusal for the
id it uses.

resolved when `wiki-parsoid.epub` classifies as the html does and the identity corpus
shows no other change.
