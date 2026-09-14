# bounded workspace publication progress

> 2026-09-14 pause: historical document; implementation is stopped.
> the [evidence audit](bounded-workspace-evidence-audit.md) distinguishes findings,
> decisions and unverified claims. the [replacement plan](production-crash-replacement-plan.md)
> supersedes this execution scope and awaits user review.

status: implementation in progress; no deployment.
origin: 2026-09-13; branch `codex/bounded-workspace`.
owner: publication/backend council workstream; contract is
[bounded workspace implementation](bounded-workspace-implementation.md).

## cursor provenance

- preserve source generation beside positioned locators; unknown historical
  provenance remains explicit, never inferred from the current publication.
- reuse the account-bound generation/cursor transaction for hosted and native
  reading. timelines use a null publication generation through the same route.
- preserve compare-and-swap, tombstones, account fencing and conditional equality
  acknowledgment; equality includes source and locator.
- shared wire: existing `/media/{id}/offline-reader-state`; outer camel-case
  `accountId`, `readerGeneration`, `cursor`; positioned `source` is publication
  (`kind: Publication`, `reader_generation`), timeline, or unresolved.

source preservation failed before implementation at its behavioral assertion:
`test-results/runs/bfd67204fc79ba27/summary.json`. corrected service/account proofs
passed in `42d1e1fe565fde15`; timeline, migration and existing cursor-cas proofs
passed in `928f3b3ea1a2faae`. these are local production-shaped postgres proofs,
not deployed or native compatibility evidence.

the source-provenance proof now has a separate canonical owner and reuses the
existing committed publication fixture. affected fault patches follow the renamed
service. exact changed-owner proofs use the repository's coherent-fault mechanism:
the old artifact lacks the renamed schema/service and cannot reach their assertions.
their product-only faults and exact proof/support hashes are recorded. extracted
canonical source/account/migration proofs pass in `95025ea0f5f045ca`.
fault runs `b44b8008c8fe390d` and `0a0777a4e78a812b` stop before execution:
`sensitivity requires a clean committed checkout`. rerun on the clean candidate;
no dirty-worktree bypass or commit was made. this is the whole of the cursor
provenance contract's sensitivity evidence, and it is empty: `reader-cursor-source-ack-bypass`
and `reader-cursor-source-migration-invention` have never executed anywhere under
`test-results/runs`, so gate c's source-equality and migration-non-invention
invariants are green-only. both faults are coherent and their owner pins are
intact, but a pin is not a red. tracked as its own ticket.

release checkpoint: native's `OfflineReaderStateValidator.kt:35` requires exactly
state/revision/locator and rejects the new source field. updated native decoding
must precede the first cursor schema/api release, not merely package v2 production.

## publication work

0229 and models now define ready-only retained members and frozen unit/target
projections. the preparation owner writes and verifies content-addressed bytes
under existing durable cleanup reservations, then installs references with an
expected-old generation fence. published-object cleanup retains historical refs;
explicit media deletion enumerates and removes every generation. publisher seams,
splitter, backfill and routes are still incomplete; no reader switches yet.

required refinements: zero-text image units use fragment/extent/part, with part a
stable content-order discriminator for equal extents. render bounds may identify
only leading/trailing separator gaps while preserving exact original canonical
text and requested locator coordinates. these need adversarial split fixtures.

runtime qualification owns numeric limits; no production defaults were invented.
units bound encoded bytes, canonical code points and DOM nodes. descriptors and
index pages have separate encoded limits. these are capacity inputs, not a claim
of measured supported envelopes.

history now uses `post /nexus/history/query`; only requested targets are scored
and PostgreSQL returns five distinct recents. the semantic target bound is 95:
20 openables + 40 owned results + 12 panes + 18 destinations + 5 recents. this is
the complete displayed candidate union, not a supported-history ceiling. the
manifested cross-language fixture records that derivation. byte qualification
and current new-history behavioral receipts remain required.

the approved publication contract uses natural composite primary keys. this is a
narrow override of the shared opaque-id convention: immutable media/generation/member
identity is already complete and another generated id would provide no correctness
benefit. foreign keys remain explicit and non-cascading.
immutable index pages use format-owned byte bounds and an opaque continuation member
key. tradeoff: callers cannot choose arbitrary page sizes. this avoids runtime
repacking or a second metadata projection solely for pagination. generation-pinned
members return their raw verified bytes; mutable queries retain normal envelopes.

## search admission is not arbitrated — it is open

`python/nexus/api/routes/search.py:31` puts the search router on
`AdmittedReadRoute`, drawing on the shared foreground JSON read pool, while the
spec's d clause "investigate the recorded search timeout with its real query
plan" (oi-083) was not done: `python/nexus/services/search/` is untouched and the
ticket is still open. `ReadAdmission.serve` holds its slot for the whole ASGI
call and `DATABASE_STATEMENT_TIMEOUT_MS` is 30000, so a pathological search now
occupies a reader slot for up to 30 s and concurrent ones can answer reader
units, index, evidence and document-map reads with `503`. admission converted an
isolated latency defect into a shared-availability one. this is recorded as open
rather than arbitrated: nobody chose it.

## recorded arbitrations — 2026-09-14 adversarial review

these were already implemented; the review found them undocumented, which is what
made them deviations rather than decisions. they are recorded here, next to the
other narrow overrides, in the form the contract table's value depends on.

- **the evidence page stays `post`, against the contract's `get`.** the spec's d
  section names `get /reader-publications/{g}/evidence` with bounded
  `after/limit`. the route is
  `python/nexus/api/routes/reader_publications.py:85` `@reads.post`, and its
  siblings (seek, associations, location, overview, bucket, preview, gutter,
  apparatus, highlight-summaries, section-context) are post as well. what the
  body carries that a bounded query string cannot: a structured `window` union
  (the visible viewport as unit/offset intervals, not a scalar), a `kinds` set,
  and a `scope`/target union — target lists whose length follows the document,
  not the request. serializing those into a query string would put an unbounded,
  percent-encoded structure in a URL that intermediaries, proxies and access logs
  truncate at implementation-defined lengths, and this project has no committed
  URL-length budget to qualify against. what is given up, explicitly: a
  non-idempotent verb for a read, no conditional requests, no intermediary
  caching, and a different BFF adapter shape. the caching loss is nominal rather
  than real — every publication query response is emitted `Cache-Control:
  private, no-store, no-transform` (`reader_publications.py:76-79`) by deliberate
  design — but the idempotence loss is genuine and is accepted. `after`/`limit`
  stay explicit fields of the request models
  (`python/nexus/schemas/reader_publication_evidence.py:210-215`), so the
  pagination contract is still readable from the route. restoring only the
  evidence read to `get` while its siblings stay `post` would make the table more
  arbitrary, not less.
- **all four publication member routes are on the admitted-read pool.** they
  share `_member_response` and are bounded by `READER_PUBLICATION_LIMITS`, so
  they belong in one pool. the separate package-transfer budget exists for the
  offline archive, which that profile does not bound.
- **the transport request bound is a required deploy key.** `request_bytes` is
  the seventh number of `API_READ_ADMISSION_LIMITS`; an admitted route refuses a
  declared or streamed body above it before taking a slot, answering `413
  E_REQUEST_TOO_LARGE`. it has no default, like the rest of the profile, and
  `deploy/env/env-prod-backend.example` carries it as a `<qualified>` placeholder.
- **native schema-1 conversion is the only read path for an installed schema-1
  copy.** there is no schema-1 reader left to fall back to: `OFFLINE_ARCHIVE_SCHEMA_VERSION`
  is the single producer constant, ingress refuses a schema-1 archive as
  `UnsupportedPackage`, and an installed schema-1 copy is readable only after
  conversion. availability therefore reads `UpgradeRequired` /
  `UpgradeBlockedByStorage` / `UpgradeFailed`, never "open it as it is".
- **no numeric limit was invented anywhere in this cutover.** every production
  profile value in `deploy/env/env-prod-backend.example` is a `<qualified>`
  placeholder awaiting the capacity run's receipt; the values in
  `python/nexus_test_control/services.py` are controller experiment inputs and
  are not production defaults. a number that has not been measured is not written
  down as if it had been.

