# mobile command palette: implementation contract

status: implemented; final production-build and physical-device qualification in progress.
origin: 2026-10-16 owner review; interaction/content, identity, and integration
specialists, followed by independent adversarial review.
implementation baseline: `4d5970de7dd3963d7862a6e3db3b99feb2f68925`.
integrated prerequisites: overlay `6d02203ee` in the baseline;
principal-actions `1397143d2` as `d29e74ccd`; pane-tabs `395a6d1fc` as `2a6bb4f7a`.
owner decisions: reset saved workspace state; physical android chrome and the
nexus android app are mandatory. ios is separate coverage.
verification amendment: owner waived accessibility qualification on 2026-10-16.
retain functional keyboard/back/focus/touch checks and visual phone checks;
no screen-reader, contrast-ratio or enlarged-text conformance campaign.

## goal, scope, final state

good software makes identity recognizable and consequences predictable. here:
a quiet, legible index to the workspace; navigation before typing; explicit
search submission; real titles without opening readers.

deliver mobile overview/search, complete tab identity, all-tabs close/focus,
and preservation of existing creation/import/playback capabilities. retain one
full-screen task, one entrance, existing count/swipe acceleration, command
dispatch, overlay and viewport owners. desktop keeps its composition and
submission behavior; it receives the same corrected titles.

exclude pane uncapping/reordering/maximize, global search/error-policy rewrites,
creation-lifecycle repair, new navigation infrastructure, ranking/index changes,
ai routing, covers/screenshots, new fonts, native ui, telemetry, and deployment.
the [pane-tabs plan](pane-tabs-plan.md) owns its separate changes.
integration prerequisite: consume the committed principal-actions row contract
and overlay contract below. the integrated pane-tabs change uncaps panes;
bounded title batching is therefore required. retain no old row contract.

## interaction and capability contract

one controller owns raw `query`, existing `NexusPage`, and mobile root mode
`Overview | Search`. mode is explicit; blur never changes it.

| input | required behavior |
|---|---|
| fresh physical/programmatic root opening | overview, empty query, heading focus, keyboard down; reset root scroll |
| mobile cmd/ctrl+k | from closed, empty search; within this opening, refocus search without clearing query; respect child workflow/overlay ownership |
| search field focus/input | latch search; preserve caret; keyboard follows deliberate focus |
| clear | empty search, input focus, recents; remain in search |
| search back/plain escape | overview; retain draft and overview scroll; heading focus, keyboard down |
| overview back/done | close; restore usable original opener, otherwise active pane landmark |
| nested menu back/escape | menu owner handles it first; root mode/query survive |
| android back | the keyboard may consume the first press; only an app-delivered back advances the task |
| empty input submit | no action |
| ordinary query submit | existing full-search target from parsed query, `Follow`; never implicit ask |
| recognized intent submit | its explicit typed target from `parseNexusQuery`; show the named action before execution |
| actual navigation-row activation | execute that row; close after acceptance; focus exact destination, including current/same pane |
| workflow action | enter existing workflow within task; preserve request identity and retries |
| playback resume | resume existing playback; close and return to opener |
| all-tabs close | stay open; focus next row, then previous; final close creates/focuses replacement lectern |
| all-tabs back | ordinary manager → overview/all-tabs trigger; retained manager → blocked recovery with the identical retained target |
| root direct close | close that named pane without activating it or dismissing nexus; next/previous surviving row gets focus, otherwise search input or overview all-tabs trigger |

input uses `enterKeyHint="search"`, or `"go"` for explicit intents. composition
confirmation never submits. native input editing stays native; results/menu
buttons use tab/enter/space. deliberate row shift-activation retains `Fork`.
mobile loses virtual up/down result selection. automatic first-row state cannot
authorize submission. actual row focus/pointerdown preserves existing late-result
stability. retain click admission against the opening pointer gesture.

overview order is fixed: header/account/done; search; up to three visible open
tabs; `all tabs · {n}`; six places; today/new/import; paused-playback resume.
for visible panes in workspace order, current index `i`, count `m`, start at
`max(0, min(i - 1, m - 3))`; take three. all-tabs always exists; its `n` counts
all panes, including minimized. places: lectern, libraries, browse, podcasts, chats, notes;
two columns when content fits, otherwise one. recents occur only in empty search.

