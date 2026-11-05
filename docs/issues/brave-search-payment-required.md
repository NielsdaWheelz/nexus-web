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
the scoped qualification in #606.

2026-11-04 read-only production inspection at api/worker sha `e505409d1`:
both `nexus-worker-background-1` and `nexus-worker-interactive-1` have no
nonblank `BRAVE_SEARCH_API_KEY` in their configured environment (presence only
was printed). current bibliography fails before model dispatch with
`tools unavailable: web.search`, not a newly observed provider 402.
`services/tools/run.py:173-184` omits the search binding without that key;
`services/generation/run.py:201-205` refuses unavailable required tools.

the two latest runs for “born again, briefly — greg egan”
(`dc49a33a-ee43-4da5-8a99-44a4374c06bb`) ended
`E_METADATA_MODEL_UNAVAILABLE` at 2026-11-04 00:10:31 and 00:29:59 utc;
latest job `01a1a3f6-724a-7592-825a-578d7ea2c82e` retains the exact missing-tool
reason in its generation. the latest sonnet 73, 116 and 130 jobs retain that
same reason. all four media have null `metadata_enriched_at`; egan has no
credits and the sonnets retain the credited name “author”. no job was submitted,
configuration changed or provider request made during inspection.

restoration requires provisioning working search credentials through the normal
configuration owner as well as resolving provider quota. then deliberately rerun
these items and verify evidenced metadata corrections. the separate
[manual-command feedback gap](metadata-update-lacks-feedback.md) conceals their
terminal failures from the initiating menu.
