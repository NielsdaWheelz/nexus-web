# api reaches its memory limit during reader and search acceptance

status: allocation fixes and 58c r2 accepted; general capacity follow-up open · origin: 2026-10-14 release acceptance at `b6768bee2469cbc3a43902302836a44d07a11ea7` · area: api / reader / search

current disposition, 2026-10-14: production
`58c7ecae6e96a164df42e961f90d6ea491cb6b9d` passed both r2 reader/scoped-search
cases under the reviewed 384-mib api cap. sampled peaks were 296.71 and
295.84 mib, with zero new app limit/oom/kill/restart events and both saved
cursors preserved. receipt: `release/attempts/58c7ecae6/r2-live-acceptance/summary.json`,
sha256 `c396d86c1f5688e88bf6a0fa37f8b16571cd56073ffbc903565c97733d55f154`.
the allocation fixes and this operational gate are accepted. representative
whole-host capacity remains the linked oi-137 follow-up; these two cases do
not establish that broader acceptance.

after the gutenberg browser closed at 03:52:56 utc, the serial keats reader
and scoped-search checks reached the api's 320 mib limit. between
03:53:31.071 and 03:53:32.071, `memory.events:max` rose from 0 to 46,
anonymous memory rose from 255,856,640 to 287,395,840 bytes, and the cgroup
peak reached 335,544,320 bytes. anonymous memory later remained at
302,817,280 bytes. no new oom, kill, or restart was observed. product requests,
repairs, and handset acceptance are held. the first limit event falls inside
the first scoped semantic search (`living`, media
`16b411ce-d0f6-47aa-8bc6-22827cfb9ab0`), 03:53:28.589–03:53:33.598 utc.
the preceding reader completed at 03:53:28.315; only readiness polling overlaps.
the second search took 0.554 seconds against the first one's 5.008 seconds.

evidence: `nexus-web-campaign-artifacts/2026-10-13/release/host-observation-20261014/r2-api-max-0357/manifest.json`,
sha256 `e8a189646fd35a44973d0938cc2e6ac8141d4e6c865a14828576eb3d7a5e19b1`.
the earlier published-image reader/map/assets/copy checks passed, but did not
establish this combined reader/search workload's memory bounds.

source audit: the first embedding call imports `provider_runtime.runtime`,
which eagerly imports all four generation engines, including gemini's sdk and
model classes. isolated published-image measurement attributes 82,001,920 bytes
of retained anonymous memory to that import and another 6,602,752 bytes to the
first sdk decode. a second decode adds zero anonymous memory. numpy is already
loaded by the normal app import; the earlier first-search numpy hypothesis is
rejected. there is no tokenizer dependency or
whole-corpus fetch in this path. source receipt:
`release/r2-search-memory-b6768bee/source-review.json`, sha256
`93acfc53e29eb50707878676ec044b9702aacc9517f69c55a4d431e50304ce9e`.
route attribution: `release/r2-b6768bee-acceptance/route-attribution.json`,
sha256 `22bb1a27cb27003431452814aa39a31dd8c887eac41efc773fe06ba5fce374ff`.
the original private `provider_calls:0` claim was corrected explicitly: there
were no generative admissions, but both searches invoke query embeddings.

measurement receipt: `release/r2-search-memory-b6768bee/import-boundary-baseline/results/receipt.json`,
sha256 `1934a41383df1fdb5cf6674c5b6eb64b56aac9ceabaee98ffe078cab8bca728b`.
the probe used the immutable image, no credentials/network, no lifespan or db,
and the actual sdk decoder with an external mock transport. cleanup succeeded;
a case-sensitive absence-message assertion failed afterward and was reconciled
from docker events without rerunning the workload. the responsible proposed fix
loads the selected engine at dispatch in the shared provider runtime; keep the
embedding wire format, retry semantics, and memory cap unchanged.

the library fix is merged in llm-calling #43, with its matching kernel pin in
llm-agent-kernel #16 and nexus #579 (`8d8350b9d8e558d73ed32cb88f9910ee74f21473`).
the isolated comparison saves 52,711,424 anonymous bytes after the first
embedding. 989 library checks and nexus static/hosted checks pass. restored-copy
search on the old image reproduces an 85,688,320-byte cold allocation, with
both search results exactly matching production; those two small searches alone
fit the cap, so they do not reproduce the complete prior workspace footprint.
published-image combined search/large-reader qualification then ran against
the restored copy; subsequent production r2 acceptance is recorded above.

