# index item reordering: implementation spec

status: implemented and verified; temporary qualification removed
date: 2026-10-16 · baseline: `69c00182c8328f46cec893517971f87f03cdbf16`
integration: migration `0291` after `0290`; wire revision `9` after current main `8`.
the original qualification receipt below predates this integration; current checks
are recorded in the pull request.
scope: library and lectern item ordering, from control to committed positions

this replaces the proposal. all five owner decisions are settled: one move at a
time; explicit conflicts; preserve up/down only; the grip opens movement
controls; unresolved requests survive reload in tab-scoped storage.
implementation was subsequently authorized in an isolated branch/worktree.
review: database/concurrency, browser-state and interaction/accessibility reviews
completed; their corrections are incorporated. section 8 records the completed
runtime proof against section 6.

## 1. capability and invariants

good software makes its concepts agree across interface, code, and storage.
here those concepts are membership, manual order, selected view, and proposed
move. none substitutes for another.

| capability | contract |
| --- | --- |
| scope | reorder a manageable named library's direct entries, or the current account's lectern |
| admission | current, complete, unfiltered custom-order view; no unresolved move for this collection; recovery storage available |
| operation | move the actual item immediately before a visible member, or to the visible end |
| preservation | membership unchanged; every other visible item's relative order unchanged; hidden lectern slots unchanged |
| preview | the insertion line and submitted successor identify the same destination |
| persistence | compare the captured collection revision under its write lock; return committed ids and revision |
| concurrency | one pending command per account/collection across panes; older reads and acknowledgements never replace newer order |
| uncertainty | a missing response is unknown; preserve the exact command until acknowledged or fenced by a greater revision |
| views | filters, sort, visibility and metadata keep their existing owners; pending order never replaces their results |

non-goals: cross-list moves, multi-select, undo, first/last commands, destination
chooser, keyboard pickup/drop, offline queue, automatic replay/rebase,
agent-inferred placement, new ranking storage, and a general dnd or mutation
framework. retain intentional lectern add/play-next behavior.

## 2. ownership and composition

`web/` below means `apps/web/src/`; `py/` means `python/nexus/`.
one implementer owns each track's files. freeze the contracts below before
parallel edits; hand off cross-track requirements rather than editing another
track's files.

the index lane supplies the bounded prerequisite consumed by
the principal-actions lane: shared
revision sequence/type, user lectern revision, conditional ensure/remove/place,
explicit-intent fencing and lectern teardown. track a owns those shared backend
files and library revision/strict move. principal actions owns its pending-first
action projection, origin guards and principal ui. shared backend and browser
files receive one sequential handoff; never implement a second lectern fence,
pending map or full-read owner.

| track | owned files | responsibility |
| --- | --- | --- |
| a · database/api | migration `0291` after current head `0290`; `py/db/models.py`; new `py/schemas/collection_order.py`; `py/schemas/{library,consumption}.py`; `py/api/routes/{libraries,consumption}.py`; `py/api/edge.py`; `py/services/{libraries,library_entries,library_listing,media_deletion}.py`; `py/services/consumption/{lectern,state}.py` | strict commands, snapshot reads, revisions, every structural writer, teardown locks; sole owner of generated `web/lib/api/wire.gen.ts` |
| b · browser order owner | new `web/lib/collections/order.ts` and `CollectionOrderProvider.tsx`; `web/lib/api/useServerList.ts`; `web/lib/libraries/api.ts`; new `web/lib/lectern/api.ts`; `web/lib/lectern/lectern.tsx`; `web/app/(authenticated)/AuthenticatedShell.tsx`; both `libraries/[id]/LibraryPaneBody.tsx` and `lectern/LecternPaneBody.tsx` | command admission/recovery, monotonic order, pagination metadata, fresh row projection, domain adapters |
| c · interaction/design | `web/components/sortable/SortableList{.tsx,.module.css}`; `web/components/collections/Collection{View,Row}.tsx` and row css; `web/lib/collections/types.ts` if its public contract changes; `web/components/ui/ResourceRow{.tsx,.module.css}`; `web/components/feedback/Feedback.tsx`; `web/components/workspace/usePaneRefresh.tsx`; web package/lockfile when removing unused dnd dependencies | grip, movement menu, geometry, scrolling, focus, announcements and content; no persistence |
| d · qualification | temporary external harness/fixtures; concise run record in this document | real end-to-end proof and adversarial review; no concurrent product edits |

