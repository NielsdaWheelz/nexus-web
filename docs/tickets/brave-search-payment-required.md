# brave search returns payment required

status: owner-deferred
origin: 2026-10-14 production release; owner explicitly deferred brave work
area: external web-search availability

the 2026-10-14 production key returned http 402. one ordinary read via
the pinned adapter confirmed it; no generations or extra retries were used.
retained production metadata exception chains independently report the same
status. the exact account plan/credit condition has not been inspected.

impact: web research is unavailable. brave-dependent metadata and release
checks remain deferred. key rotation is separately deferred; no key, plan,
billing or dependency change was made.

at pinned `f4026846`, both normal production workers have brave unconfigured.
portrait's source/index/media-unit recovery and web/phone reading passed, but
metadata job `a0a3b93c-f697-436c-8dc1-1cd8279361ee` ended dead after two normal
attempts with `E_METADATA_MODEL_UNAVAILABLE`. no brave call or operator retry
was made. this generic failure does not establish brave as its sole cause.
evidence: private campaign
`coordinator/finalf4026846/portrait-production-v1/acceptance.json` (`eb53f372`).

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

2026-10-14 x title qualification independently confirmed the same http 402 with
both configured keys; the owner explicitly waived successful live bibliography
qualification in this task. isolated job `4b4c9379-9cf6-4ed2-8291-3068486f7946`
has terminal error tool receipts and unchanged saved facts. actual local document
and resource reads passed; controlled bibliography/no-findings/review composition
passed. no successful four-tool research claim is made. see
[the scoped qualification](../x-import-titles-verification.md).