the immutable projection also freezes each unit's existing fragment index and each
section's optional end coordinate; point-only targets have no extent. find reuses
the existing literal query/scope/snippet schemas and signed query-bound cursors.
one page scans one nonempty unit, with bounded same-fragment overlap; postgres
slices context before transfer and skips zero-text parts. response bytes use the
qualified index budget. tradeoff: complete find is incremental, including empty
pages with continuation, and section/word semantics remain exact at unit cuts.

real-postgres query proof `4662547c8c9d2bb5` covers retained generations, cross-unit
matches, empty parts, section scope, unchanged exact locators, ambiguous quotes,
terminal offsets and access refusal. splitter kernel `ad3d36edd3523831` passes.
these new proofs still require registered sensitivity after the clean checkpoint.
run `658434a5e97ff63d` passed static and kernel work, then its selected storage
convergence proof stopped on the known host `XMinioStorageFull` condition.

the splitter now keeps only bounded unicode boundary lookahead and caps its first
candidate before copying; its earlier whole-fragment integer arrays and half-source
trial copy were unsuitable for the worker budget. worker source-dom residency
still requires gate-0 qualification. table continuation remains a blocker: one
large table cell can exceed the normal unit profile under the existing 64-mib
encoded legacy reader envelope, while naive cell splitting
loses grid/header relationships. no claim of support or completion absorbs that
tradeoff. all failed preparation must retain the old publication pointer.

schema-2 offline archives reuse the existing manifest keys: package schema 2,
reader contract 1, minimum reader bundle 2. exact descriptor.json plus reachable
index/unit/render assets replace reader.json. the original epub remains retained
server-side; an unreachable nested source archive does not enter the download.
five publisher seams are staged: generic web, stored html, pdf, epub and metadata title. their
objects are prepared and verified before the existing source publication transaction.
x post/thread and backfill operation wiring remain incomplete. schema-2 delivery
now runs in the durable worker; the api only authorizes and streams ready bytes.

unit text and word boundaries now use a caller-owned temporary staging file,
kept open through the source transaction and retries. one unit is inserted at a
time; the prepared plan no longer retains every decoded unit or pending orm row.
tradeoff: temporary disk i/o and per-unit sql replace whole-source resident copies.
true DOM accounting includes text and tail nodes: kernel receipt
`cf1d0d683fa61eab` passes. recovered real object-store upload/publication receipt
`98e789e2b647bc96` passes. source-job recovery and retained-query proof
`e928ca09e7618080` pass with the controller's explicitly labeled experiment profile.

schema-2 file-backed verification/assembly now passes its first independent pdf
member proof (`07f5081f5c30ee53` red → `c17f0bdf4aeb1fa5` green), including exact
identity, deterministic bytes and unreachable-member rejection. legacy schema-1
conformance also passes. candidate package producers now advertise schema 2;
these changes must stay outside the first release checkpoint until native migration
and release qualification pass. nothing has been deployed.

a resolve Unit target uses the existing immutable member key to traverse even
image-only parts. text/unit results expose constant-cardinality ordinal and
previous/next refs, avoiding linear index walks and cyclic member digests.
quote-only resolution proves uniqueness through bounded continuation: red
`c91c57bfd536437e` → green `6a89c9b1819e8921`. empty units use the retained
nonempty-ordinal index, so one request never scans an unbounded empty run.

package preparation uses one existing durable job and one ready archive member;
selected-generation status never mints a token before verified storage publication.
account mismatch rejects before job creation; transfer rechecks current visibility
while retained generation seven remains downloadable during replacement eight.
real postgres/minio + in-process JobWorker proof passes `2979605bfd951fec`.
controlled omission of the one-use claim produced replay 200 instead of 401 in
`df4fa4cea5032315`; restored green preserves internal-header and visibility proofs.
request-assembly concurrency/disconnect proofs are retired because requests no
longer assemble or own temporary archives. heavy-child cleanup still needs its
separate process proof; this service run does not claim that boundary.

title publication writes/verifies only a successor descriptor before the metadata
transaction. its existing generation fence copies frozen projections with SQL and
reuses content objects; no whole-text decode or object-store call occurs under the
publication lock. the controlled missing-install fault failed `5c9cc52d8e947e1d`;
restored immutable-asset reuse and stale-preparation refusal pass `7f3952d0d52318f6`.
tradeoff: each retained title generation still duplicates the per-generation unit
rows, which carry `canonical_text` and the search-source text — not "small SQL
projections", as this line read before the 2026-09-14 review. a no-op rename no
longer publishes at all (`replace_reader_document_title` returns `False` when the
locked media already carries the requested title), so the duplication now costs
only on a genuine title change; the content-identity split that would make a
retained title copy coordinates alone is deferred to gate 0's retained-growth
number and carries its own ticket. content object bytes remain shared.

text descriptors now retain exact canonical_length, and units retain original
fragment_document_start_cp/fragment_length_cp; document positions require no index
drain. retained schema2 unicode fixture was produced by the real Python assembler
and passed `7f3952d0d52318f6`; its checked-in metadata records current exact digests.

oversized table excerpts remain blocked in [their ticket](../tickets/reader-table-continuation-capacity.md).
accepted refinement: table header associations use bounded existing index pages
through headers_ref; their table_headers collection is separate from navigation.
source ranges retain exact starting unit keys, including zero-text headers, and
may span later units of that same fragment. tradeoff: extra immutable pages and an
on-demand context read; no eager header-chain loading. schema and verifier are
staged; splitter/staging implementation remains. actual two-unit table/header
conformance bytes are now manifested, produced and verified by `33353600723da6df`.

schema two now carries only flat `render_nodes`, not html. records preserve exact
text/tail order, adjusted svg/mathml names, explicit namespaces and tbody nodes.
parent indices are earlier elements in contiguous preorder; invalid DOM names and
duplicate attributes reject before publication. encoded-unit bounds cover the
final node JSON; expanded-node bounds charge its length plus the two actual mount
elements (prepared root and HtmlRenderer host).
the canonical text owner consumes the same node events without reparsing html.
red `e458a7bbc4d53c88` → green `3c4c5810ab6c7965` proves the authority cut;
namespace, graph, canonical and package cases pass `33353600723da6df`.
tradeoffs: larger JSON and direct node construction; malformed legacy layouts
follow the frozen source tree instead of browser repair. table span layout remains
a separate [allocation gap](../tickets/reader-table-span-layout-allocation.md).

Navigation resolution accepts the existing retained target_id and returns its
actual locator and constant-size adjacency. missing targets return no fabricated
locator; an existing Locator request always retains its original locator.
selected-generation mismatch and ordinary resolution pass `33353600723da6df`.

same-generation backfill preparation/installation passes `8b36481c3556b22d`:
expected and target generation are explicit, a repeated identical install is a
no-op, and stale preparation cannot attach after the current pointer changes.
durable operation/preflight wiring and its sensitivity proof remain unfinished.

unit activity coordinates now use the existing postgres canonical-word policy.
`document_word_start` counts starts before the unit, and `starts_in_word` retains
word continuation across its boundary. new fragments reset the continuation.
ordered producer/verifier passes reject drift without repeated prefix scans.
red `3e9c3de232ea9ecb` → green `312660c8dcf5f0be`; both actual schema2
conformance archives now contain those fields. cost: two small immutable fields
and linear worker validation; no new tokenizer or descriptor total.

x single-post publication now prepares objects outside the fenced transaction.
a versioned captured child source checkpoint runs through the existing ingest
job without provider refetch; real worker/postgres/minio proof `a528f3a0c963f49f`
publishes exact members while its accepted parent remains queued. the thread
acceptance/finalization seam and its process-death/concurrent-completion proof
remain. accepting children earlier may retain a valid child after parent failure.

SVG paint now uses one pinned tinycss2 parser at the publisher. actual EPUB
escaped external-resource red `c5167524e5221ff5` → green `47b2ad574829161f`.
render attributes retain resource-free literal CSS or a typed decoded
`LocalFragment{fragment_id,fallback}`; escaped Unicode IDs survive. modern colors
and theme expressions remain literal. native/browser validate shape and integrity;
literal CSS safety is the publisher's semantic contract, not a regex proof.
tradeoff: one small parser dependency and a publisher-owned semantic boundary,
without duplicate CSS parsers or frozen theme colors. real browser request and
vector admission acceptance remains in the SVG resource ticket.

