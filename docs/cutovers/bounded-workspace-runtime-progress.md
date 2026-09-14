# bounded workspace runtime progress

status: implementation in progress; no deployment or resource limit change.
origin: 2026-09-13 bounded workspace implementation, gate 0/a.

## inventory

- worktree: `/home/niels/src/personal/nexus-web-bounded-workspace`, branch
  `codex/bounded-workspace`; original checkout remains untouched.
- linux cgroup v2 and local docker are available. initial available host memory
  was 3,943,260 kib. foreign test stacks remain untouched.
- exact incident image pulled successfully:
  `ghcr.io/nielsdawheelz/nexus-api@sha256:8564b8ec84376772c7cad8dc8c91f29892e4bb3b325a2520a6835a10f6ed456c`.
- upstream worktree: `/home/niels/src/personal/llm-calling-bounded-workspace`,
  branch `codex/bounded-provider-imports`, based on the exact nexus dependency
  pin `8fde23ac56571a63c65cfcff55c73a0976f83eb4`.
- root owns dependency setup. no concurrent installation is running here.

## reviewed implementation boundaries

- root supplies `E_READ_CAPACITY` and its existing 503/retry-after envelope;
  runtime admission will consume it after measured qualification.
- provider runtime will import only the selected adapter at dispatch. no dynamic
  facade loader. all four adapter constructors hold only timeout and caller-owned
  http-client configuration; the per-call sdk client lifecycle stays unchanged.
- the controller must own exact capacity containers through its recovery ledger;
  a killed docker client must not leave an unrecorded workload.
- historic baseline characterization and candidate acceptance remain distinct:
  a known baseline failure cannot become a candidate gate success by reclassification.

## evidence

- observed red: `./scripts/test changed --base HEAD
  python/tests/kernel/test_provider_import_boundaries.py`, run
  `fe6d318dd67e4b12`. fresh catalog/runtime construction imported all three vendor
  sdks and all four execution adapters. static checks passed; the intended
  behavioral assertion failed.
- reviewed local provider checkpoint:
  `9abaf6b7a1f907fcf1bdbfa33dd7b343e42ffbdb`.
- the kernel's direct dependency url made a provider-only repin unsatisfiable.
  reviewed metadata-only kernel checkpoint:
  `fd2d71d8608692babbc4144ca77f65ec34f454a9`. current docs and the exact-pin
  packaging oracle move together; historical receipts retain their old shas.
- nexus now resolves both pins without dependency overrides; no other packages
  changed. root published both reviewed commits to their origins under `codex/bounded-workspace-imports`; immutable pins are reproducible from github.
- `api-capacity` is drafted in the existing test controller. the incident image
  runs only through its explicitly selected qualification node; complete runs
  select candidate nodes. initial receipts are explicitly `imports-only`.
- review correction: candidate receipts distinguish the head label from dirty
  copied-source identity; changed build inputs reject the receipt. final resource
  qualification still requires a clean committed candidate.
- both fresh-process and image probes now dispatch a real openai response via
  the external httpx transport seam, assert returned text, and inspect vendor
  imports afterward. no paid provider traffic is required.
- focused provider green: `00b0574d43f5eacd`, including the first selected-provider
  request. no competing run was cancelled.
- container ownership now has two concrete callers: api capacity and the worker
  image binding proof. the owner records identity before create; normal teardown
  and interruption recovery check the exact run/token/project labels.
- the kernel conformance owner now composes beneath the existing provider-runtime
  gate, reusing exact dependency checkouts and fixed checks. execution remains
  required before either new upstream pin can be called fully qualified.

## initial image measurements

exact incident image receipt: `test-results/runs/e4d7de2bd2d2cf80/api-capacity-baseline.json`.
app construction used 268,050,432 cgroup bytes. the first selected openai request
peaked at 298,516,480 cgroup bytes and 275,308,544 process rss bytes under the
existing 335,544,320-byte limit. all three vendor sdks loaded. this run includes
neither request lifespan nor reader/database/worker overlap, so it cannot select
replacement limits. charged file-cache pages varied between runs; subsequent
receipts decompose anonymous, file and kernel bytes.

the first fixture attempt `ef9b16eee407de90` failed because its database url
selected absent psycopg2. the corrected fixture explicitly selects the installed
psycopg driver; this was a fixture defect, not an image oom.

## admission review

`ReadAdmission` owns expensive json reads before dependencies through body transfer.
the first shield-only design was rejected: outer `RequestDbSessionMiddleware`
would close a cancelled request's database session while its child still ran.
the revised design defers even repeated cancellation until the child terminates,
then lets the existing outer cleanup unwind. no detached-work supervisor or
production resource default is introduced.

the first service proof `6a0390448d2c044a` exposed missing `Retry-After`
serialization. the canonical response owner is being corrected by row b; its
failing assertion remains. the revised proof also compares real postgres
transaction identity across cancellation and covers blocked body transfer.

no allocation profile or complete workload qualification exists yet. memory
limits and concurrency numbers have not been guessed or changed. the provider
and kernel full conformance suites remain required after the focused proof.


## production middleware and image ownership

- real `create_app` topology proof: `90d0dbae8bb4918d`. repeated cancellation
  retains the real postgres transaction and request-id context until synchronous
  work finishes; the permit covers actual body transfer. rejected work receives
  503/retry-after without a dependency call or a JSON-body receive.
- main API auth/request-id/private/public header wrappers now use direct ASGI.
  the duplicate whole-body JSON parser is removed. malformed JSON retains400,
  including author endpoints; root preserves disconnect499 in the canonical
  exception handler. MCP retains its separate protocol middleware.
- root approved deleting the image proxy's128MiB resident LRU and time-based
  validators. browsers retain the existing private24h freshness. new/expired
  browser requests pay upstream I/O; no arbitrary replacement cache is added.
- image validation now streams raw identity-encoded bytes, rejects advertised
  and observed excess before retaining it, and closes unread redirect bodies.
  origins ignoring `Accept-Encoding: identity` are rejected before decompression;
  this is an explicit compatibility price. focused proof `401725cb8d50f266`
  covers advertised/chunked excess, compressed oversize, and redirect bodies.
- actual auth6 passed in `d8da7e77818786d7`, but the subsequent public-share
  fixture hit `XMinioStorageFull`. hostfree space807MiB remains insufficient.
  qualification is blocked on exclusively owned artifact cleanup, recorded in
  `docs/tickets/test-host-free-space-blocks-minio-capacity-proof.md`.
- exact native proof accidentally ran the full class portfolio. observed
  red `3857fad0c3eaab99`; fixed exact dispatch retains its explicit Gradle class
  while full still selects all. focused green `c9448222128b7dba`.

all measurements above remain import/lifecycle evidence. no final API/browser
allocation profile or complete worker-overlap qualification has been claimed.

## actual incident-shaped reader requests

`116374034d1e2ed5` runs the exact deployed image with its own baked identity,
its Alembic head0215 in the run-owned empty database, real Supabase auth,
and the977-fragment measured source shape. the receipt separately hashes the
fixture generator, manifest and generated source bytes. socket readiness attests
container PID1; a20ms sampler retains cgroup counters across startup and requests.

| stage | cgroup peak bytes |
|---|---:|
| authenticated idle |259,670,016|
| one reader response |289,906,688|
| two overlapping responses |316,047,360|
| four overlapping responses |335,544,320|

all responses were200 and6,947,259 bytes. four-way overlap hit the exact existing
memory limit48 times (`memory.events.max`); no oom occurred in this stage.
the slower pair took~0.52s. final anonymous memory was303,124,480 bytes.
this proves foreground response allocation consumes available headroom; it does
not yet reproduce the incident's kill or qualify image/provider/worker overlap.

fixture corrections: missing test identity path caused startup exit3 in
`553da58b7b9369d0`; stderr is now retained. mixed capability preparation exposed
late migration-db planning in`e8a4ea5ef8494635`; the run now plans that resource
before its first capability prepares infrastructure. these were harness failures,
not application oom evidence. actual image-retention and planned-container-owner
proofs also passed in`116374034d1e2ed5`.

runtime/container/image faults are registered for controlled sensitivity;
registration alone is not an observed red. final profile values remain pending.

## candidate incident-shape containment

`0103cec1174b644e` passes the same reader fixture against candidate image
`sha256:87cfb3a736f22f6bf1d6d53de577d997d79b2586ca7f2a0e0ad1b4b45d5ef1af`,
schema0229 and frozen dirty-source digest
`0a85730a9bc9f025100e3e0f74c300de3dbce23bfc2039711312b18efc9612ac`.
this is provisional source evidence, not a clean release-image qualification.

explicit experiment: two admitted reads; one-second retry guidance.
idle cgroup229,306,368 bytes; one-read peak261,480,448; two-read279,777,280;
four-way overlap280,715,264. two requests finish200 in~0.12s; two are rejected
before materialization with503 `E_READ_CAPACITY` in~5ms. no memory.max events
or oom. images, actual provider first use, maximum supported source and worker
activity still need composition measurement. the same invocation passes the
complete fault-manifest kernel oracle after correcting patch headers and
preserving the existing cursor-CAS fault against its moved owner.

admission is now composed through local read subrouters. progress/mutations,
file redirects and publication asset streams stay outside the JSON read pool.
legacy search and bounded history-query routes join the pool. the controller
supplies explicit paragraph-publication experiment values:256kib unit/index,
16kib descriptor,65,536 codepoints,8,192 DOM nodes. these are not release defaults;
intact tables and maximum encoded sources are independently being qualified.

## actual artwork kill and sensitive ownership proof

baseline `254fb4ec1c47dcfc` reproduces an oom in the exact deployed image and
its own schema. the approved mounted startup replaces only the synthetic
image origin's DNS/HTTP transport; actual auth, SSRF, Pillow, ASGI and cgroup
remain real. all source/input/seam hashes are retained in the attached artifact.
idle259,588,096 bytes; six serial valid10,447,363-byte PNGs return200; the
seventh loses its connection. peak335,544,320; memory.events max210/oom1/
oom_kill1; container exit137/OOMKilled. no overlapping reads are necessary for
the resident image cache to exhaust the existing limit. this is an explicit
test-origin reproduction, not a claim that these images were in production.

the candidate removes the resident cache and opens each validated image once.
PNG opening expands compressed text before pixels: the workload also contains
a68,027-byte image with64MiB of valid metadata. no production Pillow limits
were lowered. metadata-limit rejection now uses the existing invalid-image
error; ordinary red `beb1012a4295505e`, green `160a1df6b65e8305`.

canonical controlled red/green receipts:
- admission cancellation/session lifetime: `020b61b7f4ad25a0`;
- image resident retention: `84b86bfa4528948f`;
- image allocation before its wire bound: `7b5d08bf0879be79`;
- actual foreign-container preservation: `7ac18b02a1a6babc`;
- planned container owner replacement: `9701dca62050e0f8`;
- native cursor source equality: `bb97ad9b7f6622c8`;
- native JSON pre-allocation bound: `908ded80feb4de65`.

native proof uses isolated checkpoint `d0fd963d7f`, with exact fresh class-owned
JUnit assertion evidence. runtime proof uses `3a8a4b1eb7`, then `72d6846150`
for the coherent image-byte fault correction. these are testing checkpoints,
not final release-source claims. upstream provider/kernel full suites remain
owned by `./scripts/test full` and have not run yet.

capacity JSON existed in earlier run directories but was not attached in the
capability receipt; the controller now attaches bounded named measurement files.
all independent capacity-container/tag teardown owners now run even if another
cleanup fails. reader-table diagnostics bind run, fixture, declared scope and
all six actual profile/view observations before attachment.

candidate artwork `bd1dc4955ce312e3` fails on frozen image
`sha256:61172dd09afca7a3719ce8b8ce032d78e0ff906cebcace7788a308ff9ac46d1b`,
input digest`744d6d5aa2fb347801387eb883dfe5dca1e0b5684839ce073ba77f0de7272393`.
all16 serial wire images pass, with current memory stabilizing235,261,952 bytes
and peak270,946,304. one image plus two readers and readiness passes at
peak287,129,600. two images plus two readers kills the API:137/oom_kill1,
peak335,544,320. metadata was not reached; it is not inferred from that failure.

independent metadata `a3af95506daa7bf9` fails on frozen image
`sha256:3ebf7d2330d719ee6c35812a672b9eb8e35ffac9e204db73ee86aa2272b3a5c5`,
input digest`61b96d37f95cfe569ce90d24ac0acdb78df7d83c3b9d10fa1e832ec916e6b0f5`.
the valid64MiB metadata image alone passes at peak301,133,824; with one reader
and readiness all pass at318,316,544; with two readers it kills the API137.
one image/one reader therefore leaves only~16MiB before SDK first use and other
foreground consumers. neither current320MiB nor any replacement has qualified.
all request starts are barrier-aligned and timestamped; client thread count is
not claimed as observed server concurrency.

## image ownership and orientation

nested image/shared foreground admission passes actual-app ordinary proof
`42eb3f41cada8541`; root reviewed failed partial acquisition, cancellation and
actual-send lifetime. the candidate-only512MiB trial is approved measurement,
not a release profile. its next workload warms the real selected provider adapter
through a controlled external HTTP response, explicitly distinct from cold import
and first-request evidence. readiness/progress must remain200; image/read overload
may return the owned503/retry guidance.

display orientation ordinary red `001eb1f661821d48` observed6×2 encoded axes where
EXIF requires2×6. green `3ee0bb92667e1e64` covers the corrected scalar extraction
and actual image response headers/cache behavior. public Pillow EXIF loading was
rejected after inspecting eager unselected-tag allocation; its exact source
evidence and outstanding capacity characterization are ticketed separately.

