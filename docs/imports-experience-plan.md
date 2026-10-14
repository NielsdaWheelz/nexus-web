# imports experience: implementation contract

status: implemented; qualification recorded in [verification](imports-experience-verification.md).
owner: imports. emphasis: recover failed or incomplete imports while keeping usable content accessible.
review: contracts, interface/content and verification specialists; independent source and live reviews.

base: [pane-controls pr #578](https://github.com/NielsdaWheelz/nexus-web/pull/578),
`6b9909ed74c55f1c6febff0f02415b5121a92094`, or its integrated descendant.
use that implementation's shared controls. pr #578 merged as `fa62a6901` on 2026-10-14;
its final head `5460cc041` has identical web source to this approved baseline.
the initial proof qualifies that baseline. the merge follow-up integrates main
`5dac2889e`, including lectern, fixed shortcuts, x titles and session entry;
combined qualification is recorded separately in verification.

## goal and invariants

the first scan answers: what is this, what can i use, what needs attention, what can i do?
remove repetition; retain facts needed to act.

- preserve needs attention, in progress and history. attention takes precedence;
  its rows still show concurrent work. history includes unfinished imports.
- source, search and metadata remain independent obligations. absence is not success;
  completion is not readiness; no-findings is not failure.
- preserve owner classification, ordering, cursor binding, recovery identities,
  replay, observation and polling.
- one import ref per result; multiple upload receipts may refer to one media item.
  publication never changes an upload ref. no guessed identities or redirect aliases.
- hard cut contracts and consumers together; delete replaced paths.

[imports](modules/imports.md), [add content](modules/add-content.md),
[typed wire](local-rules/typed-wire.md) and [verification](local-rules/testing-standards.md)
remain authoritative outside the explicit changes below.

## target surface

| surface | required final behavior |
|---|---|
| shell | modes in `PaneChrome.navigation`, query in `PaneChrome.query`; shell positions controls, each surface owns its content scroll. use labeled navigation with current-item semantics, not a detached `TabsList`. |
| modes | attention/progress show their unfiltered row count once. history has no invented global count. preserve initial-view selection and url state; later counts never switch modes. |
| query | reuse `PaneQueryToolbar`: draft/submit, immediate clear, reset, native single-choice filters, inline options, three-way recorded-failures filter. preserve url/date semantics. disambiguate reason-filter labels/groups. |
| results | one flat `ResourceList` of `ResourceRow`s in server order. no stage cards, duplicate summaries, routine state pills, fixed-sort prose or healthy-refresh timestamp. query status owns filtered/loaded totals; continuation remains explicit. |
| row | title selects details, always. one consequence states usable capability plus the primary problem/activity; optional context preserves additional attention/concurrent work and historical match. quiet provenance/time. expose primary recovery, usable-content “open”, then overflow. no destructive primary action. |
| inspector | existing companion/mobile sheet: consequence and open first; compact source/search/metadata sections with independent explanations/actions. source-quality warnings affecting use stay visible; history/diagnostics disclose below. |
| history | collapsed initially except when the selected row matched a historical event; expose that event and current state together. preserve user disclosure choices across refresh. keep partial-coverage wording; never fabricate missing attempts. |
| empty/error | distinguish no matching results from no imports in this view. offer reset for active filters. failed refresh retains facts with a stale notice and retry; failed continuation retains rows/events with retry. a genuinely absent notice occupies no space. |

reuse existing visual tokens, focus treatment and coarse-pointer targets. narrow titles
wrap to two lines; actions wrap; row height cannot clip content. selection, hover and
focus remain distinct. essential meaning cannot depend on color, hover or truncation.

## wire and owner changes

all new output fields are required; domain absence uses existing `Presence<T>`.
generate web types from python; do not add same-deploy json decoders.

| contract | exact change |
|---|---|
| `ImportItem` | add `readiness: ImportReadiness` and `original_filename: Presence<NonemptyString>`. published title is the current media title; unpublished title is the normalized original filename. filename is present for upload rows, absent for media-only rows. |
| `ImportReadiness` | retain `{can_read: bool, can_search: bool, can_play: bool}`; derive once from hydrated media capabilities, or all false before publication. remove the duplicate `ImportDetail.readiness`. |
| item capabilities | delete unused `can_open`; retain `can_remove` and its existing unpublished-upload policy. resource actions authorize published-content commands. |
| `ImportPage` | delete `groups`, `ImportStageGroup`, stage-count aggregation and group-count validation. keep `items`, `matched_count`, `next_cursor`, `observed_at` and other coherence checks. derive web `ImportStage` from `ImportStateNeedsAttention.stage`. |
| upload waiting | add `AwaitingUploadConfirmation` to `WaitingReason`. active unpublished upload projects `Active / Queued / Upload`, that present reason, absent progress and absent retry time. existing failure/expiry branches win first. |
| acceptance receipts | add required `import_ref: ImportRef` to `FromUrlResponse`, `UploadRequired`, `Published`, `NeedsAttention`. upload outputs name their exact session, including attention results, confirmation and replay. generic error envelopes stay unchanged. retain command-addressing `session_handle`. |

search current title, original filename and source host with the existing escaped server
query in every view. filename appears beside differing titles and always in details.

document capabilities use the reader-publication owner's shared eligibility predicate:
eligible kind, persisted `ready_for_reading`, and an existing publication. pdf also
requires its original file. project this fact in existing batch media reads; use it
for read/highlight/quote and the queryable quote projection. preserve transcript,
playback, download and recovery policy. never infer readability from an uploaded file.

move ref types/parser/formatter/error/helpers from `schemas/imports.py` to
`schemas/import_refs.py`, updating callers directly. this prevents a media/imports schema cycle.

the current url producer `_from_url_response` emits
`format_import_ref(MediaImportRef(media_id=media.id))`; current url admission cannot
return upload-created media. each upload constructor emits its exact `UploadImportRef`.
source does not depend on the imports service. repeated captures can share media while
keeping distinct upload refs. retain existing admission and transactions.

retain all four authenticated imports read routes, `Data` envelopes, filters and repeatable reads.
update every upload-output constructor and regenerate `wire.gen.ts`. the extension decoder
adds `import_ref` to all three exact-key sets and validates a nonempty string; it may
discard the field since it has no handoff consumer. build/reload that extension;
old binaries will reject the new response shape.

## commands, selection and handoff

**open.** label “open”. desktop uses `Adopt`: reuse an existing matching reader,
otherwise create beside imports. mobile uses `Follow` and back behavior. the workspace
planner owns matching, limits and refusal; no eviction.

expose `activation: ResourceActionSnapshot["activation"] | null` on the existing
`ResourceActionMenuModel`; only an actually ready cache entry supplies it, not loading,
reconciling or failed entries. usable means `can_read || can_play`. keep its open control
visible but disabled while the action snapshot is unavailable. invocation requires a
current route activation and enabled `ResourceAction.Open` descriptor. invoke
`activateResource` with the originating pane's `runtime.activateTarget` and title hint.
share row/inspector action composition; retain global menu dispositions.

**recovery.** select the primary action from the obligation named by server `item.state`;
other obligations retain their actions in the inspector. preserve exact attempt/job/revision
and metadata-review job fences. stale action snapshots offer refresh, never a command
for a different obligation. pass the actual trigger element to canonical actions.
retain pending/uncertain-command behavior and exact-intent replay.
busy inline source/search commands stay focusable with `aria-disabled`/`aria-busy`;
their handler rejects activation. other unavailable states retain native disabling.

**original file.** delete the row's raw filename/kind equality guard and `UPLOAD_KIND`.
keep basic file validation in `retryUploadSession`; `/retry` owns normalized filename,
content-type, size and generation matching before signing or sending bytes.
use `original_filename` for guidance; no duplicate browser matching policy.

**details.** change `ResourceRow`'s button callback to
`onActivate(triggerElement: HTMLButtonElement)` and pass `event.currentTarget`.
selection and visibility are separate: record one pending open intent in state
`{ref, triggerElement}`; consume only when `selected === intent.ref`, in the effect after
that selection's companion publication, then clear it. pass `returnFocusTo` to the shell.
an unchanged ref must also schedule consumption; router replacement may commit later.
first, different and already-selected rows all open correctly. url restoration alone
does not reopen a dismissed inspector. closing retains selection and returns keyboard
focus to its trigger; if removed, use the shell's existing pane-control/landmark return.
remove the unconditional selected-ref mount effect. if recovery removes the focused list
control, adapt `CollectionView`'s focus pattern locally: retain element/ref/following refs
on a capture root mounted across empty results. after removal, focus the surviving row
title, following row, then query input only if focus remains lost and this pane is active.
respect explicit command focus, another pane/input, and connected controls.
retire ownership on a real foreign `focusin`, including a move that returns to body
between list commits; observing only the next layout is insufficient.

bind matched evidence to `{importRef, apiQuery}`; a mismatched key or missing row means
absent evidence. reset history disclosure on ref change; expand a new matched event once,
preserving user collapse for that same match across refresh.

**add → import.** `AcceptedIngest` gains required `importRef`. `uploadIngestFile` accepts
an optional `onImportRef(ref)` callback, invoked immediately after each successful
create response, before attention handling, re-signing, put or confirm.
the add owner stores the known ref on submitting/rejected/unresolved rows under its
existing callback fence; preserve it through phase changes, stop and uncertain failures.
check-status retains the original intent/ref; restaging clears the old key/ref while
reconstructing the editable source/file and destinations.
success copies the receipt's ref. do not wrap unrelated errors to carry identity.

show “view import” whenever a row has a known ref. every `AcceptanceUnresolved` row also
retains its existing “check status” or “retry upload” action, including known-ref rows:
identity does not prove acceptance.
never synthesize `media:<id>`. navigate using `encodeImportsUrl({selected: ref})` and
`secondaryActivation: {surfaceId: "import-detail"}`. add this optional existing workspace
activation type to `NexusTarget.InternalHref`; forward it through dispatch and retained
blocked-target retry. selection in a url is not itself an instruction to reopen details.

use existing `openAddTarget` and guarded leave: cancel preserves rows, files, destinations
and frozen intent; confirmation may stop/discard browser work and navigates on acceptance.
navigation refusal keeps the existing blocked-target flow. no hidden or resumable add session.
receipt copy says “saved”; do not interpret request replay as content duplication.
native outcome repair remains [separate work](tickets/source-replay-is-reported-as-content-duplicate.md).

## content design contract

each assigned designer produces strings and rendered examples under the following content
contracts; another reviewer challenges truth, hierarchy and actionability. no new runtime
content schema. `lib/imports/copy.ts` has one writer; metadata uses `mediaMetadataCopy.ts`.

| feature / designer | inputs → content; definition of good |
|---|---|
| overview / information designer | readiness + primary/concurrent obligations → concise consequence/context: “ready to read · search indexing failed” only when both facts hold. attention need not require user action. |
| recovery / interaction writer | offer/restriction + pending state → what repeats/reuses and canonical action label. unreviewed no-findings: “no metadata found”, exact-job “mark reviewed”. |
| progress / systems writer | stage/reason/measured units/`next_retry_at` → concrete activity or “awaiting upload confirmation”; format recorded deadlines. add owns local preparing/uploading/verifying. no invented transfer, percentage or completion. |
| identity/query / information designer | title/filename/source/query → recognizable identity, truthful count, specific empty/reset copy. zero attention/progress does not prove empty history. no raw enums or placeholder reasons. |
| inspector/history / editorial designer | obligations/events/coverage/errors → explanation before diagnostics, current recovery distinct from past failure, legible retained facts and findable matches. |
| acquisition / interaction writer | receipt/uncertainty/guard → “saved”, “view import”, existing check/retry action, accurate leave consequences. acceptance never claims extraction/indexing completion. |

required content examples: unreadable source failure; readable while indexing; playable
without readable transcript; simultaneous metadata attention and source activity;
unreviewed no-findings; auto-retry deadline; successful item matching an earlier failure;
partial history; stale detail; known-ref upload failure; unknown acceptance.
false capability alone never supplies an invented cause. review all examples at narrow width.

## implementation boundaries

paths below are under `apps/web/src/` unless prefixed `python/` or `docs/`.
freeze contracts/copy ownership first; parallel lanes never edit each other's files.

| lane | exclusive files and responsibility |
|---|---|
| a: contracts | `python/nexus/schemas/{imports,import_refs,media}.py`; `python/nexus/services/{imports,media_source_ingest,media_upload_sessions,capabilities,media,reader_publication}.py`; affected python ref imports; `lib/imports/api.ts`; `extension/uploadSessionContract.ts`. projection, producer-owned refs, schema cutover and shared publication eligibility; existing routes/admission stay intact. |
| b: imports | `app/(authenticated)/imports/ImportsPaneBody.tsx`; `components/imports/` list/toolbar/row/inspector/styles and shared `ImportActions.tsx`; `lib/imports/{copy,query}.ts`; `components/ui/{PaneSurface,ResourceRow}.tsx` and `Button.module.css`; `lib/actions/resourceActionRuntime.tsx`. sole imports-copy writer. |
| c: handoff | `lib/imports/ingest.ts`; `components/nexus/{useAddContentSession.ts,AddPanel.tsx,useNexusController.ts,AddPanel.module.css}`; `lib/nexus/model.ts`. known-ref lifecycle and guarded navigation. |
| d: proof | task-owned temporary harness/fixtures outside the checkout; sanitized verification receipt. independent browser, contract, content and cleanup review; no application edits. |
| integrator | `lib/api/wire.gen.ts`; `docs/modules/{imports,add-content}.md`; this plan, tickets/register. integrate prerequisite, resolve ownership conflicts, run the final static gate. |

retain `usePagePrefix`, `usePaneFreeServerValue`, companion and canonical action owners.
fix optional `PaneSurface` slots through its existing fragment-aware `renders` helper;
do not introspect component output or patch spacing with global css.
delete obsolete groups, wrappers, imports, copy helpers and styles. extract shared actions
from `ImportRow`; otherwise inline one-use code unless it hides substantial complexity.

## acceptance and red → green → refactor → deletion

the user's explicit temporary-test instruction applies to this change. the permanent gate
remains the unchanged, static-only `./scripts/test`; no maintained test suite is introduced.

| id | observable acceptance |
|---|---|
| i1 | one count per purpose, clear consequence/action, independent obligations visible; shared query draft/submit/clear/reset and all filters work in two panes without cross-talk. |
| i2 | healthy view has no invisible notice gap; real loading, empty, failed and stale states have correct layout and recovery. |
| i3 | usable content opens directly; an original file without a readable publication offers download but no direct read. normal publication enables reading. desktop reuses a matching reader or creates adjacent, repeated open does not duplicate; pane cap refuses cleanly. mobile follow/back preserves navigation. recovery and title-selection remain independent of polling. |
| i4 | a signed upload with no put says awaiting confirmation. real browser transfer phases and known backoff deadlines remain truthful. no success inferred from absent obligations. |
| i5 | renamed media title and immutable filename find the same stable import. original filename with whitespace retries successfully; mismatched name/type/size is refused before put. |
| i6 | url receipt names its admitted media; upload create/attention/publication/replay retains its exact ref, including distinct captures sharing media. known-ref lost-confirmation offers guarded view and exact-intent check; unknown acceptance preserves its key. cancel preserves add state; confirm follows discard. installed rebuilt extension completes a real upload and handles real `NeedsAttention` without decoder failure. |
| i7 | more than 50 results spanning stages paginate, refresh and filter without duplicate refs, empty stage sections, false totals or lost continuation. |
| i8 | first/different/same selection opens details; close restores trigger or shell target. disappearing controls reach surviving same-row title → following row title → query, unless canonical action focus already moved. another pane/input keeps focus. |
| i9 | loaded detail/history survives a failed refresh with visible staleness and working retry. unavailable imports show gone, not retained actionable content. |
| i10 | dismissed details stay dismissed after remount, breakpoint round trip and restoration; explicit row/header/add activation reopens them. |
| i11 | switching ref/query never shows another row's match. matched history distinguishes present from past, preserves same-match collapse and states partial coverage. failed continuation retries without losing/duplicating events. recovery/review retain exact owner/job fences. |

1. **red:** build a disposable external harness against real browser → web/bff → api →
   task-owned isolated auth/database/storage and normal workers; no production application
   writes. create fixtures through public operations. record baseline source/build identity.
   demonstrate intended defects; label already-green preservation separately.
   setup failures or blocked assertions are not red proofs.
2. **green:** implement a/b/c after contract freeze, integrate, run i1–i11 and `./scripts/test`.
   induce failure/latency at real transport/vendor boundaries; delayed successful bodies
   stay unchanged. no fabricated success, workflow-row rewrites, auth bypass or app test seams.
3. **refactor:** simplify ownership and remove dead paths; rerun affected scenarios and the
   static gate. full journeys in chromium; targeted geometry/focus/disclosure in firefox and
   webkit. inspect desktop, 320px pane, phone/coarse controls and 200% text. designer judges
   screenshots. record physical-device checks when available; emulation is not device proof.
4. **retain evidence, delete tests:** reviewer signs off actual outcomes and limits in
   `docs/imports-experience-verification.md`: baseline/final source and served-build identity,
   fixture ids, red/green results, screenshots, unresolved blockers and cleanup manifest.
   delete only manifest-listed harnesses, dependencies, fixtures, services, device packages
   and port forwards. preserve sanitized receipts. run `./scripts/test` after cleanup.
   remove tickets only when their acceptance is
   met or explicitly superseded by a documented decision; record the resolution.

each gate requires independent adversarial review: identify/exercise a concrete falsifier
and record objections/resolutions. missing runtime access is a blocker, never assumed green.

## costs and exclusions

- the companion and adjacent reader consume width; they preserve the recovery context.
  reader reuse may focus a pane elsewhere. the user chose reuse over guaranteed adjacency.
- flat rows sacrifice stage totals; existing filters and per-row status preserve diagnosis.
  disclosure saves space at the cost of an extra action for history/diagnostics.
- collapsed mounted history retains its loaded prefix and follows existing summary
  observations; this costs history reads while mounted, without a second poller.
- at narrow widths the three modes wrap; readable labels and 44px coarse-pointer
  controls take priority over keeping every mode on one line.
- busy source/search recovery remains a focusable tab stop to preserve keyboard position;
  native disabling remains for other unavailable states. exact focus ownership costs
  one document `focusin` listener per mounted imports list, without a focus service.
- if an inspector's opener disappears, focus returns to the existing pane controls/landmark;
  selecting a neighboring row automatically would need a broader companion focus contract.
- confirmed add departure can discard browser drafts/files. resumable sessions are excluded
  by the user's guarded-leave choice.
- server-owned retry matching costs one admission request for a mismatch, with no uploaded
  bytes. this supersedes the older proposal to add a client size field; the resolved
  ticket is removed, with its decision retained here and in verification.
- api/web/extension cut over together; old extension builds require reload. no database
  migration, telemetry, pipeline rewrite, bulk commands, new notifications or global router.
- uploaded originals remain downloadable during processing; document reading waits for
  publication. historical ready rows without a publication retain the reader's refusal
  and no longer advertise read/highlight/quote/search. no synthetic publication repair.
- temporary-test deletion gives up future automatic regression protection. retained
  acceptance/evidence and the existing static gate remain; live repair stays the operating model.
- [url source supersession](tickets/readded-url-returns-a-media-id-that-is-then-superseded.md)
  can later retire an issued media ref; its handoff then shows unavailable. durable source
  identity repair is separate. no redirect workaround. upload refs retain their lifetime identity.
- native replay/deduplication semantics and other ingestion/history defects remain separately
  ticketed. neutral add copy does not repair native outcomes.

all unwaived acceptance is verified. the owner explicitly skipped provider-dependent
live no-findings/exact-job review after search configuration failed; it remains
[unverified](tickets/imports-live-metadata-proof-needs-working-search.md).
merge qualification and proof cleanup passed; the pr follow-up owns ci, merge and
branch/worktree cleanup. deployment is excluded.