composition: input → shared semantic move → account order owner → domain api →
existing storage owner/lock → committed snapshot → order owner → current row
projection. the reverse read path enters the same snapshot gate.

mount `CollectionOrderProvider` inside the account-keyed
`MediaSummaryProvider`, above `LecternProvider` and workspace panes.
move the existing full lectern read and its change/foreground subscriptions
into that owner; `LecternProvider` keeps add state/actions. expose
`useLecternRead(): ServerValue<Lectern>` in accepted canonical order and delegate
existing `useLectern` to it, including player-next consumers. internally, one
coalesced `refreshLectern(): Promise<Lectern>` serves ordinary reads and recovery,
adopting payload and order together. reuse existing retry/error helpers; do not
retain `usePaneFreeServerValue` beside a duplicate recovery fetch. keep this
bounded read lifecycle local rather than widening the generic read framework.

reuse `apiFetch`, generated `ApiJson`/`Schema`, change topics,
`useServerList`, existing read ownership, `isCanonicalUuid`, `ActionMenu`,
`ActionDescriptor`, `FeedbackNotice`, the overlay container and theme tokens.
extract the lectern read/strict-move transport into `lib/lectern/api.ts` so
the provider does not depend on its child context. no callback registry, generic
journal, second menu framework, or duplicate pagination loop.

## 3. storage and api

### revision

consume the shared ordinary logged sequence created by the principal-actions prerequisite:

```sql
CREATE SEQUENCE collection_order_revision_seq
AS bigint START WITH 1 INCREMENT BY 1
CACHE 1 NO CYCLE OWNED BY NONE;
```

add `libraries.order_revision`; reuse `users.lectern_order_revision` from that
prerequisite. both use `bigint NOT NULL DEFAULT nextval('collection_order_revision_seq')`
and matching `BigInteger` model fields. preserve existing positions and rows.
the defaults initialize existing aggregates and future creations. empty
collections retain their revision; deletion/recreation gets a fresh value.

