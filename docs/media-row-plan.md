**media rows and metadata: implementation contract**

status: implemented and locally verified in `feature/media-row-cutover`; record below
origin: 2026-09-26 owner approval of the [council review](media-row-council.md)
authority: this plan settles that review's choices and supersedes its verification
proposal. no blocking product questions remain. preserve unrelated work.

**goal, scope, final state**

one stored-media identity across library, lectern, author works, quick reads,
at hand, library suggestions, episode lists, whole-media search and owned-media
browse. retain `CollectionView → CollectionRow → ResourceRow`; converge the
facts and presenter above them. publisher appears only in media metadata,
including publisher-role credits currently admitted by compact media headers.
authored document content and genuine corporate authors are not filtered.

retain search-match excerpts below the common identity and existing direct
audio play/resume controls. these are the approved exceptions. podcast shows,
external catalogue works, passage/highlight/note hits, imports and pickers keep
their resource/occurrence contracts. no ranking, membership, sort, ingestion,
editor, offline-storage, player, or duration-estimation redesign; no settings,
new persistence, generic projection framework, or separate list/detail endpoint.

**content contract — row designer owns selection and hierarchy**

```text
the title of the work                                …
1925 · author one, author two +2 · ≈15 min left
processing failed
```

the last line exists only when `processingStatus=failed`. render failure and
known duration independently. no publisher, hostname, added date, ordinary
processing, suspended, unread/finished, percentage, or download decoration.
pending/suspended items remain openable to their existing informative destination;
download state remains inspectable through its existing menu/player controls.

| field | exact rule |
| --- | --- |
| title | canonical complete title; truncate visually only; native primary link |
| date | original work publication only; preserve year/month/day precision; order never changes its meaning |
| authors | shared `selectMediaAuthors`: explicit `author` roles, canonical credit order; two linked names then truthful `+n`; full list in metadata |
| document time | remaining known: `≈15 min left`; only total known: `≈25 min total`; exact zero: `0 min left` |
| audio time | `15 min left to listen` or `25 min to listen` for total only; integer minutes rounded up from canonical media time at 1×; exact zero stays zero |
| absent facts | omit with no empty separators; never substitute edition/feed/saved dates or another contributor role |
| menu | `more actions for {title}` accessible name; one `metadata…` action |

documents use reading estimates; podcast episodes use canonical listening time
when available. documents retain 240 words/minute, existing coarse rounding and
current durable resume-cursor semantics. positioned pdf remainder can be unknown. finished/unread
does not move the cursor or manufacture zero. video duration stays absent:
there is no current canonical playback-duration source for this contract.

good content is recognizable, correctly attributed and honest about uncertainty.
preserve source spelling. use existing date formatting and design tokens. narrow
panes wrap/reflow while retaining date, author overflow, time, failure and controls;
full title/credits remain accessible without hover. overflow is noninteractive,
with accessible text `{n} more authors`; the menu opens metadata. headers use
the same author selector and their existing desktop/mobile name limits.

**shared facts and composition — backend owner**

one strict camelCase `MediaSummaryOut`, decoded once as `MediaSummary`:

```text
mediaId: existing media identity
mediaKind: existing MediaKind
title: string
contributors: ordered ContributorCreditOut[]
originalPublishedDate: Presence<PublicationDate>
processingStatus: existing MediaProcessingStatus
duration: Presence<{modality: Read | Listen, estimate: ReadingTimeEstimateOut}>
```

reuse `ReadingTimeEstimateOut`: positive `totalMinutes`,
`remainingMinutes: Presence<nonnegative integer>`. all summary keys are required;
absence uses existing `Presence`. retain credit objects' existing wire encoding.
no consumption flag, href, capability, occurrence id, subtitle or source label
belongs in the summary. the frontend's sole author selector serves both the
summary presenter and full-detail header; metadata receives all credits.
`presentMedia(summary, occurrence)` is the sole media-to-row projection.
occurrence carries existing row id, activation, action subject, selection and
optional search evidence; it cannot override summary fields. the action subject
must identify that media. reorder and play controls remain existing view inputs.

define the schema in dependency-light `schemas/media_summary.py`; move the
existing processing-status alias there. move `ContributorCreditOut` unchanged
to `schemas/contributor_credit.py` to avoid contributor-work/summary cycles.
update direct imports; no duplicate definitions or re-exports.

