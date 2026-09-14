# bounded workspace implementation

> 2026-09-14 pause: historical document; implementation is stopped.
> the [evidence audit](bounded-workspace-evidence-audit.md) distinguishes findings,
> decisions and unverified claims. the [replacement plan](production-crash-replacement-plan.md)
> supersedes this execution scope and awaits user review.

status: execution superseded by the user's pause/replan instruction; preserved for reference, not further implementation.
origin: 2026-09-13 council; [diagnosis](second-tab-crash-council-review.md), [rationale](workspace-architecture-from-first-principles.md).

verification scope, 2026-09-14: the user waived physical-handset checks because
implementation runs on a vps without android hardware. native compilation and
host-side proofs remain required. record device behavior as unverified, not passed.

**target and scope**

navigation performs bounded work. outages fail within the affected feature without
destroying other panes or committed progress. panes share immutable content, retain
independent positions/selections/writers, and reuse published bytes.

retain the stack, jobs, native authority, pane limits and browser-profile restore.
preserve continuous reading, locators, find, selection, accessibility and downloaded
work. no user clarification is required for this scope.

in scope: incident/resource tickets oi-074–097 and the related offline content
duplication oi-071. publication conversion covers web articles, epub, and pdf;
transcript reads keep their timeline contract. failing its capacity gate blocks
release or requires a separate bounded timeline change. unrelated reader-map redesign, note-editor
redesign, full-library replication, new sync/queue platforms, framework migration,
and high availability are non-goals. the user's 2026-09-14 delivery instruction
consolidates these work boundaries into one worktree, branch and pr:
`nexus-web-bounded-workspace`, `codex/bounded-workspace`. verification snapshots
are temporary evidence; all retained implementation and reviewer fixes return
to this delivery branch.

**rules and final composition**

- workspace owns references and view state; reader session owns its view's unit
  leases; resource cache owns shared reads; progress storage owns pending writes.
- publication owner produces immutable generation-bound units; workers prepare
  them; api authorizes and streams them; postgres publishes their references.
- a read generation is `(media_id, reader_generation)`. reuse existing identities.
  cursor `revision` is a separate concurrency token; a package digest identifies
  bytes, not another document generation.
- all content and locations must agree on generation; never substitute current
  content beneath an old locator.
- evict recoverable data, never pending work. no truncation, fake empty success,
  blanket retries, or discarded conflicts.
- retain published generations until explicit media deletion. current access
  checks still apply; immutability does not authorize public caching.

**work boundaries and order**

each row owns its files and proofs. schema contracts land before consumers; d owns
shared orm/migration edits, including c's cursor fields. e owns client composition;
b/c/d supply its capabilities. no concurrent edits to another row's files.
paths below are relative to `python/nexus/` (`p`) or `apps/web/src/` (`w`).

| step | exclusive responsibility and principal files | dependencies |
|---|---|---|
| 0. qualify | exact-image reproduction; test-controller capability/fixtures; committed runtime and wire budgets | first; no guessed replacement ram |
| a. foreground runtime | `p/config.py`, narrow admission owner, upstream provider-runtime imports | 0; b's error contract before admission |
| b. failure boundaries | `p/errors.py`, status/envelope definitions; `w/lib/api/{client,proxy,retryPolicy}.ts`, boundary components and telemetry | independent of publication conversion |
| c. pending work | `w/lib/reader/{ReaderProgressPort,useReaderProgress,readerProgress}`, new narrow browser intent store; `w/lib/workspace/{useWorkspaceSession,sessionSync}`; `p/services/consumption/offline_reader_progress.py` | b's error contract; reuse current generation now |
| d. publications and queries | `p/services/reader_publication.py`, new publication schema/routes/artifact storage, migrations; `services/{media,reader_document_map,nexus_history}`; shared history command builder | 0; contracts precede e and f |
| e. hosted views | `w/lib/api/{resourceCache,useResource}`, `lib/workspace/bootstrap.server.ts`, `lib/panes/paneWarm.ts`; `ReaderDocumentSource`, `DocumentReaderSession`, reader bodies, `PdfReader`, nexus controller | b/c integration first; d before immutable sharing |
| f. downloads/native | `p/services/offline_reading_{delivery,packages}.py`, offline routes/schemas and preparation job; `w/lib/offlineReading/OfflineReaderAdapters.ts`; native offline store/synchronizer | d artifacts and c intent contract |
| g. cutover | backend image, compose, `release.py`, integration/release proofs, client transition and permanent docs | a supplies resource values; all applicable gates |

