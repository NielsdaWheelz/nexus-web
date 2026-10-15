# atlas sweep cost unmeasured

**problem**: one `atlas_project_job` sweep averages every active-model embedding of every
media filed in a non-system library inside one 300 s job lease. it has never been timed at
production scale (~708k embeddings).

**impact**: a sweep that outgrows its lease fails and retries forever; the frame goes stale
and new works stay in the nebula.

**evidence**: `python/nexus/services/atlas.py` `project_all`. the PCA itself is measured
(3,000 × 256: 1.5 s in the old pure python, ~12 ms with numpy); the untimed part is the
`avg(...)::real[]` scan over `content_embeddings`.

**resolved when**: one `project_all` on the release rehearsal restore records a duration
well inside the lease (`docs/issues/release-atlas.md` preflight), or the scan is batched if
it is not.
