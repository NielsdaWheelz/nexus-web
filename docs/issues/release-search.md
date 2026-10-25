# search release acceptance

deployed on2026-10-25: frozen source `3d81ef45ef28f637a4de07c66ab172bbab9e22c2`,
schema0317, wire16. the existing release owner verified the stopped-writer backup,
activated pinned postgres15/pg_search0.26.2 before migration, and paired api,
workers and hosted web. signed android0.3.8/code29 is installed; the owner
confirmed firefox1.0.2 installation in its normal profile.
production retains postgres512mib/no-swap,64mib shared buffers,128mib shared memory
and api384mib/no-swap. rollout proof and historical failures belong to
[pr813](https://github.com/NielsdaWheelz/nexus-web/pull/813).

the deployed phone operation verifies independent keyword/related completion,
catalog refresh, canonical reader activation and committed ordinary autosave.
this establishes that operation, not a new latency percentile. the initial
[admission failure](production-search-admission-contention.md) remains open;
the later successful operation does not identify its historical holder.

## accepted limits

warm visible-result p95 budgets are direct500/keyword2000/related4000ms. cold
keyword3000/related4000ms has one accepted control, not a cold percentile.
related failure caps are api5000ms/browser-bff5750ms; publication-time related
paint has a5000ms bound. longer failure waits permit more waiting and admission
occupancy; they do not speed retrieval. historical measurements retain their
original source and workload definitions.

direct navigation covers titles, names and aliases; body matches arrive later.
normal english word boundaries and bm25 replace the older lexical ordering.
broad semantic retrieval permits approximation: at least95% of exact200
qualifying owners and every reference semantic first-page owner, with changed
passages and ordering inspected. the costs are extension ownership, derived
storage, write/merge work, changed ordering and serialized queueing.

restored-background related failure during publication is accepted only with
honest failure, preserved useful results and retry; those behaviors passed locally.
this waiver does not cover active search failure. selected stock-asyncio stability
is accepted while the [original native fault](search-api-segfault-on-launcher-workload.md)
remains unattributed. retain the [historical unjoined abort](search-hybrid-publication-cutoff.md)
and [launcher lexical failures](search-launcher-indexed-preview-latency.md).

## remaining acceptance

- [manual screen-reader acceptance](search-screen-reader-acceptance.md): explicitly deferred.
- [unrestricted ordinary-worker qualification](restored-search-worker-backlog.md): explicitly deferred.

delete this release issue when those acceptance decisions are closed; existing
defects retain their own records. routine checks use the current mac docker
desktop lab and its normal teardown/cache owners, as specified in
[verification](../local-rules/testing-standards.md). no further broad search
campaign or engine change is a prerequisite to using this release.
