# library chooser

status: implemented in `4c33ec204a8433c15195523ba2618bde8ea18c61`; qualified 2026-10-15 with [explicit remaining verification limits](library-chooser-verification.md). specification source: `367da80e0c1beb1c426f6d2d72201b0733809b50`.

## outcome and scope

type → arrows → enter → type → arrows → enter → escape. input remains responsive; each accepted action clears search, keeps focus and leaves the chooser open. membership, pending intent and the next action are distinct facts.

apply to media/podcast placement, import defaults/rows/bulk, saved import rows/bulk, browse acquisition/subscription, `/share`, and extension destination selection. consolidate direct live placement, including library-suggestion acceptance, under one account-scoped owner. draft destinations remain form state until their acquisition/import submits.

user decisions: recover accepted live membership work across reload in the same tab; run live proof against disposable local data. recovery includes library creation required by a live placement. it does not restore import drafts, files, capture forms, query or focus.

excluded: library-index/launcher redesign, cross-tab intent ordering, closed-tab/browser-crash guarantees, offline workers, undo, fuzzy/ai search, virtualization, new dependencies, global mutation/cache frameworks, and new podcast replacement-confirmation flows. acquisition keeps its existing transaction-composed placement; its separate [replay defect](tickets/podcast-acquisition-retry-reapplies-placement.md) is not repaired by this contract. the adjacent [link-picker ime defect](tickets/link-picker-enter-ignores-text-composition.md) remains separate.

## interaction contract

| event/state | required behavior |
|---|---|
| open | empty query, no active suggestion. keyboard invocation focuses search at every width; touch invocation may focus the existing sheet/region without summoning the keyboard |
| typing | filter the complete current catalog synchronously, including already-selected rows. normalize with `trim().toLowerCase()`; rank exact, prefix, substring, then name using existing base-sensitive locale comparison, then raw name and id for ties |
| nonempty query | activate the first matching row, including a blocked exact match. create follows matching library rows; it is first only when no library matches |
| empty query | stable alphabetical rows; no membership regrouping. down selects first; up selects last. subsequent arrows clamp |
| refresh | preserve the active id for the same query if present; otherwise first match for nonempty query, none for empty. old requests cannot install after newer generations |
| enter/click | commit only the current action. accepted admission immediately clears query/active id; rejection preserves both. blocked enter explains the reason. ignore repeated enter and composition events; no deferred enter after loading |
| native editing | leave home/end, modified arrows, selection shortcuts and space to the input. check both composition tracking and native `isComposing` |
| pending/unknown write | typing/navigation remain enabled. show intended change separately from confirmed state; later intent queues behind unresolved work for that target |
| mutation completion | never clear newer text, move active selection, refocus, reopen or dismiss. catalog installation follows the refresh rule. pointer selection retains input focus when the input already owns it |
| escape | dismiss only the innermost chooser; no clear-first step or undo. accepted work continues. firefox owns escape for its extension popup |
| tab/outside press | no implicit commit. auxiliary controls stay reachable. leaving a transient surface closes it and continues logical tab order from its trigger without restoring over the destination; the modal sheet retains its existing focus boundary. outside click completes normally |

use one combobox and single-select action listbox. input owns dom focus and `aria-activedescendant`; `aria-selected` means active suggestion only. omit `aria-multiselectable`, checkbox roles and checked states. visible membership, progress and next effect form each option's accessible description; the check glyph is decorative. this is a deliberate action-list design using [combobox focus/default-action mechanics](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/); mixed membership on an option is [not a settled aria pattern](https://github.com/w3c/aria/issues/1640). spoken behavior is an acceptance requirement.

for ordinary/draft bulk editing: none/some → include all, all → exclude all, computed from latest intended state. existing saved-item bulk-add and bulk-remove modes retain their explicit verbs. deduplicate target ids and freeze scope at admission. unknown inventory blocks activation until read/retry; it is not mixed membership. known ineligible targets are excluded only with visible counts/reasons before activation. preserve unrelated destinations. inherited membership remains read-only.

## presentation and content

reuse existing input, buttons, feedback, tokens, anchored surface and mobile sheet. keep search fixed above a bounded results scroller; scroll only the active option into that scroller. status/actions must not resize the input or cover results. active treatment and included treatment must remain visually distinct. names wrap on narrow layouts; the full name remains accessible. no success toast per edit, moving selected groups, animation dependency or special keyboard shortcut.