typed search prioritizes actual matches, with one `search all results` action.
`use this text…` is the existing `ActionMenu`: ask/add to today/browse/create.
explicit parsed commands retain a direct named action. preserve existing result
limits/ranking and full-search serialization. retrieval is active only for root
search, or desktop root; an overview's retained draft must not keep searching.
reuse `useNexusFind` debounce, partial results, retry and delayed busy state.
retain the existing `NexusList` for the exact query while search is hidden; do
not overwrite it with disabled reads. on return, paint those rows and restore
scroll while refreshing. recompute local panes immediately: a closed pane can
never survive as a stale `PaneOpen` action. each successful remote source replaces
its prior rows; each failed source retains its successful exact-query rows with
retry feedback. a changed query starts a new list. no cross-opening search cache.

finite returns, not a page stack: `ChooseCreate` carries draft, root mode and
invoking-control key; overview new passes empty text. `ChooseBrowse` carries
query and search origin. `CreateLibrary` returns either to that exact create
chooser or its invoking root. back restores the originating control; it never
reopens the use-text menu. add retains its own dirty/uncertain/stop/close rules.
retain `Blocked/Retained` recovery while the pane cap exists; ordinary reopening
must not resurrect a previously closed manager. do not reintroduce cap recovery
if the separate uncapping change has already removed it.

capture opener once per closed-to-open transition, before autofocus. keep root
scroll positions only for this opening. rotation within mobile changes geometry.
breakpoint changes retain query/page/operation ids, suppress retiring-shell
return focus, and transfer focus to the replacement shell: the field if editing,
otherwise heading. desktop root becomes mobile search; mobile root becomes the
existing desktop combobox. editor-entry focus outranks generic destination focus.
use the existing mobile classification; its landscape limitation remains ticketed.

## visual and content contract

each package has its own content designer below; the designer owns meaningful
examples and rendered copy within these schemas, not an additional framework.
new interface copy is lowercase. resource names preserve their original spelling.

| feature / designer | good content and presentation |
|---|---|
| overview / navigation designer | heading `workspace`; `account`, `done`; field label `search`, placeholder `find anything…`; headings `open tabs`, `places`; accessible all-tabs name `all {n} tabs` |
| search / retrieval designer | `search`, `back to workspace`, `clear search`, `search all results`; menu `use this text…` → `ask nexus`, `add to today`, `browse…`, `create…`; show actual returned excerpts only |
| creation / workflow designer | `today`, `new…`, `import`; blank chooser `new` → `quick note`, `page`, `chat`, `library`; nonempty chooser `create from text`, two-line actual draft, first option `add to today`; browse choices articles/podcasts/videos/books; retain library name/create/creating/retry states |
| tabs / identity designer | actual title first; at most two useful secondary facts: real author/source and human-readable kind; `current` and `minimized` are states, not identity; no `tab · open`, raw scheme, slash aliases or invented descriptions |
| manager / navigation designer | `all tabs`; groups `open`, `recently closed`; full wrapping titles; accessible `close {full title}` / `restore {full title}`; local close stays available |
| playback / navigation designer | `resume {episode title}`, actual show/source if known; no fabricated progress |

one canvas, one content scroller, fixed header/search, 16–20px side gutters.
title: existing sans, 16px equivalent, medium; secondary: 14–15px equivalent.
rows approximately 64–76px at default text size, growing with content; every
changed shell/row touch action at least 48px; reused shared menus retain their
44px targets. preview/result titles and matched excerpts clamp to two lines;
full titles remain in accessible names, excerpts in accessible content. manager
titles wrap fully. use spacing and quiet headings instead of rounded group slabs.
current has a subtle wash plus text, distinct from focus/press. retain shared
overflow-button appearance. existing themes/fonts/tokens; no decorative fetches.
short existing motion only; reduced motion removes displacement.

status copy is part of correctness:

| state | rendering |
|---|---|
| search delayed busy | visible `searching…` beside field; reserve its space, do not move results |
| successful settled empty | `no results.`; never show during pending/partial failure |
| search source failure | `couldn’t search your resources.` / `couldn’t search inside your library.`; visible `retry`, successful rows remain |
| empty recents | `search your tabs, library and commands.` |
| unknown title, active lookup | `loading title…`; keep an existing name during refresh |
| live new note before acknowledgement | local title plus `unsaved`; a missing server row does not erase live writing |
| preview without hint/lookup | route-kind label plus `open to load title`; never a permanent spinner |
| title read failed | known name or kind label; `couldn’t refresh title` / `couldn’t load title`; one local `couldn’t refresh tab titles.` notice with `retry` |
| confirmed missing/inaccessible | visibly `unavailable`; no false loading or transport inference |

one polite search status region announces failures and `{n} results shown.`
(preview count), not automatic row selection. unavailable commands retain their
owner's visible reason and cannot execute. unavailable identity does not disable
opening an existing tab: its destination owns content errors.

preserve native control semantics and the existing modal primitive. use readable
theme tokens and visible focus. 48px is our palette touch target; shared menus
retain 44px. accessibility qualification is outside the requested verification.
account, imports, download settings and existing resource actions remain reachable.

## identity architecture and api

resource owners supply canonical facts; workspace owns visits and display hints;
the existing text owner supplies live writing. one workspace projection feeds
nexus, manager, pane chrome and document title. body mounting owns none of them.

add authenticated, read-only `POST /me/workspace-presentations` through the
existing bff (`/api/me/workspace-presentations`). python owns the schema;
generate web types using [typed-wire](local-rules/typed-wire.md), no web decoder.

```ts
// wire contract; all fields required, nullable values are explicit null
type WorkspacePresentationLocator =
  | { kind: "resource_ref"; ref: string }
  | { kind: "contributor_handle"; handle: string }
  | { kind: "daily_date"; local_date: string };
type Request = { locators: WorkspacePresentationLocator[] };
type Presentation = {
  resource_ref: string;
  title: string;
  media_kind: MediaKind | null;
  contributors: ContributorCreditOut[];
  source_label: string | null;
  text_version: number | null;
};
type Response = {
  data: { items: {
    locator: WorkspacePresentationLocator;
    presentation: Presentation | null;
  }[] };
};
```

accept 1–100 unique canonical locators. allowed resource schemes: `media`,
`library`, `conversation`, `podcast`, `page`, `note_block`, `artifact`,
`oracle_reading`. reject unsupported/malformed locators through existing
invalid-request behavior. the route projection excludes malformed locators with
existing `parseResourceRef`, `isContributorHandle`, and `isLocalDate`; mark that
pane unavailable rather than poisoning its siblings. return exactly one item per
input, in order. null means valid but missing/invisible ONLY. use the existing
repeatable-read session and viewer visibility predicates, with batched narrow
queries per kind. no writes, materialization, consumption refresh or provider
calls. reuse domain readers/predicates; extract facts rather than cloning gates.

| locator / route | authoritative read |
|---|---|
| media | raw title, kind, ordered contributor credits; known show title or source hostname |
| library / conversation / podcast | visible canonical title; library display semantics preserved; podcast credits where available |
| page / daily date | `notes.page_facts` and daily binding/title; latent daily uses deterministic page identity/date title without creation |
| note_block | first `body_text` line, trim/collapse whitespace, at most 512 unicode code points (511 + ellipsis on overflow); same projection locally, owner-filtered read without body hydration |
| artifact / oracle_reading | canonical subject title under the head's audience/subject gate / owned question; no html, interpretation or argument bodies |
| contributor_handle | author-route visibility; generic contributor lookup is insufficient |
| browse preview | route-bound hint, updated only by actual preview resolution; excluded from batch |
| static/query routes | existing route model; derive stats year there; no body publication |

dossier tabs use the subject's canonical workspace title; their kind identifies
the dossier. they may omit the reader heading's author decoration or show a
fuller note excerpt. graph labels remain the graph owner's presentation; the
workspace does not hydrate that owner to reproduce its formatting.