compose summaries alongside existing `CollectionMedia` /
`list_collection_media_for_viewer_by_ids` in `services/media.py`. reuse its
visibility/credit facts and batch reading estimates. audio duration facts belong
to `consumption/projection.py`, sharing its existing listening-duration-before-feed
precedence and current position; do not hydrate player chapters just for minutes.
nonpositive chosen audio duration means absent; no listening record means position
zero. positive duration uses `ceil(durationMs/60000)` total and
`ceil(max(0,durationMs-positionMs)/60000)` remaining. retain raw playback facts.
retire frontend row-time calculations; keep operational action/player facts in
their existing owners.

collection owners select eligible ids, then hydrate one batch without changing
order, limits, cursors or author relationships. use their existing snapshot
mechanism; queue reads use the existing repeatable-read pattern, command results
remain in their current transaction. `consumption/service.py` composes the summary
map and passes it into projection functions, including `nextItem`; projection
must not import `services/media.py`. search/browse complete external work first;
local result/ownership selection and summary hydration share one repeatable-read
phase using the existing transaction primitive. never hold it across provider calls.

**api cutover**

| existing boundary | change |
| --- | --- |
| `/libraries/{id}/entries`, `/podcasts/{id}/episodes` | stored-media item requires `mediaSummary`; retain operational/membership fields separately |
| `/lectern`, `/lectern/commands`, `/consumption/commands` | item requires summary, including nested `nextItem`; retain item id, added time, activation and operational consumption |
| `/lectern/slate`, `/lectern/quick-reads`, `/libraries/{id}/slate` | media target requires summary; podcast target retains its own shape |
| `/contributors/{handle}/works` | explicit media/podcast/external-work variants; media requires summary; `roleFacts` remains relationship data |
| `/search` | whole-media hits (`media`, `episode`, `video`) require summary; preserve match evidence and activation; other hit types retain their own facts |
| `/browse`, owned resolutions in `/browse/preview` | distinguish owned media, owned podcast, and external preview; owned-media identity comes only from summary |
| `/media/{id}` | retain existing detail fields; add stored `edition_isbn: Presence<string>` and `duration` using the shared duration contract |

`mediaSummary` replaces row-facing copies of title/date/credits/status/time in
affected media variants. fields serving independent playback, citation, command,
or acquisition contracts remain with those owners. preserve outer endpoint
conventions, envelopes, auth, query parameters and bff paths. update initial
server seeds, strict decoders and command-result consumers together. full media
detail remains the source for complete metadata; no per-row detail fetch.
preserve the separate bounded player descriptor, including its existing 300-character
title and subtitle; `playerSession.ts` must not replace it with the full row title.
native consumes that descriptor and listening/activity endpoints, not queue dtos.

**metadata designer owns labels, grouping and completeness**

one surface: `metadata` title, complete media title, then these fixed groups:

| group | content |
| --- | --- |
| publication | all credits grouped by role; publisher; `first published`; `this edition`; isbn; language; one description |
| source | media type and full usable source url |
| reading/listening | completion and progress with distinct labels; current playback position; total/remaining duration with modality |
| activity | `record created`, `record updated`, `metadata enriched`, `last engaged` |
| availability | processing; transcript state/origin/coverage; retrieval availability/reason; readable failure explanation using existing error formatting |

authors and the two publication dates display `unknown` when absent. omit absent
optional fields and empty groups. preserve all credited names in order within
roles. `updated_at` is record modification, not authored revision; `created_at`
is not a viewer's save date. no invented completion/acquisition dates, raw ids,
capability dump, new provenance collection, or duplicated description formats.
provider scheduling and membership/queue-added dates remain in their existing
owners; this change adds no new history aggregation. cost: metadata covers
available media facts, not every fact attached to related resources.

add server capability `MediaMetadata` for every visible stored-media resource,
including failed/pending media; canonical action id `ResourceAction.Media.Metadata`,
label `metadata…`, navigate group. existing visibility authorizes the read;
author-edit permission is irrelevant. use `resourceOverlaysController`, one
self-loading `MediaInfoOverlay`, existing `Dialog` / `MobileSheet`, and existing
`GET /media/{id}`. remove the pane-local action/state. forward the actual existing
`ActionSelectDetail.triggerEl` through action dispatch; never discover the opener
from `document.activeElement` after the menu disappears. use the existing focus
return primitive and invoking pane chrome if that trigger is disconnected.