each implementation slice has a designer/content owner (ownership table below). good content answers: what is confirmed, what is pending, and what will enter do? names retain user capitalization; ui prose uses these defaults:

| feature/state | content contract |
|---|---|
| search | title `libraries`; input `search or create a library`, or `search libraries` when creation is unavailable; `loading libraries…`; `no matching libraries` |
| empty catalog | `no libraries yet. type a name to create one.`; omit the creation invitation where unsupported |
| context outside results | `selected libraries: {names}` for drafts; `current libraries: {names}` for live editing; `none` when empty; bulk title `libraries for {n} items` |
| option | `{name} · included/not included · add/remove`; bulk `{name} · in {n} of {total} items · add to all/remove from all` |
| partial eligibility | `add to {n} of {total} items` or `remove from {n} of {total} items`, followed by excluded counts and existing domain reasons. never call a subset “all” |
| work | `adding…`, `removing…`, `change not confirmed`; retain a summary and retry outside filtering. confirmed membership is not replaced by a pending checkmark |
| create | `create “{name}”`; `creating “{name}”…`; definite refusal `couldn’t create “{name}”`; uncertain `creation not confirmed`; recovery `retry` |
| partial create/place | `“{name}” was created.` plus the shared per-target confirmed/refused/unconfirmed states; derive membership only from canonical reads; do not delete the library |
| recovery outside picker | existing persistent feedback: `library changes need attention`, count and `retry`; storage failure: `library changes couldn’t be saved for recovery`, `retry`. no duplicate announcement while the same failure is visible in a chooser |

reuse and extend the finite domain-reason mapping in `libraryRequestErrorMessage.ts`; no server-message parsing or generic “try again” for permanent refusal. announce acceptance/progress politely and refused activation clearly without shifting focus. use the existing feedback rail for unresolved work after dismissal/reload, with inline detail on reopening; dismissing feedback never discards commands.

## owners and capability contracts

composition: surface → chooser → draft/live adapter → owning state. live owner → frozen command → bff → api → domain transaction + replay receipt → canonical inventory read. draft adapter changes local selection only; acquisition owns the later multi-effect transaction.

`LibraryChooser` owns query, ranking, active id, keys, option rendering and announcements. adapters supply complete choices and admit explicit actions. `LibraryChooserSurface` owns invocation intent, dismissal, tab continuation and return focus through `useOverlay`/`MobileSheet`; do not add another escape listener or focus trap. query is session-local, not catalog-hook state.

```ts
type Membership = { included: number; total: number };
type Choice = {
  id: string; name: string;
  confirmed: Membership | null; // unknown is not zero
  intended: Membership | null;
  progress: "Settled" | "Pending" | "Uncertain" | "Reconciling";
  exclusions: readonly { reason: LibraryPlacementBlockedReason; count: number }[];
  provenance: readonly LibraryIdentity[]; // retain inherited/read-only explanation
  action:
    | { kind: "Set"; included: boolean; targetCount: number }
    | { kind: "Blocked"; reason: string };
};
type Admission = "Accepted" | "Rejected";
// commit({choiceId, included}) -> Admission; never recompute/invert the shown verb.
// adapter owns rejection feedback and rejects changed eligibility/scope.
// creation is a distinct action with the captured trimmed name, not a fake library.
```

these are derived views, not another store. `total` always counts the full named scope; `targetCount` counts actual changes. already-satisfied targets need no command. “add to all” means resulting coverage is all: two already included plus one addition is all three. exclusion counts/reasons describe only targets that cannot reach the requested state. if no eligible change remains, expose the reason and admit nothing. local drafts settle synchronously. live adapters translate the captured desired boolean into explicit add/remove commands, never a server-side toggle.

extend `placementController.tsx` into the sole live owner. keep visible overlay session separate from per-target inventory, ordered work and recovery. expose `useLibraryPlacements(targets)`, synchronous `admitPlacement({targets,destination,operation})`, `admitCreateAndPlace({targets,name})`, and `retry(commandId)`. admission returns accepted command ids or rejection feedback; the chooser maps that result to `Admission`. expose receipt observation for callers such as suggestion acceptance, which must await confirmation before reporting success. an observer ending never cancels work.