`text_version` is the page title/note body resource-version lane, otherwise null;
latent daily uses its existing initial version. all other absent facts use null
or empty credits. canonical titles are not shortened for layout; note titles
are the defined first-line excerpt. reuse credit-name/author-role formatters:
first two actual authors then `+n`, otherwise known source; append kind. never
promote hosts/channels into authors. kinds: article/book/pdf/episode/video for
media; library/chat/podcast/page/note/dossier/reading/author otherwise. daily uses
`page`; preview uses `preview`. genuinely empty names render `untitled {kind}`.
unavailable without a name renders `unavailable {kind}`; with a name, retain it
and show `removed or no longer accessible`. a failed unnamed read renders its
kind label plus `couldn’t load title`. identity status outranks ordinary metadata.

freeze this frontend handoff (types here describe implementation, not wire):

```ts
type PanePresentation = {
  title: string;
  detail: string | null;
  status: "Ready" | "Unsaved" | "Loading" | "Unresolved" | "Unavailable" | "Failed";
};
declare function useWorkspacePresentations(): {
  forVisit(visit: PaneVisit): PanePresentation;
  retryTitles(): void;
};
// store command; reject a mismatched current pane/visit/title key
declare function setVisitTitleHint(input: {
  paneId: string; visitId: string; titleKey: string; title: string | null;
}): void;
```

`forVisit` is nonthrowing and handles current/history/closed snapshots; looking
up a closed visit never starts a read. `NexusPane` carries the presentation,
including status. title is rendered text, including specified placeholders;
these never become hints. consumers cannot invent another title owner. expose
only matching-preview publication through pane runtime; canonical publication
stays internal to the projection/store.

mount the projection inside existing workspace/imports providers, above nexus/host; put only
its read child below a local error boundary. use `usePaneFreeServerValue`, keyed
by account, sorted distinct current locators and read revision. include minimized
panes, exclude historical/closed visits until reopened. skip empty sets. current
panes are uncapped: read sequential chunks of at most 100 and publish the complete
batch. cost: additional round trips above 100; a failed later chunk retains known
names and marks the batch failed, without a separate partial-batch error policy.
keep last successful facts for retained locators; prune removed locators; discard
all title state when the authenticated account changes.
workspace saving/content remain outside the failure boundary. modeled failures
are data; unexpected defects are reported locally and cannot poison other owners.
retry resets the read boundary and advances revision. no throwing shared getter,
bootstrap dependency, independent cache service, per-pane reader requests or polling.

refresh on locator changes, `Libraries/Entries/Metadata/Podcasts/Chats/Notes`, task opening,
return to foreground and reconnect. advance the request key on invalidation so
an older read cannot publish after it; use existing change topics, never consumption.
note acknowledgements publish `Notes`, as page titles already do; accepted chat
sends already publish `Chats` in `lib/chat/drafts.ts`, so reuse that. contributor
visibility also follows the existing committed link observer. the outline owner
publishes `Notes` after committed deletions, `insert_resource`, and `remove`,
including removal of a contributor's last visible edge. successful assistant undo
also publishes `Notes`; committed context detachment announces through the existing
link observer. successful highlight deletion publishes `Metadata` because its
edge cascade can remove a contributor's last visible link. cost: ordinary linked-item
edits and assistant undo refresh retained titles, and highlight deletion refreshes
titles and media summaries, even when their names did not change. these are committed-write signals;
title reads never republish them or trigger a read loop. contributor edits replace
private bibliography invalidation with `Metadata`, which already
refreshes media summaries. these coarse committed-write topics refresh retained
titles; do not publish per keystroke or call both invalidators. same-account
duplicates share facts; a response can update only its own locator, never a newer
destination. stale/failed reads retain names with honest status.
also consume existing `useImports().observation`; publish `Metadata` from the
existing podcast subscription terminal-event callback after sync/backfill settles.
these follow worker-produced names through existing observers; add no poll/stream.
when those observers are inactive, the next task-open/foreground/reconnect refresh
supplies current names. import observations may refresh titles that did not change.