paint fragment ids mean decoded DOM ids: CSS decoding followed by exactly one
URL percent-decoding pass. `%20` and `%2520` sensitivity is red
`895a34540ffda200` → green `8f5740066a405df0`. browser construction must percent-encode
that id before CSS quoting; literal percent signs cannot become a second decode.

thread preparation now accepts/checkpoints/dispatches quoted child sources through
the existing fenced owner before any parent publication. prepared children and
parent fragments share the multi-fragment web member builder. finalization checks
the same child identity and respects an independently completed/superseded child
attempt. this seam is staged; thread death/race proof is still required. the
single-post real-worker regression remains green `5ab2e397cee9dd39` and
`7a68e9cceebb55bb` after the shared preparation changes.

web/stored-HTML embeds now preallocate the existing occurrence UUID, accept and
durably dispatch child sources, then freeze authored source facts and the original
materialized/terminal target in units. only the first original DOM anchor carries
that declaration/card; continuation preserves canonical placeholder text.
`post /reader-publications/{g}/embeds {unit_key,after_ordinal}` reads only that
unit's declarations and projects current authorization, title and processing
status through the existing card owner. responses use the explicit index byte
budget and return `items,next_ordinal`; no current-fragment lookup or mutable
projection enters the immutable package. behavioral green `3a23f53249c540ff`
proves one card across continuations, original target identity, current child
state/access and complete response pagination; controlled-fault sensitivity and
parent acceptance death/race proof remain required. current occurrence retry is
disabled; a retained id does not acquire command authority. costs: an extra live
read and early child dispatch; a valid child can outlive failed parent preparation.

units now carry `epub_target` using the existing cursor target shape and the first
retained navigation target of that fragment. this avoids a navigation drain or
per-scroll lookup. producer and verifier reject inconsistent defaults. source ids
in immutable unit/index/range/section wire are opaque nonblank strings bounded at
256 code points, preserving the already admitted installed-v1 fragment contract.
hosted SQL keys remain UUIDs with explicit boundary conversion; media/account ids
are unchanged. the only cost is repeated small target metadata. opaque-id proof
is pending; current manifested schema-two archive fixtures contain the required
epub target and embed fields, produced by `7a68e9cceebb55bb`.

highlight/evidence payloads need more than SQL row pagination: a highlight row
currently expands its complete quote and all linked note bodies, and graph anchor
reads load complete current source text. the existing highlight residency ticket
records this; bounded paint/summary/detail composition and retained selector
resolution remain unfinished.

2026-09-13 continuation: opaque publication fragment ids preserve installed
schema-1 source ids without widening live SQL fragment ids. complete producer
archive/query proofs passed `053e28c2290f8798`, including `fragment-a`.

embed continuation sensitivity: removing only the splitter's continued-ancestor
`data-nexus-document-embed-id` removal produced the independent duplicate-card
assertion in `f5b6c8aeeb18ade2`; restored kernel owner passed in
`a6495d43c289851f`. that run's overall service result failed on the newly added
highlight cursor codec call, corrected before later green runs.

highlight paint now reads bounded scalar facts for one selected unit. exact
immutable fragment identity is the source fence: all content publishers allocate
new fragment ids, while title-only publication reuses unchanged text. missing or
repaired-away old caches cannot paint the retained source. no quote repair or
linked body hydration occurs in this read.

`POST .../{g}/highlight-summaries` exposes all visible authored highlights through
signed keyset pages, including unavailable historical locators. it returns an
explicit 300-codepoint SQL excerpt, total quote codepoints, original metadata,
and nullable existing source range. exact quote/context/linked content remain in
the existing explicit highlight detail read. price: detail requires a separate
request; live mutable pages are not historical snapshots. non-highlight evidence
and the aggregate legacy map cutover remain unfinished.

bounded find/resolve/embeds/highlights/highlight-summaries responses preserve the
normal data envelope. the route owner checks actual serialized bytes against the
required index budget and sends private,no-store,no-transform with exact length.
price: these small responses travel uncompressed, preserving client allocation
admission. BFF header preservation and browser proof belong to the client owner.

`d7011ae03c42817e` passed the real FastAPI/PostgreSQL proof for paint provenance,
title reuse, repaired-away retention, ordered complete sidebar pages, Unicode
excerpt/full-detail distinction, and response transport headers. source-fence
fault sensitivity and maximum query-plan qualification remain required.

new qualification gap: `reader-whole-word-dictionary-segmentation.md` records
that publisher UAX regex boundaries have not proved parity with the old browser
Intl dictionary segmentation. current word-boundary bytes are not claimed to
preserve those supported-script semantics.

2026-09-13 continued: `prepare_reader_publication(media_id, expected_generation)`
now uses the existing durable background lane, exact-generation deduplication,
terminal attempt fence, and object-first install. `943a01b8f9cc927e` exercised the
actual worker and proved generation-seven preparation makes no unrequested ZIP.
preflight `rebuild` only enqueues; `verify` stages and verifies exact reachable
bytes and retained SQL unit/target projections without creating an archive.
`475b770e30a64e28` included the green real-worker/verification owner and proved a
corrupt artifact reference fails despite an existing descriptor; its unrelated
old cleanup expectation failed. corrected preflight/package tests passed
`464b31beeb20b69a`.

release verification requires the existing maintenance owner to stop ALL old and
candidate publication writers through activation. a final descriptor census
alone cannot detect concurrent pointer replacement. operational instructions are
in `deployment.md` and the native cutover document. price: preparation jobs,
one complete verification read, temporary local staging, and this maintenance
stop; descriptor existence is never convergence evidence.

retained navigation sections now declare their exact existing `unit_key`,
including zero-text targets. publication section IDs preserve the installed
256-codepoint contract. shared Unicode and table-context archives were generated
by the actual producer in `0a28ed822cb831d1` and `ce22bb85c6c3f335`.

stale source cleanup could delete an older retained source when its path differed
from the current media-file pointer. the real source lifecycle proof failed
`f241b29d0d954f20`; cleanup now checks immutable artifact references as well as the
current pointer. `6d95d902f2d30fcc` passes and reads the exact older bytes through
its selected-generation access owner.

native schema-1 conversion may explicitly emit `word_boundaries: null`: native
Find is unavailable, so computing a new dictionary engine serves no capability.
`[]` remains a computed empty boundary set. hosted preparation, installation, and
release verification reject null. decoder red `2bc9318546898c06`, green
`6d95d902f2d30fcc`. hosted dictionary semantics and maximum unbroken CJK allocation
remain separate qualification work; no fake empty arrays or UAX-equivalence claim.

2026-09-13 continued: primary contents now has its own `contents_ref` chain under
the existing index codec. it contains authored TOC rows, or section fallbacks;
`next_ref: null` is the exact end. the unit-first `index_ref` retains unit
positions, section lookup, landmarks, and page lists. price: fallback section
metadata appears in both lookup and display projections. no unit duplication,
empty display tail, or cold native read behind an entire TOC. actual producer
receipts: Unicode `1a19040280d6f5c4`, table-context `7cb63fb277a43279`; registered
archives are `3ec04c62e31b143854a4789bc0a5e3d0282e259e525a6700e975f12276e1d0d6`
and `ee6df691f65095febefd3484d9e6d594cb5c370082af01b0c25ddb4dc89c3d81`.

hosted word boundaries now use preparation-only `Intl.Segmenter("und", word)`
through the already pinned worker Node runtime. original-fragment segmentation
preserves dictionary context across unit cuts. Thai/CJK oracle red
`f6f9e9550b217028`, local green `656fbb3131af91bb`. the worker script participates
in both Docker COPY and the exact frozen-image input inventory. price: an extra
worker process, staged files, and ICU allocations for a full original dictionary
span. maximum CJK and pinned-image/browser parity remain release gates; local
Node 24/ICU 78 evidence does not qualify pinned Node 22 or prove version identity.