fetch on opening; render `loading metadata…`, `couldn’t load metadata`, `try again`
for the corresponding read states. cancellation/latest-request ownership prevents
an old item's response replacing the current item. no mutation lease, optimistic
write, background polling or separate metadata cache. retain recovery commands
in the canonical menu rather than duplicate them in metadata.

**non-overlapping packages and adversarial gates**

one writer per file. a freezes wire contracts first; b/c consume them independently;
d integrates; e reviews every handoff. each feature's named designer owns its copy
and rejects content that violates the tables above.

| owner / designer | exclusive ownership; paths relative to repository |
| --- | --- |
| a: backend / domain-content | `python/nexus/schemas/{media_summary,contributor_credit,media,contributors,consumption,resonance,library,podcast,search,browse,resource_action_snapshots}.py`; `services/media.py`, `consumption/{service,projection}.py`, `library_entry_listing.py`, `contributors.py`, `resonance/service.py`, `podcasts/episodes.py`, `search/{service,projection}.py`, `browse/{service,nexus}.py`, `resource_items/action_snapshots.py`; `api/routes/lectern.py` read dependency; necessary direct import/serialization callers |
| b: shared row / row-content | `apps/web/src/lib/media/mediaSummary.ts` (new); `lib/contributors/formatting.ts`; `lib/collections/{types,readState,presenters/*}`; `lib/resonance/presentSlateItem.ts`; `components/collections/{CollectionRow,collectionRowFormatting}` and row css; required `ResourceRow` geometry |
| c: metadata / metadata-content-accessibility | `components/media/MediaInfoOverlay.*`; `lib/media/mediaDetail.ts`; `lib/resources/resourceOverlaysController.tsx`; `lib/actions/resourceAction{Snapshot,Menu,Runtime,s}.ts(x)`; required `ActionSelectDetail` forwarding |
| d: surface integration / interaction-content | affected route bodies and list wrappers; `MediaPaneBody.tsx`, `mediaFormatting.ts`; library/lectern/contributor/resonance/search/browse/podcast client contracts, loaders and first-paint adapters; `LecternProvider.tsx`, `lib/consumption/projectionRevision.ts`, `lib/player/{playerSession.ts,androidPlayerRuntime.tsx}` |
| e: proof and closure / independent designer-reviewer | temporary probes and task-owned data; module docs, this plan, tickets/register; no production edits |

gates: a rejects cycles, duplicate facts and new per-row summary/detail loads; b/c reject fabricated
values, inaccessible content and inconsistent copy; d rejects eligibility/order
changes and stale visible data; e rejects green results obtained through mocks,
ineligible targets or weakened assertions. each rejection returns to its owner
before dependent work proceeds. no separate row presenter or policy by surface.
cross-package changes go through the named file owner; no concurrent edits.

**hard cut and acceptance**

delete publisher-subtitle media hydration, source-host/added-date row overrides,
parallel media presentation/time paths, pane-local metadata ownership, replaced
wire fields, unused props/imports/css. retain non-media presenters and player
subtitle semantics. coordinated backend/web rollout and client reload; rollback
the coordinated build. receipts already reproject current items from stored
outcomes/ids, so no receipt migration, compatibility decoder, alias, fallback,
feature flag or dual implementation.

use existing invalidation/reconciliation for accepted cursor/content/author/state
changes. fix the relevant library refresh defect
where it affects current row/menu/metadata or eligibility; do not reload ordinary
paginated lists on every audio heartbeat or introduce another consumption store.

the owner's explicit request authorizes temporary executable live tests;
`./scripts/test` remains the sole committed static/ci gate. use real browser,
bff, api and database with authenticated task-owned data; no mocked application
responses, auth bypass, production test hooks, new permanent dependencies or ci
suite. distinguish persisted fixture setup from ingestion proof.