release checkpoints: first ship qualified incident containment, import/admission
repairs and pending-work ownership with their schema changes; next hosted
publication/query/view contracts; finally native packages after conversion proof.
each uses g's applicable gates. incident repair does not wait for publication
migration. this planning task authorizes no production release.

**0/a — measurable capacity contract**

reproduce deployed image `8564b8ec84376772c7cad8dc8c91f29892e4bb3b325a2520a6835a10f6ed456c`
from the incident receipt, then the candidate. use local production-shaped cgroups,
database, proxy and workers. never inject profiling into the nearly full live api.

before tuning, record numeric limits in their committed owners and link run receipts:
cold/warm/peak cgroup bytes; unit/index/response bytes; read/worker concurrency;
thread/database headroom; foreground deadlines; browser lease/cache budgets;
retained-growth tolerance; probe/host reserve. receipts identify images, source/schema
versions and input hashes. qualify maximum supported content/evidence/history and
repeated navigation with worker activity. final capacity proof excludes profiler overhead.

one api admission owner rejects excess expensive reads before materialization with
503 `E_READ_CAPACITY` and bounded retry guidance. no waiting queue. reuse the existing
offline-route permit-to-worker-future ownership: release only after synchronous work
terminates and owned live allocations/buffers are released, not when rss falls. reserve
execution/database headroom for progress, auth, readiness and streams. a global
uvicorn connection cap alone is insufficient. an oversized supported request must
be redesigned or provisioned correctly, not declared successful with missing content.

make provider-runtime contracts/catalog imports independent of engine imports in
the upstream package. preserve adapters actually required by foreground features.
first-use reads must not reload unrelated engines. g adjusts api/host capacity together.

**b — transport and recovery contract**

browser and bff classify unenveloped 502/503/504 as availability failures. preserve
owned error envelopes, request ids, strict successful-body decoding, and internal
defects. b declares `E_READ_CAPACITY` retryable availability. `retryPolicy.ts` owns the three-attempt jittered schedule;
semantic reads, including post search/locator resolution, use one retry owner.
exhaustion wraps its final cause as a defect under the repository retry rules.
mutations retain their reconciliation/replay protocols.

contain throwing search/history controllers, not only their visual children. feature
retry leaves other views intact; cold account/profile bootstrap may still fail globally.
durable coordinators publish failures without throwing above their boundary. existing
telemetry records operation, request id, release and recovery scope, never private content.
replace the blanket “your data is safe” claim with accurately scoped save status.

**c — pending state schema and acknowledgment**

reuse `ReaderProgressPort` outcomes, the reader reducer, native reconciliation,
account-scoped indexeddb transaction patterns from `activityOutbox`, and the existing
generation-fenced cursor service. rename the offline-specific service/schema owner
to reflect shared use; do not duplicate its serializable generation/cursor checks.

add cursor storage `source` json: publication `{kind, reader_generation}`, timeline
`{kind}`, or unresolved `{kind}`. positioned cursors return it separately from current
generation; empty tombstones need none. existing document cursors lacking evidence
remain unresolved with locator/revision preserved. do not backfill from the current
pointer. equality acknowledgment compares source plus locator. unknown provenance
uses `ContentChanged`: preserve the locator, open current content without applying it,
and save only after explicit navigation/confirmation establishes a selected-source
locator. never infer historical generation from a reused fragment id.

browser intent record, keyed by `(account_id, writer_id)`:
`{account_id, media_id, source, writer_id, desired_sequence,
desired_locator, baseline_cursor, attempt?}`. `attempt` freezes
`{sequence, source, locator, base_revision}`. before dispatch, atomically retain an
existing attempt or create one only if absent. create a writer per reader visit;
recover orphan records independently of restored views. coalesce unsent movement.
commit before `durably pending`; failed local storage remains unsaved.
one runtime drives each writer locally; other browser contexts may deliver the same
frozen attempt. existing revision cas and conditional indexeddb acknowledgment must
tolerate duplicates; no leader election. resume attempts before newer movement.
native keeps its existing durable owner.