remove live placement from the add session's mutation slot and `leaveReason`; retain import/upload/draft guards. surface dismissal is always available, so remove nullable `onClose` as a creation lock. no view owns the lifetime of an accepted live command.

retain only observed targets and targets with outstanding/reconciling work; this is not a permanent library cache. aliases share facts. `Entries` invalidates all observed inventories, including episode/show effects. expose one placement acknowledgement subscription to `resourceActionRuntime`, which reconciles its existing action snapshots; remove view-owned `reconcileActions` callbacks. installing a read requires the same account, target, read generation and write/change stamp, with no intervening dispatch. a read cannot erase uncertainty.

confirmed receipt retains a `Reconciling` intent marker until a post-write canonical read; never infer `Direct`/`Absent` from success. refused receipt removes its optimistic effect immediately and exposes the reason; derive remaining intent from facts plus surviving work. transient reread failure preserves stale facts and retry; definitive target-unavailable ends reconciliation and blocks edits. inherited placement can be the correct result of add.

### complete catalog

hard-cut `GET /libraries/writable-destinations` and extension `GET /extension/library-destinations` to `Data<LibraryIdentityOut[]>`: the entire eligible named-library catalog, `{id,name}`, no query/cursor/limit. reject supplied legacy parameters. retain current owner/admin, non-default, non-system eligibility. live target inventories remain the existing complete media/podcast reads.

replace `useLibraryDestinationSearch.ts` with `useLibraryDestinationCatalog.ts`, a small complete-catalog read hook shared by web and extension transport. read on opening and relevant change stamps; retain last successful snapshot during refresh, label refresh failure, and fence late replies. initial failure supplies no actionable rows. last-good rows still match the CURRENT query locally; creation requires a successful latest complete snapshot. no debouncing, load-more or first-page-as-catalog shortcut. browse's `reviewDestinations` uses the same complete read. selected draft ids absent from the new catalog remain visible as unavailable selections that can be removed; never silently delete them.

### placement api and replay

add one `POST /library-placement-commands`, through the existing bff proxy. input is an extra-forbid, camel-alias discriminated union; ids are uuids:

```ts
type PlacementCommand =
  | { kind: "AddMedia" | "RemoveMedia"; clientMutationId: UUID;
      mediaId: UUID;
      destination: { kind: "SavedInNexus" } | { kind: "Library"; libraryId: UUID } }
  | { kind: "AddPodcast" | "RemovePodcast"; clientMutationId: UUID;
      podcastId: UUID; libraryId: UUID };
type PlacementReceipt = {
  clientMutationId: UUID;
  outcome: { kind: "Confirmed" } | { kind: "Refused"; code: PlacementRefusalCode };
}; // HTTP 200, Data<PlacementReceipt>; no implied current membership.
```

closed refusal codes: `E_MEDIA_NOT_FOUND`, `E_NOT_FOUND`, `E_LIBRARY_NOT_FOUND`, `E_FORBIDDEN`, `E_LIBRARY_FORBIDDEN`, `E_DEFAULT_LIBRARY_FORBIDDEN`, `E_INVALID_REQUEST`, `E_MEDIA_DELETING`, `E_MEDIA_LAST_REFERENCE`, `E_PODCAST_SUBSCRIPTION_REQUIRED`, `E_PODCAST_REPLACES_EPISODES`. preserve existing permission, subscription, inherited placement, deletion-marker, last-reference and podcast/episode conflict rules. named destinations still pass non-default validation; saved-in-nexus resolves the viewer's default internally. no podcast/saved-in-nexus combination exists in the type.

reuse `resource_mutation_replay.py` and `resource_mutations`; no table/migration. fixed scope `Library.Placement`; identity `(viewer_id, scope, clientMutationId)`; hash the canonical validated request including target, destination and verb. authenticate first, then lookup before current authorization/domain checks. exact replay returns the original receipt without writes; changed body conflicts. receipt identity must match the request at the client boundary.

the service owns one retryable transaction, preserving existing domain lock order. direct command helpers must raise every enumerated business refusal BEFORE their first mutation. catch only those refusals inside the one transaction and record `Refused`; success records `Confirmed` with the domain change. no savepoint or nested transaction. preserve this prewrite-refusal invariant when changing helpers. commit before replying. duplicate-receipt unique conflicts retry the WHOLE transaction using the existing retry helper, so a delayed duplicate cannot commit another effect. defects, authentication failure, malformed wire and replay mismatch produce no terminal receipt. do not classify every exception as refusal. internal ingest/tool/acquisition callers retain transaction-level domain composition.