for a nonnull page/note result, unsettled live text wins; otherwise acknowledged
text wins only when its version is at least `text_version`; newer canonical text
wins otherwise. for null, live unacknowledged text that is not gone remains
`unsaved`, including failed saves. persisted dirty text retains its typed name
WITH unavailable status; clean text/hints cannot conceal unavailability. use
`texts.ts`'s existing dirty/conflict/timer/queued/gone state and one read-only
subscription to project current title and acknowledged title/version. no new
save lifecycle, copied dirty logic or `adoptText` from a title excerpt.

## persistence and hard cutover

add required `title_hint: string | null` to every `PaneVisit`, including current,
back and forward. no default accepting the old shape. a hint is last-known
display evidence, never authority or proof of access. collapse whitespace;
nonempty strings, maximum 512 unicode code points; overflow becomes 511 plus
ellipsis. this bound does not limit canonical titles.

publish hints only from accepted navigation/settled identity or matching preview
resolution, against captured `{paneId, visitId, titleKey}`. `titleKey` is the
canonical locator, or the preview's exact sealed target. accept only explicit
semantic `labelHint` at navigation; remove generic menu-text inference in
`targetLinkActivation.ts` (`open in new tab` is an action, not a title).
preserve on same-resource view replacement; clear on a different resource/preview target. carry through
history/reopen. never persist drafts/placeholders; equal updates do nothing.
forking a tab carries only its existing visit hint. tab-selection history uses
that hint, or the projected title only when ready (including static routes).
cost: an unnamed unsettled tab produces no recent-selection record until settled
identity exists; live draft text cannot return later as a durable navigation hint.
choose acknowledged/canonical hint text using the same version precedence;
an accepted stale response cannot replace a newer acknowledgement. known-empty
canonical text clears the hint instead of reviving an old name.
use the existing serialized/debounced saver, never per-keystroke workspace saves.

one forward migration deletes `workspace_sessions` rows across devices.
layouts, tabs and navigation history reset; content, libraries, notes, ownership,
credentials and playback progress remain. no conversion, dual reader, runtime
repair/reset, legacy field or compatibility path. present invalid rows still fail.

raise existing global `WIRE_REVISION` once for the release; regenerate wire,
rebuild web, extension and android apk together. the bff forwards the caller's
revision; old writes receive 426 before schema validation and cannot recreate
old sessions. this gate also rejects old extension/native requests; native queued
work retains its existing retry/update behavior. no native source change is
inherently required. use existing stopped-writer, backup, migration and release
invariants. rollback is not lossless: old code cannot read the new strict schema.
deployment is a later action, not part of writing or implementing this plan.

## exclusive work packages and handoffs

web paths below are relative to `apps/web/src`. freeze emitted interfaces before
parallel implementation. a package owner and its feature designer review their
fixtures/copy together; a different specialist challenges each completed step.

| owner | exclusive files / responsibilities | emits |
|---|---|---|
| a — server identity and cutover | new `python/nexus/{schemas,services}/workspace_presentations.py`; `api/routes/me.py`, `api/edge.py`, `schemas/workspace_session.py` under `python/nexus`; narrow existing domain-reader changes; next canonical reset migration; generated `lib/api/wire.gen.ts` | endpoint, visibility/version semantics, strict visit schema |
| b — workspace identity and identity designer | `lib/workspace/{model.ts,store.tsx,presentations.tsx}` (new projection); `lib/panes/{paneRouteModel.ts,paneRuntime.tsx,targetLinkActivation.ts,paneHeaderModel.ts}`; `lib/notes/{texts.ts,useOutline.ts}`; `lib/assistantWrites.ts`; `lib/resourceGraph/links.ts`; `lib/api/changes.ts`; `lib/podcasts/api.ts`; `components/contributors/MediaAuthorsEditor.tsx`; dead bibliography-invalidation export in `lib/media/MediaSummaryProvider.tsx`; `components/workspace/{WorkspaceHost.tsx,PaneShell.tsx}`; `components/ui/PaneHeaderIdentity.tsx`; `app/(authenticated)/AuthenticatedShell.tsx`; `app/(authenticated)/media/[id]/annotations.ts`; all retired body-label callers below | shared presentation/retry contract, hint publication, exact committed close selection |
| c — mobile interaction and feature designers | `lib/nexus/{model.ts,rows.ts,query.ts,useNexusFind.ts}`; `components/nexus/{useNexusController.ts,Nexus.tsx,NexusPages.tsx,NexusRow.tsx,Nexus.module.css}`; `components/switchboard/{SwitchboardTask.tsx,NexusButton.tsx,CreateLibraryPanel.tsx}` | modes, explicit submission, finite returns, mobile surfaces/copy/focus |
| integration/proof — one owner | documentation/issue register; temporary external harness/evidence; coordinated builds and device qualification; shared-file scheduling | independent review and exact-candidate verification receipt |