the corrected same-snapshot combined proof passed both semantic searches, the
largest book reader/map, 25 assets, a full 26-member offline copy, and one warm
reader revisit, with no max/oom/restart events. peak was 319,225,856 bytes
(304.44 mib), leaving 15.56 mib. the warm revisit reused allocations; it did
not exceed that peak. an initial map-oracle refusal was a cross-snapshot
comparison error: four generated citations and six links from earlier live
acceptance explain every difference; both published images return identical
map bytes on the same restored database.

the consumer fix is merged in nexus #580 (`1512ee109`): `build_reading_copy`
streams the same JSON into the ZIP member instead of holding a whole JSON
string and a second UTF-8 buffer. the completed response also removes its
temporary ZIP on normal completion, range refusals, send errors and
cancellation. actual document bytes and ZIP attributes match; isolated peak
allocation fell by about 29 mib. the final published-image sequence below
includes this consumer fix. provider behavior and the copy contract are
unchanged.

final `1512ee109` immutable-image qualification passed all oracles and clean
shutdown at 320 mib, but the warm reader/map revisit reached 322,224,128 bytes
(307.30 mib), leaving only 12.70 mib. copy peak alone fell to 291.48 mib; that
does not prove warm-process capacity. post-idle memory was 301,506,560 bytes.
no limit/oom/restart events occurred. receipt:
`release/r2-search-memory-1512ee10/green-1512ee10/receipt.json` (sha256
`cc7f851ca25597e8b4e5623307b4d3193c283d856a942b5463ac86b8846d50e5`).
that 320-mib stage left capacity acceptance open; do not repeat workloads
merely to obtain a lower peak.

first correlate the retained request timestamps, then reproduce the exact
sequence against a restored copy using the published image and measured
per-request memory. repair the responsible allocation or establish a measured,
safe capacity requirement. do not treat a restart or successful response as
acceptance.

done when the corrected immutable image and production both complete the
affected cold and warm sequence with defensible headroom, no new limit/oom
events or unexpected restarts, and unchanged saved cursors and source data.

related: [oi-137 reader/search capacity](api-reader-search-memory-margin-remains-small.md)
tracks the earlier production recurrence; closing either requires actual combined
host and live workload evidence, not an isolated cap increase.
# 2026-10-14 aggregate capacity result

the exact staged `31d69ff7b` image under its 384-mib api cap passes both
keats searches, the largest reader/map, 25 assets, full reading copy and a warm
reader revisit. broad document search then exhausts the verified 1260-mib
ancestor containing actual api/postgres and the unchanged 800-mib anonymous
allowance. the kernel kills the allowance; this is a FAIL, not api-local oom.
api peak is 317583360 bytes, with zero local limit/oom/restart events and clean
exit zero. postgres anonymous memory stays about 39563264 bytes while shared
memory grows from 50536448 to 141697024. the original clone, protected facts,
network and volume restore cleanly; no production deployment occurred.

evidence: devbox
`/home/niels/.local/state/nexus-search-memory-20261014/capacity-31d69ff7-control-attempt3/`;
scope receipt sha256 `f808205fccf1903ce6b76a9613da9a2b9e4de7197a41e831e96365bf162eb560`.
postgres currently uses 128-mib shared buffers. review the database cache
budget at its configuration owner and requalify the unchanged capacity
envelope and deadlines. do not lower the allowance or claim this conservative
failure proves the physical host cannot work. resizing is prohibited.


corrected attempt4 PASS: reviewed postgres startup cache is 64 mib, with a stronger touched 832-mib allowance and the same parent1260/api384/postgres512 caps and deadlines. the exact 31d api completed all unchanged search/reader/map/assets/26-member ZIP oracles and three positive vector queries without fallback. api peak288.1641 mib; local limit/oom/restart events zero. parent peak1260.1758 mib with 8,282 cache-reclaim limit events: no comfortable parent margin claimed. worst trailing full stall319ms over9.909s, below1s gate; no oom or kill. broad body12.6116s below30s. all temporary exits zero; original clone and facts restored. scope sha256 `c8b3c51c1a32b6cee72430a162f6ba6f647b4b385612777a673bc3567a647941`. pr #583 merged exact reviewed head as `58c7ecae6e96a164df42e961f90d6ea491cb6b9d`; final-image r2 operational acceptance subsequently passed as recorded above. representative whole-host capacity remains open.