after ambiguous delivery: fetch source and canonical cursor. changed generation
preserves intent as content-changed; matching submitted source and locator acknowledges that
attempt; unchanged base permits replay; otherwise expose the existing conflict choice.
acknowledgment conditionally installs baseline/removes the matching attempt; delete
the row only when its desired sequence also matches. never silently rebase onto
a newer cursor or reset tombstone. recheck generation atomically with cursor cas.
use the existing account-bound progress endpoint for hosted and native callers.

workspace saves separate desired/in-flight/acknowledged snapshots; serialize writes
per owner and coalesce newer state. persist dirty snapshots
locally by account + browser-window writer; indexeddb already scopes browser profiles,
and the server device cookie stays httponly. recover dirty records before delivery.
preserve server-commit-order last-write-wins: delayed writes across reloads/windows
can win; local records preserve recovery, not global latest-layout ordering.
within a writer, late completions cannot acknowledge newer state. keepalive is an extra delivery
opportunity, never the durability owner. activity remains its existing immutable outbox.

**d — publication schema and api**

keep `reader_publications` as the sole current-generation pointer. add ready-only
`reader_publication_artifacts`:
`{media_id, generation, path, role, storage_path, media_type, size_bytes, sha256,
created_at}`; primary key `(media_id, generation, path)`, media foreign key;
closed roles descriptor/index/unit/asset/archive. jobs own preparing/failed state.
no nullable not-yet-ready artifact rows and no second current pointer.

freeze two query projections alongside artifacts: `reader_publication_units`
`(media_id,generation,unit_key,ordinal,fragment_id,fragment_idx,start_cp,end_cp,canonical_text,word_boundaries)` and
`reader_publication_targets` `(media_id,generation,target_id,ordinal,label,unit_key,
offset_cp,end_cp,href_path,anchor_id)`. end is null only for point-only targets.
composite primary keys end in unit/target id;
unit key is its artifact member path; foreign keys bind units/members. indexed ordinal
and fragment/range lookups resolve old generations without scanning bodies.

descriptor: `{media_id, reader_generation, kind, title, reader_contract_version}`;
text adds `{first_unit_ref,index_ref,unit_count}`, pdf adds
`{document_asset_ref,page_count}`. member refs include key, bytes and sha256.
index pages preserve toc hierarchy, landmarks, page lists and section extents;
target rows serve point resolution. pages include unique unit refs and continuation. units contain
original fragment id, canonical code-point `[start,end)` extent, sanitized html/text
and asset references. identity is fragment + extent + stable part for equal zero-text
extents. render start/end bounds describe only separator gaps; canonical coordinates
remain exact. worker-computed whole-fragment unicode word boundaries preserve find
semantics across cuts. semantic splitting preserves valid html and original locators;
bound expanded as well as encoded bytes. pdf retains binary/range delivery.

| api path below `/media/{id}` | contract |
|---|---|
| `get /reader-publication`; `get /reader-publications/{g}/descriptor` | select current or reopen a known generation's bounded descriptor |
| `get /reader-publications/{g}/index?after=…` | fixed byte-bounded immutable page and next member ref; reject non-index cursors |
| `post /reader-publications/{g}/resolve` | existing canonical locator → addressed unit and exact local offset; read-only |
| `post /reader-publications/{g}/find` | `{query,match_case,whole_word,scope,after?}` → bounded canonical matches/continuation; preserve existing section scope |
| `get /reader-publications/{g}/units/{key}` | one verified bounded unit |
| `get /reader-publications/{g}/assets/{key}` | authorized member bytes; range support where required |

immutable members return raw artifact bytes with exact length/digest/type. html assets
use `nexus-reader-member:<key>` resolved against selected-generation refs only.
new bff routes remain thin streaming adapters. all generation paths authorize current
media access, reject unknown members, and never fall back to current. pdf resolution
returns its asset/page. find preserves matches across artificial unit splits, original
code-point positions and deduplication using bounded overlap/state. annotations/cursors
remain separate. resolve existing quote selectors against the selected generation
or report unresolved; historical results are view data and cannot overwrite the
current-content locator cache. preserve authored records and explicit reanchoring policy.

