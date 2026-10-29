# nexus exact matches lose to local result prefix

remaining problem: an authored exact-title match can fall outside the first
query page, before the palette gets a chance to rank it.

`apps/web/src/lib/search/localSearch.ts:30,93` requests 50 local matches.
`node/authored/src/queries.ts:79-85` orders unscoped matches by opaque ref.
sorting that returned page cannot guarantee admitting the best local title.

the recent-history change fixes composition of admitted candidates: canonical
deduplication and relevance ordering precede display caps, while authored facts
remain authoritative. a live case with four authored prefix competitors and an
exact show title verifies that boundary. it does not fix query admission.

reproduce the remaining gap with an exact local title after the first 50 matching
refs. rank exact/prefix candidates at the query owner before its limit, retaining
stable pagination and each source's internal ordering. do not fetch the corpus
or blend incomparable scores. resolved when this target is admitted ahead of
incidental matches and selection remains stable.