splitter final cuts now map the admitted crop's canonical output back through
the existing normalization owner to source coordinates, then recrop once at an
original grapheme boundary. capacity fitting remains separate. range-indexed
child traversal and frozen list ordinals avoid rescanning earlier siblings.
this exposed a real first-part reversed-list numbering defect: red
`99cf28f0f4646191`, corrected corpus green `420e93ee31858b9c`, including repeated
text, cross-node normalization, astral points and combining clusters. giant
indivisible atoms/attributes/clusters remain supported-content acceptance gaps.

shared CSS corpus exposed tinycss2's decoded escaped surrogate. local fragment
projection now applies the CSS-mandated replacement character to that scalar,
without dropping the authored reference: red `679199535ff2baa3`, green
`d11bb7e20a21f521`.

selected-generation `section-context` now returns one captured point's current,
previous, and next authored sections plus scalar position/count. equal-offset
EPUB targets keep their explicit section identity; zero-width headings are not
replaced by a later heading. no current-source substitution or per-scroll
poller. API red `61143d9d9ac4a680`, green `170eae950cdb4ced`. price: an explicit
bounded semantic read; position/count are computed from actual authored order.

non-TOC EPUB anchors now have a required main-index `anchors` projection with
original href/id, exact unit key, and canonical offset. unit-local canonical
marker projection reuses the source normalization owner; first authored
occurrence wins. an image-only anchor survives both href navigation and locator
reopen. requested missing anchors remain unresolved; anchors never count as
chapters. private SQL lookup uses SHA256 of the unambiguous JSON address tuple,
retains originals, and rejects a collision; long authored ids do not become
PostgreSQL btree entries. title reuse and preflight retain/check that projection.
price: additional index/SQL metadata and bounded marker projection work.

source producer missing-anchor red `54b75494f0d9f4dc`; actual producer and API
suite green `d34117b45c6e0638`; table-context archive green `31792b1fca440169`.
registered Unicode/table/PDF/EPUB fixtures now contain the required field;
source PDF is a real readable binary and EPUB comes through actual extraction.
URL pathname normalization remains an explicit pending compatibility item:
original stored href and browser pathname cannot be compared by raw equality.

pathname normalization now preserves the original browser algorithm through one
worker Node process per publication. original hrefs remain on wire and locators;
private target pathname uses a hash index plus exact equality and selected-media/
generation predicates. earliest matching source wins, including legacy aliases.
controlled raw-path substitution red `9ee1596c4cc49357`; real producer/API/corpus
green `adcbd573bb65b80d`; Unicode, escaped slash, long authored id and splitter
regressions green `f3b0993e27d528b9`. price: one staged metadata pass/process and a
private SQL projection/index. full-history EXPLAIN remains a release requirement.

CSS EOF recovery corpus exposed an additional valid unquoted URL diagnostic:
red `7ee55912546e02d3`, green `2f11d8f9a02ae289`. only a valid URL token's trailing
`eof-in-url` diagnostic is removed; resource-bearing fallbacks still reject.

- table geometry now has an independent sparse source model and normative tests:
  `reader_publication_tables.py`. one rectangle per cell; source order stays
  separate from logical row order. spans, deferred footers, implied rows,
  malformed overlaps and nested-table exclusion pass `06f4a7afc896ee67` after
  deliberate lost rowspan=0 extent red `4606a76b369e2087`. no table wire cut yet.
- initial source-cost receipt `628bb927cfb7f432`: shared 2,097,129-byte dense table
  (137,508 cells) parses in 0.095s and projects in 0.624s; observed process peak
  113,328→195,504KiB includes lxml and the Python model, not an isolated cgroup
  bound. ordered active intervals have an unacceptable repeated-prefix cost:
  4,096-row/127,006-byte rowspan=0 staircase 1.482s; 8,192-row/253,982-byte
  staircase 5.915s. root approved a scalar occupied-prefix cache with expiry,
  preserving original rectangles independently. no maximum-source qualification.
- `readerPublicationOverlays.ts` now owns strict compact paint, highlight-summary
  and existing embed decoders plus one-attempt bounded query transport. no full
  authored Highlight facade, cache, retry or session state. source-range-loss
  fault red `5ee5d3477d345e6e` → green `628bb927cfb7f432`; client owns actual
  selected-unit binding/admission/UI. non-highlight evidence remains unfinished;
  `reader-connection-summary-materialization.md` records why existing paged graph
  APIs still cannot supply a bounded reader projection.
- Node word-boundary output now handles partial `writeSync` returns for full and
  final blocks. dictionary/splitter corpus passes in `628bb927cfb7f432`; final
  worker image qualification must include these exact script bytes.

the table occupancy prefix cache fixed the staircase but failed staggered
expiry: 4,096/8,192 source cells took 1.532/5.887s (`1fa02baf5294be42`). it is
replaced by maintained `sortedcontainers==2.4.0` disjoint intervals with exact
live expiry/free indices. no dense grid, stale expiry heap or custom tree.
each range update touches at most 1,002 integer boundaries under HTML's
normative colspan limit. original overlapping rectangles remain independent.
wrong overlap replacement red `f4b8d65794fbf277` → whole table kernel green
`d433fbf5365dba09`: the same expiry shapes take 0.093/0.245s; 65,536 rowspan-zero
cells take 1.156s; the shared 2mib dense table takes 0.643s. price: one direct
dependency and source-sized interval indices. these process measurements do
not qualify the maximum supported source or final worker/native pipeline.

table header expansion, aggregate schema-two size and non-highlight evidence
remain open. the existing 512mib/4,096-member offline limits can conflict with
lossless render-node expansion of a formerly accepted 64mib source; neither
per-unit bounds nor sparse geometry proves that aggregate contract. dedicated
tickets retain the exact evidence and prerequisites.

table source header classification now uses merged data-row/data-column
intervals and the document's first ID binding, without automatic pair expansion.
explicit `headers` may name a data cell; an earlier non-cell ID shadows a later
header. authored empty lists suppress automatic inference. non-ASCII whitespace
and child elements keep an otherwise empty header nonempty. wrong th-only
target filter red `859e74429f437d5d` → whole table kernel green
`e1ebddf1c9e709e4`. the selected-cell ray query and native metadata access remain
unimplemented; these source semantics do not claim bounded foreground queries.

connection read and Link-note mutation now share one bounded pair-to-note SQL
lookup. partial motifs cannot win; historical duplicates choose the earliest
canonical first-endpoint attachment `(created_at, id)`. previews select only
200 codepoints in PostgreSQL and leave authored bodies unchanged. wrong second
endpoint red `8365a9102fb249ab` → real database green `8b8afd18fd76a8f0`.
whole endpoint hydration and complete retained evidence remain separate work.

equal-range highlight conflicts now return the already-authorized duplicate id
as `error.details.existing_highlight_id`; the client can open its existing
detail without relisting a fragment. the shared create/update span query still
checks the viewer and holds the same fragment lock. other id/selection conflicts
omit this field. actual API missing-details red `0ad2659c7f058e62` → green
`dfb3ba9578e8ebe8`, including an identical foreign user's range and unchanged
authored color/count. no new query endpoint or mutation behavior.
## retained source apparatus

`0229` now retains original apparatus item ids, exact label/body/selector values,
and directed same-generation source relationships. content installation copies
the accepted current projection with `insert select` under the publication fence;
title installation copies its selected predecessor. generated compact geometry
and codepoint counts keep large selector quotes/counting out of foreground reads.
preflight compares current source facts and retained facts in sql. this costs
retained database storage per revision; original html remains in source assets.

selected-generation reads expose source-reference summaries, ordered target
pages, marker-key lookup, explicit unicode text pages, and exact pdf geometry on
activation. summaries retain existing first-nonempty forward-target fallback and
name the original item supplying each excerpt. complete text remains accessible;
it is not silently clipped. deep sql substrings still require maximum-source
toast/query-cost qualification. these json responses use existing exact-length,
private/no-store/no-transform transport, at the stated uncompressed bandwidth cost.