b owns removal of `useSetPaneLabel` from `components/chat/Conversation.tsx` and
the media, oracle-reading, stats, author, page, browse-preview, notes-index, note,
library, artifact and podcast-detail pane bodies. previews get a narrow
matching-visit hint command; other bodies lose title authority. retire runtime
body-label storage/setters and obsolete route loading-label behavior. reuse
existing media/credit formatters; remove the now-unused private bibliography
invalidator, but keep `MediaSummaryProvider` lifecycle/defect repair separate.
do not use heavy `resource_items_out` as the new read.

b exposes `closePane(paneId): {paneId, visitId}`, the exact committed active
selection. c absorbs that token for its own root/manager closes before
the navigation effect runs; external navigation still dismisses. this is the
same bounded close slice in [pane-tabs](pane-tabs-plan.md), implemented once.
one integrator schedules shared controller/model/pages/css edits across plans;
chat's owner hands off its label call removal to b. no concurrent competing edits.

principal-actions owns the shared row cutover: `NexusRow.secondary` is optional,
either `{kind: "ResourceMenu"; resourceRef: CanonicalResourceRef}` or
`{kind: "CloseTab"; paneId: string}`. it replaces `NexusRow.menu`.
mobile renders resource menus through
`NexusRowMenu({row, menuProps})` and tab close as a sibling direct button invoking
the controller; no `closePane` menu prop or `Tab` compatibility. desktop owns its
direct close and opens only `ResourceMenu` with cmd/ctrl+k; mobile's root shortcut
still enters search. reuse the public overlay ownership APIs
`getInteractiveOpenGeneration` / `useInteractionBlocked` where needed, and native
menu tab exit from `6d02203ee`; c does not implement another overlay policy.
the integration owner serializes `model.ts`, `rows.ts`, `NexusRow.tsx`, controller
and shared css changes after principal-actions, preserving its committed contract.

c removes mobile unconditional autofocus, virtual arrows/active-row submit,
active-key scrolling/narration, query-clearing-before-back, first-five tab
composition and unused `.quickNoteHandoffInput`. narrow manager button selectors.
reuse `MobileFullScreenTask`, `ModalFrame`, `ActionMenu`, `OverflowMenuButton`,
resource actions, activation planner and viewport owner. isolate mobile css.
do not retain the old mobile path behind a flag.

## red → green → refactor → delete

the owner explicitly requests temporary live tests: a task-scoped exception to
the retired-suite policy. `./scripts/test` stays the sole repository gate,
unchanged; no permanent test dependency, runner, suite or production seam.

1. contract: adversarial review of actual schema/copy/ownership; settle material
   contradictions before coding. every feature gets a content fixture including
   long, duplicate, empty and failure examples where meaningful.
2. red: task-owned harness outside the checkout, pinned drivers, isolated real
   database/api/web/auth. ordinary sign-in and product apis; browser → bff → api.
   record genuine baseline failures separately from preservation passes.
3. green: implement a/b/c through the frozen handoffs. keep successful responses
   real; delay/release/abort actual traffic for races. no injected react state,
   fake auth, fabricated success payloads or test-only exports.
4. refactor: reviewer attacks identities, focus, replay and error containment;
   remove replaced paths/duplication; rerun affected journeys and
   `./scripts/test`. review the served candidate, not just the patch.
5. delete: save a concise verification receipt, then remove task-owned tests,
   drivers, dependencies, fixtures, credentials and services. inspect cleanup and
   run the unchanged static gate. no deletion of unrelated work.

