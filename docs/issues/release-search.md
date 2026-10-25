# coordinated search release

release baseline: main `2b85ecb3d`, schema0316, frozen once by the owner. import no
later unrelated main changes. preserve current authored
identities, retention, online-first writing, account-scoped reads, tls/http2 and
removed dossier/link-note/author-editing contracts and source-backed pieces.
the measured older candidate is
preserved at `2cacaa3c2`; its observations are not relabeled as integrated proof.

read-only deployment inspection on2026-10-24 observed source `dc12792e` and
schema0312. its existing verified nightly backup is retained privately; recheck
actual ancestry and stopped-writer state at rollout. keep main's0306–0316 chain
unchanged and apply one0317 search conversion after it. earlier search0306/0307
identities and the0292 qualification clone cannot be stamped into this history.

0313/0314 remove author-editing/dossier state under their existing owner steps;
0315 adds consumption observation;0316 adds piece/schema and stored-payload fields.
qualify those intentional changes separately from0317 preservation. compare
surviving canonical identities, text, vectors, revisions/readiness and
suggestion-clock state at0316 against0317. require exact
logical/native projection agreement across the fifteen surviving families.
no repair, reindex or provider call is hidden in conversion; invalid input refuses.

main's0316 refuses live old media-reindex jobs. finish legitimate work through its
existing queue/publication owners before migration; never cancel or rewrite jobs
to satisfy this precondition. offline extraction of the verified0312 backup finds
zero live media-reindex jobs (150 succeeded, three dead). this is a rehearsal input
fact, not a rollout-time queue guarantee. recheck with writers stopped.

piece access must not grant source/neighboring text or whole-source activation.
passages/vectors remain source-owned; results carry the authorized reading
identity and bounded literal evidence. lexical publication proves the current
source partition independently of embeddings. highlight context uses clipped
reading-qualified index variants with canonical highlight ids; extra derived rows
and atomic refresh work preserve contextual matching without scoring outside text.

before migration, stop every writer and use the verified-backup deployment owner.
the infra-owned `POSTGRES_IMAGE` must point to the immutable pg15 image providing
pinned pg_search0.26.2 with preload; preserve512mib/no-swap and128mib shared memory.
the migration command uses `--no-deps`, so installing the extension at ordinary
application startup is too late. verify binary/catalog versions and exact head.
rollback restores backup plus paired binaries; no downgrade/mixed-version reader.

ship api, workers, hosted web and generated wire together. apply the wire bump
rule against the actual released pair, not an old recorded wire number. include
[endpoint/client cutover](release-desktop-lab.md), reload open clients after pending
writes settle, and retain main's account and installed-client admission rules.
api/worker expensive retrieval holds shared session admission through cleanup;
transaction-pooling proxies and old workers violate this contract. provider waits
and direct lookup remain outside admission. preserve stock asyncio and sdk import
preparation before readiness; the [native fault](search-api-segfault-on-launcher-workload.md)
remains unattributed with selected-runtime measured stability accepted.

warm visible-result p95 budgets remain500/2000/4000ms for direct/keyword/related;
cold keyword3000/related4000ms has one accepted control, not a percentile.
independent failure deadlines remain unchanged. the prior controlled candidate
passes book publication once, durable unrelated edits and scoped browser/merge
request observations. integrated `a3e6b8ee2` passes the mac static gate, three
retained checks and actual0312→0315→0316 populated preservation/native proof.
one rebuilt-index paraphrase retains all53 reference owners with identical
first-page order and representatives; it is no new latency or recall campaign.
the integrated combined operation fails: publication needs a serialization retry
and active related search expires. current `0a4098235` passes local static and the
three retained checks, including source-backed piece boundaries and native
publication equality. its controlled local publisher probe removes the late
state-table read and commits once alongside an unrelated edit. these results do
not replace the failed populated operation or establish a new latency result.
see [publication coupling](search-publication-retries-during-unrelated-edits.md)
and [related cutoff](search-related-timeout-during-publication.md).
the older populated preservation and recall proofs retain their recorded scope.
complete the [piece integration](release-search-contained-works-integration.md)
with an affected populated0316→0317 conversion and combined operation before release.

the owner accepts occasional restored-pane related failure during publication
with verified honest failure, preserved useful results and retry. the integrated
mac tls/http2 check establishes those behaviours by holding one client response
through its unchanged3750ms cutoff and successfully retrying. it does not measure
api queue cost or waive active after-input failure. the cost is occasional manual
retry of restored related results; no scheduler or cutoff increase is authorized.
preserve the [historical unjoined abort](search-hybrid-publication-cutoff.md).
manual screen-reader and unrestricted ordinary-worker qualification remain
explicitly deferred. give the [restored backlog](restored-search-worker-backlog.md)
its legitimate disposition; never blanket-cancel it to create acceptance.

after coordinated rollout, check independent phases, interaction-held refresh,
continuation, literal evidence/canonical activation, mobile ime and announcements,
and text publication before embeddings. release execution remains a separate
owner action. delete this issue after rollout and owner checks.