replacement preserves graph/citation dependents of retained item identities;
final media deletion owns their cleanup. a current user link already promotes an
apparatus candidate into a passage anchor with owner/quote. bare historical refs
have no generation attestation; citation edge snapshots are display-only.
retained item-to-media membership preserves their associations, but ambiguous
historical body/navigation stays unresolved. no minimum/maximum generation or
display excerpt is treated as provenance.

real publisher/read proof: deletion fault `09f987ecbce0513e` red →
`f03297a6bcc446ee` green. rewritten/removed items, source relationships, exact old
text, bounded summaries/pages, pdf geometry, title reuse, and final deletion were
observed. initial setup `e4d1e1a2a3c74248` missed a required generation argument;
`09fe80e5e643bd6e` exposed an ambiguous sql join; `e6d28d5bf8629e0a` exposed the
proof's incorrect 200-codepoint expectation (the reused snippet contract is 300)
and a nested correlation warning. those were corrected. marker lookup and the
retired bare-reference rollup now pass `8c5fc19d83ee63ee`; the omitted historical
membership failed `c5655e7c33a28631` first. connection ownership is now composed
as sql child selectors before the edge page limit, preserving exact visibility,
direction and recency order without a Python lifetime child set. the existing
neutral-link note proof and compact overlay decoder/static checks pass with it.
maximum query cost remains a qualification requirement. required summary
`stable_key` preserves the original inline DOM marker identity.

resolved `reader-apparatus-replacement-deletes-authored-links.md`: retained source
replacement no longer destroys authored edges; final media deletion still does.
selected-generation detail is exact. bare logical refs retain membership but do
not acquire a fabricated historical body or locator.

- normalized passage search: real postgres oracle `12f2b74326f9bba9` follows
  coordinate-loss fault `6eb07d535e0da9b7`; >900-codepoint quotes, unicode,
  whitespace across cuts, ambiguous retained sources, stale hints and pdf page
  intervals retain exact coordinates. normalized text is streamed through copy;
  sparse offset runs retain only changes in the source delta.
- publication integration `9a9463c4b0521c00` passes the complete ownership,
  retained apparatus and search service owners. text/pdf publishers, same-generation
  backfill, title-only SQL reuse, deletion and release verification now share that
  projection. preflight compares exact normalized digests and offset runs across
  different chunk boundaries. search bytes/maps add storage and worker staging;
  database detoast/search/digest allocations still need maximum-workload admission
  qualification. this is not a bounded-api-rss substitute for that database gate.
- summary SQL oracle `c876d877e97c4dea` returns bounded unicode note excerpts and
  exact lengths, preserves the full authored body and rejects another viewer.
  final evidence fact/association/overview queries are still unfinished.

- approved disclosure ordering for the pending evidence cut: relationship then canonical resource ref,
  rather than the full related label's unicode casefold. fact kind/id and source
  position ordering remain unchanged. this avoids reading entire note bodies or
  introducing persistent sort projections across mutable resource owners. the
  visible price is disclosure order by identity rather than alphabetized prose.
- exact evidence-span validation is now a scalar SQL predicate at its existing
  resolver owner. it checks contiguous block ordinals, exact slice bounds and
  byte-equivalent text under the C collation; it never joins source bodies into
  a foreground string. source-byte bypass `8637984bcb4ada07` fails the stale-block
  oracle; restored source and existing citation/search owners pass
  `e381573716caac34`, and the focused source/retained-membership run passes
  `ccf7a1fdd6d92df8`.


- retained-fragment ownership and final deletion: restored source/rollup and
  evidence-piece proofs pass `63c53197a7f282da`; omitted retained membership
  fails `d8ada076bdb1bf7b`. exact old member access remains authorized independently
  of logical-ref activation; final media deletion removes its edges, preserving notes.
- selected pdf geometry: actual extraction/upload/publication through the write
  and paint owners passes `045a0350e445ec16`. digests distinguish identical geometry
  on different binaries; legacy details survive and explicit bounds edits attest
  the selected old source. title-only reuse and complete publication ownership,
  backfill/preflight checks pass `609c7c31658efd6a`.
- pdf nfc defect: independently declared composition, reordered marks, hangul,
  and canonical expansion fail `220584fe6bcd063a`, then pass `609c7c31658efd6a`.
  pdf normalized projections now attest pages only, with null raw-offset arrays;
  raw literal source bytes remain unchanged. maximum cluster/worker and database
  allocation gates remain open. cross-page exact quotes preserve beginning-page
  navigation; a first grapheme spanning pages remains unlocated. both independent
  cases pass `8e6c1d2b684d720d`.
- stale bounds acknowledgment: two real sessions and an observed postgres lock
  wait fail `3ba9894bd804682f`; coordination/duplicate locks followed by a fresh
  locked anchor/quad read and one comparison pass `dfee0a23bb19687a`. exact
  duplicate geometry now returns one sql identity without hydrating candidate
  highlight bodies. maximum late-match query cost remains unqualified.
- new paint contract is selected-g `POST .../pdf-highlights`; rows contain only
  id/color/creation/author/ownership/quads, with a common source digest and signed
  continuation. full detail remains explicit. backend and one-attempt types are
  staged; client integration and complete evidence queries remain unfinished.
- canonical pdf source filtering passes `c42be9d51941b6b3`; canonical locked-state
  refresh passes `3accafcb8d0078e4`, both against coherent candidate `ed03a124bc`.
  these faults independently remove only the digest filter or locked ORM refresh.
  the actual two-session source/geometry acknowledgment defect (oi-159) is fixed;
  maximum duplicate-candidate database allocation (oi-160) remains open.
- evidence facts/seek/associations and complete overview/location contracts are
  staged. real classification/page oracle 72603c945b9a4627 covers coalesced chats,
  same-locus citation/synapse/context, neutral two-local endpoints, exact counts
  across byte-forced pages, source text activation, eof markers and unavailable
  embeds. strict client contracts pass 15421e27e816cc58. pdf activation/source
  geometry and representative fault receipts are still pending.
- overview source metadata adds each declared embed's scalar identity/range and
  retains apparatus ordering and pdf page heights alongside the selected source.
  the producer, title reuse and preflight compare these with their source bytes.
  storage and database query cost are explicit; no lifetime-query capacity claim.
- sparse table wire is agreed with the native owner: a separate metadata chain,
  source cells and explicit-header records; no preexpanded automatic associations.
  schema and verifier integration are staged. the actual oversized-table splitter
  now passes the source kernel (`c6dda79f655206e3`; original atomic source red
  `0dc32a58890e91da`). it preserves nested ordinary tables under a summed logical
  layout allowance, falls back when final JSON is too large, and keeps original
  spans, empty cells and forward caption keys. maximum source/device qualification
  remains unfinished.
- sparse original marker projection passed the independent nfc/reordering/hangul/
  emoji/whitespace kernel in `bd8ea004677d16d3`. that run also passed actual epub
  and pdf archive production, then failed an unrelated source-range fixture.
  those exact archives and member derivatives were refreshed with that limited
  provenance. requested element-anchor projection now reuses the sparse owner;
  whole-source memory qualification remains open.
- all four source-range service cases passed `14acf6a0990791b9`: complete long
  quotes, missing hints, ambiguity and half-open/null-point section membership.
  the same run's real table archive exposed an opening-only cell separator outside
  its first unit extent. the fix keeps that separator in the unit canonical suffix;
  archive replay is pending. original epub anchor positions now come from source
  markers before cropping; the actual source-to-retained-href oracle is staged.
  the old cropped-offset verifier assertion stays until sensitive source proof.
- raster inspection is an unactivated full-frame preparation experiment. public
  Pillow seek/load is charged as decoding, with actual GIF canvas and embedded ICO
  dimensions. the first GIF fixture recipe was rejected by its own expected facts
  (`8d4f2a3d539e8e93`): the writer cropped the larger frame. independently encoded
  frame blocks replace that recipe. no predecode, worker-peak or maximum-image
  qualification claim follows from these small cases.