| temporary case | acceptance |
| --- | --- |
| identity | same article across every eligible article surface; separate episode across eligible episode surfaces: title, original date, author order/overflow and time agree; no publisher/source/added-date leakage; no per-row summary/detail requests |
| truthful facts | partial/unknown original date with known edition; authorless publisher credit; total-only positioned pdf; cursor backward/zero; manual finish/unread/reset cannot fabricate position or duration |
| status/modality | real processing failure stays legible beside time; pending/suspended opens informative content; episode original versus feed date; zero/nonpositive duration and position beyond duration; play/resume and auto-advance preserve the bounded descriptor, including a long title |
| metadata/accessibility | row and pane show identical complete facts; keyboard/touch, narrow width, long text, loading/error/retry, exact focus return; delayed a response cannot replace b |
| freshness/identity | accepted edits/cursor/state changes refresh relevant projections; queue reorder preserves item ids/order/selection; heartbeat preserves loaded library pages; non-media and search evidence survive |
| replay | replay identical pre-cutover placement bytes/id after implementation: no duplicate effect or lost subsequent order; refreshed summary passes the new strict decoder |

at hand excludes queued items; compare sequentially across queue transitions.
quick reads permits queued unfinished documents but requires raw
`0 < remaining_seconds < 600`; its endpoint accepts no parameters. never change
ranking or add selectors to force a fixture into results.

workflow: write probes → observe intended baseline failures → implement → green
→ refactor → rerun affected probes and static gate → delete probes, temporary
setup and task-owned data → final static gate. retain concise commands, revision,
observations and captures as evidence; no executable test residue. browser/mobile
viewport proof is distinct from physical-device proof. visually review narrow
collection rows with duration and failure.

update current media-metadata/library/player/reader module contracts. resolve the
four media-row council findings; record fixes in the commit/pr and update the
issue register. unresolved findings get their own ticket.

accepted costs: provenance and completion require inspection; author overflow
trades full attribution at a glance for density; unknown values disappear; audio
time describes media time rather than speed-adjusted elapsed time; metadata does
not aggregate unrelated histories; all affected transport consumers cut over
together. these are explicit limits, not permission to substitute or invent facts.

**local verification record — 2026-09-26**

base `cfa27d6ce`; isolated branch `feature/media-row-cutover`. temporary api,
renderer, metadata, browser and database probes failed against the old contract,
passed after the cutover, and were deleted. the old api rejected the new library
probe at `mediaSummary`; the new api passed library, episode, lectern and command,
slate, contributor, detail, search, owned browse and action-snapshot reads. the
same pre-cutover placement bytes and mutation id replayed to one existing item
and order with a freshly projected summary. cursor 0.4→0.2, finish/unread,
author edit, audio zero/overrun, pdf total-only, bounded player title/subtitle,
queue reorder/id restoration, and at hand→queued→at hand identity passed against
the task database or authenticated api; rollback probes left no mutations.

authenticated chromium through the real bff showed matching identity across
library, lectern, quick reads, author, episode list, whole-media search and owned
browse. pending and suspended destinations explained their state. failure and
time remained legible at 390px without horizontal overflow. metadata from row
and pane included complete credits, publisher, both publication dates, isbn,
source and activity; loading/error/retry, focus return, stale-response rejection,
and manual finish/unread completion passed. at hand menu state followed queue
membership. real same-origin audio played, paused, resumed and ended. text search
returned 8 hits, 7 whole-media summaries; media evidence showed no publisher,
credit dump or repeated title. a clean signed-in browser loaded library, lectern
and search with zero per-item media-detail requests. narrow captures:
[library](evidence/media-rows/library-mobile.png),
[failure](evidence/media-rows/episode-failure-mobile.png),
[metadata](evidence/media-rows/metadata-mobile.png),
[search](evidence/media-rows/search-mobile.png).

fixtures were inserted directly, so this does not prove ingestion. browser
viewport and local audio proof do not establish physical-device or production
behavior. title/publisher-only search matches can have no inline excerpt; the
matching fields remain searchable and inspectable through metadata.
these runtime observations were made on `d73d9ffd1`. the unchanged patch was
rebased onto `fdfb911ea`; `git range-diff` found only context changes. the
rebased tree passed `./scripts/test`: format, lint, pyright (0 errors),
typescript, offline and extension builds, css tokens, and migration graph head
`0242`. `git diff --check` passed. the live stack was not replayed after the
rebase.
