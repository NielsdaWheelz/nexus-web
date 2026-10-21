# wikipedia note markers never classify

status: open
origin: 2026-10-20 reader python ingest re-slice (design notes)
area: reader python, apparatus

wikipedia's parsoid html gives each marker anchor its own id
(`<sup id="cite_ref-x"><a id="..." href="#cite_note-x">`). `_source_element_id_owner`
(`python/nexus/services/html_apparatus.py`) prefers the anchor's own id over the
`sup`'s, and the note's backlink names the `sup` id, so no backlink matches and
no wikipedia footnote is classified: the article publishes without notes.

impact: every wikipedia article (and other parsoid pages) reads without its
footnotes in the evidence pane. evidence: probe
`2026-10-20/rpy/sketches/probes/q_wiki.py` on
`2026-10-20/rpy/corpus/web-readable-wiki-hamlet/article.json`: 0 apparatus items.

fix: let the backlink match either id of a `sup > a` marker, proved on the
public corpus with no other identity change.

resolved when the readable hamlet article publishes its footnotes and the
identity corpus shows no other change.
