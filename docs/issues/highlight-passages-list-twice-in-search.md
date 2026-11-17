# a highlight's passage lists beside it in search

status: open · hypothesis from reading at `125f1ab87`; not run · area: search, local and server

a text highlight mints a passage owned by its media
(`apps/web/src/lib/documentReader/annotations.ts:475-483`). local search indexes
every passage as its own row, family `saved_passages`, with no test for what binds
it (`node/authored/src/queries.ts:55-62,65-72,92-96`). the server relation does the
same (`python/nexus/services/search/sources.py:451-473`). nothing excludes a
passage that a highlight's `selection.passage_ref` names.

impact: a search for highlighted words should return the highlight and, again, its
passage as a saved passage. pdf and tool-made highlights mint no passage and are
unaffected.

resolved when one highlighted span yields one result, or the duplicate is shown not
to occur.