allocate only under the existing aggregate lock. every accepted strict move
advances the revision, including an api no-op. lectern public writes and
explicit internal membership intent also advance when already satisfied, as
specified by principal actions; other library writers advance on actual change. gaps and multiple advances within a transaction are
valid; never assume `+1`, reset the sequence, or cache values above one.
the sequence avoids incarnation fields and reused counters; its ordering
depends on [postgres sequence semantics](https://www.postgresql.org/docs/current/sql-createsequence.html).

`OrderRevision` is a canonical positive decimal STRING: pattern
`^[1-9][0-9]{0,18}$`, maximum `9223372036854775807`. no whitespace stripping,
numeric coercion, zero or leading zeroes. services use integers; web comparisons
use `BigInt`, never `Number`. put the wire definition in
`schemas/collection_order.py`; validate browser storage at its own boundary,
not same-deploy api responses.

### transport

all fields below are required; nullable means an explicit `null`.
successes use the existing `Data[T]` envelope.

```text
LibraryOrderOut = { order_revision: OrderRevision, entry_ids: UUID[] }
LecternOrderOut = { order_revision: OrderRevision, media_ids: UUID[] }

MoveEntryRequest = {
  before_entry_id: UUID | null,
  expected_order_revision: OrderRevision
}
MoveLecternItemRequest = {
  before_media_id: UUID | null,
  expected_order_revision: OrderRevision
}
```

| endpoint | behavior |
| --- | --- |
| existing `PUT /libraries/{library_id}/entries/{entry_id}/position` | strict move; replace 204 with 200 `LibraryOrderOut` |
| new `PUT /lectern/items/{media_id}/position` | strict move; 200 `LecternOrderOut` |
| new `GET /libraries/{library_id}/order` | complete visible ids/revision, without row metadata; any current member of a mutable named library may read, including a demoted admin |
| existing `GET /libraries/{library_id}/entries` | `LibraryEntriesPageOut {items, next_cursor, order_revision}`; revision non-null only for a mutable named library with all four server view fields absent |
| existing `GET /lectern` | add required `order_revision`; its full visible item array supplies the snapshot |
| existing `PUT /lectern/items/{media_id}` and `DELETE` | consume principal-actions mandatory `expected_order_revision` and revision acknowledgement; retain intentional ensure-and-place for add/play-next; reorder never calls it |

library commands identify `entry_id`; lectern commands identify `media_id`.
ids are scoped to their collection and revision. no command id, receipt table,
row objects, client indexes, or presentation text on the wire.

use existing error envelopes: malformed body/revision or self-anchor →
400 `E_INVALID_REQUEST`; obsolete revision or missing/invisible subject or
successor → 409 `E_RESOURCE_CONFLICT`. retain existing authentication,
permission and masked collection-not-found errors. no parsing generic error
details to infer whether an earlier attempt committed.

### transaction and all writers

strict move: authorize → lock aggregate → compare revision → load current
membership/visibility → validate visible subject/successor → move subject before
successor or append using the domain rule below → write positions → advance
revision → build ids/revision → commit → respond. build the acknowledgement
inside that transaction, never through a post-commit reread.

library moves operate on ALL stored entry ids, including hidden entries, and
densely rewrite all positions; null appends after the last stored entry. writing
only visible positions could collide with an untouched hidden entry. lectern
instead retains its visible-slot permutation and hidden positions.
reuse one visible snapshot helper per domain for command acknowledgement and
canonical reads. library's helper belongs beside the named-membership query in
`library_listing`; retain a single visibility predicate.

| write owner | required coverage |
| --- | --- |
| `library_entries` | `ensure_entry`, `delete_entry`, `delete_all_entries_for_media`, direct episode deletion in `place_podcast_in_named_libraries_in_current_transaction`, strict `move_entry` |
| lectern storage primitives | insert/restore, delete with survivor densification, visible placement, strict move; agent append/undo, auto-queue, finish/natural-end/undo inherit these primitives |
| parent library deletion | remove entries as today; no surviving aggregate needs publication; recreation receives a new sequence value |
| media teardown | lectern owns queue deletion, survivor densification and each affected viewer's revision |

keep existing library lock order: podcast → media → libraries, sorted by uuid
within a group. do not add another revision write in each upstream caller.

teardown is a necessary repair, not optional cleanup:
baseline `consumption/state.py:245-257` deleted queue rows outside their
owner. within the existing serializable `run_teardown_job` attempt, enumerate
affected queue viewers and lock their user rows in uuid order BEFORE locking
the media. then recheck intent/references and invoke lectern-owned cleanup for
exactly that locked set before hard deletion. remove queue deletion from the
generic state loop. never acquire another viewer lock after media.

reuse whole-transaction `retry_serializable`, reloading the set each attempt.
an unseen concurrent insert must cause whole-transaction retry or fail behind
the completed deletion; it cannot survive an unfenced cleanup. a read-committed
internal append can make hard deletion raise the named queue foreign key
`fk_consumption_queue_items_media` (`23503`) rather than `40001`. only teardown's
hard-delete boundary maps that exact constraint to `TransactionRestart`; the
existing bounded retry rolls back and reloads affected viewers. other foreign
keys still propagate. qualify the actual internal append/undo callers at their
real isolation against postgres; retain external object cleanup after commit.
resolved by `49ca31dfb` and `ebd64fcd9`; see the verification receipt below.

### consistent inventory

canonical reads and library pages use `RepeatableReadDbSession`: revision and
ids come from one snapshot. for the non-null-revision page scope, bind the
revision into the existing keyset cursor binding. a changed revision returns
existing `E_INVALID_CURSOR`; restart at page one, discarding the incomplete
walk. no transaction spans page requests.

add optional `order_revision?: string | null` to internal `ListPage<T>`
so unrelated endpoints remain unchanged. normalize to required nullable
`orderRevision` in `ListSnapshot<T>` and `ServerList<T>`; preserve it through
seeds/mementos. a continuation must match its base revision; a refetch walk
must match its first page. never commit a mixed walk as complete.

this versions membership/order, not titles or authorization. execution still
checks access. filtered or partial pages cannot replace the canonical inventory.

## 4. browser command owner

the only shared operation is `moveBefore(ids, itemId, beforeId)`: remove the
actor and insert it before the successor, or append. use it for preview,
up/down and optimistic projection. equal resulting order sends no request.
up uses the preceding visible id; down uses the id two positions ahead, or
null. `SortableList`/`CollectionView` emit the semantic `Move`, never a
permutation or vendor event.

```text
Collection = { kind: "Library", id: UUID } | { kind: "Lectern" }
Snapshot = { revision: OrderRevision, ids: readonly UUID[] }
Move = { itemId: UUID, beforeId: UUID | null, expectedRevision: OrderRevision }

observe(collection, completeSnapshot)
move(collection, move)
check(collection)
useOrder(collection) -> accepted snapshot | null, pending | null, read/recovery state

pending = frozen Move + phase ("Sending" | "Unconfirmed" | "Checking")
```

the provider owns the fixed library/lectern adapters. scope account identity
through `useAuthenticatedAccount`. reserve the per-collection slot synchronously
BEFORE awaiting storage/network; two panes cannot admit competing local moves.

| event | state/behavior |
| --- | --- |
| admission | validate current scope/revision and no-op; reserve → persist exact request → publish optimistic intent → send once; persistence failure releases the reservation and sends nothing |
| matching success | settle that command; adopt returned snapshot only when newer (or no snapshot exists); an equal revision keeps current visibility; no metadata reread gates another move |
| definitive first-attempt refusal | clear that command/record; remove preview; explain refusal; conflicts require a fresh canonical read before another move |
| timeout, transport loss, incomplete response or ambiguous server failure | retain command/record as `Unconfirmed`; show current confirmed order with recovery notice |
| explicit `check` | enter `Checking`; read canonical order; if revision is unchanged, conditionally replay the EXACT command; never substitute a newer revision |
| `check` without pending intent | read current order only; this is the conflict notice's `load current order` action |
| snapshot greater than pending expected revision | old request is fenced; remove pending/record, adopt current truth, require fresh intent; do not claim its historical outcome |
| snapshot equal to pending expected revision | uncertainty remains; a GET does not prove an outstanding request stopped |
| refusal during `Checking` after prior uncertainty | preserve uncertainty unless a successful exact acknowledgement or greater revision settles it; 401/403/404/409 alone cannot do so |
| stale completion for a replaced/settled command | cannot change pending state, overwrite newer order, publish obsolete feedback, or take focus |

compare command object identity in async completions. retire callbacks when the
account owner unmounts: they must not mutate state, storage, feedback or focus.
a later owner for the same account owns recovery; an old callback cannot erase
its newer journal record. gate every snapshot, including old GETs, seeds, pane
mementos and write acknowledgements, against the
highest accepted revision. `observe` seeds empty state or advances revision;
equal-version seeds/mementos/list observations cannot replace canonical visibility.
only a coalesced canonical GET may refresh visibility at equal revision; equal
revision with different row coverage requests that read. coalesce checks.
use existing transport with a 30-second attempt signal covering request and
response consumption;
reads may be repeated, writes have no automatic retry. cancellation of browser
waiting never means cancellation of server execution.

keep fresh row data and visibility in existing read/summary owners. project
visible rows through accepted order; apply pending placement only during
`Sending` in custom order, then apply the selected view. never use saved row
objects or reintroduce a withdrawn item from an acknowledgement.
equal revisions do not imply identical
visibility snapshots. missing metadata for newly observed ids triggers the
existing view refresh and disables drag; never call a truncated projection
complete. pure reorder may reuse complete metadata from an older revision
when its membership coverage still matches.
lectern recovery must adopt its full payload with its ids; player-next must
never skip an unhydrated member. expose a ready lectern read only when that
coverage is complete; next-item selection stays unavailable until then.

strict-move adapters return their acknowledgement before publishing changes;
the order owner adopts it, then publishes existing change topics. ordinary
metadata refresh does not block reorder when complete membership coverage and
accepted order remain available. `refreshing` blocks only when canonical order
or current view coverage still needs resolution. reuse foreground refresh for other
tabs/devices; no broadcast system is added.

### reload journal

one session-storage key per account/collection:

```text
nx_order.v1:<accountId>:library:<libraryId>
nx_order.v1:<accountId>:lectern
value = { item_id: UUID, before_id: UUID | null, expected_revision: OrderRevision }
```

validate the exact record shape, canonical uuids and revision when reading.
persist no title, rows, phase, focus target, timestamp or order snapshot.
hydrate surviving records as `Unconfirmed`; automatically read current truth,
but never automatically replay. canonical recovery uses library `/order`
or the existing complete lectern read, independent of pane lifetime.

pane closure, view changes, reload, signout and auth-expiry navigation preserve
records; another account cannot consume them. tab closure ends this recovery
guarantee. a storage read/write failure before admission sends nothing and
shows `recovery unavailable` / `this tab could not retain the move. reordering
is paused.` preserve an unreadable existing record for live repair; do not
silently erase it or downgrade to memory-only operation.

remove a record only on settlement. cleanup failure after acknowledged success
does not make the server save fail: a later higher revision fences that stale
record. before any subsequent command, its own record must persist successfully.

## 5. interaction and content

the interaction designer owns movement content; the state/recovery designer
owns status and exceptional content. track c implements both against track b's
states. “good” means one purpose per control, exact destination feedback,
truthful tense, one useful next action, and no storage/network jargon.

### controls, focus and availability

add `ResourceRow.leadingControl?: ReactNode`; preserve `primaryControl`.
render a native grip button through `ActionMenu.renderTrigger` using
`GripVertical` from the installed icon library. click/tap/enter/space open
exactly `move up` and `move down`. alt-up/down work only on this grip,
ignoring composition and other modifier combinations. no keyboard drag mode.

label: `reorder “{title}”`, from plain `row.title.text`.
description: `drag to reorder, or open movement controls. alt plus arrow up
moves up; alt plus arrow down moves down.`
merge existing menu trigger props and description ids; do not replace them.
retain disabled menu items with `already first` / `already last` reasons.
remove movement commands, shortcuts, drag listeners and suppression from the
ellipsis. keep generic resource actions there.

show the grip without hover; use existing `--size-md`, at least `--size-xl`
for coarse pointers, and focus/hover tokens. keep it mounted and focusable
during saving/recovery using `aria-disabled` plus admission guards.
mark grip `data-row-reorder-control` and ellipsis
`data-row-actions-control`; replace generic menu focus matching.

menu selection uses existing close/return-focus behavior before dispatch.
keyed grips survive local movement. network completion never steals focus.
cancellation restores the origin grip only while that scope remains active.
if a resolved recovery notice held focus, restore it to the moved grip when
available, otherwise the existing collection focus target.
expose the existing `Signal.returnFocus` through one optional forwarding prop
on `FeedbackNotice`; its current containment check owns conditional restoration.

derive one ordering presentation for `CollectionView`, rather than independent
busy/disabled flags. unsupported surfaces have no reorder presentation.
priority: unresolved → saving → invalid view → loading/refreshing → ready.
use `PaneQueryToolbar.status.content` alongside existing count/loading content.

| state | content |
| --- | --- |
| ready | no permanent instruction; visible grip is sufficient |
| sorted | `choose custom order to reorder.` |
| filtered custom order | `clear filters to reorder.` |
| incomplete | `reordering is available when all items finish loading.` |
| refreshing | `updating order…` |
| saving / checking | `saving order…` / `checking order…` |

hide grips in sorted/filtered views. view changes stay available during a
pending move and never silently reset filters or sort.

### geometry and gestures

1. retain installed dnd-kit core sensors: mouse distance 8px; touch hold 250ms
   with 8px tolerance. use its public draggable/overlay primitives; stationary
   rows need no sortable transforms.
2. at activation capture collection, revision, ids and source. freeze source
   width/height and pointer offset. portal an inert, `aria-hidden`,
   pointer-transparent `DragOverlay` into the existing overlay container.
   render only frozen grip/title at their original relative positions; measure
   the title rectangle once. no duplicate ids, menus or view-transition names.
3. retain source space and legible text; drag paint is separate from selection.
   remaining rows never displace while aiming. the preview never scales,
   shrinks or reflows.
4. valid surface is the actual list rectangle intersected, on BOTH axes, with
   its pane scrollport. exclude header, suggestions, blank space outside the
   list, other panes and unrelated body content.
   among remaining rows, the first midpoint below pointer y supplies
   `beforeId`; below all remaining rows means append.
5. draw the insertion line at the successor's top, or last remaining row's
   bottom. use `--focus-ring-width`, `--accent`, an in-bounds `--space-2`
   terminal, and system foreground in forced colors. no hitbox/layout height.
   line and release use the SAME `beforeId`. the insertion edge must be visible
   within the valid surface; autoscroll reveals distant edges. an offscreen edge,
   no-op or outside release writes nothing; an invalid target hides the line.
6. scroll only the owning `[data-pane-content]` standard body, vertically;
   neither workspace nor page may scroll horizontally. remeasure after scroll,
   using rendered bounds rather than the 52px intrinsic estimate. qualify
   `content-visibility: auto` as rows enter view; do not remove it globally.
7. escape, sensor cancellation, scope/eligibility loss, changed revision/ids,
   or non-scroll layout changes that invalidate bounds cancel before submission.
   consume the activated drag's click through its lifecycle, without app timers.
8. pull-refresh excludes the grip at gesture start and respects consumed
   events; ordinary row touches still scroll/refresh. no competing canvas gesture.
   bypass collection document transitions for reorder; disable overlay drop
   animation, including reduced motion. direct pointer tracking remains.

fewer than two rows disables drag activation. a one-item list still opens its
movement menu with both commands disabled.
retain core 6.3.1; remove unused sortable/utilities dependencies after the
consumer census. use the documented
[overlay primitive](https://dndkit.com/legacy/api-documentation/draggable/drag-overlay/);
an engine migration is outside this repair.

### feedback

use existing in-flow `FeedbackNotice`; uncertainty never expires in a hud.
`check order` invokes the owner, with existing `FeedbackAction.busy`.

| outcome | title; message; action |
| --- | --- |
| unknown | `order not confirmed`; `we could not confirm your last move. check order before moving another item.`; `check order` |
| checking | retain unknown content and button identity; mark action busy |
| conflict, fresh order | `review current order`; `review the current order before making another move.`; no replay action |
| conflict, read failed | `review current order`; `the current order could not be loaded. load it before making another move.`; `load current order` |
| confirmed rejection | existing domain error mapper; never label an ambiguous attempt rejected |

immediate polite announcements use `{title, from, to, count, targetTitle}`
from current presentation, never persisted: `moving “{title}”, position {from}
of {count}.`; destination `before “{targetTitle}”, position {to} of {count}.`
or `last, position {count} of {count}.`; cancellation `move cancelled.`;
only acknowledgement says `“{title}” moved to position {to} of {count}.`
announce destination only when it changes. recovery says `order check
complete. showing the current order.`, without claiming historical success.

one announcing pane: origin while visible and non-inert, otherwise the active
matching pane.
duplicate panes render silent status. exceptional notices own their announcement;
do not duplicate it in the drag live region. up/down supplies the non-drag
alternative required by [dragging accessibility guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

## 6. delivery, acceptance and deletion

the owner's temporary red → green → refactor → delete workflow is the explicit
exception for this work to the normal static-only automation policy.
[local testing rules](local-rules/testing-standards.md) retain authority for the
permanent gate. no tests ran during the initial planning step.

1. freeze contracts and run adversarial review by database/concurrency, browser
   state, interaction/accessibility and qualification reviewers. each feature's
   designer checks its content against section 5 before implementation.
2. build the smallest temporary harness against isolated real postgres, migrated
   api/bff and a normally authenticated browser. create disposable fixtures
   through real paths. no production user data, fake successful responses,
   auth bypasses, production test switches or shared staging mutations.
3. establish red on observed target-behavior failures, not missing services or
   fixtures. transport controls may hold/drop actual requests/responses; db
   locks may expose races. then implement tracks a–c against the contracts.
4. get the matrix green; reviewers try stale replies, missing members,
   interrupted gestures and owner-boundary violations after each track.
   refactor with the same live checks; delete superseded paths, not their names.
5. retain a terse dated receipt: source sha, actual environments/devices, case
   results and unverified limits. delete temporary tests, fixtures, dependencies
   and infrastructure. run `./scripts/test`; do not create another permanent
   gate. unresolved failures receive individual tickets, never a claimed pass.

| acceptance group | observable proof |
| --- | --- |
| geometry | unequal/wrapped/expanded and taller-than-viewport rows move first/middle/last; preview dimensions stay fixed; only a visible insertion line permits a drop and predicts order after reload |
| cancellation | outside, escape and interrupted touch send no write; title and ellipsis still work independently |
| scroll/touch | long list targets newly visible rows accurately; only owning pane scrolls vertically; physical touch never also arms refresh |
| accessibility | grip click/menu/alt-arrow agree; focus survives saving; reduced motion, forced colors, narrow panes and enlarged text remain usable |
| strict mutation | exact actor moves; unrelated relative order, membership and hidden lectern slots survive; absent subject/anchor conflicts; play-next still works |
| races | competing revisions, remove/reorder, duplicate old requests, empty collection and same-id recreation never accept stale intent; teardown/append interleaving preserves dense order and revisions |
| stale observations | delayed GET and delayed ACK cannot replace newer removal/order; duplicate panes share one pending slot; player-next observes accepted lectern order |
| uncertainty | loss before execution and after commit, equal-revision read, exact replay, retry refusal and later fencing produce the specified distinct outcomes |
| lifetime/views | reload, pane closure, sort/filter changes, account switching and storage failure preserve exact intent without stale rows or cross-account replay |
| inventory | more than 100 library rows plus an intervening mutation cannot produce a mixed complete inventory; acknowledged pure moves need no metadata reread |

hard cutover: increment existing `WIRE_REVISION` in `py/api/edge.py`,
regenerate wire types and rebuild paired web, extension and android clients.
use the existing 426 gate; no alternate bodies, optional revision default,
old 204 branch, compatibility route or fallback to ensure-and-place.
deployment retains stopped writers, migration ancestry and verified-backup
requirements; do not invent a second deployment mechanism.

delete pane-local `dragged` row arrays, array-diff actor inference, lectern
generation arithmetic, transformed-row sorting, drag-as-selection paint,
click-expiry timers, detached silent drag region, duplicate movement commands
and reorder view transitions. preserve generic `ServerValue.generation`,
ordinary view transitions and live add/play-next APIs. update the touched module
contracts/comments; close issue tickets only after behavior is proven.

## 7. explicit costs and boundaries

| choice | accepted cost |
| --- | --- |
| distinct visible grip/menu | another focus stop and less title width |
| stationary rows/source-sized preview | less animated arrangement; blank preview space where omitted metadata appeared |
| visible insertion boundaries | tall or clipped rows can require extra scrolling before a drop |
| complete custom-order view | loading delay for large libraries; no filtered drag |
| up/down only | distant keyboard placement remains repetitive |
| one pending move; explicit conflict | one server round trip between moves; concurrent edits require fresh intent |
| revision sequence and conditional writes | migration plus every structural writer must participate; no historical command receipt |
| complete `/order` read | one extra narrow endpoint and linear id payload; avoids recovery pagination and metadata hydration |
| shared lectern payload/order owner | a small dedicated read lifecycle replaces the generic hook here so recovery and playback cannot disagree |
| tab journal before sending | unavailable storage blocks reorder; tab closure abandons local recovery |
| integer positions and existing core | linear position writes; eventual dependency migration remains separate work |
| hard wire cutover | stale web/native/extension clients must reload or update together |
| temporary tests deleted | qualification evidence remains, automatic regression protection does not |

measure large-list geometry and save latency during qualification; do not add
a queue, fractional ranks or virtualization without a demonstrated requirement.
the teardown defect above is in scope. existing general menu, transport and
unconfirmed-add defects keep their separate tickets; this repair does not
silently expand into them. scoped findings remain in the
[open-work register](outstanding-issues.md) until implementation passes.

## 8. implementation and verification receipt

2026-10-16 · product source `d1830dc91` · branch
`codex/index-reordering-20261016` · baseline `69c00182c`.
commits, in order: `49ca31dfb` (revision/api/storage), `ebd64fcd9`
(actual-isolation teardown retry), `8613a6b9c` (shared browser owner, caller
migration, grip/geometry), `d1830dc91` (native touch scrolling).
principal-actions received the paired interface and these hashes; its projection,
origin guards and membership recovery copy remain its separately owned work.

qualification used disposable postgres 15/pgvector, supabase password sessions,
minio, migrated api/bff, normally uploaded pdfs and public podcast acquisition
against a signed metadata/audio fixture. no production data, auth bypass,
fabricated application successes, retained test switch or deployment.
host: macos 26.4.1; desktop chromium/firefox/webkit via playwright 1.59.1;
physical samsung sm-s906w, android 16, chrome 155. handset gestures used trusted
os touchscreen input through adb, rather than a desktop touch emulator.

| proof | result |
| --- | --- |
| baseline red | four backend failures; distinct grip, outside release and source-frame failures reproduced against running baseline |
| strict backend contract | 8/8: required preconditions, cursor fences, explicit no-op fences, exact moves, competing requests, revision encoding, same-id recreation |
| internal ownership | 13/13: ensure/remove/restore/finish/undo no-ops, hidden-slot preservation and real claimed teardown/dense survivors |
| actual caller isolation | 3/3: read-committed append before cleanup triggers exact queue fk/retry and surviving viewer `311→312`; append behind deletion refuses without committing; real serializable undo/restore triggers retry and fence `319→320` |
| ordinary browser interaction | six cases per engine green in chromium, firefox and webkit; actual submitted actor/successor and persisted order agree |
| browser state | 8/8: before-delivery and after-commit loss, exact reload replay, stale get/ack fencing, fresh conflict, filters/sort, storage refusal, real cursor rejection and complete 106-row restart |
| lifetime | 3/3: shared pending slot, origin closure, reload/signout/account isolation, old completion versus newer journal |
| uncertainty boundaries | stalled successful body and stalled canonical read both meet the 30-second attempt bound; real retry409 and recovery404 preserve uncertainty; a greater read/recreated empty collection fences it |
| empty/single row | no drag/write; one-row movement menu exposes both unavailable directions |
| live playback | 4/4: strict lectern acknowledgement/reload, actual decoded next playback, menu play-next, transcript play-next while current audio continues |
| geometry | header/blank/beside-pane/resize cancel without writes; own-pane autoscroll596px targets a newly visible row; real161px row inside114.3125px port requires a visible edge |
| physical touch | line predicts acknowledged save and reload; grip drag never also refreshes; interruption writes nothing; ordinary native scroll159.67px and one pull-refresh work after the css fix |

one local 106-row save took **28.391ms** from request start through response-body
completion (`request.timing().responseEnd` after `response.finished()`). this is
one local observation, not a production latency claim. frozen frame, title
metrics/truncation and grab offset were measured directly.

adversarial review corrected the read-committed fk assumption, equal-revision
visibility/read invalidation, account callback retirement, receipt-only revision
floors, source font shorthand and directional touch restriction. no new queue,
generic mutation framework, second full lectern reader or compatibility path.
two false failures were isolated to the temporary harness: an aborted cursor
request let its replacement beat the mutation; a held acknowledgement was still
in flight at test teardown. repaired causal gates passed without product edits.
the owner's final instruction stopped further accessibility qualification.

build/cleanup: production `bun run build` passed; its configured standalone
server passed a real pointer move/acknowledgement/reload check against the api,
using the built assets and direct bff transport. android wire2 debug assembly and
extension builds passed. after deleting the temporary tests, fixtures, auth/data
volumes, traffic-control processes, browser storage/profile artifacts and owned
adb ports, final `./scripts/test` passed with migration head `0287`. only concise
receipts and source remain; the explicitly requested principal handoff is retained.
no release was deployed or installed on the shared handset. all scoped tickets
are resolved; their register entries and ticket files were removed.
