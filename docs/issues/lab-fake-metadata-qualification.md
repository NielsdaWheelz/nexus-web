# fake lab transport cannot qualify successful metadata enrichment

accepted qualification limit, outside the parallel-lab change. at source
`aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306`, epub completion requests enrichment
(`python/nexus/services/epub_ingest.py:703`, `source_runner.py:378-384`). the
handler requires structured output (`python/nexus/tasks/enrich_metadata.py:207-224`),
but `python/scripts/lab_fake_providers.py:3-6,29` explicitly excludes structured
generation and returns fixed plain text. required research tools may also be
unavailable. failed generation can settle as a typed product outcome (`272-300`).

this is source evidence; no new runtime reproduction was performed. a fake-mode
epub import can prove ingestion, storage and reading without proving metadata
success. record the exact ancillary outcome; never count it as successful
research or suppress unexpected failures. fake-provider semantics stay unchanged.

resolved when separate supported metadata qualification proves the intended
product outcome with working provider/tool prerequisites; the existing
[live qualification record](imports-live-metadata-proof-needs-working-search.md)
owns that live boundary. expanding the fake transport requires a separate scope
decision.
