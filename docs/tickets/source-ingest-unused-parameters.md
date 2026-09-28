# two source-ingest helpers take a parameter they never read

status: open · origin: 2026-09-28, pr-09 cleanup/prune-write-only-schema (claude session), found by
`ruff check --select ARG` over the touched files; present on origin/main `335c49c3a` · area:
source ingest

- `media_source_adapters._publish_file_source` declares `kind: str`
  (`python/nexus/services/media_source_adapters.py:499`) and dispatches on the plan type
  instead; both callers (`:369`, `:441`) still pass it.
- `media_source_ingest.reusable_embedded_source_media_ids` declares `viewer_id`
  (`python/nexus/services/media_source_ingest.py:422`); its callers
  (`media_source_adapters.py:692`, `web_article_ingest.py:137`) pass it and the body never
  reads it.

fix: delete both parameters and their kwargs at the call sites.

acceptance: `uv run ruff check --select ARG nexus/services/media_source_adapters.py
nexus/services/media_source_ingest.py` reports nothing; `./scripts/test` passes.