workers write/verify objects first; keep the old current pointer until ready. the transaction fences the
expected old generation and publishes all required online members with the new
pointer and query projections. metadata-only changes may reuse content objects.
retain source originals as referenced assets. backfill before switching readers. stop deleting
superseded objects still referenced by retained publications; existing cleanup owns
abandoned preparations and explicit media deletion.

map reads retain their summary route and add `get /reader-publications/{g}/evidence`
with bounded `after/limit` pages. reuse existing evidence unions; each page supplies
ordered ids and continuation. mutable evidence is a live view: revalidate affected
pages after mutation, never claim a frozen multi-request snapshot or drain all pages.
replace the history read with semantic `post /nexus/history/query`
`{query, target_hrefs}` → `{recent: up to 5, frecency_by_href: requested targets only}`;
bound input targets/bytes in gate 0. e supplies its actual candidates; d preserves
scores and ordering using bounded sql queries. define history's
label snapshot as a display excerpt of at most 120 unicode code points; cap its query
snapshot at 200 before ingress. one command builder creates these snapshots; canonical
titles, targets and search input remain unchanged. preserve replay identity and reject
malformed commands. investigate the recorded search timeout with its real query plan.

**e — view and read capability contract**

extend the existing resource-cache owner with a narrow publication-unit acquire/release
capability. key = account + media + generation + unit. one entry owns a shared promise,
abort controller and consumers until settlement; completion changes only its exact
entry. adoption cannot erase admission accounting. last-consumer release permits
cancellation; bounded retention evicts only unreferenced ready content. mutable query
seeds keep their existing freshness contract; do not cache all `useResource` results
as immutable data or add another query framework.

per-session decoded-byte/lease limits include pinned units and transition overlap;
exhausted foreground capacity blocks additional acquisition and speculation, never
silently exceeds budget. `ReaderDocumentSource` obtains units; `DocumentReaderSession` owns its
leases, position and independent progress writer. restore compact visits first,
then active mobile/displayed desktop bodies. offscreen reader bodies may unload after
their view state and pending work are retained. pin selection, focus, dragging and
unfinished interactions; do not introduce generic editor eviction. speculation uses
remaining capacity and keeps ownership through completion. share data, not dom/canvases.

preserve existing epub section/grant reuse and pdf rendering. align pdf stream/autofetch
flags with the chosen measured loading policy. derive offline navigation prefix offsets
once; count code points without temporary character arrays. complete document find must
address unloaded units; arbitrary native find/selection cannot see absent dom. prove
existing supported interactions or retain a qualified complete reading unit—never
silently exchange continuous reading for chapter buttons.

**f — offline contract and migration**

package schema 2 archives descriptor/index/unique units/assets; a descriptor read never
decodes all text. reuse hashing, verifier, local leases, account/generation binding,
one-use transfer grants, and native no-network behavior. prepare archives in existing
workers on first download request, deduplicated by publication + package/reader schema;
reuse verified archives thereafter. token minting takes selected generation and ensures
preparation idempotently; until ready it returns 202 `{reader_generation,status_path}`.
`get /media/{id}/reader-publications/{g}/offline-package?schema=2` returns preparing/ready/failed
with the existing typed failure outcome. the native transfer scheduler owns bounded
status observation and durable resume; ready retries minting. tokens are issued only
for verified archives. transfer checks bind retained selected generation, not current
generation, while access remains current. cursor source/current generation stay separate.
`justify-polling`: native transfer has no completion channel; reuse its scheduler
backoff instead of adding a subscription lifecycle. gate 0 fixes maximum status age
and per-attempt deadline. no hot loop; unfinished preparation retains durable resume.

update native and its reader bundle before switching package production. installed
schema-1 packages require bounded local staging/conversion or a verified same-generation
replacement; preserve canonical locations and pending progress, verify before atomic
activation, retain the original on failure. conversion preserves generation, locator,
cursor revision and intent identity; only package-byte identity changes. staging is
resumable and bounded, including the largest installed schema-1 member.
do not require network access to rescue an
unavailable old generation. the final state has one producer and unit-based reading;
remove the migration decoder only after supported installed data has converted.

**acceptance and adversarial gates**

