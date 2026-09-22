# media metadata

`services/metadata_enrichment.py` owns bibliographic meaning and generated-output
acceptance. source adapters observe the encountered edition; one scoped metadata
generation identifies the original work. both write through the existing media
publication transaction and collection invalidation.

- `original_published_date`: first public publication of the identified work,
  including serialization. translations and revisions retain the work's date;
  a collection uses its own first publication.
- `edition_published_date`: publication of the encountered edition/version.
- `edition_isbn`: valid isbn-10/13 from epub package metadata, normalized to isbn-13.

dates preserve year, month, or day precision. source instants become utc calendar
days. file creation, scanning, fetching, and modification do not establish
publication. the shared validator lives in `schemas/publication_dates.py`.

a valid source observation replaces the edition date; missing or invalid source
observations leave it alone. an accepted generation replaces both dates, including
null. failed, stale, or uncertain generation publishes neither. other metadata
retains its existing merge and manual-author rules.

the `MetadataRead` plan admits `web.search`, `web.read`, `nexus.document.search`,
and `nexus.resource.read` for one media resource and its admitted children.
`requester_user_id` supplies authorization from the successful source attempt,
podcast sync, retry, or explicit maintenance viewer. execution, replay, budgets,
and uncertain dispatch remain owned by the shared generation runtime.
metadata runs as a light job on the interactive worker, which owns the callable
model-tool listener. parsing and indexing retain the bounded background worker.
chat has higher queue priority, but waits for an already running metadata turn;
research retains its 300-second generation limit and existing bounded drain.
the plan requires the existing brave search configuration; unavailable bindings
fail admission instead of silently reducing the research capability.

initial sampling reads source prefixes bounded in sql by
`metadata_enrichment_max_content_chars` before normalization. source order stays
plain text, ready indexed chunks, fragments, podcast notes, then description.
leading whitespace or markup consumes that raw window; the agent can inspect
further through its scoped tools. metadata row queries defer
the full plain text so sampling does not load the whole document into the light
worker.

lists, search, author chronology, and media recency use the original date without
an edition fallback. the shared media response and reader's media info show both.
provider scheduling timestamps, acquisition, and consumption keep their own
contracts. `services/metadata_enrichment.py` owns tool limits and acceptance.

author works sort oldest first by default on `media.original_published_date`.
podcasts and catalogue-only gutenberg works have unknown publication dates and
sort last in either date direction. the gutenberg `issued` date remains a
provider release fact; it never substitutes for the work's publication date.

the forward-only `0229` migration requires maintenance, drained publication work,
and stopped old api/workers. it drops the mixed old date without copying it and
advances affected collection revisions. deploy api, workers, and web together.

after migration, from `python/`, run:

```sh
uv run --frozen --no-sync python scripts/backfill_media_publication_dates.py --viewer-id <uuid>
```

the command reads only that viewer's authorized media in batches of 100. it
hydrates epub edition/isbn hints from the stored opf and enqueues ordinary,
deduplicated metadata jobs. unfinished document imports remain with ingestion.
it reports queued, skipped, and failed counts; the ordinary job history records
research outcomes. source/access changes detected before enqueue are command
skips; rerun after they settle. already queued jobs retain their dedupe key and
history, so rerunning does not repeat research. failed research follows ordinary
job handling; explicit metadata retry is available for the viewer's readable
media and pending videos/episodes, after any uncertain turn is resolved. it does
not rebuild content or indexes. dates remain unknown until research succeeds.