- `ee367cda82cca3b7` passes all 22 canonical/parser, source-range, gutter and
  retained PDF evidence cases. the table member graph now verifies. its final
  exact ZIP comparison exposes the existing streamed `ZipInfo` default compression
  level versus the explicit level-9 byte encoder. the shared per-member level
  correction is staged; archive replay and the original-marker sensitivity run
  remain queued behind the existing host controller lease.

- original epub marker sensitivity is now observed in `6c95b1b1a29d314e`:
  the second table row publishes cp 5 instead of the independently known cp 6.
  the original-source marker producer is staged; pending-space/grapheme boundary
  correction and candidate replay remain open. no cropped-offset verifier claim
  has been removed before that replay.
- `1e1466348783c061` passes the table graph and exact streamed ZIP comparison
  after pinning the existing level-9 compression on each supplied `ZipInfo`.
  its later assertion exposed a proof traversal error: member construction is
  reverse digest order, while source order follows the metadata continuation.
  that traversal is corrected. web sanitization also removes caption elements;
  text survives but no caption source identity may be invented. the existing
  caption-loss ticket owns that gap; accepted EPUB/native caption semantics
  remain separately covered.

- schema-two verifier proof retirement is complete at its Python boundary:
  canonical member-closure mutation fails the intended assertion, then passes
  (`955a011befc6a38f`); all 21 ordinary revision/path/manifest/ZIP/SVG/MIME cases
  pass in `00868f27f1ac42f8` with the current manifested Unicode archive. the
  obsolete server-schema-one proof registry entry is replaced by the exact
  schema-two closure owner. the intervening ordinary failure was a stale archive
  in the independent proof checkout, not a remaining product-field migration.
  native compatibility and maximum-source qualification remain separate.

- `78c3004b3b782f1a` passes all five original-marker/retained-href cases and
  the actual web source table archive. the source marker red was
  `6c95b1b1a29d314e`; pending-space/grapheme red `64ac81d16e138e3a` passes in
  kernel run `a4249283c531e5bf`. sparse geometry and full-frame raster facts pass
  in that kernel run too; its overall service setup failed on stale proof-tree
  configuration, then the corrected current profile reached the later service
  green. table artifact bytes and exact range assertions are retained under
  the green controller run directory.
- original anchor offsets are now explicitly publisher-owned canonical facts.
  a cropped render tree cannot recompute separators or NFC source markers.
  Python package verification instead binds each declaration to the first visible
  original id/name and exact unit key, selected source href and unit bounds.
  checksums bind those published facts; the sensitive actual-source oracle owns
  exact CP correctness. independent cropped-offset recomputation is retired,
  not replaced by a fabricated source context. package replay remains required.

- authenticated fragment reads now accept only podcast/video timelines after
  canonical access masking. the actual database oracle failed on readable web
  documents in `0f2d8e9a5c65a688`, then passed in `b8c86cd27a015d54`, preserving
  timeline timing, speaker, source word positions and display order. public-share
  fragments remain their separate owner. documents use selected publications.
- `b8c86cd27a015d54` also passes the complete current Python package corpus after
  the first-visible original-anchor binding change. maximum source, native raster
  attestation and browser figure allocation remain separate open gates.
- deterministic maximum-source recipes are staged for the existing capacity owner:
  EPUB counts sanitized HTML plus canonical UTF-8 together; PDF declares encoded
  bytes, pages and extracted text independently. their small actual-decoder oracle
  passed in the kernel portion of `0f2d8e9a5c65a688`. long single-word fills do not
  qualify dense word boundaries, CJK, image surfaces or PDF operator density.

- actual web caption preservation fails in `8f6f3c370237c003`, then passes in
  `24d947b70dabea09` after adding only the safe caption tag. the source publisher
  retains exact caption range/unit, caption element, original bytes and a closed
  archive. generic authored web ids remain under their existing sanitizer policy.
  browser replacement/replay of the new attested artifact is still pending.

- authenticated timeline fragment guard sensitivity is canonical green
  `821d1bd32acd9f73` at `cd1977e239`: removing only the kind guard reaches the
  expected behavioral assertion; restored code passes. the exact proof is
  registered under the existing runtime-health risk. stale proof-checkpoint
  fault/import refusals before this run are setup failures, not sensitivity.

- the strengthened cross-unit gutter oracle is canonical green
  `c37404976ea4303a` at `cd1977e239`: the unchanged omitted-viewport predicate
  fails its count assertion; restored source passes with the span starting in
  unit 0 while unit 1 is visible. root reviewed the exact oracle/fixture change;
  its existing coherent pin is now `5dea9c78885cadc40fb239ab0ef9c6fc3809c68faa7f94955cdc5a2e74190ebb`.

- authored web table scope preservation is canonical green
  `890f082e88921d60` against original base `7fa89b88c8342bca9edfb46a6d20053c49555fb2`:
  the old sanitizer fails the explicit scope assertion; current sanitization and
  retained projection preserve row/column/group semantics and reject executable
  attributes. oi-162 is closed: the resolution was a deliberate allowlist change
  in `python/nexus/services/sanitize_html.py:83-86` (retaining `th scope`, plus
  `ol start/reversed` and `li value`), made safe across unit cuts by the
  list-ordinal projector in `python/nexus/services/reader_publication_lists.py`,
  and proved by `python/tests/kernel/test_reader_source_table_scope.py:10-72`,
  which drives an authored `scope` through the real sanitizer, table projector and
  unit splitter while still rejecting `onclick`/`style`. its ticket and register
  row are deleted. the runtime dossier's earlier "the source policy was not
  changed to suit the workload" records that run's decision, not this one. discarded historical source attributes are not
  reconstructed; caption interaction and maximum layout costs remain separate.

- all 16 direct resource-action fixtures now compose the actual account cache
  and artwork readers. cache-only replay failed at the actual media-session
  artwork dependency (`4b3cdec89febcffb`); the complete provider composition
  passes `703cd32497dbaf5b`, preserving every behavioral assertion. root reviewed
  the exact three registered owner deltas before their coherent pins were added;
  unchanged product-fault replays remain required.
- full raster source-fact kernel run `3c5e13747bb3e4b8` passes. its exact authored
  GIF/ICO bytes and independent expected surfaces are retained in
  `reader-raster-source-facts.json` (sha256 `6930524638e1506dab43090c812700b7748ccade552b9da15ae5f01116fe2944`)
  and handed to the native owner. no raster wire or maximum decode claim follows.
- both sparse and dense-word capacity recipes pass the small actual decoder and
  Node segmentation oracle in `fdc539b91e909329`. dense words retain the same
  HTML-plus-canonical byte envelope and independently known boundary counts.
  the maximum worker run `2d62e6863b9d280e` failed before segmentation because
  the test data environment selected a checkout-only Node path in the image.
  reader scripts now live beside their Python owner as package resources; the
  actual installed-worker replay owns correction evidence.

- full isolated snapshot `21f24bdcb7` binds 3,956 git-visible files with source
  inventory digest `7d6ead89fea73fd54bdcfc7d98e0bc20035512338dcdb56bb9e5776ffa6ff314`.
  earlier selective browser/controller snapshots stopped in setup; they establish
  no fault sensitivity. complete manifest review found stale contexts and exact
  owner pins inherited from the earlier whole-source checkpoint. each correction
  requires its original mutation/owner review; no bulk digest refresh is licensed.
- the cursor acknowledgment owner now uses a directly committed seeded generation
  change instead of calling the publisher without prepared members. root reviewed
  the exact predecessor pin and unchanged source/CAS assertions; current exact
  owner is `282bb31a03a679fa13a1463ef234424a759313f873fdd4b427f04118aedb0ce6`.
  it proves progress behavior after a generation change. publication atomicity
  remains under actual prepared-artifact service proofs. canonical replay is pending.
- hosted selected-cell table header/caption access remains unimplemented. sparse
  immutable pages and excerpt accessibility do not supply that interaction. the
  native event/coverage query is semantically sensitive but its maximum cost is
  unqualified; its many per-node SQLite calls cannot simply be moved into API-to-
  PostgreSQL round trips. browser metadata-chain draining is not an accepted substitute.