### creation composition

keep one `POST /libraries`, body `{library_id,name}`, success `Data<LibraryOut>`. trim once; enforce 1–100 unicode code points and the existing reserved-name rule. creation is offered only without a normalized exact catalog match. names remain nonunique; this chooser does not introduce a global uniqueness constraint.

strengthen the shared service with `Library.Create` replay scope, `library_id` as identity and frozen normalized body. build `LibraryOut` INSIDE the existing creation transaction and commit its ORIGINAL result with library + owner membership; retain that transaction/retry owner. lookup precedes inspection of the current row. replay after rename/deletion must not rename/recreate anything. validate returned id in `createLibrary` before publishing change. historical metadata is not present existence or authorization.

an existing id without a `Library.Create` receipt conflicts, even when name/owner match. delete the live-row replay branch; no receipt backfill or legacy adoption. resolve pre-cutover uncertain creates by inspection/live repair before relying on the new guarantee.

live create-and-place atomically admits a create plus explicit dependent adds into the journal before sending anything. suppress a second create for the same outstanding normalized name: show its pending/retry state, without changing its frozen targets. creation acknowledgement unlocks adds; each add still receives normal server authorization. definite creation refusal drops only never-sent dependent adds, with explicit feedback. success followed by placement refusal leaves the created library intact. no compensating delete or pretend atomicity.

draft creation belongs above the dismissible picker in its existing form owner. freeze id/name and draft target scope; clear search on admission; on success delta-add to CURRENT selection only if that scope still exists. never restore an old array, change newer query, or resurrect a departed draft. unknown attempts retain identity. same-name retry resumes only the same frozen scope; a different scope waits for that creation, then selects the existing library. do not silently retarget or create a duplicate. other names and selection editing remain usable. draft creation has its existing form lifetime, not live-membership reload recovery.

only initial `E_NAME_INVALID`, `E_INVALID_REQUEST` or `E_FORBIDDEN` may settle create as definite refusal; after any uncertain delivery, a nonreceipt refusal cannot establish the earlier outcome. preserve that attempt for exact replay/live repair. the libraries-index dialog remains a separate task; this plan owns backend replay strengthening. keep its public create success contract and implement its shared client identity check once.

### ordering and same-tab recovery

one fifo per `target.kind:id`, across destinations; independent targets may progress concurrently. later intent is accepted/persisted immediately but does not dispatch before the predecessor has a terminal receipt durably retired. do not coalesce opposite commands or generate a new id for retry. a fresh read agreeing with intent is not a receipt. one named 30,000ms delivery deadline covers fetch and body; timeout means unknown, not canceled. no automatic retry loop; same-account startup makes one recovery attempt, then explicit retry owns further attempts.

use one account-keyed `sessionStorage` record, `nx_library_work.v1:{accountId}`:

```ts
type Journal = { version: 1; work: StoredWork[] }; // admission order
type StoredWork =
  | { kind: "Placement"; phase: "Queued" | "Sent";
      request: PlacementCommand; afterCreate: UUID | null }
  | { kind: "CreateLibrary"; phase: "Queued" | "Sent";
      request: { library_id: UUID; name: string } };
```

`afterCreate` names one concrete creation prerequisite, not a dependency framework. no dom nodes, callbacks, query, inventory, credentials or whole import state. strict decoding is required here and at extension version boundaries; use generated types for same-deploy api responses.

1. write the complete new journal before acknowledging admission; failed storage means no acceptance or send. update synchronous owner state, then render.
2. persist `Queued → Sent` before fetch. unknown/defect retains the exact record and blocks that target; unrelated targets continue.
3. after receipt, persist removal before releasing successors. create success removes create and clears matching `afterCreate` fields in ONE storage write. failure to persist retirement stops new admission/dispatch, retains received receipts in memory and offers storage retry; never discard known work to get unstuck.
4. restore only after authenticating the matching account. queued work resumes; sent work replays its exact body/id. restored sent creates already count as uncertain. account change revokes old callbacks/dispatch; another account never reads, displays or sends its key. returning to the original account resumes its retained work.
5. malformed/unsupported journal stays untouched, with blocked recovery and visible live-repair feedback. no migration/fallback or silent deletion. completed receipt retirement is the routine removal path; membership reads never remove records.

