# brave search returns payment required

status: owner-deferred
origin: 2026-10-14 production release; owner explicitly deferred brave work
area: external web-search availability

brave returns http 402 with the current production key. one ordinary read via
the pinned adapter confirmed it; no generations or extra retries were used.
retained production metadata exception chains independently report the same
status. the exact account plan/credit condition has not been inspected.

impact: web research is unavailable. brave-dependent metadata and release
checks remain deferred. key rotation is separately deferred; no key, plan,
billing or dependency change was made.

the final release also defers new html-import acceptance. an ordinary import
unconditionally schedules metadata research: `services/web_article.py:139`,
`services/media_source_ingest.py:2214-2225`, and
`tasks/enrich_metadata.py:127-134` at `58c7ecae6`. the planned loc article
was not admitted. existing repaired resources qualify reader, search and
note-link behavior separately; this does not qualify new-source ingestion.

evidence: private campaign release `attempts/31d69ff7b/brave-direct-read-1253.json`;
production exception receipt `capacity-2g-reaudit-20261014/brave-exception-causes-20261014T125313Z.json`.
the separate unexpected-handler classification bug is recorded in
[the metadata ticket](podcast-sync-metadata-handler-failures.md).

owner restores the intended brave service through its dashboard. acceptance:
one ordinary real search succeeds with production inputs, then the deferred
web-research journeys are qualified. do not change providers or paywall paths
to conceal the outage.
