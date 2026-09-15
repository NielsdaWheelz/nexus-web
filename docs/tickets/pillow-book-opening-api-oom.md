# book opening still oom-kills the api

status: open · origin: 2026-09-15 post-release manual use · area: api memory · oi-116 reopened

## evidence

production69583dc3075730dc98e2ba33ffb2553335d0b813 api container
1905313206e7698389eeda5b6a889ecc7c79d1590f2d19ee391dd25c7b6059a4 was
oom-killed at22:24:54,22:26:03,22:29:01 and22:31:46 utc under320 mib. kernel CONSTRAINT_MEMCG
reports uvicorn anon-rss324876 and320696 kib respectively. restart/cgroup
counters reset across lifetimes; later zeros do not erase either kill.

the user had shadow & claw and confessions open, then replaced confessions
with the pillow book; it worked briefly before the workspace failed. the
pillow book alone also crashes. theme switching/persistence had passed earlier
and remains a distinct fixed defect. the earlier paired-reader interval was
insufficient to close the api memory problem for representative book opening.

22:24 access logs end after confessions document-map.22:25:58–59 logs
show pillow-book navigation, first fragment, document-map and233-kib-or-smaller
cover response headers before the22:26 kill. exact active request at kill is
not yet known; `http.request.completed` logs when headers return through
middleware, before body transfer finishes. no request-start evidence exists. both
media.plain_text values are null, first fragments tiny. pillow has30 JPEG
assets totaling1129274 bytes, max233207; confessions four totaling80984.

private mac receipts: `/tmp/nexus-release-255/kernel-69583dc3-restart.log`,
`api-69583dc3-restart.log`, `runtime-69583dc3-restart.json`,
`production-69583dc3-memory.jsonl`, `pillow-book-production-census.txt`
(confessions; first identification corrected), `pillow-book-actual-census.txt`.

production read-only census found zero highlights for pillow/confessions and
zero passage anchors for the viewer, excluding the two known quote repair paths.
exact695 devbox diagnosis at320 mib (private verifier, original auth/bootstrap,
real TCP/R2 and retained0229 clone; catalog skipped) traversed all23 pillow
fragments and their30 unique assets without oom, peak258.660 mib. repeating
with six concurrent p-to-pillow searches also stayed below260 mib. these do
not reproduce production and exclude real JWT/catalog, current article and
browser post-open mutations. receipts `pillow-69583dc3-{exact,search}/`.
full catalog startup with snapshotted production catalog/health responses also
completed those routes, peak247.766 mib. its retained clone correctly fails
production readiness without a fresh reconciler; this allocation observation
is not a release health pass. two earlier diagnostic setup failures (forbidden
production identity override, then waiting for clone readiness) remain recorded.
all five stopped task containers were removed; clone databases/objects retained.

320 mib is a chosen containment budget, not an intrinsic api requirement.
current seven service limits total2160 mib on about1919.6 mib usable RAM;
reservations total1024 mib. at the previous233.055 mib available-memory low,
api used253.316 mib. holding other use constant, api384 would leave102.371 mib,
below the128 mib operating floor. this is illustrative arithmetic, not a
prediction. reassess the budget against a measured stable workload.

## established trigger

manual reproduction at23:00:56 utc caused the fifth api oom/restart. the
nonblocking50-hz live process sampler caught `/search` -> `discovery_candidates`
-> `build_query_embedding` -> `semantic_chunks._embed_with_openai_async` ->
`ProviderRuntime`, importing OpenAI, Anthropic and Gemini generation engines.
288 sampled search stacks include this path;69 nonblocking read errors among
24473 recorded samples limit completeness. sampled api memory rose from237 mib
to320, including317 mib anonymous memory just before the kill. the reader-only
probes omitted ordinary semantic `/search`; openables is a separate lexical
endpoint. the killed request never emitted a response-header access log.

private evidence: `production-695-pillow-stacks-followup/`,
`production-695-pillow-stack-memory-followup.jsonl`,
`kernel-69583dc3-pillow-repro.log`, `api-69583dc3-pillow-repro.log`.

fix the pinned provider runtime's eager generation-engine imports. preserve
its public embedding sdk, retry, credential and response contracts. first-use
OpenAI allocation still needs native measurement. do not repin unrelated newer
agent-control changes or bypass the provider owner.

## next action and acceptance

reproduce on the native devbox with the exact image, retained clone and real
request/asset sequence. distinguish book metadata/quote repair, first S3 client
setup, per-request storage lifetime and transfers before choosing a fix.
retain access checks, size integrity and SVG CSP. reassess the api ceiling
against measured combined host demand; do not resize or weaken capacity proof
merely to obtain a pass.
close only after exact replacement-image evidence and the actual pillow-book
opening sequence remain usable without oom/restarts.
