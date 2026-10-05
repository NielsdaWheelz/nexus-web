# source adapter results use an untyped private dictionary protocol

status: open, source-qualified; runtime not run.
origin: 2026-10-04 linear cleanup backend audit at `f2167baf3`.
area: durable source execution / adapter contracts.

`python/nexus/services/media_source_adapters.py:114-152` returns
`dict[str, object]`. source owners encode contributor observations, supersession,
reindex targets, transcript reason and metadata follow-up as ad hoc dictionary
keys (`x_ingest.py:250-277`, `pdf_lifecycle.py:108-125`,
`epub_lifecycle.py:110-133`, `web_article_ingest.py:184-194` under the same
services directory). `media_author_observation_seam.py:16-34` inserts and pops
private values inside that dictionary so credited names do not enter job logs.
`media_source_ingest.py:1930-1962` then reconstructs a `SourceRunOutcome`; a
non-list reindex value silently becomes no targets, boolean flags are coerced,
and transcript reason remains `object` until terminal publication at `2210-2215`.
this is a source-proven ownership gap, not an observed lost index or disclosure.

prerequisite: admit every source-result producer and its real caller together.
preserve the queue result/log shape separately from private observations and
follow-up commands. provider acquisition, publication fences and durable
payload formats remain owned by their existing boundaries.

fix: return one typed source outcome directly from adapters and source owners,
with a separate explicit queue-log result. remove mutation of result dictionaries
and the reconstruction seam. keep required contributor/reindex/transcript and
metadata obligations explicit; do not silently recover malformed own output.

acceptance: all current source branches preserve queue logs, contributor
publication, supersession, document embed synchronization, warning policy and
exact once-only index/transcript follow-up under a real live claim. credited
names do not reach stored/logged job results; stale claims publish nothing.
`./scripts/test` passes with no private result dictionary protocol.