new `lib/media/artwork.ts` requires explicit derivative/residency inputs and is
not activated in product components yet. ordinary browser proof
`a9ea9e775d12710d` covers real rotated JPEG decoding, static GIF first-frame
derivation, shared retries, last-consumer URL revocation, queued demand and
cancelled-source replacement. these are small ownership/format proofs, not memory
qualification. the first attempt's blob-fetch assertion hit the test's network
guard; its replacement uses actual image-element decoding and keeps that guard.

provider-warmed512MiB trial `c243cd943a90b130` passes on frozen image
`sha256:67ddc250b8da8bdd87e3e0c6430220be1f94c70427caaa1be0dcb499a673aeb6`,
input digest`13158041775a772cecda68493db917fa64eebcc7535c2fa2d089aa499bee16fa`.
valid64MiB PNG metadata alone peaks354,811,904bytes; with one reader368,750,592;
with two requested readers383,221,760. the latter admits one reader200/91.9ms,
refuses one503/11.8ms, and keeps readiness200/22.6ms and image200/294.6ms. no
max/OOM events. progress writes, actual worker overlap and the complete supported
image-format language are still outstanding; this does not select release RAM.

exact-deployed-image `043599ef91d1ad0c` independently confirms EXIF amplification:
one63,839-byte JPEG with2600 private IFD tags sharing32,000bytes kills API137.
peak335,544,320; max101/oom1/oom_kill1; no concurrent readers. source and complete
test-origin seam identities are retained. JPEG APP metadata now stays out of
the validation view, while original bytes remain the served representation.
AVIF's eager EXIF loader and ICO's actual pixel decode still prevent a complete
image-format qualification claim.

the proposed maintained `imagesize`2.0 header reader was rejected after source
audit at`cf87fc06d599c71b61564eca97873b7bc75ab49a`: zero-width AVIF extent entries
can allocate65,535 tuples per six encoded item bytes, before choosing the target
metadata. PNG/WebP orientation and AVIF `irot` handling also fail the required
axis contract. no dependency was installed or changed. the allocation claim is
static source evidence; no unbounded-host experiment was run.

real worker restart failure`9e8bbb67bf37ee0d` was a registry/topology mismatch:
its retained worker log names undeclared`prepare_offline_reading_package`.
the task now belongs to the existing background lane in`job_topology.py`.
exact committed-note/process-death/replay proof passes`446d864c510724b1`;
the pending-worker ticket is resolved. this was not a memory failure.

bounded foreground decoder ordinary proof`11c18e5d0c06e631` passes the existing
rotated JPEG, animated GIF,4096² PNG,64MiB PNG metadata and invalid-input cases,
plus actual API admission/body/proxy behavior. new explicit trial profile is
256MiB address space,5s hard CPU and10s wall; no production defaults. Linux
parent-death binding is shared with the existing worker primitive. worker
ingestion keeps its current bounded child rather than adding nested isolation.
anonymous input/result descriptors retain no path and stdout/stderr are discarded.
the locked standalone Python omits`os.memfd_create`; the same Linux libc call
supplies that syscall. original wire bytes and child input overlap in the cgroup.

browser artifact`37dd92f994a09377/artwork-capacity.json` retains all12 ordinary
profiles.16 sequential4096²-source derivatives become ready in1.52s at256px,
2.01s at512px and2.05s at1024px. summed process RSS high-waters across the ordered
run range~542–614MiB; these are not simultaneous peaks. private footprint stays
~108–124MiB. repeated solid-color derivatives may share or optimize decoded
surfaces; this experiment does not establish worst-case retained surfaces or
the complete workspace budget. CDP private-footprint/high-water observations
replace a rejected `/proc` file access; Vite's filesystem guard remains strict.

foreground child limits/lifetime proof passes`b58dc4f7de7704bf`: actual CPU
SIGXCPU, separate wall expiry, parent death, supported existing image corpus and
nested API admission. the shared background parent-death primitive also passes.

frozen decoder image`780f35615cf5bb2e27b1a5b9b592fdef2fa2f5e1d9c0ff239e9c5aa57f3cbbea`
passes`08c371ca397dd14e`: provider-warmed API + maximum supported PNG metadata +
one admitted legacy reader peaks422,051,840bytes inside512MiB, no max/OOM events.
readiness18–23ms, reader91–97ms, image1.04–1.09s; competing reader503 in3.8ms.
this receipt excludes progress writes and worker overlap. child isolation adds
startup time and peak memory; it prevents malformed image allocation from owning
API lifetime. values remain experimental, not a release profile.

