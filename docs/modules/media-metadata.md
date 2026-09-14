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
the plan requires the existing brave search configuration; unavailable bindings
fail admission instead of silently reducing the research capability.

lists, search, author chronology, and media recency use the original date without
an edition fallback. the shared media response and reader's media info show both.
provider scheduling timestamps, acquisition, and consumption keep their own
contracts. see the [implementation contract](../cutovers/original-publication-dates-hard-cutover.md)
for tool limits and acceptance.

the forward-only `0228` migration requires maintenance, drained publication work,
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
research outcomes. changed sources or access are skipped at publication; rerun
the command after they settle. it does not rebuild content or indexes. dates
remain unknown until research succeeds.