- root independently reviewed seven more exact Python owner changes before pinning:
  account fence extracts real seeded fixtures while preserving route/service and
  tuple-header oracles; import recovery drops an unused import; PDF write race
  moves the identical real-lock wait helper; PDF source identity preserves its
  original checks and adds explicit source-unverified/revocation assertions;
  read admission changes only imports used by siblings; container ownership replaces
  an error-message oracle with the exact unchanged ledger; dossier visibility adds
  complete registered-scheme equality. added behavior still requires ordinary
  execution. pins establish reviewed source identity, not successful verification.
- hosted/workspace fault patches required semantic migration: the hosted fault now
  bypasses source equality only at the original reconciliation decision while
  preserving first-dispatch behavior; the workspace fault replaces recovery of a
  missing local row with the original false acknowledgment of the newest sequence.
  root reviewed these exact mutations; original assertion fingerprints remain.

- the three unchanged resource-action fixture faults now pass canonical replay
  at `bec1fbf403`: imports workspace `5097810c40084c1b`, imports pane
  `6d7ab9ca53ad90d9`, chat admission `23dd9b3e9b268dab`. all original assertions
  and fault fingerprints remain; the real account-cache/artwork composition is
  the only fixture adaptation apart from the required conversation classification.
- configured web ingest now uses the existing absolute script setting and PATH
  node resolution independently of the data environment. actual adapter red
  `e2e35ed86a0b8eb9` becomes full 25-case green `e6cbe0248733ac12`.
  the production configuration guard rejects both old and new script overrides;
  its replay `70ba5ecbdd2fa3fb` stopped in the existing sudo/no-new-privileges
  harness setup. no behavioral or image-identity claim follows from that attempt.

- reviewed cursor owner replay is canonical green `a65c283aa8ec925e` at
  `bec1fbf403`; unchanged acknowledgment fault reaches the source/CAS oracle.
  the stale-owner ticket is closed. direct fixture generation advancement remains
  a progress boundary; it does not replace prepared-artifact atomicity evidence.

- epub's separate sanitizer also discarded captions. real stored-source
  preparation red `58f65f6f1291df22` becomes green `940b798f8a9a3b7a` after adding
  only the safe caption tag. exact original range, authored anchor, rendered
  element and member/source bytes agree. no old retained source is rewritten;
  registered sensitivity remains pending for this exact new owner.

- source-memory overlap correction passes all 26 unit/unicode/table kernel cases
  in `1d0352ce35e553a2`: ICU finishes before source DOM construction; atom fallback
  updates ancestor layout totals on recursive return, removing strong parent
  cycles that kept completed fragment DOMs eligible only for cyclic collection.
  no memory-budget change or maximum-peak claim follows before image replay.
- the newly added opening-only table case assumed array element zero carried text.
  exact predecessor replay `32b68c71555bb057` disproves that assumption; legal
  structural zero-text units may precede it. the oracle now selects its first
  nonempty source unit while retaining exact text, `(5,6,6)` endpoints, original
  `0-6-0` source key and following continuation, plus full canonical concatenation.

- capacity EPUB source archives now use explicit fixed ZIP entry timestamps,
  preserving stored compression, insertion order and every member byte. the
  existing real source recipe fails at the wall-clock metadata assertion in
  `5f8bb456a6928b66`, then passes fixed metadata and complete repeated-byte checks
  in `0a6b517480f1fd69`. retained publication/native archives were not regenerated.
  earlier maximum receipts retain shape equivalence, not identical archive hashes.
- formatted PDF source proof and its reviewed exact pin now agree; ordinary
  source identity, literal matching and real locked-write cases pass together in
  `1e1977dd2c708abe` at `fbd9b320e5`. the added source-unverified and revocation
  assertions actually executed; their scope remains separate from capacity.

- embedding input and request composition is ordinary green `70722769ac9c9f5d`.
  document pieces preserve exact codepoint ranges within 8,191 UTF-8 bytes; the
  existing adapter preserves up to 64 inputs while limiting aggregate bytes to
  300,000 for the two attested third-generation OpenAI models. ordinary word
  windows and overlap remain; long words cost more chunks and provider requests.
  unknown model settings are refused before borrowing that tokenizer bound.
- canonical embedding replay `ab165301e93b149e` at `02d1891097` uses the normal
  original base `7fa89b88c8342bca9edfb46a6d20053c49555fb2`: its actual adapter
  fails the external HTTP aggregate-envelope assertion, then the candidate
  passes. the controlled missing-bound fault also fails `2f10d781e976cd33`.
  the aggregate-bound ticket is closed. the complete 8 MiB unbroken-input,
  astral/combining source-range and adjacent-block oracles pass, but full source
  indexing, corpus cardinality, spool capacity and worker headroom remain open.

- exact paragraph coalescing is sensitive: original planner red
  `95935b997d3e7d71` emits 1,000 chunks instead of three; corrected real
  canonicalizer/block-parser/spooled-planner composition passes with the
  embedding/settings corpus in `5c5d4977026646ae`. only original whitespace
  between exactly adjacent same-source blocks is retained and charged.
  multibyte 8,191-byte fit/overflow and unknown-gap refusal pass the final
  focused replay `85b50d8f6d6228f8`. complete source/block retention and the
  structural maximum remain open; the spool limit is unchanged.

- controller attribution is sensitive: unfixed `fa61caf404fc0ea7` loses the
  actual capacity owner after the external storage error. corrected focused
  replay `125c9a1cb42b91dd` preserves completed evidence, cleanup-after-pass
  artifacts and prior behavioral failures, interruption causes and final CLI
  projection. the same run exercises the provider fixture with its actual
  kernel pin and unchanged provider assertions. both narrow fixture/attribution
  tickets are resolved; no capacity outcome follows from this kernel receipt.
- canonical validation now checks the retained expected text through the existing
  sparse marker transform, including no-id input, rather than constructing a
  second complete canonical string. empty-marker prerequisite red
  `9898c78c2e4b8116` becomes whole marker/unit corpus green
  `125c9a1cb42b91dd`; literal Unicode/source-offset and mismatch behavior remain.
  the old publisher already rejected mismatched canonical text. raw parser and
  all-fragment extraction state remain, so actual worker peak is still unqualified.
- rootless capacity composition now shares only the secret-free owned socket
  with mode 0666, keeping its private host ancestry/audit and exact read-only
  mount. host gid numbers are no longer passed as container gids. actual socket
  mode and the local-connect tradeoff are retained in the next receipt; metadata
  success still awaits image replay after errno 13 in `71e44d03ca91ca18`.
- relational cleanup replay `c5408c925c83e974` stopped at fixture setup: its
  assistant message omitted the parent required by `ck_messages_parent_role_shape`.
  cleanup did not execute. the matching queued old-source run was retired as
  `c00143c876c37403` (sigint, no behavioral result). both proof copies now create
  the actual user parent before the assistant child; graph/count/rollback
  assertions are unchanged. exact proof bytes are
  `b6b79e3473b647593be783baf49f97aa24fab3ad2b1de063e7f7f811b7e5b943`;
  old product snapshot is `926802ee07`. corrected pair replay remains pending.
- corrected cleanup sensitivity is now real: old product `926802ee07` passes
  the singleton and fails at 4,100 chunks in `92dcc198b03b7568` with the exact
  postgres `stack depth limit exceeded` message. candidate `d428a08c7a4c11bc`
  passes all four graph/rollback/detach cases plus selected python static checks.
  both 2-resource and 8,200-resource cleanup execute 13 observed statements;
  maximum statement text is 1,103 bytes in both receipts. this attests constant
  query shape for these fixtures, not database working-memory or end-to-end
  capacity qualification. the enclosing worker cleanup still needs replay.