the authenticated provider owns feedback even after every picker closes. no unload-send trick, service worker, database queue or periodic poll. replay receipts remain in the existing ledger; do not introduce expiry that would make old stored commands execute again.

## implementation boundaries and cutover

freeze interfaces before parallel work; one writer per file. paths are relative to `apps/web/src/` unless prefixed otherwise. each slice's designer authors the states above; an independent reviewer challenges its contract, implementation and live proof.

| owner | exclusive files / responsibility | designer review |
|---|---|---|
| a: command/catalog | `python/nexus/schemas/library.py`; api `routes/{libraries,media,extension_captures}.py`; services `library_governance.py`, `library_entries.py`, new `library_placement_commands.py`; `lib/libraries/{client,destinationContract,libraryPlacement,libraryRequestErrorMessage,placementController}.ts[x]`; new `placementJournal.ts`; `lib/actions/{resourceActionRuntime,resourceActionMenu}.tsx`; generated `lib/api/wire.gen.ts` | truth, pending/refused/recovery copy; exact scope and partial outcome |
| b: interaction/surface | `components/libraries/LibraryChooser.tsx`, `LibraryChooserSurface.tsx` and css; `lib/libraries/presentation.ts`; only a necessary narrow tab-continuation capability in `lib/ui/overlay.ts` | ranking, active state, names, focus, keyboard/touch and spoken output |
| c: adapters | remaining `components/libraries/LibraryDestination*`, `LibraryEntryEditor`, `LibraryPlacementOverlay`; replacement catalog hook; `components/nexus/{AddPanel,useAddContentSession}`; `components/browse/AcquisitionControl`; `app/share/ShareCapture`; `app/(authenticated)/libraries/[id]/LibraryPaneBody`; `extension/{popup,background,captureClient,captureContract}` plus directly affected styles | draft/live/bulk semantics, frozen targets, creation, extension feedback |
| d: verifier/integrator | disposable proof outside checkout; this plan, verification receipt, `docs/modules/{library,add-content,extension,overlays}.md`, relevant tickets/register | independently authored oracles; content/visual approval; scope and deletion audit |

extension hard-cuts `search_destinations`/paged result to `list_destinations`/complete catalog. extend the existing view port for `{kind:"set_destination",draftId,sequence,destination:{id,name},included}` and `{kind:"save",draftId,sequence}`. sequence increases per port; reject gaps, wrong draft and frozen edits. post every delta immediately; a popup-held unsent queue would lose accepted edits on escape.

background admission is synchronous, before awaits. one draft-local fifo persists deltas against the latest durable draft, one write at a time; derive intended selection from durable state plus the queue. acknowledgement carries sequence and pushed-view revision. pushes carry increasing revisions, with snapshots captured before asynchronous permission reads. popup ignores older pushes and retires only the contiguous acknowledged prefix covered by the installed view revision, then reapplies the remaining provisional suffix; rejection removes only its delta. no second authoritative popup store or persistence framework.

save closes edit admission immediately, claims the existing exclusive command slot, waits for preceding edits, then enters the existing capture lifecycle. keep the permission request in the original click immediately after posting save. failed storage rejects that barrier, releases its slot, retains queued intent with `couldn’t store library choices` / `retry`, and starts no capture mutation. retry resumes the failed fifo. discard, account disconnect and draft replacement close admission, settle any in-flight storage write, then abandon unsent edits and clear/replace through existing owners; do not require failed edits to persist before discard. late writes cannot resurrect a draft. popup-port closure leaves background work intact; restart restores only stored choices. no extension library creation or live-placement journal.

remove six old direct write operations: media library post/delete, saved-in-nexus put/delete, library/podcast put/delete. remove `addLibraryPlacement`, `removeLibraryPlacement`, `projectLibraryPlacement`, view-local placement machines, global placement busy gating, selected-first groups, bulk checkbox bypass, debounced/paged destination search, and obsolete types/styles/error branches. delete only helpers proven unused after consumer migration. preserve inventory gets and internal transaction helpers. regenerate wire through `bun run gen:wire`; no hand-maintained parallel api shapes or compatibility routes. ship server/web/extension together; old installed extensions require updating.