| acceptance case | required observation |
|---|---|
| reset/wire | every saved workspace reset; sampled content unchanged; old-revision save 426/no write; matching-revision old shape rejected; new visits include nullable hint |
| cold identity | every route above, minimized tabs, duplicates/long names; nexus/manager/chrome/document title agree without inactive bodies or preview-provider calls |
| races | delayed old read cannot rename another visit; duplicate panes converge on rename; unsaved new notes survive null reads; dirty/clean text versions and saved hints obey precedence; view replacement/history/reopen preserve the right hint |
| failures | loading/unresolved/unavailable/read failure distinct; retry recovers; retained names and session saving survive; prove local unexpected-defect containment separately if genuine backend triggering is unavailable |
| overview/search | keyboard down on entry; explicit search and mobile shortcut; clear/back/menu/re-entry; ordinary submit never asks; explicit command/ime/native editing; delayed and partial results truthful |
| navigation/manager | current/same-pane focus; root/manager direct close stays open and focuses successor, including final pane; closed panes disappear from retained search; recent-close restore and external navigation dismiss; share pane-tabs close proof |
| workflows | no request-id replacement or duplicate command from new mode transitions; existing uncertain retry/import exit guards and exact cap-retained target preserved |
| visual/usability | one/six/twelve and >100 panes after integrated uncapping; normal phone widths, three themes, long identities, touch targets, visible focus/state, account/import/download access; desktop preserved |

run the matrix in chromium; repeat changed focus/input/overlay/reflow journeys
in firefox and webkit. physical android chrome AND matching nexus apk must pass
keyboard, back, rotation, menus, tab management and destination focus; record os,
browser, system-webview provider and apk hash. unavailable devices/fixtures are
blocked, not green. physical ios is optional recorded coverage; desktop webkit
does not establish ios behavior.

receipt: baseline/candidate sha plus digest of uncommitted implementation;
actual api `/version`, database head, process/source identity; production next
build id and fetched-asset hashes; generated wire and device versions; observed
results, screenshots and limits. verify the same served identity after final
qualification. subsequent implementation edits invalidate affected proof.

## decisions, costs, remaining boundaries

| decision | cost accepted |
|---|---|
| overview first, three-tab preview | one extra tap to type; distant/minimized tabs need all-tabs |
| one full-screen task, top search | background hidden; top field less thumb-reachable; avoids a new detent/keyboard layout owner |
| matches before alternative text actions | ask/create/browse gain a tap; mobile virtual-arrow accelerator is removed |
| two-line preview | less visible title text there; full names remain in manager/accessibility |
| reuse shared menus and within-opening results | menus stay 44px; returning search may briefly show matching older rows while refreshing; no menu rewrite or durable search cache |
| independent batched title read | extra bounded metadata reads, including unchanged import observations; worker names follow existing observation/refresh timing; avoids consumption/media-cache coupling |
| durable 512-point hint | small wire/state expansion; stale or shortened last-known names offline; canonical reads restore full current names |
| strict reset/global wire bump | saved workspace lost across devices; matching web/extension/apk update required; no compatibility or lossless rollback |
| temporary proof then deletion | one-time behavioral evidence, no continuing regression coverage; live repair/manual qualification remain necessary |

fix and then delete the [title](tickets/workspace-restored-pane-titles-depend-on-mounted-bodies.md),
[search progress](tickets/mobile-nexus-search-progress-is-invisible.md),
[search key](tickets/mobile-nexus-search-key-can-open-chat.md),
[focus](tickets/mobile-nexus-places-leaves-focus-on-body.md) and shared
[manager-close](tickets/manage-tabs-active-close-dismisses-task.md) tickets only
after their acceptance passes. keep separate: [media-summary poisoning](tickets/media-summary-defects-poison-all-consumers.md),
[retrieval defect policy](tickets/nexus-retrieval-defects-replace-the-workspace.md),
[creation lifecycle](tickets/nexus-library-create-completion-outlives-page.md),
[landscape classification](tickets/phone-landscape-exceeds-mobile-layout-cutoff.md)
and [mobile keyboard proof](tickets/mobile-keyboard-inset-has-no-browser-proof.md).
record any unaddressed finding in its own ticket/register entry; no silent scope growth.
