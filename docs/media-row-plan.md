**media rows: implementation contract**

status: implemented and verified on `feature/media-row-current-progress`;
temporary probes/setup/data removed; final `./scripts/test` passed.
evidence: [current-main integration receipt](media-row-integration-verification.md);
[initial historical receipt](media-row-verification.md).
origin: 2026-10-09 owner decisions; initial source `a494f743e`; integrated onto
`167773ac1`, then `3a42c73d2` before merge. current owners below supersede the
initial file map.
authority: replaces the september policy. historical implementation/proof is in
`aada476d5` (#385), not evidence for this change. no product questions remain.
implementation authorized 2026-10-09 in an isolated worktree; verification follows
the temporary red/green/refactor/removal sequence below.

**goal and boundary**

one identity across library, author works, lectern, quick reads, at hand, library
suggestions, episode lists, whole-media search and owned-media browse: title,
authors, original publication year, consumption state, remaining time.
reuse `presentMedia → CollectionRow → ResourceRow`.

include current-position progress, sticky completion, resumable unread,
automatic filter/order refresh, consistent title-and-author local filtering,
and stored catalogue coauthor credits. preserve occurrence ids, selection,
search excerpts, play/resume, reorder, menus and permissions.

external works show available bibliography only; no invented viewer state/time.
podcast shows, passages, notes, imports and pickers keep their resource contracts.
no ingestion/research, enrichment, new pdf/video estimator, speed-adjusted time,
ranking redesign, metadata redesign, settings, player rewrite, generic cache,
polling/SSE framework or permanent test infrastructure.

**content — bibliography and progress designers**

```text
the title of the work                                      …
author one, author two +2 · 1925                 42% · 5 min
processing failed
```

the last line appears only for processing failure, independently of other facts.
retain existing pending/suspended destinations.

| field | exact rule |
| --- | --- |
| title | canonical title; preserve source spelling/case, native link and full accessible name; visual truncation only |
| authors | existing `selectMediaAuthors`: explicit author role, credit order, credited name before canonical name; no publisher/editor/channel substitution |
| overflow | stored media: first two linked names, truthful noninteractive `+n`, accessible `{n} more authors`; existing metadata action exposes all. external rows without metadata expose all supplied names |
| year | original publication year only; omit if absent; never substitute edition/feed/saved dates. metadata retains full date precision |
| state | `Unread → unread`; `InProgress` with known fraction → nearest integer percentage; unknown → `in progress`; `Finished → finished`. zero percent is valid; display rounding never determines completion |
| time | known remainder only: `0 min`, `1 min`, `59 min`, `1 h`, `1 h 1 min`. no approximation, total substitution, modality or trailing words. finished hides time |
| absence | omit missing authors/year/time and their separators; never invent zero or label unknown progress unread |

good content is recognizable, correctly attributed and numerically honest.
authors/year and state/time form two groups; narrow panes wrap the second intact
without clipping year, state, time, failure or controls. use existing tokens,
direction handling and author links. no progress bar, state button, hover-only
attribution or heartbeat live announcement. accessible time may expand units
and explain read/listen/remaining.

one pure title-and-author field selector supplies every existing media-list
filter, including external author works: all authors, overflow included, both
credited/canonical names. retain NFC/case-insensitive substring matching and
intentional extra fields. announcements and visible rows use the same predicate.
no new search boxes or remote ranking changes. add row-year selection separately;
`MediaInfoOverlay` still needs the existing full-date formatter.

**domain — consumption owner**

percentage and remainder follow CURRENT saved position. remove furthest-point
tracking from storage, readers, writers and current documentation.

| fact | authoritative source |
| --- | --- |
| document percentage | `reader_cursor.current_position_rows_sql()`; web/epub/transcript whole-document progression; positioned pdf stays unknown |
| document time | existing `reading_time.py`, same cursor, 240 words/minute, existing 1/5/15-minute rounding; unstarted total is also remaining; positioned pdf can have total without remainder |
| podcast percentage/time | listening facts regardless of playable stream; listening duration before feed duration; nonpositive chosen duration is unknown; clamp known fraction to [0,1] and remainder to ≥0 |
| podcast minutes | `ceil(max(0,durationMs-positionMs)/60000)` at canonical 1× regardless of speed; no listening row means initial time at zero position, but no observed percentage |
| video time | absent; transcript progress creates no playback-duration source |

canonical state: explicit override → started → unread.
started means a reader-engagement row for non-podcasts (even zero/unknown progress),
or positive listening position for podcasts; stream availability and recency do
not substitute. summary, detail, menus, queries and lectern share this policy.
require a listening row and positive duration before clamping its percentage;
a null position must not become 100%.

inside the existing viewer lock/transaction, a new accepted canonical-modality
position write clears ONLY unread, then settles known progress ≥95%: document
`Finished` override for either modality, and the existing first-completion fact
once. apply at reader writes, heartbeats and successful preview-position
transfer. remove read-time threshold completion. automatic audio completion
changes the override revision; its acknowledgement supplies the new fence.
manual finish keeps its existing command semantics.
preview transfer requires absent listening state; an owned zero bookmark and
its unread/reset fences cannot be replaced by delayed preview data.

finished survives backward movement; the cursor still changes. mark unread
preserves the bookmark; genuine resumed activity restores current progress.
resuming at ≥95% finishes again. reset clears current progress/completion,
preserving historical completion counts/dates. exact completion undo retains
its explicit history deletion. metadata duration edits update percentage/time;
automatic completion waits for the next accepted position write.

**unread ordering — reader/player owners**

`SetUnread`, `UndoFinish` and batch unread retire old writes without rewinding:
bump reader revision, preserving locator; for podcasts advance reset epoch,
preserving position/duration/rate/recency. main already retired the completed
flag and write revision; do not restore them.
create an empty/zero fence record when absent.

reader base-revision validation precedes equal-locator idempotency: every stale
write returns the existing conflict response with no side effects. matching-base
same-locator saves count as new activity. reads, hydration, replay, rejected writes,
offline pending data and podcast transcript saves cannot clear unread.
read-only lifecycle capture, responsive reflow and find/inspection preserve unread;
genuine reading input or explicit reading adoption may resume it.

keep `ConsumptionResult.progressState` reset-only. replace the existing pre-reset
registration inside the current `LecternProvider` with paired hooks:

```text
registerProgressFence({
  prepare(mediaIds): Promise<void>,
  reconcile(mediaIds): Promise<void>
})
```

target ids already exist on reset/unread/batch commands and undo's `unreadMediaId`.
prepare inside the command FIFO immediately before sending: each owner handles
only its mounted target, drains and retires old writes, then gates saving.
after unread acknowledgement or failed settlement, reconcile from its existing
authoritative GET. reset also prepares; success installs its returned canonical
state without another GET, failure reconciles by GET. retain successful
`snapshot.unreadMediaIds` presentation effects. failure uses existing
load/persistence retry feedback; writes stay gated until authority returns.

- hosted reader: current `documentReader/progress.ts` and its hosted port load
  `GET /media/{id}/reader-state`, then install authority without a save.
- browser audio: current `browserEngine` pauses/drains, then adopts authoritative
  `GET /media/{id}/player` position and both fences. next play resumes.
- android audio: current native service performs the same drain/adoption through
  its bridge; reject adoption if the active media/session changed.
- separate offline reader: no local unread commands. next existing sync discovers
  the remote fence: equal pending data at a newer revision retires, differing data uses its existing
  canonical/device conflict choice. pending alone cannot resume. no new offline
  opcode, storage migration or forced-refresh operation.
  matching-base equal-position activity uses the existing canonical save; its
  acknowledgement refreshes consumption even when cursor revision is unchanged.

listening acknowledgements, stale-write details and reset snapshots use the same
required tuple: `{positionMs, resetEpoch, consumptionOverrideRevision:
Presence<nonnegative int32>}`. PUT changes from 204 to `Data<ListeningPositionOut>`;
GET/player already carries both fences. assemble acknowledgements inside the
existing viewer-locked transaction. do not revive the deleted listening GET.

natural end retains its captured reset epoch and drains its own prior heartbeat
before choosing that acknowledged override revision; a later unread/reset still
supersedes it. native bridge compatibility follows main's object-name contract:
rename `nexusAudio` to `nexusPlayback` and `nexusOffline` to `nexusDownloads`,
with no old-object fallback. required `consumptionRevision` in both snapshots
publishes acknowledged native listening and offline saves, including unchanged
cursor revisions; pending alone does not advance it. no protocol
version/hash, resume command or neutral override state.

**schemas and API — backend owner**

all new fields required; preserve existing camelCase and
`Presence<T> = {kind:"Absent"} | {kind:"Present",value:T}`.
move `ConsumptionStateValue` and `ConsumptionOut` into dependency-light
`schemas/consumption_state.py` to prevent the summary/consumption import cycle.

```text
MediaSummaryOut = {mediaId: UUID, mediaKind: MediaKind, title: string,
                   contributors: ContributorCreditOut[],
                   originalPublishedDate: Presence<PublicationDate>,
                   processingStatus: MediaProcessingStatus,
                   consumption: ConsumptionOut,
                   duration: Presence<MediaDurationOut>}
ConsumptionOut = {state: Unread | InProgress | Finished,
                  progress: Presence<float in [0,1]>}
MediaDurationOut = {modality: Read | Listen,
                   estimate: {totalMinutes: positive int,
                              remainingMinutes: Presence<nonnegative int>}}
ExternalContributorWorkItemOut += contributors: ContributorCreditOut[]
```

`services/media.py:list_collection_media_for_viewer_by_ids` owns batch assembly,
reusing visibility, credits, read states and estimates. consumption service passes
summaries into projections; projection never imports media service. collection
owners select ids/order, then hydrate in their existing repeatable-read phase;
browse/search finish provider work before opening the local transaction.

remove duplicate consumption from `LecternItemOut` and `MediaSuggestion`; library
`read_state/progress_fraction/progress_resettable`; episode
`episode_state/progress_resettable/listening_state`. use current suggestions
hydration and remove lectern engagement loads. keep backend-only
`CollectionMedia.progress_resettable` for reset capability and listening facts
used by library hydration; remove its duplicate state/progress fields. detail
fields derive from the same policy; action
snapshots consume summary state instead of remapping another representation.

summaries contain no href, occurrence id, selection, capability or player
descriptor. occurrence adapters cannot override facts. existing capabilities
authorize reset/play/metadata/edit; percentage never implies permission.
retain bounded player titles and player subtitle semantics.

batch external author-page credits from the local Gutenberg catalogue in
`services/contributor_credits.py`; reuse credit construction, roles and ordering.
integer catalogue ids remain distinct from UUIDs. `roleFacts` describes the
viewed contributor's relationship, not all authors. no provider reads or invented
dates/credits.

| boundary | cutover |
| --- | --- |
| GET library entries/suggestions, contributor works, podcast episodes | summary consumption; external credits; remove replaced fields |
| GET lectern/suggestions/quick-reads; POST lectern/consumption commands | summary including `nextItem`; retain receipts and occurrence ids |
| GET browse/preview, search | owned-media summary; retain remote variants and match evidence |
| PUT `/media/{media_id}/listening-state`; GET `/media/{media_id}/player` | acknowledged position and override/reset fences; preserve current epoch-only ownership |
| new POST `/media/summaries/resolve` | `{mediaIds: UUID[]}`, 1–100 unique ids; response `{data:{items:[{mediaId,summary:Presence<MediaSummaryOut>}]}}` |

resolve rejects duplicate ids/invalid bounds; returns exactly one result per id
in request order. missing/invisible both mean absent. authenticate and reuse
visibility checks, bounded hydration and `get_repeatable_read_db`. no provider,
activation, detail or action-snapshot hydration. existing generic BFF suffices.

type every affected route with its response model/envelope; preserve unaffected
bytes/aliases/query parameters. follow [typed wire](local-rules/typed-wire.md):
generated `Schema`/`ApiJson`, no same-deploy success decoder or handwritten DTO.
make credit nullability required and update constructors. regenerate
`apps/web/src/lib/api/wire.gen.ts` via `bun run gen:wire` in `apps/web`.
remove replaced client/seed-loader decoders; retain needed native,
persisted-storage, error and untouched detail/activation decoding.

**freshness — frontend data owner**

one account-scoped `MediaSummaryProvider`/`useMediaSummaries` under `lib/media`,
mounted in authenticated composition. reuse consumption revisions and query
owners; neither action snapshots nor consume-once `resourceCache` owns row facts.
`useMediaSummaries(seeds)` accepts loaded summaries and exposes read-only
resolutions by media id, refresh/error state and retry for that retained set;
consumers cannot mutate cached facts or use it to change collection membership.

1. mounted consumers retain all loaded ids BEFORE filtering, using stable id sets.
   payloads seed unseen ids only; refresh new retainers through the batch endpoint.
   old pane snapshots cannot overwrite accepted facts/absence.
2. keep values/tombstones until account teardown; release subscriptions on unmount.
   invalidation marks inactive values stale but fetches only mounted retained ids;
   remount revalidates. consumption revisions invalidate retained summaries,
   edits invalidate targets, and return/focus/reconnect/retry refreshes them.
3. one in-flight batch; dirty-id union drained fairly in chunks ≤100. advance each
   id's generation at invalidation, install only matching account/generation,
   coalesce intervening writes into follow-up. no timers or per-row requests.
4. patch before presentation, preserving occurrence ids, pages, cursors, order,
   evidence, focus and scroll. authoritative absence removes occurrences and
   reconciles their collections; no seed resurrection.
5. keep accepted content during refresh/failure. one affected-collection notice:
   `couldn’t update items` / `try again`. retry failed ids; no skeleton flash.
   account changes synchronously clear state and abort old work.

query membership/order has a separate owner:

- ordinary insensitive views patch facts only. sensitive library/episode queries
  quietly reread their loaded prefix through existing pagination, up to its
  committed row count; an empty view still requests page one. compare ordered
  occurrence ids across the WHOLE prefix;
  adopt fresh revision/cursor without dropping rows when unchanged. replace the
  prefix only for changed identity/order/extent. a formerly complete view gaining
  a cursor has changed extent; continue its existing exhaustive loading. same-id
  results still update non-summary facts, including external credits.
- accepted progress also advances collection revisions. on `E_COLLECTION_CHANGED`,
  automatically perform that same retained-prefix reconciliation, then resume
  pagination at the fresh boundary. never substitute an unrelated revision.
- quick reads, at hand and bounded suggestions requery their existing local endpoints
  on relevant invalidation, including unseen eligible candidates. retain old rows
  while pending and install actual topology changes. suggestion refresh queues behind
  add/refill; lectern membership/capacity changes invalidate at hand too.
- local filters reapply to current summaries. metadata/author edits invalidate
  affected relationships/order. no consumption-triggered remote provider searches.
  quick reads keeps raw `0 < remaining_seconds < 600` and existing ranking;
  at hand still excludes queued items.

existing query owners guard account, exact view and operation/invalidation
generation; discard superseded topology/append results and coalesce follow-up.
mounted accepted collections refresh independently of which pane owns focus.
preserve surviving row focus/scroll. if the focused row disappears, repair focus
to its next surviving row or existing section fallback only while that surface
still owns focus.

publish accepted changes from hosted saves, browser heartbeats, commands, existing
native activity acknowledgements and newly observed canonical offline progress.
offline sync `Accepted` means scheduled, not committed; pending is not authoritative.
out-of-process/worker changes without an observed completion event appear on
return/focus/manual refresh; no worker notification redesign.
pane-return snapshots are process-local: reload clears old shapes.

**migration and hard cutover**

add `0265` after the actual sole head `0264`; immutable
baselines remain. before dropping the maximum:

1. persist old effective finished non-podcasts, including video transcripts:
   maximum ≥95%, no override → `Finished`; explicit unread wins.
2. persist old effective finished podcasts as `Finished` overrides, using
   listening duration before feed duration and respecting explicit unread.
3. fence existing explicit unread as above so old writes cannot revive it.
4. drop `reader_engagement_states.max_total_progression` and its constraint.
   keep started/recency; delete obsolete locator arguments, wrappers, queries,
   formatters, duplicate DTOs and current-doc claims. preserve completion history;
   do not invent timestamps.

stop writers, verify backup, coordinate backend/web/android builds, reload clients.
rollback needs that database backup AND prior builds. no dual write, compatibility
decoder, fallback, feature flag or fabricated downgrade. receipts reproject
current facts without reapplying effects.

**exclusive work packages and designers**

backend paths below are under `python/nexus`; web paths under `apps/web/src`.
one writer per file. a freezes contracts first; parallelize only disjoint files.
each package receives independent review, including its content.

| owner / designer | exclusive implementation boundary |
| --- | --- |
| a — backend / domain-content | affected schemas; `services/media.py`, `consumption/*`, `reading_time.py`, catalogue credits, library/podcast/contributor/suggestions/search/browse/action-snapshot assemblers; routes, DB model, migration. owns state truth, units and absence |
| b — presentation / bibliography and progress | `lib/media/mediaSummary.ts`, pure filter selector, contributor formatting, collection types/presenters, current suggestions presenter, `CollectionRow`, formatting/CSS. owns copy, credit overflow, narrow layout and accessibility |
| c — list integration / refresh-content | new summary provider, authenticated mount, list panes/wrappers, client contracts including current `lib/lectern/contract.ts`, `paneResourceLoaders`, generated wire, `useLibraryEntries`/suggestion/episode reconciliation. owns retained feedback, counts and occurrence preservation |
| d — progress coordination / interaction-content | `LecternProvider`, projection revisions, hosted reader port and `documentReader/progress.ts`, current offline sync; `browserEngine`, `nativeEngine`, `playerRuntime`; android listening writer, reader bridge and `NexusPlaybackService`. owns fencing, resumption and bridge identity |
| e — proof/closure / adversarial content reviewer | temporary probes/fixtures, evidence, current module/architecture docs, this plan, tickets/register; no production edits |

b defines row inputs; c integrates without surface-specific formatting.
c alone edits shared HTTP contract files, including retained decoder changes
requested by d; d owns the current player/native bridge files. designers create long,
multi-author, missing-data and RTL examples within the schemas, and reject
misleading/inaccessible output before visual approval.

**red → green → refactor → remove**

temporary real integration/live/e2e probes are authorized for IMPLEMENTATION.
durable migration, cross-pane consistency and write-order failures justify them.
use authenticated browser → BFF → API → database, task-owned fixtures; no mocked
application responses, auth bypass, test-only production hooks or permanent
test dependencies/CI suite.

| temporary journey | acceptance and adversarial case |
| --- | --- |
| rows/filtering | multi-author short article across every eligible surface; episode across its surfaces; exact title/year/state/time/credits; hidden coauthor matches with correct count; unimported catalogue work with three stored authors exposes all names, matches coauthor/count, omits unknown year/state/time; no per-row detail fetch |
| progress/commands | 80%→20% lowers percentage, raises time; 96%→20% stays finished; unread preserves bookmark, genuine resume restores progress, reset starts over, history survives; delayed equal/different cursor, heartbeat, natural-end and offline pending cannot undo unread/reset |
| audio/absence | missing listening row never fabricates 100%; unknown/nonpositive/overrun duration, 1× despite speed, streamless episode, sticky preview transfer ≥95%; natural end still advances after unread/resume |
| freshness/topology | two loaded pages and multiple open/restored panes converge; unchanged topology preserves pages/focus; unseen entrants appear, including from empty views; continuation recovers quietly; removed-row focus repairs; old response/account switch/deletion cannot resurrect facts; no provider search on heartbeat |
| content/cutover | unknown original with known edition/feed year, editor-only credit, pdf total-only, video, known zero, long/RTL/narrow pane and 390px viewport; full metadata dates, keyboard focus, play/reorder; migration preserves finished/unread/history and drops maximum |

compare at hand sequentially across queue transitions; never change eligibility
to make fixtures pass. exercise actual Android adoption and offline canonical
convergence; browser viewport proof is not device proof.

independent gates: contracts/invariants → intended baseline red (not setup failure)
→ implementation/green → integrated behavior and migration review → refactor and
duplicate-path removal → affected probes plus `./scripts/test` → delete probes,
setup, task data and test-only dependencies → final `./scripts/test` and residue
review. reject weakened assertions and mock-only green.

retain terse revision/command/result/capture receipts and limits, not executable
tests. inserted fixtures prove behavior, not ingestion. update
`docs/modules/{library,media-metadata,reader-implementation,player,consumption-activity}.md`
and `docs/architecture.md`. close row-contract, freshness, author-filter,
missing-listening and state-divergence tickets only after proof; reconcile stale
september council tickets against source. unresolved items remain in
`docs/tickets` and the issue register. [testing standards](local-rules/testing-standards.md)
owns the permanent static gate.

accepted costs: author overflow requires inspection; unknown facts disappear;
coarse minutes and rounded percentages remain estimates; duration-only changes
complete on the next accepted write; stale reader retries can require conflict
resolution even when the canonical bookmark did not move; truthful topology can
move rows; sensitive views reread their loaded
prefix and summary refresh adds bounded reads, including some unaffected items;
inactive open panes also issue bounded refresh reads; an owned zero bookmark wins
over preview transfer; eligible libraries run existing sortable bookkeeping from
their first loaded page to preserve list geometry, with movement disabled until
complete; session memory grows with seen identities; unobserved
worker changes await
lifecycle/manual refresh; native same-position resumption requires a real
idempotent save rather than a read-only equality check; deployment requires coordinated native builds and
database rollback; deleted probes provide no continuing regression suite.