that receipt's child`ru_maxrss` field is misattributed: Linux preserves resource
usage through exec, so the number carries the pre-exec API footprint. the cgroup
peak is unaffected. the fixed result now reads`/proc/self/status`'s`VmHWM`, which
belongs to the child's current memory map. sources:
[Linux task_mem](https://github.com/torvalds/linux/blob/master/fs/proc/task_mmu.c#L34)
and[getrusage](https://man7.org/linux/man-pages/man2/getrusage.2.html).

### artwork activation and recovered storage — 2026-09-13

- composed web provider/actual media-image/media-session ownership passed
  `87185d2ef683d606`; page-hidden release with an ongoing media-session cover
  passed `73f4628602b59b1c`. visible consumers share the current cover's object
  URL; hidden leaves drop `src` before passive lease cleanup; the last consumer
  revokes it. observed red exposed the missing-source image's intrinsic inline
  box; explicit non-replaced display geometry fixed its demand identity.
- the activated web experiment is explicitly unqualified: 1024 maximum display
  dimension and 4×1024² resident pixels. excess visible demand waits in arrival
  order with pass-over-once, not strict arrival order: a demand larger than the
  remaining headroom may be overtaken by a smaller later arrival exactly once,
  after which it is the exclusive next admission, so the 1024×1024 media-session
  cover cannot be starved indefinitely by small leaves. the earlier "waits in
  arrival order" wording overstated the policy; `apps/web/src/lib/media/artwork.ts`
  `nextAdmission()` is the owner and `artwork.browser.test.tsx` proves it.
  the retained encoded PNG derivative is measured per profile as
  `derivativeBytes` in the capacity receipt but is not reserved; only decoded
  pixels are charged. this is a residency
  contract, not a promise that an arbitrary viewport can display every cover at
  once. actual process measurements, not RGBA arithmetic, qualify release.
- the image-admission ticket's consumer half is resolved (2026-09-14 adversarial
  review). both named proxy consumers now acquire through the artwork provider:
  `apps/web/src/components/ui/MediaImage.tsx:11,64` uses `useArtworkReader`, and
  `apps/web/src/lib/player/mediaSession.ts:189-211` publishes the provider's
  object URL rather than a proxy URL. the fetch runs under `requestWithRetry`
  (`apps/web/src/lib/media/artwork.ts:8,258`), which honours `Retry-After`, and
  `apps/web/src/lib/media/artwork.browser.test.tsx:51-75` asserts a 503
  `E_READ_CAPACITY` is retried rather than stranded. the ticket is rewritten to
  state only what is still open: the allocation measurement under concurrent
  JSON/progress/readiness load and its concurrency/recovery receipt.
- disk recovery removed only the idle runtime-proof virtualenv and idle
  native-proof `app/build`/`.gradle` after root approval and process checks.
  source and receipts were preserved. exact owned MinIO volumes were 104/88 KiB;
  they did not explain the host exhaustion. later external cleanup restored
  17 GiB, provenance unknown. real PDF upload and source worker passed
  `3427e8d7d605d4d4`; no storage-availability claim relies on `df` alone.
- native artwork is staged: fixed-origin preview proxy, serialized bounded
  original read/decode, static current-track PNG metadata, and retry on existing
  `Connect`. entry identity prevents an old account/track completion from
  publishing to the replacement. replacing metadata preserves the audio source;
  the new host proof is pending. the 1024 native derivative and 30s acceptance
  deadline are experiments, not measured physical-device budgets.

### actual decoder/progress and native current-track recovery — 2026-09-13

- frozen image `925bb845ae33c4ee77776b3b398befcea64dd8971d81208d5217568efdd7904c`
  passed `512035dbb20c3d80`: API cgroup peak 388,591,616 bytes, no memory.max or
  OOM event; both cursor writes acknowledged at 55/84ms, readiness 47/25ms.
  current-image child VmHWM was ~41 MiB for aliased EXIF and ~110 MiB for maximum
  PNG metadata. two requested reader calls won the shared slots in the last
  batch, returning image503; evidence distinguishes requested from admitted
  overlap. no final worker/browser/device envelope follows from this run.
- native current-track canonical sensitivity passed `c1acaef6c4638227` on clean
  `e1932cba2d`: deliberate reconnect retry removal failed its independent request
  count assertion, then the actual ExoPlayer/loopback/native-graphics cases
  passed. preview origin, rotated dimensions, static GIF first frame, stale
  account completion and metadata/position/play-intent preservation are covered.
  the player begins idle; actual active audio-renderer continuity is outstanding.
  separate `NexusOriginClientTest` advertised-byte tests were not selected.
- earlier native runs `610e25dbeb97c9b0` and `d7d8c2b79215f7f0` failed fixture
  setup, not product behavior. the existing independently manifested artwork
  bytes were then included in the isolated checkpoint; no oracle was weakened.

### worker composition evidence retained but gate not yet accepted

`f97b9463886acc57` returned `not_run`: its indented 5,250,291-byte receipt exceeded
its 4 MiB artifact contract. the original JSON remains intact. it reports API
peak435,490,816 / worker peak346,521,600 bytes; zero max/oom/oom_kill, actual source
child high-water295,641,088 bytes, successful retained-object publication and
real worker health. image1188ms / reader146ms intervals intersect the source job
and observed child; readiness43ms / progress142ms both200. these observations
are not an accepted gate. the next run uses lossless compact JSON (the same
existing evidence is3,318,130bytes in that encoding); no samples are discarded.

web artwork feature-owned retry plus page-hidden/media-session ownership passed
`c52d6d98284d401d`. retry stays outside the cover's navigation link and restarts
only consumed failed demand. production derivative/profile qualification remains
open.

### accepted worker composition — 2026-09-13

`b2dd452e8f455625` passed, with all samples retained in a3,350,913-byte compact
JSON artifact. API image857d376cdabf1e13c2826615a220900210bac4123bc8b98443bc12c2039ea4ca;
worker imagec228c140c6e03dc53954c22f5a0fec87e97f135167d68a810cb505b0db8bd7c7.
API peak435,421,184 / worker peak345,092,096 bytes; both zero max/oom/oom_kill.
actual source child high-water296,054,784 bytes, observed6.87s interval;
source-job and child intervals intersect accepted reader182ms/image1271ms.
readiness37ms and cursor68ms both200. two retained objects and actual lane health
passed. the controller's combined owned peak was1095MiB, including local service
containers and test processes; this is not a production-host reserve.

this completes the two-page worker/API composition stage. maximum source/new
publication units/browser/native-device qualification remain open. next assigned
boundary: native schema-2 TS source/session composition and verified member MIME/
PDF ranges. native artwork active-audio continuity and its separate advertised
byte-limit proof remain outstanding and are not erased by this reassignment.

### native schema-2 composition (source proof green; composed reader pending)

- `OfflineReaderSource` now reads only the selected local descriptor, bounded index pages and acquired unit members. it reuses strict shared publication decoders, counted byte transport and the existing immutable unit cache; constructor no longer starts a whole-document fetch. native verification remains the digest/media authority, with no hosted reroute.
- resolve uses exact retained section `unit_key`, original code-point coordinates and bounded cross-unit quote carry. its required scratch reservation covers one index and one unit decode plus finite quote/snippet overlap. abort releases the query's unit consumer; if another consumer retains the shared read, scratch remains reserved until that read's existing deadline settles. no late query reduction may run after cancellation.
- `OfflineDocumentReader` now uses the extracted common unit window, one leased contents page and the same prepared DOM root. native capture/conflict handling keeps its existing durable owner. captured resource attributes stay deferred; figure/vector activation remains a release blocker owned by the shared resource work.
- native selected leases now retain the manifest's declared member media types; `resolveEntry` returns the declared member file/type and refuses undeclared files. PDF MIME/ranges no longer depend on a filename extension. extra per-open manifest parsing/map retention is bounded by the existing 4MiB manifest and 4096-entry contracts and must enter native qualification. the router proof is staged, not executed.
- native `find:null` now states the existing downloaded-reader scope; the shared source capability is optional and this reader exposes no find control. local converted units may carry unavailable word metadata without inventing a dictionary segmentation engine. schema-1 browser fixtures still need migration to actual retained schema-2 bytes.
- source proof `49fac6e55b6b051f` passed actual archived member reads, Unicode offsets, exact retained navigation, advertised-byte refusal, and canceled query scratch retention while another consumer owns the shared read. initial run `ae57721688fbd484` exposed an incorrect test expectation: resolve scratch uses payload admission, not lease-count admission. the corrected assertion still requires refusal before physical settlement and success afterward. controlled sensitivity remains pending.
- immutable native unit identity now includes actual account, media, source generation and opened lease; source/session retries share one application cache and cannot reset physical read admission. the final contents chain is a distinct display projection; exact section resolution continues through the unit/lookup index chain.

- native member MIME/range sensitivity passed `9160ba3d44198525` on isolated checkpoint `ebe73a241a`: extension-based MIME fault loses PDF range support; candidate serves exact declared extensionless PDF bytes and ranges and refuses undeclared files. this is the actual lease/router boundary. a producer-archive/store-open composition remains pending; this receipt does not claim PDF.js/device rendering or final resource qualification.

- 2026-09-13 native composition: actual producer schema2 Unicode members,
  strictmode shelf, prepared DOM, `cat` navigation, generation7/original offset7
  durable native save, close and keyboard return passed `2bc2481945e0635e`.
  `9793c10038ccedb8` observed the permanently closed memoized reader session;
  acquisition now lives in the existing effect that closes it. The intervening
  `89c0b0c06d4078ba` reached reading/saving then exposed parent-close/child-unpin
  cleanup order; shared unpin(false) is idempotent after release, while acquiring
  a pin on a released unit remains a defect. No lifecycle delay or reopen.
- Native paint checkpoint compile `124f30207c43fd3e` exposed constructor arity
  and a root unit-byte hashing call typo; neither is a behavioral red. Corrected
  narrowly before rerunning the registered supplementary-identity fault.

- Native migration paint parser owner resolved: canonical fault red/green
  `8a4d00877734ac68`, clean checkpoint `2b27e8a2d8`. The pinned Java17
  HtmlUnit lexer owns token boundaries and raw spans; the narrow CSS scalar
  escape decoder preserves supplementary/local identity. Shared independent
  corpus also passed the actual Python producer (`d11bb7e20a21f521`). No
  JavaScript runtime or CSS AST roundtrip. Price: one migration-only Java17
  dependency and explicit escape decoding; literal fallback bytes are retained.
  The first composed proof caught use of lexical URL instead of public URI
  tokens (`05cd4479aee96b5c`); corrected before final sensitivity acceptance.

- 2026-09-13: expanded native SVG paint recovery is demonstrated-sensitive green
  `90265c9d3dc00502` at native checkpoint `764f06e019`, following the shared
  Python EOF diagnostic correction `2f11d8f9a02ae289`. the same independent
  corpus now covers implicit EOF close for `rgb(1 2 3`, `[red`, quoted/unquoted
  local `url`, escaped function names, supplementary scalars, and external or
  nested resource rejection. this supersedes the earlier premature closure of
  the parser-owner ticket. price: one pinned Java 17 lexer plus a narrow normative
  scalar escape projection; no migration runtime or CSS AST serialization.
- native package activation and account purge are under proof. direct-child
  creation prevents conversion from recreating a deleted binding's ancestors;
  purge checks absence before completing the account transition. an interrupted
  or failed local conversion remains `UpgradeRequired`, with local retry/remove
  and the original package/progress retained. no resource profile is qualified
  by these functional checks.

- native conversion conservation is now demonstrated-sensitive: index chain
  `e0a988e25c806440`, atomic activation/pending preservation
  `90b50c979f99a9fc`, purge during suspended source staging
  `afda7bc4888dbb56`, task-only v1/v2 database row/FK experiment
  `20051d316f1a10c3`, actual temporary file-access denial
  `4470cff7dcad92d2`. snapshot `cf43c0fe2d` includes the source-range crop/index
  correction; graph/NFC/crop/list/unit replay remains in progress.
- browser source/current-wire composition `e390e5b1f53bfd43` preserves actual
  producer EPUB anchors and original Unicode offsets. native handshake review
  then found the effect-replay fixture accepted impossible duplicate connects.
  the connection now belongs to the real local document in `main.tsx`; React
  subscribes only, and fatal recovery reloads that document. the native bridge
  retains its existing one-connect and page-start lease ownership.
  `2432575214fe32f7` enforces Busy on a second native connect; `0bedfff517b6d813`
  additionally proves initial AppLink retention, retired receiver rejection,
  retained initial refusal, and local upgrade/removal refusal+recovery. no
  `pagehide` listener was added: a persisted document must keep its connection.
  controller recovery reloads the local document and releases its active view;
  installed source and pending progress remain native-owned.
- refreshed native graph sensitivity `0e48f00ecf147bcb` and default EPUB source
  identity `b97c3782efa1f5b9` pass at `cf43c0fe2d`; actual retained PDF/EPUB wire
  fixtures are included. list replay is intentionally held while its owner
  resolves observed engine differences. incoming schema1 archive retirement
  remains open: old archive faults must move to schema2 before that branch is
  removed, so a blanket unsupported-schema response cannot masquerade as a
  successful integrity proof.
- original canonical normalization sensitivity is green `3a190d8ee0439839`
  at `cf43c0fe2d`. the source-first crop replay is next; browser/version-specific
  list default reversal is a separate explicitly open compatibility decision.
- explicit native list projection is demonstrated-sensitive green
  `d55a85e4810c5cde` at `09af7cb73b`; unit/canonical conservation is green
  `6e71658dfb04e5e4`. a subsequent crop replay (`0b4ac4ae1961ac2b`) exposed its
  retired synthetic-`ol.start` assertion. the reviewed correction preserves
  authored `start=7` and observes continued `li.value=4`, without changing the
  text/anchor oracle. its new replay is pending.
- current browser schema2 replacement and native-document startup are green
  `1415ad2467509749`: actual retained Unicode/EPUB/PDF members, visible PDF
  source text, native save refusal/retry, exact conflict/choice authority,
  AppLink lease replacement, typed local read failure, sign-out and keyboard
  return. first attempts exposed fixture-only mismatches: unit-local offset
  versus original offset, EPUB UTF-8 versus PDF base64 encoding, and the omitted
  production PDF viewer stylesheet. canonical choice/startup sensitivity remains
  pending; this is not release/capacity qualification.
- explicit coherent-fault review (no automatic fallback): native paint, index,
  database and purge proofs are byte-identical to their accepted green
  checkpoints. they call new migration/fixture/DTO owners absent at the real
  pre-cut base, so BASE cannot reach their behavioral oracle. their single
  canonical owner and exact file bytes are now pinned to the existing named
  product fault. evidence: paint `90265c9d3dc00502`, index
  `e0a988e25c806440`, database `20051d316f1a10c3`, purge
  `afda7bc4888dbb56`. this attests only each named invariant; it does not
  qualify imported helpers, fixture bytes or the final release by itself.
- incoming schema2-only admission is demonstrated-sensitive green
  `fdc26b2904a269b4`, after observed schema1 acceptance
  `5e405b33830f7eaf`. historical migration remains live. latest corrected crop
  text/anchor/list projection passes `85813228f51cff3e`.
- actual legacy URL conversion exposed the separately recorded preservation
  gap (`69ac6e672afadfdc`). the migration projector now retains historical URL
  and subresource restrictions before rewriting declared images. independent
  schema2 link support is unchanged; final corpus sensitivity is pending.

- historical streaming migration verdicts are demonstrated-sensitive green
  `2020bdd26b480c84` at `cb6d60ccc4`, including the original shared reader
  corpus and the explicit remote/executable attribute rejection following red
  `69ac6e672afadfdc`. the whole-reader native verifier and its superseded
  lifecycle method are removed. schema1 installed manifest/signature/source
  migration remain live; independent schema2 ordinary links remain supported.
  this resolves the historical URL-verdict ticket (oi-144).
- current schema2 archive integrity replacement is demonstrated-sensitive green
  `bd8b9c469e0bb784` at the same checkpoint. an accepted coherent archive precedes
  metadata/member/path/signature/integrity faults; a symbolic-link entry reaches
  the named assertion under the product fault. an earlier candidate failure
  (`2ead45850d59993b`) incorrectly sent unknown-manifest-key vectors to generic
  JSON parsing; those retained vectors now use the actual manifest parser.
- these two exact native proof files now explicitly pin their coherent product
  fault: the real pre-cut base lacks the migration owners/current producer
  contract required to reach the assertions. prior red/green receipts are above;
  this is per-invariant evidence, not a blanket substitution for BASE. incoming
  schema1 refusal retains its observed BASE evidence and adds a separate narrow
  missing-admission-guard fault for final coherent-candidate sensitivity.

- native document startup is demonstrated-sensitive green `1c3afa05ae0eecd3`
  and schema2 source/choice composition `137e41db244507ef` at `9bd0352a8a`.
  the real one-connect-per-document fixture rejects repeated connection while
  connecting or connected; React effect replay only subscribes. initial native
  open waits for the actual shelf subscriber, and retired document replies do
  not alter the replacement. this resolves oi-130. fatal connection recovery
  reloads the local document; no bfcache pagehide teardown or reconnect protocol
  was introduced.
- shelf refusal ownership is demonstrated-sensitive green `ab1f413ddb3f2d31`
  at `1782294bcf`: local retry/remove refusal remains visible, refused removal
  keeps its confirmation, success permits normal return, and unknown defects
  remain with the existing reader feature boundary. this resolves oi-138.
  source/save/choice authority stays native-owned; no released command protocol
  was expanded.

- final strict incoming-package admission is demonstrated-sensitive green
  `99080ad8416215f0` at `2b0ebeefb9`: without its admission guard, a historical
  schema1 archive incorrectly reaches current member validation and reports
  Integrity; the candidate refuses UnsupportedPackage before member extraction.
  actual current Unicode/PDF/EPUB/table producer archives preserve every exact
  member and installed byte count. this follows the original observed schema1
  acceptance/red and BASE fix receipt `fdc26b2904a269b4`. the incoming owner now
  explicitly pins its exact green bytes and named coherent fault, since the real
  pre-cut base lacks its new installed fixture/current producer contract.
- source identity replay is green `9dd69904d22bfa0b`; all 30 current schema2
  store lifecycle cases pass in sensitivity `bc99d5941185ce9b` at the same
  checkpoint. its red specifically deletes pending intent during corrupt-member
  recovery; the candidate preserves it. historical installed conversion remains
  offline and progress-preserving. incoming schema1 branch/whole-reader verifier
  retirement is complete (oi-137); full release/device/capacity qualification
  remains separate.
- artwork's three browser owners now read the same manifested external image
  fixture through the existing commands.readFile/exact fs allowlist, with an
  owner-local __tests__ envelope. this removes forbidden deep imports without
  modifying fixture bytes, decoders, allocation profiles or expected outcomes.
- artwork core/provider replay is green `742c0825a92dbd2c` after the fixture
  import correction. independent observer review also caught queued callbacks
  reacquiring retired demand and first-entry batching preserving stale visibility;
  the shared observer now fences retirement and uses the final queued entry,
  clearing src/busy before lease release. the client owns its direct callback
  proof. no capacity profile was reclassified by this functional replay.
- native table geometry qualification began with publication's proposed sparse
  cell contract: original independent rectangles, resolved zero spans, int64
  coordinates, explicit header targets versus automatic ray/opaque-block rules.
  `OfflineReadingTableGeometry.kt` is only an unactivated ordinary-btree candidate;
  no wire fields or package activation changed. source-sized ray scans and
  output/header cardinality still need actual qualification. repeated logical
  rows and an int32 spatial index are not acceptable implementations.
- table measurement was paused for the confirmed SVG retention defect (oi-148).
  actual external JAXP/stream observation `fb658b10d97e81db` shows IO becoming
  false/corrupt after a real input prefix. the staged fix preserves deliberate
  invalid-source/syntax rejection but propagates resource/setup/VM failures;
  canonical candidate proof is pending. no synthetic VM error or owned verifier
  mock is used. successful native measurement retention is separately recorded
  in `native-qualification-green-artifact-retention.md` before relying on it.
- SVG resource preservation is demonstrated-sensitive green `3c6bbc8bd154706b`
  at `e64281855b` against the observed old parser catch at `daa726ae25`; prior
  red `fb658b10d97e81db` consumed real SVG input before its external read failed.
  deliberate source violations and actual XML syntax still reject; input, setup
  and VM failures propagate instead of authorizing corrupt-package cleanup.
  this resolves oi-148. existing installed-access proof `4470cff7dcad92d2`
  supplies the Store preservation half of the contract. an explicit narrowly
  equivalent IO-swallow fault pins the unchanged accepted class for final PR:
  the true pre-cut base lacks its current verifier signature. its direct FAULT
  replay remains pending; BASE evidence is the completed proof above.

### native svg resource verdict and durable successful evidence

`verifySvg` now catches only deliberate source rejection and uncaused parser
syntax failure. parser setup, streaming i/o and vm/resource failures propagate;
they do not authorize deleting an otherwise valid installed package. the actual
external sax-stream failure has base red/green `3c6bbc8bd154706b`, plus declared
fault red/green `565f19a6b1816207` at native checkpoint `bfa20857d3`. existing
store filesystem-denial proof `4470cff7dcad92d2` covers non-destructive
reconciliation. this closes the specific svg corruption-classification gap;
full host/device and aggregate resource qualification remain separate gates.

native exact-class reports now retain bounded standard junit system-out. the
existing sensitivity artifact owner copies successful reports into the run
receipt, so later gradle output cannot replace the evidence. kernel behavioral
reds `0582690035918c9c` (lost stdout) and `5e404701d3cc16a5` (lost green link)
precede focused green `a9b9713f6b29e5c5`. actual native receipt
`565f19a6b1816207` now links its successful exact-class report and retention
manifest under its green attempt directory. no schema, diagnostic cap, launcher
or failure-classification relaxation was introduced. this resolves the native
qualification green-artifact retention ticket.

### sparse native geometry experiment

unactivated ordinary-int64 sqlite geometry passed declared row-end truncation
red/green `792026fe6800d47c` at `d5b330da07`. native sqlite mode, 1MiB cache and
128-row keyset pages are explicit experiments. the receipt retains eight
measurements for dense, rowspan-zero, staggered-expiry and >int32 implied-row
shapes at 65,536 and 262,144 cells. the larger source streams in 0.21–0.42s;
derived files are 7.25–9.60MB. whole test-process rss/heap includes framework,
jni and prior profiles; these are not per-index residency budgets. physical
sqlite page reads are not exposed by the supported Android API and were not
claimed. the earlier compilation/setup receipts did not qualify behavior.

small late-slot queries still scale with source prefixes: 16 reads grow from
0.077–0.160s to 0.301–0.576s. this does not qualify a per-ray automatic-header
algorithm; its multiplication by principal spans is tracked separately in
`native-table-ray-query-prefix-cost.md`. no table wire, source-sized metadata,
package activation, maximum encoded source or device claim follows. work moved
to the root-prioritized explicit pdf navigation completion boundary.

existing svg declaration bypass also passed `79fc8a567a080f47` at `bfa20857d3`
with the exact prior oracle and its successful report retained.

geometry's new whole-file native owner is explicitly pinned to its exact green
`d5b330da07` bytes for coherent-fault sensitivity (`792026fe6800d47c`). the
pre-cut baseline has no sparse geometry module, so it cannot load this owner
and reach its int64 semantic assertion. this declaration applies only to this
reviewed new owner; the ordinary base strategy remains unchanged elsewhere.

### explicit pdf location completion

new `PdfReaderControlActions.locate(page, readonly quads, signal)` borrows the
caller's exact location geometry through the existing scroll and pulse owner.
true means actual positioning and installed pulse geometry, followed by state,
DOM and pending-callback retirement. invalid/unavailable/superseded locations
return false; abort rejects after retirement. replacements wait for the old
retirement commit. the existing 1200ms pulse and eight-frame positioning retry
remain; there is no second timer/retry loop. a cancellation before first commit
still schedules a retirement commit. cancelled callbacks retain a nullable work
cell, which cleanup clears along with its geometry-closing callback.

actual leaf+external RAF/layout-interruption proof passed `fae76f66247f92cd`.
separate canonical owners now test early completion and cancelled-key restart;
combined replay with preserved committed-highlight/BFF reconciliation passed
`7e18b2d839d835a5`. the older highlight fixture supplies real PDF bytes directly
to the leaf while retaining actual hosted highlight queries/writes and the
original pending-reconciliation oracle. selected-publication source composition
remains a separate required boundary. final unmount proof now additionally
awaits the caller's false result; its replay and both declared-fault runs are
pending the dedicated web checkpoint.

final unmount completion passed `2abdf2826f790ce3`. both declared faults now
have canonical red/green at `fb109a36cc`: premature lease completion
`c089158a1ebdb7d2` and cancelled-key retention `35d42f5b72ba672b`. the latter
also retains deliberately late cancelled RAF callbacks and verifies they no
longer read the caller's quads. source-generation replacement remains the
separate composed-reader acceptance boundary; these are actual leaf lifecycle
proofs, not aggregate PDF allocation qualification.

### selected-cell table association candidate

`OfflineReadingTableHeaders.kt` now reduces one selected cell with a descending
source-event sweep, indexed active endpoints and private disk interval state.
source geometry is staged once per package revision; the selected query owns
its scratch file and bounded keyset result pages. no package wire or serving
activation changed. actual python scalar projection `3cbf3cc17e96b344` supplies
20 independently declared WHATWG cases, including wrong-scope/empty principal
headers, cross-ray first-seen order and authored footer-first group append.
the initial wrong fixture directory produced setup receipt `99fbd31ddff4c6f5`;
corrected canonical opacity fault red/green passed `5209f835af62592e` at
`0a4a8cf85c`. the >int32 span takes one band, and revision refusal/close remove
query scratch while retaining the package index.

correction (2026-09-14 adversarial review): the table-header characterization
workload is no longer part of the blocking lane by default.
`OfflineReadingTableHeadersTest` now reads
`System.getProperty("nexus.capacity.offlineReadingTableHeaders")`; unselected, every
shape runs one bounded size (256) and the printed record carries
`selected_capacity_workload`, so a bounded run cannot be read as the measured one.
the numbers below are measured-run observations and require that property.
no latency or byte budget was invented for them; §7 needs a qualified percentile
and a regression policy first.

first whole-query characterization is retained in green receipt
`fb6c4293bae751a1` at `7f52aa4139`. dense 64/256-header reductions take
182/265ms; source-formable overlapping windows take 1,674/3,244ms. overlap
active endpoint reads grow 12,352→196,864 and unique spans 2,207→33,407 while
source cells grow 129→513. these cold/warm host observations expose repeated
coverage work; they do not qualify the supported maximum. the next measured
correction removes repeated identical unique-cell tokens without changing
gaps, overlaps or opacity. no source workload is being narrowed.

the 1MiB-per-connection sqlite cache and 128-row pages are explicit experiments.
reported scratch bytes (40,960–90,112) are final main-file bytes, not peak
journal/temp storage; heap/rss include the host test framework and prior cases.
completed-axis state row counts are not a transient state high-water claim.
full source scan per selection, maximum coefficient/fragmentation, peak disk,
native device and existing read-lease activation remain gates tracked by oi-153.

last-unique-cell interval compression passed opacity red/green and 40 seeded
literal-slot differential cases in `039722e221f15f99` at `f826de217e`. overlap
64/256-header processed tokens fall from 2,207/33,407 to 128/512; observed
reductions are 258/811ms. endpoint reads remain 12,352/196,864, and unique
coverage visits remain 2,207/33,407. the extra disk partition remembers skipped
gaps/overlaps without resetting cell identity; a different unique cell still
changes it. this improves repeated SQL state work, not endpoint complexity.
timings span different host/JIT states and are observations, not qualified limits.

the next checkpoint `cfc5d41bdb` measures constructor/first-page/full-drain
latency separately on 65,536/262,144 irrelevant cells and 4,096/16,384 legitimate
rowgroup headers. no source-sized output is declared bounded merely because
the returned cursor has a small page size.

that latency baseline passed `4d48773a6ea88c09`: irrelevant first pages cost
204/609ms; group first pages cost 724/2,838ms and full drains 729/2,854ms.
indexed eligible-header checks now omit an axis only when no nonempty row or
column header could contribute. active axes still include wrong-scope, empty
and data cells for coverage/opacity. group phases now page directly in source
order from the prepared index, retaining its readonly connection until query
close. closed header kinds make these groups disjoint from ray results.

this correction passed `ffab9e7615993229` at `b441333ab9`, including pages
crossing ray/rowgroup/colgroup boundaries. irrelevant first pages cost 4.16/5.90ms;
group first pages 4.53/9.02ms and full drains 13.74/37.14ms. final scratch stays
40,960 bytes; the prepared source index grows to 4.89/20.40MB for irrelevant
cells and 0.42/1.54MB for groups. returned source candidate counts are not
physical SQLite page reads. overlap256 still visits 196,864 endpoints and takes
684ms to first page. larger overlap coefficients and geometrically irrelevant
eligible headers remain unqualified; owned journal sampling follows separately.

the larger coefficient run passed the same semantic fault in
`acadb25b123d1f06` at `f3df479f1a`, but rejects the current query cost:
1,000/2,000 overlapping headers take 8.37/17.02s to first page. endpoint reads
are 3,001,000/6,002,000, unique visits 502,499/1,004,998, and changed cell
spans only 2,000/4,000. final scratch is 327,680/561,152 bytes. ten-millisecond
owned-directory sampling also catches a smaller case's journal amplification:
dense64 reaches 66,096 bytes with a 40,960-byte final file. these are sampled
main+journal observations, not hard peaks or coverage of SQLite temp files
outside that directory. cumulative host HWM reaches 598,604KiB; this includes
Robolectric/prior cases and is not an isolated native-device allocation budget.

actual source validation first caught web sanitizer scope loss in
`7b3de0ea50c358e4` (oi-162); the source policy was not changed to suit the
workload. (note, 2026-09-14: the publication owner subsequently changed the
sanitizer allowlist deliberately — see the publication dossier's oi-162 entry —
so this sentence records the qualification decision of its own date, not the
current policy. the two dossiers do not disagree.) existing EPUB sanitizer and table/header projection then passed
`48899c7db2a2eae1`, including every padding/header/principal rectangle and role.
1,000/2,000-row recipes contain 82,845/165,631 bytes of source and identical
sanitized HTML; canonical text contains 2,001/4,001 code points. complete
schema1 EPUB reader JSON is 94,241/188,027 bytes. source SHA-256 values are
`d44bac45d1366e77680ec7e450c7a4202abcdbbbc6e316675a08233adad9add0` and
`3ca08b238165a7621b8e413b356d155696746e061cf07fd7a04694914dc8043a`;
reader digests are `94f5b87917a530068ac219f52220df0a74c7f8e7a18d67b8ee2ed4652ef1b4a4`
and `01a885f7f10cd818d0aecfa24cfe10ae3496ea295577816c90be2ffa672870cf`.
this attests the small recipe, not the maximum accepted source or full archive
activation. the next correction must visit changed coverage, preserving the
existing literal-slot/opacity oracles. no release profile follows from this run.

an ordinary changed-owner invocation in the selective native checkout stopped
at routing setup (`991dfe9fefa0be84`): its unrelated browser proof files are not
copied there. the canonical exact native proof above ran through the existing
controller without weakening routing policy. source proof formatting setup
`9e397c68fe4c769a` was corrected before the behavioral source receipts.

query-private interval coverage now replaces repeated active endpoint scans.
one leaf spans two adjacent source endpoints; SQLite stores its binary parents,
coverage extrema, lazy count/xor, uniform identity and per-event-batch epochs.
only changed nodes that can contain uniquely covered ranges are visited.
full ancestor updates force descendant visits before stale-epoch exclusion.
all same-coordinate events settle before those visits. the existing opacity,
last-cell, first-seen result and page owners are unchanged.

first canonical tree proof passed `44ae28f4a554d64e` at `1beb6f7343`, keeping
the 20 normative cases and 40 tiny literal-slot differential cases. overlap
1,000/2,000 first pages now take 1.915/3.507s. unique visits are 2,000/4,000;
the tree builds 1,999/3,999 nodes and performs 86,760/187,520 node reads,
38,796/83,592 writes and 27,900/57,800 reduction visits. final scratch grows
to 393,216/688,128 bytes. this trades source-sized scratch and logarithmic
SQL updates for full endpoint rescans; per-node SQL cost still precedes the
first page. no maximum-source or release latency claim is justified yet.

publication independently reviewed a 21st source case: removing one spanning
data blocker reveals h1/h2/h3 in previously unchanged child intervals; first
header order remains h0/h1/h2/h3. actual source projection passed
`6aa5eb3757bf00d5`; only the shared corpus, its derivative and those two hashes
changed. expanded native replay is at `2b9a6d139d`.

the 21-case native corpus passed `d5a209efeeec64f3`. statement timing then
passed `53ad137e4db5b8bc`: overlap2000 spends 2.757s of 3.806s in scalar node
reads, 0.155s in node writes and 0.719s reducing unique ranges/opacity. the
constructor already batches all work in one transaction. cursor creation,
not absent transaction batching, was the measured dominant cost.

one query-private `SQLiteCursor` now copies each scalar node before rebinding
its arguments and calling checked `requery()`. it closes within the existing
transaction scope, before the database can retire. there is no new cache or
fallback after a failed requery. canonical `4508c4be3b1225e8` at `3918a6d26b`
passes all semantics. overlap1000/2000 reductions are 0.994/1.401s; node read
time falls to 0.214/0.369s. overlap2000's remaining unique/opacity work is
0.722s. source/scratch/node counts are unchanged. maximum source and device
qualification remain open.

the approved activation contract reserves exactly `.table-context.sqlite`
under the installed package owner, outside manifest member capability. a
nullable `table_index_sha256` on the existing package row records its exact
bytes atomically with activation; the original publication revision stays
unchanged. the existing streaming digest plus revision check owns validation;
no duplicate SQLite integrity policy is introduced. failed derived validation
permits rebuilding only from verified source and cannot authorize deleting
original source or progress. existing staging, atomic activation, reconciliation,
remove/purge and installed-size accounting own its lifetime. the price is
derived disk, local preparation wait and original/candidate overlap. sparse
source wire remains publication-owned and unfrozen; no derived file is yet
allowed by installed closure or exposed through `resolveEntry`.

nullable digest plumbing now covers fresh package rows, conversion updates and
the required internal package DTO. the unshipped v3 schema adds one nullable
column; supported v1/v2 rebuilds preserve every original field and initialize
only this new field to null. no task-only intermediate v3 migration is added.
correction (2026-09-14 adversarial review): that "still write null" statement is
no longer true and is retained here only so the record reads in order. both
producers emit `table_metadata_ref` — the hosted publisher at
`python/nexus/services/reader_publication_artifacts.py:542,549,782` and the
legacy converter at
`apps/android/app/src/main/java/app/nexus/android/offline/reading/OfflineReadingLegacyIndex.kt:167`
— and both native paths build and persist the derived index: the download path
at `OfflineReadingStore.kt:1245` inside `verifyDownloadedPackage`, and the
conversion path at `:926`. what remains open under oi-167 is the real legacy
table producer's canonical-boundary and activation acceptance, plus maximum
package expansion and device query capacity — not the wire.

the parent independently reviewed the database and activation owner additions:
the former restores the historical absent column, compares all old fields and
asserts the new null; the latter keeps original row/progress after commit failure,
asserts null after table-free conversion and checks installed size against actual
files. only those two reviewed coherent file pins were refreshed. initial
checkpoint setup receipts `d9279ac3e508489e` and `3236d276ab3b5d88` exposed its
old Python-only policy and missing class registrations. the already-proven
controller policy and exactly two current registrations were transferred;
no exception or source fault was removed. database conservation red/green now
passes `2607a3a1431662f0` at `690f3ba666`; activation replay follows there.

activation conservation also passes `ae324c4895965731` at `690f3ba666`;
both refreshed class pins now refer to actually replayed canonical faults.
source-size accounting for a future derived file will apply only to schema2:
recorded installed total minus manifest/member bytes gives its expected length,
which must be nonnegative and match actual bytes before digest verification.
legacy size semantics stay unchanged until conversion. no second size field is
needed. base `7fa89b88` declares database version 1; no production-v2 claim is made.

the expanded actual EPUB source recipe passes `7e3435900022a0fc` at 8,000 rows:
16,001 cells, 662,347 source/sanitized bytes, 16,001 canonical code points and
750,744 encoded schema1 reader bytes. source digest is
`c0f981d66089fe28871406600f67441d39f4873a817435255275255e27d7a217`;
reader digest is `eb23f6dc897c714fad8ec5dbd3eb07847b5d9a9b4ad75e2f4899c944605aa2d0`.
the next native run adds this exact geometry plus late-principal irrelevant row
headers, where the source predicate must reject a long preceding prefix. these
remain recipe-specific host observations, not a maximum-source or device claim.

expanded header canonical passes `31bf96457f77a5a8` at `5608675026`. actual
8,000-row overlap first page is 5.624s and complete drain 5.644s. prepared index
is 1,048,576 bytes; final/sampled main+journal scratch is 2,580,480 bytes.
coverage builds 15,999 nodes, reads 852,080, writes 382,368 and visits 237,200;
unique/processed spans are both 16,000, across 2,000 event bands. node reads
cost 1.624s and unique/opacity reduction 2.807s. the completed axis has 24,000
state rows. this rejects a final latency profile at only 750,744 encoded reader
bytes, despite the earlier reduction in repeated endpoint work.

late irrelevant row headers expose residual source predicate scans: first page
is 46.9/90.8ms at 65,536/262,144 cells, with zero decoded candidates and
49,152-byte scratch. prepared indices are 4,751,360/19,841,024 bytes. decoded
candidate counts do not claim physical index-page reads. sampled host HWM is
491,256KiB across prior cases/framework; it is not an isolated device bound.
red-stage numbers are preserved in the same receipt as non-verdict observations;
these values come from its passing candidate artifact. source maxima, temporary
files outside the sampled directory, repeated selection and actual device
qualification remain open.

predecessor/successor cursor replay passes `8403e63be75bbca7` at `7dbba0b272`
with the same 21-case corpus, literal differential cases and measured shapes.
8,000-row first page falls from 5.624s to 3.742s; unique/opacity work falls
from 2.807s to 0.864s. node reads remain 1.680s; scratch and operation counts
are unchanged. late irrelevant first pages are 28.2/96.7ms at 65,536/262,144
cells. the two cursors belong to the existing reduction use scopes; interval
methods copy all scalars before mutation and check every requery result.
strict predecessor coordinates use the exact integer equivalence
`low < boundary` = `low <= boundary - 1`, including boundary zero. no cache or
new lifetime was introduced. the representative fault only changed surrounding
method names; its lost-opacity mutation and failure oracle stay identical.

sparse wire review also records oi-165: the current native source-range
validator reparses its complete start unit per range. sparse per-cell metadata
must reuse already verified scalar unit identities/ranges or the staged index;
a bounded member size alone cannot bound repeated decode work.

2026-09-14: native sparse metadata source verification passed the original graph sensitivity `a7558c30501872e7` at `9d7f9affec`, using actual producer archives `825a36c68be5445b` / `b83cd1bbeaf94d15`. scalar unit-fact replacement also preserved graph `faae544c72a7292d` and epub default `e68ab0260ab85cef`. actual host jdk read-volume sensitivity `eba5f1fe64049569` at `ade76889a4` observed 256 ranges over a 139,796-byte unit: candidate 139,796 bytes in 2 events; restored per-range decode 35,927,572 bytes in 514 events; both report zero lost bytes. the preliminary `aff2e465d85714b0` was a compile-only failure because android's test compile classpath omits jdk.jfr; explicit public host reflection resolves that without a production dependency. oi165's repeated-read defect is resolved; maximum 4,096-entry scalar-map heap and device qualification remain part of the open capacity gate. oi167 retains the required real legacy table producer's canonical-boundary and activation acceptance. (corrected 2026-09-14: incoming derived preparation IS activated — `OfflineReadingStore.kt:1245` prepares and persists the derived index on the download path and `:926` on the conversion path; the earlier "not yet activated" wording was stale and misled one reviewer into filing a finding against the table wire.)

2026-09-14: explicit prepared-package staging now separates attested source from
its revision-bound private table index. original legacy activation sensitivity
passed `003502e6f9d6c54e` at `4317cdd928`. retained table preparation first reached
its intended unready-publication red in `47f0842e3ff717d8`, but the candidate retry
failed. diagnostic replay `e1c3546d871f1eee` exposes the actual failure:
`org.robolectric.shadows.ShadowLinux.open` reports `EIO` when android directory
fsync opens the candidate directory. the separately injected staging IOException
is observed first. these host proofs now use a narrowly shared host-filesystem
adapter with actual file fd.sync and directory FileChannel.force; production
AndroidOfflineReadingDurability is unchanged. this is no device durability claim.
preliminary `7312cc28b3e8247e` stopped at a test-only private scheduler import;
ingress now uses the actual existing scheduler. final retained and ingress
receipts remain pending; source-join negatives require named validation failures.

legacy table source projection is now a main-only draft in
`OfflineReadingLegacyTables.kt`: the existing source.sqlite owns int64 geometry,
column occupancy intervals, first source ids, scalar header kinds and ordered
explicit targets. expiry/free/downward indexes avoid rescanning prior row groups;
a colspan update holds at most 1,001 integer boundaries. no dense slot array or
all-cell association table is created. actual-html geometry/scalar tests and a
rowspan-zero loss fault are staged, not yet executed. unit contexts, canonical
source-boundary mapping, caption finalization and final metadata emission remain
required under oi-167. native's effective tbody projection is now coordinated
with publication's effective-tree normalization; no divergent rowgroup semantics
are accepted. the separately approved ordinary-layout slot trial is 8,192 and
remains unqualified; encoded byte fit alone cannot license operative spans.

retained table preparation canonical is green `33dab28b28d0e746` at `cd032c6012`.
the actual producer archive forms the private sqlite index; corrupted index bytes
plus an injected host durability failure preserve original member hashes, the
installed row, exact pending intent and canonical baseline as upgrade-required.
local retry under the existing authorization-required binding rebuilds and atomically
replaces the package, accounts every file once, reopens without another replacement,
and refuses the private filename through the real public entry lease. host fsync
and the intentional failure are distinct; android device durability and capacity
remain open. incoming publication and malformed source joins are the next canonical.

- incoming sparse-table preparation canonical passed `5b7cef176009c16f` at `cd032c6012`: actual archive prepare/publish/reopen plus named missing-target, duplicate-target, cell-span and table-count rejections. missing-target fault alone supplies the sensitivity witness. parent reviewed and approved exact preparation and ingress coherent pins after `33dab28b28d0e746` and this receipt: base lacks the prepared-package/store contract and cannot reach these retained invariants. host fsync evidence remains separate from android-device durability qualification.

- actual legacy html geometry/header staging canonical passed `d206e6f46f159866` at `299360435f`: deferred footer/source order, rowspan-zero, clamped spans and overlap, first source-id explicit data targets, and scalar header classification. source-sized sqlite staging never expands logical slots. this receipt predates source-unit composition and does not qualify its latency or activation.
- source-unit table composition is drafted at native checkpoint `34f3da2cdf`, canonical pending. raw crop no longer owns table atomicity; the unit owner keeps only fitting ordinary tables whole and bounds their summed trial layout charge by `max(1, rows) * max(1, columns) <= 8192`. excerpt structural tags receive the shared marker and lose operative span/header attributes. bounded crop node markers use the existing nfc source projection; caption references/hashes are finalized before the fragment checkpoint. the extra bounded node arrays, source-sized range rows, and final caption pass remain explicit capacity inputs.

- actual legacy table conversion canonical passed `b36bfbe2311d361d` at `91069774aa`: fitting whole-table preservation at the 65k boundary is sensitive to skipped atom expansion; candidate preserves caption/header semantics. a separate candidate case converts the 65,534-row/70k-text-cell source through exact unit/caption ranges, sparse metadata, source verification and derived preparation. only the superseded whole-table assertion moved out of raw-crop proof; its distant-read/source/anchor oracles remain. opening-only continuation and existing crop/unit replays follow. this does not qualify maximum source/device cost or interrupted table-specific activation.

- opening-only table continuation canonical passed `f73ce92b3d7246cc` at `dae0c05ee6`: the actual source tokenizer charges each element opening, so an empty first canonical crop still owns a prior cell excerpt. the fault removes that one structural position; the next text crop then fails the independently named continuation assertion. private `html_nodes.*_cp` coordinates are structural, distinct from canonical range offsets.

- raw-crop canonical replay passed `5cf156c6969b83ad` at `fb724be2b4` after the reviewed whole-table assertion moved to the sensitive actual producer owner. anchor and distant bounded-source assertions remain sensitive to the original duplicate-anchor fault. refreshed only this reviewed main coherent pin after green; base-inapplicability rationale is unchanged.

native canonical opening boundary follow-up (2026-09-14): publication's actual
archive red `14acf6a0990791b9` exposed a retained cell opening after a synthetic
separator beyond the preceding trimmed render end. native had the analogous
marker collapse. the actual 65,536-codepoint converter regression retains the
first structural unit key and expects the separator in its canonical suffix.
`9ca5f820fe3f6961` at `c98c1e450a` stopped in the faulted run because the new case
read an absent metadata ref without asserting its presence; the fitting-table
fault itself reached its named assertion. that fixture access is now guarded by
its required metadata assertion; `1882889c513854b5` at `05eadc2809` is active.

main now drafts one crop canonical projection using the already-open canonical
spool/current offset. bounded opened/closed bits distinguish real source events
from crop-created ancestry. pending whitespace origins settle against original
canonical whitespace before unit admission; no whole-fragment marker map is
introduced. direct canonical/boundary/continuation fixtures now supply real
utf16 spools. new independent boundary cases cover a newline expanding to two,
spaces removed by a later block, real closing boundaries, and a text-empty
opening after previous text. no new green or maximum/device claim yet.

recorded separately: `native-table-duplicate-cell-classification.md` describes
a unique-coordinate sqlite exception escaping the invalid-source verdict. its
actual re-attested archive variant and named assertion are staged; the source
translation is not yet changed, so a pre-fix observation remains required.

`1882889c513854b5` finalized with the exact unfixed separator assertion:
65,536 expected, 65,535 observed. corrected converter replay is green
`6cc6137b7275c99b` at `c39536b11c`, preserving fitting-table fault sensitivity
and original first-unit identity. this does not close the separate new
pending-space grapheme edge. main now includes pending-tail source origins in
the existing cut map and checks canonical end as well as render end. a new
actual converter regression keeps a space plus combining mark in one unit;
one astral prefix variant also exercises the opening marker's code-point
identity. the proof-only checkpoint `d3bdec36d5` is running before that last
correction is copied.

transferred native anchor verification has a separate staged correction:
replace the existing identity set with pending identity→canonical member key,
populate it in one bounded index prepass, and consume entries on the first
visible original id/name during the existing unit pass. no extra unit read,
all-source-id set, seen-state cache or new lifecycle. the explicit price is one
additional index decode per member; normalization maps and source-sized anchor
metadata remain part of final memory qualification. new canonical owner
`OfflineReaderPublicationAnchorTest.kt` and fault
`native-publication-anchor-first-identity-bypass` cover visible id/name,
multiple names on one element, hidden/aria-hidden subtrees, missing ids and a
later duplicate's wrong unit. these changes are not yet proved.

ordinary exact-gradle focus on the partial native checkout stopped before tests
as `fb73af8daffb93dd`: unrelated `ArtworkProvider.browser.test.tsx` is absent
from that selective snapshot's full routing inventory. the existing canonical
native path is being used instead; controller policy was not changed. run
`1fb34a503de50a6a` at `d3bdec36d5` is active and its faulted execution already
observed the new independent pending-space defect (`canonical suffix split a
whitespace grapheme`, trailing space incorrectly retained in the first unit).
the fitting-table fault does not alter this paragraph-only source. candidate
observation and correction replay remain outstanding.

original anchor visibility was independently confirmed by publication: any
hidden attribute (including until-found), exact lowercased aria-hidden=true
without trimming, inherited visibility, skipped script/style/noscript/template
local names, and namespace-null id/name across html/svg/mathml. native matches
that rule. existing preorder and embed-marker faults were context-rebased only,
preserving their mutations/oracles; new actual anchor owner is still unproved.

`1fb34a503de50a6a` finalized as an assertion-level candidate failure at
`d3bdec36d5`: `canonical suffix split a whitespace grapheme` observed the
trailing space in the first unit. this is independent of the fitting-table
injected fault. the exact same owner is replaying the tail-origin correction
at `00d2a4e6a3`; all snapshot fault patches apply and its existing native
coherent owner pins match. no new pin or maximum claim is made.

corrected actual table-unit owner is green `3e0a6b9f03eed27e` at
`00d2a4e6a3`. the same candidate now preserves the pending-space combining
grapheme, bmp/astral opening separator and exact first-unit source ranges;
the fitting-table mutation still reaches its original assertion. canonical,
boundary and structural-continuation replays remain required before new pins.

canonical normalization replay is green `3154976a9a82baa0` at `00d2a4e6a3`,
using actual canonical spools and the preserved nfc-bypass assertion. the
boundary mapping owner now follows at the same source identity.

boundary replay `f32caf85fcee3037` stopped at a new fixture assumption:
the expected anchor point was also used as expected crop end. for
`<p>A <span id="mark"></span></p><p>B</p>`, the original marker is 1,
while the same crop owns the real closing paragraph separator and ends at 2.
the proof now declares those independent expected values. original anchor and
source-coordinate oracles are unchanged; no production edit. replay runs at
`7477b0f8b8` before any pin update.

maximum-source follow-up is drafted in the existing legacy html owner. it writes
exactly 64 mib of encoded reader json incrementally, rather than calling 64 mib
of plaintext a valid reader. the actual package/prepared entrypoints run before
bounded one-node/sql-part, canonical stream hash, source preservation and byte
accounting assertions. host heap/owned-file observations are sampled at 100 ms
and stop before assertion rereads; linux process status is explicitly separate
from jvm-only observations on other hosts. no execution or device result yet.
new tickets distinguish maximum retained metadata (4,096 members is not an
anchor-record bound) and the source-derived indivisible-grapheme conflict.

boundary mapping replay is green `0870450a5ac7cc35` at `7477b0f8b8`.
all independent pending-whitespace cases pass; the original source-coordinate
fault still fails only its named boundary assertion. product bytes remain
`00d2a4e6a3`. structural opening-only continuation now replays at the same
coherent snapshot before pins and the next verifier/ingress snapshot.

structural continuation replay is green `e952b5bace006ca8` at `7477b0f8b8`.
only four reviewed projection owners now opt into the existing coherent-fault
mechanism: table units (`3e0a6b9f03eed27e`), canonical normalization
(`3154976a9a82baa0`), exact boundary mapping (`0870450a5ac7cc35`), and
opening-only continuation (`e952b5bace006ca8`). their exact current raw bytes
match the green native snapshot. each class is absent from base `7fa89b88`;
base cannot load these actual source/spool/converter owners to reach their
assertions. no old owner, patch mutation or expected fingerprint changed.

next native snapshot adds the first-visible original anchor verifier and its
actual archive owner, plus the uncorrected duplicate-cell ingress observation.
the native-only ingress coherent pin is temporarily absent because the proof
adds that still-unfixed source classification case; main's old pin is retained
until its corrected candidate earns a new receipt. every snapshot patch applies
and all other native owner digests match.

anchor run `7573380890ef7306` was blocked before tests by a registration gap:
the newly opted canonical normalization/boundary classes were not in the
canonical priority-risk map, including main. those two existing green owners
are now registered under source provenance beside the table-unit/continuation
owners; their exact source files are selected there too. snapshot `8d9bcd4771`
retries the unchanged anchor source/proof. all opted native classes now have
their canonical risk registration in main and the native snapshot. no frozen
ownership digest was changed.

first-visible retained anchor binding is canonical green `f2a2c02987623aba`
at `8d9bcd4771`. bypassing only the member check accepts a later duplicate's
unit and fails the named archive assertion. candidate also preserves visible
id/name, two distinct names on one element, hidden/aria-hidden source subtrees,
and rejection of absent ids. this closes the narrow source-identity defect;
maximum retained metadata memory remains separately ticketed. the pre-fix
duplicate-cell ingress classification now runs against the same snapshot.

pre-fix duplicate-cell ingress is assertion red `5a19528d82b137b3` at
`8d9bcd4771`: the actual malformed archive reached sqlite constraint failure,
but the named source-validity oracle requires illegal-argument rejection.
only the cell insert now translates its constraint exception to the exact
duplicate-coordinate source verdict; other sqlite, io and vm failures remain
resource failures. corrected canonical replay runs at `5d83625312`.

duplicate-cell ingress correction is canonical green `d7f9e20565cda371` at
`5d83625312`, following actual classification red `5a19528d82b137b3`.
the old missing-target fault still reaches its named source-join assertion.
this closes duplicate-coordinate classification; its separate pre-fix red is
the sensitivity witness for the new branch. the existing reviewed ingress
coherent pin now names these exact green class bytes.

final actual-table activation is canonical green `e46caec8eead21cc` at
`f6834f5aac`. the table and original paragraph scenarios retain exact original
rows/source/progress after the physical precommit failure, retry locally and
reopen the exact prepared publication; private index bytes remain excluded
from entry resolution and included in installed accounting. the reviewed
activation coherent pin now matches this green class. exact 64 mib encoded
source characterization runs next at the same snapshot.

exact encoded-source maximum is canonical green `9e65cb29ca5735e0` at
`f6834f5aac`. source sha `c6c9db4b559790bb66f379a22c3769e67ed14815ddca2dfb38f6bdd64e04cd99`
is exactly 67,108,864 bytes, containing 33,554,312 canonical code points.
candidate conversion took 64.386 s; preparation 1.028 ms. it produced 512 units,
515 members and 67,553,777 installed bytes. sampled heap rose from 113,641,216
to 345,894,256 bytes; sampled owned files peaked at 305,150,584 bytes. linux
process hwm was 775,100 kib and final rss 599,112 kib, including the host
framework. these are unqualified host observations, not a device budget or
universal unicode/grapheme acceptance. exact source/canonical preservation
and the original unicode source-substitution sensitivity both pass.

next aggregate graph profile writes 4,096 attested members incrementally and
measures retained source verification. 997,960 empty source elements expose
both id and name, giving 1,995,920 distinct original anchors across 21 fragments;
48,800 elements in each full fragment stay below the existing epub entry/book
limits. opaque ids are 44 ascii code points. encoded bytes must be 95–100% of
the aggregate bound before measurement. this is an independently constructed
accepted-wire profile, not an archive claimed to have been emitted by the
worker, and it does not qualify every legal source shape.

aggregate metadata canonical is green `104ba8ddd92809b8` at `674b4243c0`,
but its measured cost is unacceptable for native qualification: 4,096 members,
520,633,402 expanded bytes (521,274,549 installed), 1,995,920 anchors;
verification took 106.199 s and sampled heap rose from 87,916,448 to
503,188,280 bytes. linux hwm was 653,444 kib. manifest sha
`9afd1818b8c4e77c919b2363184fab4a5541d2b2276d2bd28bd83371f73b9d72`,
revision `876d06e579d55606bbebaca21bc89c68a10bd78921faf5ba7140d2671fda812a`.
the original first-visible-id fault remains sensitive. root approved replacing
the retained pending map with the existing preparation sqlite owner and replaying
this unchanged workload. no metadata-capacity closure or new anchor pin yet.

### native anchor preparation ownership cut (in progress)

the exact 4,096-member baseline `104ba8ddd92809b8` used 503,188,280 sampled
heap bytes for 1,995,920 anchors; this is unacceptable as native qualification.
production inventory: archive verification is consumed only by store preparation;
publication accepts only the prepared result. installed member verification is
consumed by reconciliation; open requires the exact installed row with prepared
readiness, and post-commit recovery rechecks that actual row. legacy and retained
conversion both enter the same preparation owner.

`verifiedofflinereadingmembers` now names the incomplete byte/member verdict.
the existing `.table-context.sqlite` transaction stages exact anchor identities,
consumes them on the first visible source occurrence in index-unit order, drops
the working table, then vacuums before hash/publication. format 2 plus exact
revision/digest is mandatory for every epub and table package. source-valid old
format/null-index packages rebuild; failures preserve source and pending progress.
non-epub anchors remain invalid under the current wire. this adds disk and
source-copy overlap, not a cache, extra database owner or lower source limit.

header run `b5e907341e8097d6` stopped at kotlin nested-sequence type inference;
no behavioral proof ran. explicit sequence types are staged. accidental identical
replay `c2d87cf6c2534ce3` was interrupted; corrected snapshot `905f5b7f52` is
running. no green or maximum/device claim from these setup receipts.

actual legacy html → sparse geometry/header query canonical is green
`da35b9ad3bb79af8` at `905f5b7f52`, including the independent effective-tbody,
source-order group and opaque-block corpus. the scope-loss fault reached its
named header-association assertion. kotlin type inference was the only setup
correction. this snapshot compiles the native graph before the pending sqlite
anchor cut; it is not a full native suite or maximum/device result.

anchor preparation snapshot `dcfaa2e645` is exactly `905f5b7f52` plus the
reviewed sqlite anchor cut, its actual preparation/max graph proof, duplicate-id
fixture row and four context-only fault rebases. pre-existing unreviewed main
word-boundary, storage-admission and progress-error deltas are excluded. canonical
first-id proof is queued under the shared heavy-work lock; no compilation or
candidate result yet. the graph is pinned to the original manifest/revision and
520,633,402 expanded bytes. physical-handset verification was explicitly waived
by the user; build/host qualification remains, with no device claim.

anchor replay `a824aa278f87e08e` at `dcfaa2e645` compiled and observed the
original first-visible-id assertion under the canonical fault. candidate small
identity/duplicate/missing cases and old-format/null-index readiness cases pass.
an epub with zero anchors requires 61,440 private index bytes for 4,037 source
bytes; the small anchored epub also requires 61,440 bytes. maximum measurement
did not start: moving the fixture from plain junit to robolectric changed its
manifest hash to `895dde4f5ea0221cd0772c41ea8911ca12d8f7e33be9e6d92b32173815671bd5`.
the original pinned graph remains the oracle. the baseline dependency is
`org.json:json:20250517`, jar sha
`3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796`.
its hash-map object order and conditional slash escaping differ from android's
insertion order and unconditional slash escaping. a fixture-only public
constructor adapter to that existing parent implementation is staged for review,
one bounded member at a time before measurement. no replacement hash, maximum
claim or coherent pin follows from this failed run.

root reviewed the exact serializer adapter and retained input oracles.
`c3f0e32cf8ce2c92` at `159b2f9aad` again reached the canonical first-id red;
its maximum case stopped in diagnostic logging because the instrumented android
class has no code-source URL. the JVM serializer loaded, but the full input
hash was not reached. the pending candidate replay was interrupted to correct
that diagnostic to explicit null; controller-owned runtime cleanup is being
completed through its prescribed `./scripts/test clean`. no product or oracle
change follows from this setup failure.

the prescribed isolated cleanup passed (`runs=0; runtime=absent`). corrected
anchor replay `bd88629aa9ca0584` at `48179353b7` is queued. native proof files
remain immutable during that command.

main's reviewed origin cut now supplies `retained` in the two direct legacy
test callers as well as the production conversion/reconciliation callers.
word-slice/hosted-null auxiliary audits and the separately reviewed distinct-range
fixture replay follow the anchor receipt; their proof pins are not refreshed.

root also reviewed the formerly unknown per-media progress isolation and
unrecognized-ack handling, but their algorithm-only callback assertions do not
prove storage conservation. two new cases in the existing lifecycle owner use
actual archives/store/sqlite and external origin responses. after reopening,
they compare exact pending/baseline/package rows, require a later independent
writer's commit, and preserve mismatched locator/source acknowledgments as
conflicts with the original intent. these cases are staged, not executed. storage
availability comments now state preflight observation rather than a reservation
or expansion bound. old native receipts do not attest these changed sources.

`bd88629aa9ca0584` red-stage artifact now confirms the original maximum
manifest/revision and 520,633,402 expanded bytes exactly. the real-anchor
comparison records both changed key order and slash escaping; the public
`json-20250517.jar` serializer restores the pinned source. the canonical
first-id assertion fails as required. this faulted-stage maximum case completes:
45.819 s member verification, 25.005 s copy/preparation/readiness; sampled heap
258,221,848 bytes, private index peak 179,613,696 bytes, journal 8,720 bytes,
final index 61,440 bytes. sampled vacuum-temp bytes are zero, which does not
establish their absence. the source/candidate plus sampled-private-disk upper
bound is 1,222,171,514 bytes. candidate remains pending; these are explicitly
non-verdict observations, not the final qualification or a pin basis.

canonical candidate passed `bd88629aa9ca0584` at `48179353b7`, retaining the
original first-visible-id sensitivity and every byte/count pin. candidate member
verification took 43.861 s; copy/preparation/readiness 24.047 s, total 67.908 s.
sampled heap peaked at 246,886,688 bytes (before 186,746,104), versus the
original 503,188,280-byte map profile. sampled private index/journal peaks were
179,613,696/8,720 bytes; final index 61,440 bytes. source/candidate plus sampled
private disk upper bound was 1,222,171,514 bytes. zero sampled vacuum-temp bytes
does not prove zero transient allocation. linux hwm 537,292 kib includes fixture
and robolectric; physical-device testing is waived and no device claim follows.
the original accepted-wire graph has 21 sections and exceeds the hosted epub
attribute count, so it neither qualifies maximum section metadata nor claims an
actual worker source recipe. final anchor pin review is pending; the reviewed
word/caller/fixture snapshot follows now.

root independently reviewed and approved six exact native pins. anchor
`3a4e45eed522bd0b6f44c4eb28ee0dd90b16ca15fc31cab8fc9b0be67fc4c604`
is canonical green above; base lacks its prepared-index interface and cannot
reach the first-visible-id oracle. since `dcfaa2e645`, its only changes are the
reviewed bounded fixture serializer and nullable diagnostic, with original
graph/hash/count assertions unchanged.

the other five approvals precede canonical replay: legacy index/contract only
add explicit retained-origin arguments (prior greens `e0a988e25c806440` /
`2020bdd26b480c84`); purge adds an external-origin refusal to its existing
no-network boundary (`afda7bc4888dbb56`); shared contract adds the three existing
schema1 corpus archive refusals, with precise unsupported-schema classification
(`bd8b9c469e0bb784`); database preserves its full v1 row/FK/null-field oracle
(`2607a3a1431662f0`) while dropping task-only v2 coverage. exact base `7fa89b88`
has database version1. version2 was introduced by task-owned native proof commit
`b9e83ef82c497f16cb330b17bbd63adb9f7c6276`, which descends from base and is
contained only in the native proof branch; no release was authorized. current
supported upgrade is v1→v3, not a historical production-v2 migration. earlier
v1/v2 observations describe that unreleased experiment only. each refreshed
pin preserves its original canonical product fault and independent oracle;
these reviews do not substitute new execution receipts.

reviewed word/origin and exact source fixture snapshot is `0fee34cdcf`.
auxiliary overvalidation audit is running from `a64d055e24`; the exact canonical
preorder row and patch are saved for restoration. initial setup receipts
`8d3baf4487c0bbc9` / `6bce2730604bebe8` ran no assertions: the selective
snapshot lacked the already-existing purge canonical registration, then retained
the unregistered canonical patch beside its temporary replacement. both isolated
inventory mistakes are corrected; no product, oracle, or main registry change.

word overvalidation audit `a9fc6f18e36e29c6` reached the two intended named
assertions (empty original slice and unchanged actual table members). two older
positive cases also rejected their valid word slices with raw package exceptions,
so the controller refused mixed assertion/execution failures. root reviewed the
narrow correction: only those typed package refusals become acceptance assertions
with their original causes; other exceptions still propagate. original fault
breadth and all source/hash/render/offset assertions remain. replay is from
`df67f022c1`.

word-slice auxiliary sensitivity is green `87bdfdf09a940a3a` at `df67f022c1`.
the original nonempty/endpoint overvalidation rejects both the independently
specified interior slice and unchanged actual table members; the candidate
accepts them. the downloaded-null auxiliary is running from `13bb17a13f`.
these are isolated audits under the existing verifier owner; its canonical
preorder fault will be restored and replayed afterward.

downloaded-null auxiliary sensitivity is green `fb24cd882f6dc595` at
`13bb17a13f`: bypassing the origin guard fails the named hosted-metadata
assertion, while the candidate admits the same bytes only as retained local
conversion. both temporary word patches are now retired from the active native
snapshot, and its exact original preorder row/patch are restored. canonical
preorder replay follows; no main auxiliary fault or new proof owner was added.

restored canonical preorder is green `5fd3129c60a0e320` at `dba7e40d85`.
the original row and patch are byte-identical to the saved canonical definition.
final verifier owner sha256 is
`98e9f7ced0e25c4ac9d6b5c01327f40932672edcf96baa6ae2f0395bf7c218a2`.
word overvalidation is resolved: removed its ticket/register entry, with the two
independent word auxiliaries and current canonical receipt above. ordered unique
in-range slices remain required; downloaded null is refused and retained local
null stays explicit. no producer bytes or source limits changed. coherent pin
review is pending; range-read replay is now running at `699b0ff649`.

range-read canonical is green `e509f4ce9c66d74f` at `699b0ff649`. final
owner sha256 is `c69264d82fe80801be208db3281ab050b160fe04fc01838f2242aed9fb4509d5`.
all 256 distinct nonempty ranges retain matching canonical/render source text,
and the original input-member bound remains alongside the JFR byte-volume,
positive-coverage and zero-data-loss assertions. removed the resolved fixture
mismatch ticket/register entry. no expected read outcome was refreshed.

root reviewed both final verifier/range diffs and approved explicit coherent
opt-ins after `5fd3129c60a0e320` / `e509f4ce9c66d74f`. both owners are absent
at base `7fa89b88`, whose pre-schema2/prepared interfaces cannot reach the
preserved assertions. staged only the two reviewed exact owner hashes on their
original canonical product faults; word auxiliary evidence remains separately
scoped. publication's concurrent caption row and every prior pin are preserved.

actual indivisible-source candidate red `0855e169907e194d` at `f5ff26e56b`:
262,390 encoded reader bytes, sha256
`7b64a2ca72dcb5534956488464f80fbaf0c9538f604e5f02deb626bbc98bafa8`, contain
one ICU-confirmed 65,537-code-point grapheme. source staging preserves exact
canonical bytes; conversion rejects `canonical grapheme exceeds publication
capacity`. the same candidate passes the original 64 mib ascii case. original
html-substitution red remains separate; this is a real candidate representation
failure, not a passing capacity proof. restored the temporary added html case
at `52c3114d64`; immutable audit source/artifacts remain. the representation
ticket remains open, with no changed source limit or grapheme semantics.

### indivisible atom comparison and actual http classification red

`reader-indivisible-atom-options.md` records the reviewed source envelopes and
whole-unit versus storage-paging comparison. publication and client agree the
corrected q+u+0344 epub witness approaches 48 mib raw-render plus canonical text
and 528 mib under current 11× transient admission. this is a derived witness
charge, not an actual allocated unit or universal peak. storage paging leaves
continuous shaping/selection allocation unresolved. no cap or wire changed.

actual http pre-fix receipt `cef05c4358410726` at `1d0db9aff1` reaches three
assertion failures: malformed successful json is modeled Network, cookie storage
IOException is modeled transport loss, and bundle minimum zero binds. the
modeled transport/owned-http outcome case passes. candidate `bb0105224a` narrows
translation to execute/body-read IOException, leaves completed parsing and cookie
installation outside, narrows unsuccessful gateway parse fallback, and requires a
positive usable minimum. its original download-generation canonical replay is
pending; preparation-age and attestation need their separate sensitivity.

http candidate canonical is green `c519411148257963` at `bb0105224a`.
malformed successful json/utf-8 and attestation defects propagate; cookie
persistence remains an IOException; the actual truncated response is Network.
owned status/error outcomes, unsuccessful raw-gateway fallback and all five
account-bundle vectors pass. the original generation-substitution fault remains
sensitive. isolated expiry audit is running at `b8d1b3eccf`; its replacement row
is confined to the native proof checkout, with the exact canonical saved for
restoration. no main fault or proof pin was changed.

expiry auxiliary is green `f63403947d09106b` at `b8d1b3eccf`: removing only
the guard continues origin observation after the deadline and produces the wrong
modeled outcome. account-schema auxiliary is green `9a79ae9a464f7e7a` at
`9717343c24`: bypassing schema equality binds an unusable package and fails the
named refusal assertion. restored the exact original origin row/patch at
`fe10ec8bb2`; these auxiliaries never entered main metadata. the reviewed real
sqlite progress source/tests are now in native proof; first durable isolation
audit runs `22763a53f4`.

first durable-progress audit `c54e44381fc95081` reached its intended assertion,
but the unchanged system-stop scenario also exposed a real preparation race:
stop removes staging while verified byte work is held; the new descriptor read
then throws a zero-length contract failure. recorded the separate retirement
ticket. the fix captures the destination under the monitor, brackets file work
with exact binding/transfer/transition authority, distinguishes missing files
with `Files.size`, and fences only retired FileNotFoundException or
NoSuchFileException (including their known archive wrapper). other IO, parsing,
invariant and SQLite failures remain failures. extractor/download writes cannot
recreate missing account ancestry. no new cancellation owner.

replay `5463894a99f9bab4` passes the old system-stop case. my added durability
case then hit a fixture assumption: scheduler-queued work need not be immediately
runnable. changed that assertion to the actual persisted staging-name rotation.
added begin-only account transition alongside stop and purge; successful physical
durability must still yield no prepared publication, and the Logout transition
must remain. live zero-byte member damage remains IllegalArgumentException.
`f3667d2ac2` is now replaying the same durable-progress fault. main's preparation
fixture has one explicit binding-parent mkdir for the stricter owner-created-root
contract; its reviewed pin awaits a new canonical replay.


durable per-media isolation is green `80fd551e1850b63a` at `f3667d2ac2`.
the injected whole-pass abort fails only the named real sqlite isolation case;
the candidate preserves the exact failed writer's source/pending/baseline rows
and commits the later writer. all 35 candidate lifecycle cases pass, including
held verification, actual prepared-directory stop/purge/begin-transition, and
live zero-byte contract damage. wrong-ack and post-durability retirement each
still require their distinct auxiliary, followed by canonical restoration.
new heavy runs are paused while the shared host has less than one gib free.

preparation fixture's explicit live binding-parent creation changes only one
line; current owner sha256 is
`c7c36ea1521456e7497ea24486a92025353e8c2dd6ed6547fdf5c9b24879dae9`.
root has the exact delta for review. its canonical coherent fields stay in place;
reviewed source pinning and successful execution remain separate claims.

root independently reviewed and approved the exact final http owner
`57e5cc3fb3c3a22807817576d872ef6e12cfcb35a620f30ee5c7da6b0e2bf5d5` and
the one-line preparation fixture parent creation
`c7c36ea1521456e7497ea24486a92025353e8c2dd6ed6547fdf5c9b24879dae9`.
staged only their canonical coherent pins. original http fault and both separate
auxiliaries are green above; preparation's unchanged fault still awaits replay.
base lacks the prepared-package/derived-index and current schema2 origin
constructor contracts required to reach these preserved assertions. the pin
records reviewed source identity, not a claim of unexecuted green behavior.

preparation canonical is green `8921c76c6d3ed91b` at `fd3a340d9d`, with
the reviewed `c7c36ea...` fixture bytes and unchanged unready-publication fault.
the single fixture-owned parent creation preserves actual archive, failed
durability, upgrade-required, local retry and exact source/progress oracles.
root retired the exact abandoned `vc_i737t` audit through its controller clean;
original receipt `c3f0e32cf8ce2c92`, red artifacts and commit remain retained.
the shared host disk hold is released; wrong-ack sqlite audit follows.

wrong-ack durable sqlite auxiliary is green `c0aad7258a56c817` at
`166daeb22d`. bypassing exact accepted-cursor equality loses the persisted
conflict and fails its named assertion. the candidate reopens with original
pending source/locator and package rows, retaining the attested baseline as
Conflict for both cursor and source mismatches. generation fencing remains
unchanged in that fault. the separate final prepared-publication guard audit
follows; original canonical row/patch remain saved for exact restoration.

root independently verified the exact maximum-atom source and canonical hashes
and approved its diagnostic boundary. manual file-backed ICU traversal adds
measurement work; stage timings and host samples must state that cost. the
experimental case will not replace the canonical html owner or count permanent
unit rejection as support. no main source/test or admission cap changed.

resolved the native progress HTTP classification ticket/register entry. actual
controlled HTTP canonical `c519411148257963` and independent expiry/account
auxiliaries establish the transport/protocol boundary; real sqlite auxiliaries
`80fd551e1850b63a` and `c0aad7258a56c817` establish exact pending/source
preservation, persisted conflict and continuation of other writers. these are
composed boundaries, not an additional HTTP-through-SQL journey receipt. final
canonical lifecycle replay remains required after retirement sensitivity.

final retirement guard audit is queued at `6c5ee6a56d` against
`native-transfer-retired-prepared-publication`. it removes only the final
`isCurrent()` publication check; begin-only transition with successful physical
durability must falsify it. main remains on the canonical fault registry.
maximum-atom diagnostic source is prepared separately in
`/tmp/OfflineReadingLegacyHtmlTest.kt.maximum-atom`, with the reviewed exact
source hashes in the option comparison. it has not executed or replaced main's
ordinary html owner. raster remains ordinary and unexecuted.

retirement auxiliary is green `6fc6200ef7e02061` at `6c5ee6a56d`.
removing only the final publication identity check fails the actual
prepared-directory case during a begin-only account transition with successful
physical durability. all 35 candidate lifecycle cases pass, including original
held-verifier system stop, missing-file retirement and live zero-byte damage.
the prepared result never escapes retired authority; the filesystem work stays
outside the store monitor. this resolves the preparation-retirement ticket.
the original canonical lifecycle row/patch is restored exactly at `c0b2c39a3c`;
its final canonical replay remains pending.

maximum-atom diagnostic is running at isolated `f254aca819`; experimental
html owner sha256 is
`dc4975bdd825146f8a8cca552cb3e6f74e4025ecf8f9646aa7b0068b769cd2f8`.
the original ordinary owner is preserved for restoration. source and canonical
hashes remain root's independently verified 64 mib recipe; sampler cleanup
retires its executor before asserting observer health. no admission cap or
main test changed. the five separately discovered main-only native deltas are
excluded from this exact snapshot and await independent disposition.

maximum-atom candidate is red `312e8d38541cb232` at `f254aca819`.
the exact 67,108,864-byte source (`d509331c...`) is admitted unchanged;
44,739,081 canonical bytes / 22,369,541 code points (`70fa54c3...`) and
one ICU grapheme are verified. cumulative stage times are source 1.1905 s,
html 1.9564 s and fixed-width spool plus diagnostic ICU 2.5554 s. publication
then rejects `canonical grapheme exceeds publication capacity` at 5.0763 s;
derived preparation never starts. sampled heap is 188,829,800 bytes from an
88,687,656-byte baseline, owned files 202,333,325 bytes and JVM VmHWM
497,916 KiB. these are observations through rejection, not complete-unit or
browser capacity. the unchanged 64 mib ASCII case passes 512 units / 515
members; original source substitution also reaches its separate named red.
ordinary html source is restored exactly at `aa1aa809fe`; the experimental
owner and retained diagnostics remain in the immutable audit commit/receipt.

root independently approved the three scratch-retirement diffs: completed
fragments retry spool unlink, the new units scenario restores the exact spool
at a real committed checkpoint and rebuilds an orphaned table candidate, and
the unchanged maximum HTML projection assertions run before scratch retirement.
updated only the existing units coherent pin to reviewed owner
`9cc0d5250f86e8fd334c8e8fd14c7a07159440b9be2cbf41576e78559488a55f`.
its original canonical fault remains; actual unlink sensitivity and source
replays are still pending. the HTML case retains all existing limits and final
original/published hashes inside its measured conversion region.

also registered the existing lifecycle owner's two missing-discriminator
refusals with `native-progress-missing-kind-defect`, restoring only the two
original `Map.getValue` calls. its source/proof delta is independently reviewed;
no coherent exception or successful execution is claimed yet. installed-access
strengthening retains the actual chmod stimulus and original row/source checks;
its omitted `assertFalse` import is corrected before replay.

original lifecycle canonical passes `f005f6ef84910801` at `aa1aa809fe`.
the unchanged corruption fault fails only the named durable pending-intent
oracle; all 35 candidate lifecycle cases pass. this completes canonical replay
after the separate per-media, wrong-ack and final-retirement auxiliaries. exact
owner remains `c4e1b7946a25c1e96056725985ed88e96b5b5ab7fe602851697de7dd8b043923`.
scratch cleanup and the newly reviewed standalone malformed-kind/access changes
are excluded from that receipt.

ordinary public raster characterization is running at `750b36dda4` through
`./scripts/test changed` with its exact Gradle owner. copied only the test,
independently encoded fixture (`69305246...`) and its fixture-manifest row.
no new priority owner, device run or decoder-allocation claim accompanies it.

root reread the final store-lifecycle proof from `dcfaa2e645` through
`f3667d2ac2` and approved its coherent opt-in at exact owner `c4e1b794...`.
the main canonical row now pins those reviewed bytes after durable isolation
`80fd551e1850b63a`, wrong-ack `c0aad7258a56c817`, retirement
`6fc6200ef7e02061` and original canonical `f005f6ef84910801`. base lacks
the prepared-package interface required to reach these retained assertions.
the original corruption patch remains the sole registered fault for this owner.

root reviewed the added scratch case’s caption-owner correction: published text
is concatenated across ordered units, and the independent caption extent 11..18
is resolved through its exact owning unit. the proof no longer assumes the first
unit contains the table or caption. refreshed only the units canonical pin to
`e89f0f163e8ba651cff6b2eae4beb38242fd817d19910e48dd0b098e131f43b6`;
source identity/hash and original canonical fault remain unchanged. execution
is pending; the earlier raster workflow deferred android-host and supplies no
native decoder evidence.

root independently reviewed the lifecycle owner’s additional timeout-vector
change against native `a554382764`: the retired package-timeout envelope is
replaced by actual 503 `E_READ_CAPACITY`, preserving busy/content-conflict
assertions and the existing 5xx Server classification. final main lifecycle
owner is `b804e7ca3123b6f46f4697f4ca5fc904505d45da7b6f31dcb56a61311c4000d9`;
the reviewed missing-kind scenario is unchanged. focused execution is pending.

root reviewed all newly found native deltas against `a554382764`. removed the
unsolicited storage-specific availability/set and only its added web wire/copy/
shelf case. the existing exact-row readiness owner, UpgradeRequired outcome and
durable preflight/source/progress oracle remain; StoreLifecycle is byte-identical
to reviewed `c4e1b794...` again. removed both newly introduced NoSuchElementException
catches: strict JSONObject accessors and the corrected progress kind reader
already classify malformed input locally. durable missing invariants keep their
existing defect route. the two review tickets/register entries are retired by
these source removals, without a new execution claim.

preserved reviewed shared clock wiring, preparation-status comment, owned schema
constants and playback header error precision. device source now resolves the
actual descriptor first-unit key and fails its SDK precondition explicitly; no
handset run is claimed. exact main changes/hashes are retained in
`/tmp/native-reviewed-disposition.diff` and
`/tmp/native-reviewed-disposition-shas.json`; active native proof is untouched.

units canonical replay passes `a78356f4cd4de579` at `a554382764`, including
committed-spool restoration and orphaned table publication rebuild. owner
`e89f0f16...` retains the original canonical fault and exact source/locator
oracles. the separate spool-unlink auxiliary `e342d11a4be2fe8a` did not run
android: its isolated offline environment lacked pydantic-core 2.41.5. restored
the exact canonical row/patch; hydrating the unchanged locked dependencies through
the existing agency setup recipe before replay. no auxiliary evidence claimed.

root reviewed and approved deferred-resource correction `9c06cd1f...`; after
main hold release removed only the unadmitted original-resource helper, its
memberAssetUrl seam and three body calls. raw deferred resources remain. final
publicationDom/session/body hashes are `32ccc835...` / `ff42eac0...` /
`4cb9013a...`. figure support remains incomplete; removing unbudgeted URLs does
not satisfy raster/vector rendering acceptance. the shared raster contract and
implementation candidate remain outside the checkout for independent review.

spool-retirement auxiliary passes `c09529dd5b4f3bcd` at `f47e2e7930`,
then exact canonical row/patch restored at `4a452bd6d0`. the reviewed native
inventory changed in main before import; the guard preserved those unknown
capacity/conversion-policy diffs and imported none. reconstructed every earlier
reviewed file byte-for-byte from preserved diffs; codec proof now runs at
`d10e5e068f`. setup-only dirty preflight `8a53d974f851cb0a` is not behavioral
evidence. the review-gap ticket records the four new source identities.

missing-kind canonical `30f5e1a7e298db6d` passes at `d10e5e068f`: restored
Map.getValue fault fails at the named IllegalStateException/NoSuchElementException
assertion, then exact reviewed lifecycle owner `b804e7ca...` passes. main's later
capacity-policy edits changed that owner again, so this is not evidence for
those bytes and no main coherent pin was refreshed. installed-access canonical
is next on this same reviewed snapshot. current remaining implementation/proof
list is retained at `/tmp/native-current-acceptance-20260914.txt`; no full native,
raster, table-query or max-atom support claim follows from these focused greens.

installed-access canonical `a858f54393a9dfff` passes at `d10e5e068f`, exact
reviewed owner `5a828478...`. the permission stimulus is asserted, original
bytes/row survive, unreadable work is not Ready, and permission restoration
allows reopening. its unchanged corruption fault fails at original deletion.
all 18 later main deltas now have independent classifications in the existing
native review-gap ticket; none was imported. html64mib canonical replay runs
on the reviewed snapshot; one-row cursor and ordinary-artwork proxy drafts
remain outside both checkouts.


2026-09-14 reviewed native replay: original 64-mib html canonical proof
`fb73e1148c5b88a6` passes at `d10e5e068f`, owner `ebcf58ef...`. source-size,
canonical and manifest oracles remain unchanged after scratch cleanup.
subsequent keyset/artwork snapshot `2b58be55b5` stopped before android in
`ccb91bffcbb0124b`: two legacy fault contexts still had the old loop indentation.
only those contexts were rebased (original canonical-text and URL mutations,
owner pins and assertion fingerprints preserved); all fault patches apply at
`06d85d87dd`. canonical units replay remains pending. no main source changes
were imported or reverted for these checks.


keyset original canonical `0a3dc98d6a8249f6` is green at `06d85d87dd`:
original newline-to-space mutation fails the canonical-text assertion and both
candidate cases pass. the one-row fragment walk is now exercised with the
original resume/caption/source oracles. reviewed artwork controlled-upstream
owner `229f6672...` is staged only in native proof `b3ce533d16`; its reconnect
canonical and direct-source auxiliary remain pending. no green claim includes
the unactivated conversion-refusal draft or concurrent reviewer policy changes.

conversion-refusal candidate lives outside the checkout under
`/tmp/native-conversion-refusal-draft`, with exact baseline/candidate inventory.
root independently reviewed the local full-grapheme fact, one nullable row
reason, explicit retry callback reuse, closed readiness, snapshot-free failure
outcome, precise resource errno handling and callback completion isolation.
actual-source, sqlite recovery and held-durability proofs are drafted, not run.
this limits repeated known conversion failure; it does not make the accepted
maximum atom readable. the separate job ready-fast-path entry remains ticketed.


artwork canonical `3dd7d33e512346e0` is green at `b3ce533d16`, owner
`229f6672393fd5d40e0f9ec48da3f07d3b4a28dbea39f3ddac01bdcf1d0a707b`.
actual android red reaches the original reconnect-future assertion; candidate
cases include ordinary and preview HTTP authority, decoded pixels and playing
media identity. direct-source auxiliary is running at `49ed66abbe`; its
product-only URL substitution does not change cookie or client handling.
root merged the exact green keyset source `d77d5a47...` and two context-only
fault updates into main after reviewing patch `2d17293c...`. the other reviewer
conversion policy remains intact pending replacement candidate evidence.

job ready-inspection repair is a separate two-file draft under
`/tmp/native-reconcile-job-entry-draft`, based on approved store `c2d5cb81...`.
it retains the shortcut and existing running/callback ownership, moves sqlite
inspection onto the existing executor and reports failure without a snapshot.
its actual prepared-store unreadability/recovery proof is pending review and
execution; no new host or full-native acceptance follows from this draft.


artwork direct-source audit `a0c1a26c63550a55` at `49ed66abbe` is terminal
FAIL. its retained complete junit class has four actual AssertionErrors,
including ordinary owned-origin expected 1 / observed 0, but the controller
misclassifies the old-account coroutine assertion: its stack contains only
`NexusArtworkTest$...` compiled closure frames, while the classifier requires
`NexusArtworkTest.`. candidate execution did not run. exact canonical fault
row and patch restored at `54c3e1f7f4` (manifest sha
`ecc3a04724fa4185ee3ea79b78df7700c92aa2de68839e511a636becb4e3a86e`).
root records this controller gap as oi-213. reviewed two-file correction lives
under `/tmp/native-junit-nested-draft`; proof-only exact kernel replay runs
against the old classifier first. neither the failed controller result nor
source review earns an artwork auxiliary green.


classifier repair has independent old-source reds `5a51e29413fd9eee` (owned
Kotlin closure rejected) and `308e6e171b378cbd` (arbitrary message-only class
mention accepted). unchanged ten-case kernel is green `1bbbbb48828d26d3`;
reviewed exact at-frame delimiter correction committed in native `51c939aa05`.
minimal main reconciliation patch `1b5dd7f5...` preserves concurrent controller
edits. actual artwork direct-source auxiliary now replays at `87fd1c9b4b`;
its canonical row must again be restored after terminal. native product source
and the approved refusal draft remain unchanged pending this replay.


artwork direct-source auxiliary `46629af11920478a` is green at `87fd1c9b4b`:
the actual owned HTTP/image/media assertions fail under the direct-source
product mutation, then all candidate cases pass. canonical row and patch are
restored in native `e3f300d72c`, manifest sha `ecc3a04724fa4185ee3ea79b78df7700c92aa2de68839e511a636becb4e3a86e`.
root integrated the reviewed artwork `332a3470...`, owner `229f6672...` and
exact classifier correction into main; combined classifier/residency receipt
`f201bcf4256aa8b1` passes at main-equivalent `b65d7341`. this does not activate
reader raster resources or qualify native decoder maxima.

reviewed eleven-file refusal candidate is now native snapshot `7c21ebb5ae`,
with final store `3a850828...`, activation owner `7268cf0b...`, and exact source
inventory `/tmp/native-conversion-refusal-final-inventory.json`. all 164
registered patches apply. the unready-table fault was adapted, independently
reviewed, from old boolean true to closed Prepared in the same branch;
sha `08916c26abd25f4acf2aa3814a55d2f3c3e3b13048df9feab188dfb1522eb03e`.
original activation canonical is running; seven separate reviewed auxiliary
witnesses remain pending. main still preserves the reviewer conversion policy
until this replacement has actual evidence and selective reconciliation.

oi-214 held-worker proof and AnyIO scope correction are draft-only under
`/tmp/read-deadline-scope-draft`; existing cancellation and stalled-send
proofs remain unchanged. oi-215 completed route TimeoutError rethrow is in
the same draft, but no same-loop spin probe was launched. its distinct
external-process behavioral oracle remains required.


native refusal canonical attempt `2c96d3fcd3993f73` is terminal FAIL at
`7c21ebb5ae`. the original pending-deletion mutation reaches its named
AssertionError, but three new durable-row comparisons first hit the helper's
`check(moveToFirst())`, producing IllegalStateException and correctly blocking
the all-assertion sensitivity verdict. the proof-only row-presence assertion
correction is independently reviewed; no candidate run or green follows yet.

web deadline pre-fix run `7b9fcecb0a209f5f` at `f075c680ed` fails the selected
case, but retained log truncation loses the primary assertion. no exact red
fingerprint is claimed. the evidence-retention gap is separately ticketed in
`controller-service-tail-loses-primary-assertion.md`. the separate original
route-timeout child proof now runs at `81d73cc4ab`; its new subprocess/sys
support imports have the independently reviewed cancellation-owner digest
`9b9e0ea16c6cac36671613ecba1e163ad7cbf7aa4484a43a376ab03a5a70b8c0`.


refusal canonical `92e121d1acc36da9` is green at `89b96c0f96`, activation
owner `4bc026d3df920cf86f8010feb993649b169868a87036652d7954d9feb3cb1a71`.
original pending-row loss fails as an owned assertion; every candidate case
passes. the first of seven separately reviewed product-fault auxiliaries now
runs; none of their distinct sensitivity claims is inferred from this canonical.

original route-timeout child proof has an exact old-source red
`4d9b14e7a928a02b` at `81d73cc4ab`: after entering the actual admitted ASGI
route, its event loop fails to settle and the parent stops/waits that child.
original exception identity and following request acceptance remain candidate
oracles. revised held-worker proof `16d948e0...` separately preserves its
observation before physical cleanup; old-source replay is running.