- insertion batching has actual source sensitivity: `25bc3f6e6e6b358c` reaches
  the row-by-row failure (1,000 driver calls for 1,000 blocks) after exact
  source/span/part/vector checks. the earlier `2695d2b63901d962` stopped at the
  proof's mistaken list assumption for pgvector text, before that assertion;
  its explicit sql-text cast/json decode preserves the prescribed vector oracle.
  candidate `a7c51d710386cd10` passes both shapes and the original corrupt/stale
  publication owners. 1,000 blocks use 16 driver calls; 1,000 parts use three
  complete-group calls. the 1,941,069-byte mixed source has 348 chunks and 22
  calls per dependent table. ordinary block batches stop at 52 rows because of
  their prepared bytes; the accepted 1.5mb block alone costs 4,500,816 prepared
  bytes. the envelope counts serialized parameter names/values, not heap or
  PostgreSQL protocol bytes, and allows one existing oversized block/group alone.
  this does not establish fewer server statements or heartbeat/worker headroom.
  source is `359ebe746a9c1cc63fcf001a7c8882fe0e3bda236091b872ba75d6eb2fc82eac`;
  exact proof is `003ab8b5556dacfa83829c0680d74a876115f0d08d0e03ca845e9c8fd4b8a34e`.
- cleanup canonical replay `41095ab2b2b42b75` at `2fa900ad8f` is green against
  original base `7fa89b88c8342bca9edfb46a6d20053c49555fb2`, with only the exact
  cleanup proof overlaid on base. its singleton passes and its 4,100-chunk case
  fails with `bulk graph cleanup failed in PostgreSQL: stack depth limit exceeded`;
  candidate passes. no coherent-owner exception was needed. actual enclosing
  capacity teardown remains a separate open acceptance step.
- epub body spooling is an isolated reviewed candidate, not a main-branch or
  capacity completion claim. four product owners retain exact staged HTML/canonical
  pairs in the existing source-attempt directory through publication, flushing one
  fragment at a time; block/apparatus lists remain. seven direct proof adaptations
  preserve original literals and assertions. the public source-job proof first
  stopped at an incorrect fixture expectation in `1e74d91e878e04fc` at `260714e703`:
  canonical text-node whitespace collapses inside pre too. the source bytes stay
  unchanged; the contract-derived literal is `café 🧠\nx y`. corrected proof
  `29ff2dd5f587f9276a52047bb0c8063cdf9f1a1b8d986587c8cba8cd0a1eb04e`
  is frozen in old-source snapshot `0e64c31d2e`; its replay remains queued.
  no spool sensitivity or lower heap is claimed from the first run. final reviewed
  changes must integrate selectively into codex/bounded-workspace, preserving the
  concurrent reviewer edits; no isolated snapshot is a finished deliverable.

### epub body spool: old source lifetime witness

- old product at `0e64c31d2e` reaches the intended failure in `885733c6b26f3dd5`: `EPUB body files were retired before source publication`; the driver saw `[{}]` during actual fragment insertion. static passed and the exact source/canonical/unit checks ran before the failure.
- the approved filename-independent byte-membership refinement is frozen at `12aef132193e142f66cefcb9247c17e07c8e9d19`, proof sha `73e5ccfaf40eadae1eda4516f0ce2acf013d855bfc54ee06d2fd61cfd2eadfc1`. its old-product replay is pending in publication proof session `30519`. no candidate or memory success is claimed. the four product files remain unapplied to main.
- exact cleanup/batching integration inventory is `/tmp/cleanup-batch-integration-inventory.json`: all seven reviewed files and the cleanup canonical metadata already match main. batching remains ordinary green plus actual row-by-row sensitivity; no separate canonical batch fault is registered.

- refined old proof reaches the same lifetime failure in `4bea545504ca5d1c` at `12aef13219`, now with `[set()]`; its source/unit identity assertions remain unchanged. candidate `964da5aec22ccc97343107ce3e08e827602fa4f9` stages only the reviewed four product owners, seven adapted proofs, unchanged refined source-job proof and exact dimension pin `6acce10f…`. full eight-file ordinary command is pending in publication session `75496`; main spool product remains unapplied pending verification and selective integration.


### integrated epub spooling and canonical replay

- candidate `964da5aec2` passes the full eight-file ordinary command in
  `b62b8c26fe4e0c77`, following the filename-independent old-source assertion
  red `4bea545504ca5d1c`. root integrated all twelve reviewed source/proof files
  and the sole dimension pin into `codex/bounded-workspace`, preserving reviewer
  edits. the earlier queued/unapplied entries above are historical.
- source-scope canonical replay `81b519b5e3ca8350` at correct-source `22cc8ac27f`
  passes: the registered premature-scope-close fault reaches an assertion red,
  then restored source passes. the scoped availability assertion reports
  `EPUB staged source disappeared during publication` only for a missing path
  under the actual attempt root; unrelated missing files re-raise. source,
  canonical, unit, transaction, retry and cleanup assertions remain unchanged.
  exact owner is `b4ceabff570ab1c463bd907300b2a00095098599039074cb7b86b03dfd38c4fd`.
- dimension canonical replay `6355d6296d15434d` at the same source passes the
  unchanged parser-dimension fault and restored candidate. its reviewed owner
  remains `6acce10ff6774d3d026ec438980162b93b59e2921c0f15f7b59956e740e68707`.
  both replays finish their controller cleanup. the earlier bare missing-file
  observation `5ef38c0ad28d3d27` was an execution failure, not canonical assertion
  sensitivity. its deliberately faulted product commit is excluded from both
  candidate ancestry and main; the accepted commit contains correct product.
- integrated maximum worker receipt `815aca6a7ea47827` at `03863b4f9d` still
  fails headroom. all 516 units are verified and the source job takes 117.136s.
  source-child high-water memory falls from 329,789,440 to 247,975,936 bytes;
  first-pressure anonymous/file memory changes from 330,711,040/88,997,888 to
  248,664,064/174,915,584 bytes. source spooling shifts substantial residency to
  file cache. the cgroup records 192 ceiling events during source preparation,
  918 after followups, and no out-of-memory kill. reindexing succeeds with
  4,100 chunks and one heartbeat timeout. source headroom, maximum single
  fragment, dense words and structural shapes remain unqualified.
- the fallback navigation label now preserves literal splitlines/strip/512
  semantics with a bounded scan and a retained scalar label. the ordinary
  source corpus includes all line separators, empty lines and long trailing
  whitespace before later nonwhite text. its narrow allocation ticket is
  resolved; this does not attribute the measured source peak to label creation.

- focused word proof first encountered unselected web dependency admission in
  `cf829fa570f3e159`: all Python static checks passed, then static-web blocked
  before the kernel because node_modules was absent. the unchanged dependency
  check now follows actual static selection. exact predecessor sensitivity
  `f00cc141eb4d52fd` at `314344c7f1` reaches an assertion red on `aa982d02d1`,
  then passes. only the existing scheduling proof's node_modules creation moved
  after its unselected call; all lock/pass oracles remain. both narrow reviewed
  slices are integrated into main, preserving unrelated runner/proof edits and
  the existing canonical owner digest. the focused controller ticket is resolved.

- word-input lifetime now has actual source sensitivity. old producer
  `314344c7f1` fails `bccdc369872279d9`: after real Node output exists, the exact
  anonymous canonical input file remains open during boundary consumption.
  candidate `d832ddc601` passes `cdb36f08cbc5f5a8`, including full/early iterator
  retirement, the recipe corpus and three literal dictionary cases. input
  closes only after synchronous subprocess completion; output remains through
  consumption. source sha is
  `32645e20e090aa3021e5593cbd4feca6ef065694e847b115239531e4b3181139`.
  the reviewed source and proof are integrated into main, preserving its existing
  deterministic archive assertions. this proves physical file lifetime only;
  worker headroom and Node/maximum-source residency still require actual capacity.

- temporary selected-cell scalar characterization passes `7dcdc43092c83664`
  at `3b0d3b9a6b`: 22 independently expected source cases, actual tiny
  fragmentation geometry and literal operation/output counts. doubling the
  3-by-4 fragmentation recipe to 6-by-8 increases candidate visits 35 to 108
  and endpoint visits 70 to 216; no moderate or maximum query was executed.
  three headers followed by four data cells produce 12 header links; six and
  eight produce 48, for both row and rowgroup scopes. thus source-sized markup
  permits quadratic materialized per-cell output. the 100,000-element witness
  has 1,599,979 markup bytes and 2,499,750,006 pairs by construction. this
  rejects eager per-cell links, not every possible shared representation.
  the duplicate draft reducer was retired from the active proof checkout and
  is not shipped in main. hosted query, continuation and disclosure remain open.