## proof and acceptance

the user's temporary red/green/refactor/delete campaign is an explicit exception to the static-only [repository verification contract](local-rules/testing-standards.md). `./scripts/test` remains the sole permanent automated gate. test deletion trades away future automated journey coverage; retained spec and evidence do not replace it.

1. independent verifier and designers freeze observable assertions; adversarially review scope, terminal-outcome semantics and accessibility before implementation.
2. use an isolated worktree and disposable local auth/database/storage, distinct ports/project, real browser → bff → api → database. keep runner, dependencies, profiles, credentials and proxy under one external task root. normal public fixtures/auth/workers only. do not reuse production data or ambient shared-stack defaults.
3. demonstrate genuine baseline reds. setup failures and nonexistent future selectors are not red; preservation cases may already pass. intercept real traffic only to hold/drop delivery, never manufacture successful application responses or add production test seams.
4. implement a/b/c; cross-review each slice, integrate, run unchanged oracles and `./scripts/test`. refactor against ownership/minimality rules; rerun affected proof and static checks after changes.
5. retain actual source ids, red/green outcomes, receipt identities, canonical read evidence, content/visual observations and limits in `docs/library-chooser-verification.md` plus small nonsecret artifacts. delete temporary tests/dependencies/fixtures/proxies/profiles and stop task services. the user's later docker coordination instruction requires preserving every task volume and its data. audit hard-cut deletions, rerun unchanged `./scripts/test`, and close only demonstrated resolved tickets.

| case | acceptance oracle |
|---|---|
| 1. repeated entry | full type/arrows/enter loop on media, podcast, import default/row/bulk and saved row/bulk; exact final memberships; no query/focus reset from late completion |
| 2. complete search | >50 libraries; selected/unselected filter identically; exact match wins; blocked exact match explains itself; initial enter does nothing; late catalog refresh never reverts query/active identity |
| 3. draft composition | deltas preserve unrelated selections; frozen deduplicated bulk scope and visible exclusions; drafts emit no placement writes; browse/subscription/share receive the chosen ids |
| 4. extension | actual installed firefox popup: rapid repeated choices during delayed background storage/replies; no lost delta; save freezes latest accepted selection; popup escape remains host-owned |
| 5. creation | unicode/reserved validation, new typing during create, failed name then corrected name, same-id retry, create success/place refusal; replay after rename/deletion never recreates; no departed-draft resurrection |
| 6. ordering | hold add a, admit opposite b and another target's edit; b is stored but unsent while unrelated target progresses. receipt a releases b; delayed duplicate a after b has no new effect |
| 7. uncertain outcome | real commit with lost reply; canonical read does not settle identity; exact replay does. same id/changed body conflicts; refusal after state/authority change obeys terminal receipt rules |
| 8. canonical truth | add yielding inherited membership, last-reference refusal, deleted target, changed permissions, podcast subscription/replacement refusal; stale reread never overwrites later intent |
| 9. reload | hard reload with sent-unknown a AND admitted-but-unsent b; restore exact ids/bodies/order and visible recovery. also lose a real create receipt with dependent adds blocked, reload, replay creation, and release each add once; no mount/close/retarget loses work |
| 10. account/storage | sign out a, sign in b: no a display/send; return a resumes. failed pre-send storage sends nothing; failed retirement (including atomic create-removal/dependency-clear) blocks successors; malformed journal remains intact |
| 11. focus/accessibility | ime, repeat/modified keys, nested escape, logical tab exit, outside click, removed opener, keyboard at narrow width, touch with keyboard already open; actual speech distinguishes active action/membership |
| 12. final state | normal/narrow/zoomed visuals; no legacy writers/endpoint clients, duplicate placement state, test-only seams or retained temporary tests; static gate passes |

run chromium broadly; target firefox/webkit on shared keyboard/focus behavior, firefox for extension, and real screen-reader/handset checks for spoken output/soft-keyboard claims. record unavailable checks as limits, never passes. key costs: full catalog means a larger initial read; clear-after-commit means retyping repeated prefixes; per-target serialization delays server dispatch but not typing; separate creation can leave an empty library; same-tab journaling adds explicit storage failure handling; conservative create recovery may require live repair after a lost refusal. no hidden compatibility or fallback paths.