all executable proof uses `./scripts/test`. register the capacity scenario in the
existing controller; no parallel benchmark/test launcher. each defect needs observed
red against the old behavior or a coherent injected fault, then green. use focused
service/browser proofs first; the enclosing journey proves real process wiring.

| gate | required observable result |
|---|---|
| 0/a | configured maximum admitted work plus lightweight requests/worker load meets budgets; cycles stabilize; zero kills; overload rejects promptly while progress/readiness remain responsive; cancelled threads retain admission; first use retains import savings |
| b | raw gateway failures exhaust within the correct feature; other panes survive; malformed 2xx/internal defects remain loud; no retry multiplication |
| c | close/reload, failed storage, lost ack, newer movement, competing writer, reset and generation replacement preserve exact pending intent or expose explicit conflict; no false save acknowledgment |
| d/e | same-unit panes share one read but move independently; replacement cannot mix generations; old content remains readable; large documents traverse completely within byte/residency budgets; unicode, find, selection and accessibility remain correct |
| e | twelve-pane restore, pinned selection and slow cancellation remain within budgets; views take priority; old prefetch settlement cannot alter a replacement |
| f | unchanged downloads reuse verified bytes; interrupted preparation publishes nothing; offline descriptor opens independently; old packages convert without lost progress or unauthorized/network access |
| g | exact candidate passes required `pr`/`full`/native release lanes, then the existing exact-sha deployment protocol; post-release request/memory/restart receipts confirm the deployed artifact |

at every step, an independent reviewer challenges its contract, forbidden interleavings,
proof sensitivity, retired paths and tradeoffs before integration. unresolved correctness
objections block that step. numeric budgets are qualification outputs, not permission
to lower the supported workload after a failing test.

delete retired whole-document read callers, api package assembly, duplicate provider
imports, obsolete cache settlement/ack logic and completed migration adapters only when
all callers/data have moved. retain transcript consumers until explicitly converted.
update permanent module docs; delete resolved tickets and record their resolution.

**prices and supersession**

bounded units add requests and interaction work; less speculation increases cold-load
latency; retained revisions/archives cost storage; first-download preparation adds wait;
candidate scoring adds a read after discovery; live evidence can change between pages.
older cursors with unknown provenance may need explicit resume confirmation.
durable intent adds storage/conflict handling and possible cross-context duplicate
attempts; layout lww retains cross-window arrival-order ambiguity; schema-1 conversion adds native
migration work; adequate host memory may cost more. a single api remains an availability
dependency. measure these costs; do not claim memory savings before qualification.

this spec supersedes the consume-once-only restriction solely for immutable publication
units in the pane-loader cutover, and the no-browser-outbox restriction in the
reader-progress-continuity cutover. other freshness, locator, url, native authority and
restore contracts remain. the research documents explain alternatives; this document
selects the implementation boundary.

**recorded deviations from this document**

this section records deviations that were implemented and arbitrated; it changes
no requirement above. the reasoning for each is in
[the publication dossier's arbitrations section](bounded-workspace-publication-progress.md).

- section d names `get /reader-publications/{g}/evidence`. the implementation
  serves it as `post`, with its siblings (seek, associations, location, overview,
  bucket, preview, gutter, apparatus, highlight-summaries, section-context). the
  bounded `after`/`limit` semantics are unchanged and remain explicit fields of
  the request models. accepted because the request carries a structured viewport
  `window` union and target lists whose length follows the document, which a
  bounded query string cannot hold; given up: a non-idempotent verb for a read,
  conditional requests, and intermediary caching (nominal only — these responses
  are `private, no-store` by contract). `get` remains correct for descriptor,
  index, units and assets, which take no body.
- all four publication member routes draw on the admitted-read pool; the separate
  package-transfer budget serves the offline archive only.
- the admitted-read permit covers the request body: `request_bytes` is a required
  field of `API_READ_ADMISSION_LIMITS`, and an over-large body is refused with
  `413 E_REQUEST_TOO_LARGE` before a slot is taken.
- the section-d/f schema-1 hard cut leaves native conversion as the only read
  path for an installed schema-1 copy; availability is `UpgradeRequired` /
  `UpgradeBlockedByStorage` / `UpgradeFailed`.
- no numeric limit in section 0/a has been invented. every production profile
  value is a `<qualified>` placeholder pending the capacity run's receipt.
