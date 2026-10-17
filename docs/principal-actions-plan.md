# principal actions

status: implemented and locally qualified; known limits and release smoke in the verification receipt. 2026-10-16.
source baseline: `69c00182c`; canonical integration: `eb5560864`, migration0291/wire9.
implementation and observed limits: [verification](principal-actions-verification.md).

## outcome and scope

make the principal task visible, keep content directly usable, and make delayed commands respect their original subject and subsequent user intent. reuse the action catalog/runtime, shared lectern owner, pane chrome, collection slots, feedback and overlay kernel.

this plan owns principal task publication, reading-row add, lectern command fencing, delayed resource-action navigation, shared menu semantics and pdf zoom controls. hard-cut the replaced paths. no compatibility branch, second action registry, general mutation/cache framework, overlay dependency or permanent test infrastructure.

approved choices: keep mobile-palette integration separate; add in libraries/search plus existing direct-add cohorts; retain late results for explicit opening; isolated real-stack qualification followed by released smoke; include the bounded lectern revision prerequisite; save zoom with genuine reading movement; later editing or opening another task relinquishes automatic result opening.

adjacent owners remain [library creation](libraries-creation-plan.md), [pane tabs](pane-tabs-plan.md) (consumed slices in the verification receipt), [index reordering](index-reordering-plan.md), [suggestions](suggestions-plan.md), find and [inspector](inspector-control-plan.md). consume their named slices below; do not absorb tab uncapping/maximize, drag redesign, library revisions, suggestion ranking, tooltips or query-toolbar redesign. the branch composes adjacent owners’ reviewed commits; their broader acceptance and remaining device work stay separately owned. new audio promotion and podcast notes changes are excluded. preserve existing playback, import recovery and selection tools.

the older audit is not the source contract: the ellipsis icon/targets already exist; pane management and view controls already have separate owners. resource menus fetch on open and discard on close; there is no shared capability-cache freshness framework to repair. remove the direct-add menu preflight, without claiming to fix the separately tracked [request latency](tickets/resource-action-reads-wait-before-send.md).

## target surface and content

| surface | direct task | authority and retained behavior |
|---|---|---|
| chats | `new chat` | existing navigation link; independent of list loading/failure |
| libraries | `new library` | opens/resumes the creation plan's pane-owned dialog; remains available in every list/view state |
| individual library | `add content` | existing management capability and command; captures this library's id/name |
| podcasts index | `browse` | existing navigation link; independent of list loading/failure |
| library media entries; search media results | `add to lectern` | stored `web_article`, `epub`, `pdf`; use the canonical media id, never a snippet's owner ref |
| existing quick reads, lectern suggestions and transcript adds | existing direct add/recovery | preserve existing eligibility and suggestion retirement/refill contracts |
| other rows | existing controls | playback stays playback; library suggestions still add to this library; external results retain acquisition |
| pdf navigation | minus / scale and fit-width reset / plus | existing zoom steps/bounds; explicit fit mode |
| desktop nexus tab result | direct close | narrow tabs-owned slice; closing a pane never deletes its resource |

search fragments, chunks, passages, notes, chats and show/library rows receive no manufactured add control. format membership is a presentation cohort, not a claim of ready publication or authorization. titles remain real links, including modified-click and copy-link behavior. keep every existing menu command, using the same descriptor when promoted; new library remains direct-only. duplication is accepted for stable discovery and recovery.

place one full-labelled principal task in the pane's controls band, below the unchanged identity/history/more/inspector bar. order: reader navigation, then primary task and query controls. primary comes first in dom and visual order; query takes remaining width and wraps below when needed. no abbreviated label, bare plus, breakpoint relocation or separate mobile-bar projection. keep the primary outside query-specific keyed/hidden subtrees and count it in mobile chrome measurement.

reuse existing 32px controls and at least 44px coarse-pointer targets, theme tokens and visible focus. allow wrapped controls at 320px and enlarged text; never truncate the action verb. preserve the existing 48px mobile top-bar targets. row controls occupy `CollectionView.rowControls` / `ResourceRow.primaryControl`; do not teach `CollectionRow` task priority. mutation identity and row-occurrence focus identity remain separate.

each work package assigns a content designer, who authors these states before implementation and approves the rendered result. good content names the action/subject, states only known outcomes, explains unavailable actions visibly and offers one useful next step. use lowercase copy here; no implementation vocabulary or duplicate success announcements.

| state | visible content / action |
|---|---|
| add available | `add to lectern` |
| sending / checking retained add | `adding…` / retained check verb while checking; keep the focused button, guarded and `aria-disabled` |
| add unconfirmed | `check add`; `couldn’t confirm adding {title}`; `it may already be on lectern.` |
| known membership, no unresolved command | `on lectern`; never turn the direct control into remove |
| shared initial read unavailable | `checking lectern…`, or `couldn’t check lectern` with `retry` |
| remove/place recovery | `removing…` / `placing…`; unconfirmed: `couldn’t confirm removing/placing {title}`, `check removal` / `check placement`; checking: retain the exact check verb and show busy state. never relabel these as add |
| obsolete intent | `lectern changed`; `review its current state before trying again.`; no automatic resend |
| late result | `chat created` → `open chat`; learning `Opened` → `dossier available`, `BuildAccepted` → `dossier requested`; `open dossier`. retain until opened/dismissed; accepted is not finished |
| resource menu | existing loading/failure/retry states; unavailable reason as wrapping secondary text |

menu names identify scope: `more actions for {title}`; tab close is `close {title}`. confirm destructive operations through the existing runtime. a pending transition preserves the control; replacement/removal repairs focus only if it still owns focus, using existing collection settlement. never pull focus back from a later interaction.

## capability and composition contracts

```ts
// paneChrome.tsx; uses the existing descriptor, including disabled reason
type PanePrimaryAction = Extract<ActionDescriptor, { kind: "link" | "command" }>;
// PaneChrome
readonly primaryAction?: PanePrimaryAction;

// lectern.tsx; semantic input, frozen with expectedRevision at admission
type LecternIntent =
  | { kind: "Ensure" }
  | { kind: "Remove" }
  | { kind: "Place"; placement: Placement };
type LecternCommand = Readonly<{
  mediaId: string;
  intent: LecternIntent;
  expectedRevision: Schema<"OrderRevision">;
}>;

// ActionMenu; existing overlay type, independent of geometric anchor
readonly returnFocusTo?: ReturnFocusTarget;
```

`PaneShell` renders the optional descriptor through existing button/link primitives. commands receive the actual button as `triggerEl`; links remain anchors with semantic attributes/handlers on the anchor itself (`Button.asChild` only supplies styling). no arbitrary jsx slot or shell-specific resource logic. absence means no principal task. feature owners publish the same descriptor to the existing menu where one exists.

resource controls invoke the existing runtime, which owns confirmation, execution and failure. extract only the lectern command projection shared by direct add and resource menus; direct add fixes `Ensure`, while the menu may expose `Remove`. keep their catalog identity, but retain the frozen intent separately. a descriptor's checkbox state is not a membership api.

`CollectionOrderProvider` owns the one accepted shared snapshot `{items, at_capacity, order_revision}` and highest observed revision. `LecternProvider` consumes that owner and owns same-media pending commands and short-lived `{order_revision, present, intentKind}` receipts. `intentKind` is required and comes only from the exact acknowledged command. suggestions accept only Ensure acknowledgements, including hud recovery; Place/Remove and observed membership do not accept a suggestion. its command outcome is `Acknowledged | Unconfirmed | Superseded`; only a real write acknowledgement returns `Acknowledged` and retires a suggestion through that existing path. direct controls consume these typed facts; they never open/fetch a full resource menu on mount. no new capability endpoint. server permissions, teardown and capacity remain authoritative. positive membership is usable; absence from the visibility-filtered read is not proof of global absence. a failed background read retains usable last-known facts; initial absence of a revision blocks only lectern writes and offers shared-read retry.

unresolved same-media intent precedes menu snapshots, membership and capacity. identical media/verb/placement invocations join its delivery; a different placement cannot retarget or join; an opposing ensure/remove/place is unavailable until settlement. unrelated actions and media remain usable. capacity may block a proven fresh addition; it must not block checking an unresolved add or ensuring membership whose absence is unknown. recheck these rules synchronously at command admission, not only through disabled styling.

remove `checked` projection for inverse verbs such as mark unread, unsubscribe, remove from lectern and remove download. keep checkbox semantics only for stable state labels; disclosure semantics remain unchanged. menu reads/loading never disable independent principal tasks or every command for the same resource.

canonical feedback composition (`7a706f63e`): late results use an untimed `offer` with its exact-publication handle; explicit open withdraws that handle. unresolved lectern writes project required `Write` conditions from the existing command owner. recovery retains its check verb while busy, with progress conveyed separately. no retired `publish`/`resolve` api, compatibility wrapper or second result store. consumption, restart-safe source/metadata admission and detached chat-deletion recovery retain their canonical owners.

## lectern wire and ordering

adopt the reordering spec’s single `collection_order_revision_seq`, `users.lectern_order_revision` and `OrderRevision` contract (canonical migration0291, wire9). this prerequisite creates the logged, noncycling bigint sequence (`START 1 INCREMENT 1 CACHE 1 OWNED BY NONE`), the user field with `nextval` default, its `BigInteger` model and shared wire schema. the integrated reorder owner supplies the library field through the same migration. allocate under the existing viewer lock; empty/recreated aggregates never reuse a revision. wire revisions are canonical positive decimal strings up to `9223372036854775807`; compare with `BigInt`, never `Number`. gaps are valid; never assume `+1`. metadata refresh does not advance them.

| existing endpoint | hard-cut contract |
|---|---|
| `GET /lectern` | `Data<LecternOut>` adds required `order_revision`; items, capacity and revision come from one repeatable-read snapshot |
| `PUT /lectern/items/{media_id}` | `PlaceIn` adds required `expected_order_revision`; `placement: null` ensures membership, existing `First`/`After` retains play-next placement semantics |
| `DELETE /lectern/items/{media_id}` | required `expected_order_revision` query parameter |
| both writes | `200 Data<LecternWriteOut>` with required `order_revision`, replacing `204`; stale expected revision returns `409 E_RESOURCE_CONFLICT` |

under the viewer lock: compare expected revision before membership/no-op decisions; validate current authority and input; apply the operation; advance revision; return the committed revision. **every accepted public command advances it, even a no-op.** otherwise an acknowledged remove of an absent item cannot fence an older delayed add. each retry retains the original revision and payload. no automatic rebase, unconditional compatibility path or claim of historical exactly-once execution.

all structural writers participate: `place`, `remove`, `remove_media_in_txn`, `restore_in_txn`, `append_missing_in_txn`, `remove_item_in_txn`, including finish/natural-end/undo, agent and podcast sync callers. explicit membership intent must fence even when already satisfied: finish-with-removal, restore, nonempty agent/sync ensure and explicit remove all advance. empty batches or replay paths executing no membership intent need not. advance at the owning primitive/transaction boundary, not every caller; multiple allocations are safe, but do not duplicate them needlessly.

media teardown currently bypasses this owner. in each existing serializable teardown attempt, enumerate queue viewers and lock their user rows in uuid order before the media lock; recheck intent/references and run lectern-owned deletion/compaction for that locked set. remove queue deletion from the generic state loop; acquire no viewer lock after media. reuse whole-transaction `retry_serializable`, reloading viewers each attempt. an unseen concurrent insert must cause serialization retry or fail behind deletion; the foreign key participates. do not pretend a serializable snapshot can reread a newer affected set. qualify this precise postgres interleaving and absence of a new lock cycle. this is a prerequisite, not optional cleanup; see the [qualified index receipt](index-reordering-plan.md#8-implementation-and-verification-receipt).

the reordering plan consumes this same lectern revision; it must not add another field or revision owner. when its `CollectionOrderProvider` lands, hand canonical snapshot acceptance to that owner; `LecternProvider` keeps membership receipts/pending intent and consumes/publishes through the same revision gate. never run two independent accepted-order stores. strict move, library revision and pagination remain its work. this plan migrates every existing web ensure/remove/place caller to the conditional protocol, including menu play-next, transcript play-next and current drag placement. agent/sync transaction helpers retain their internal interfaces. regenerate wire types through the existing generator; use generated schemas and the existing bff.

client settlement rules:

1. synchronously freeze `{mediaId, intent, expectedRevision}` and register pending state before sending. new explicit ensure/remove uses the highest observed revision; drag placement uses its displayed snapshot revision. retries reuse the original command. keep the existing delivery deadline; no automatic mutation retry. obsolete callbacks may settle only their exact still-owned pending entry/attempt.
2. on success retain an acknowledged membership receipt with its returned revision and publish the change. an add/remove acknowledgement proves present/absent at that revision; it does not supply an order snapshot. never relabel older ids with a newer write revision.
3. discard reads older than the accepted snapshot; retain receipts until a read at least as new supersedes them. a failed reread cannot erase success or turn it into `check add`. do not install an older receipt over already-newer truth.
4. on lost response retain the exact command as unconfirmed. a read at its original revision proves nothing about a delayed write. a later revision fences every delivery with the old precondition; release retry authority, settle that caller as `Superseded`, stop its browser wait and reconcile current truth; require a fresh explicit intent if still desired. do not claim server cancellation or leave its runtime busy key waiting for timeout.
5. a conflict triggers a shared read; after prior uncertainty, a generic `409` alone settles nothing. exact success acknowledges the attempt; a successful newer snapshot fences its remaining deliveries. either settles uncertainty. first-attempt definite refusal may clear it, but fresh submission waits for a current revision. positive membership can show `on lectern`; filtered absence cannot prove historical failure. later auth/validation refusal cannot erase earlier uncertainty.

other-media commands can conflict because the revision covers the whole lectern. accept this visible retry cost; do not add a queue, per-item generations or request ledger. acknowledged/current-state safety survives reload through the server revision; pending recovery controls and receipts are session-local, so reload may require inspecting the actual lectern.

## delayed results and focus

capture the initiating active pane and visit synchronously when selecting `chat about this` / `learn from this`, before the first await. capture the workspace store’s nonpersisted `foregroundGeneration` with the origin; initialize it at zero. increment synchronously when active pane or source identity changes: visit id plus resolved route id/pathname, matching `paneSourceKey`. source replacement can retain a visit id, so visit equality alone is insufficient. returning does not restore the token; width/metadata and same-source query/hash refinements do not revoke it.

only these two async actions also call the overlay owner’s read-only `getInteractiveOpenGeneration()` and attach temporary capture listeners for subsequent trusted `pointerdown`, non-modifier `keydown`, editable `beforeinput`/`input` and `compositionstart`. any of these irreversibly relinquishes automatic opening; the invoking event has already passed capture before listeners are installed. remove listeners on settlement and provider disposal; disposal also revokes publication/navigation into a later account/session. the overlay generation advances when a new interactive layer opens, not on close, passive hints or rerender, so open-and-close still relinquishes. no global input tracker or callback registry.

after completion, automatic activation requires the same foreground token, unchanged interactive-open generation, no later-input relinquishment and no remaining interactive overlay. an originating nexus modal still open also requires explicit opening; there is no same-origin exception. a cancelled press, selection or editing attempt also leaves an explicit-open receipt. pointer movement and wheel scrolling alone do not revoke. use the captured origin with the existing workspace target activation. otherwise publish the real result through existing persistent feedback, with explicit open; opening is a new user intent against the then-current workspace. no background focus/navigation and no late dialog resurrection. store only the returned target and display metadata; no durable receipt database. the resource remains normally accessible after reload even though its receipt does not.

the tabs owner supplies content-origin activation without canvas reveal: clear any held target, suppress only that activation transition, and retain pointer geometry through release. keyboard focus activates its containing pane without refocusing. explicit strip/navigation activation still reveals, including an already-active offscreen pane. no timers or replayed clicks. the accepted cost is a partially visible pane after an interior click.

menus follow the [menu keyboard contract](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/): arrows/home/end/typeahead navigate owned items; tab/shift-tab exits and closes; disabled items can receive menu focus but cannot execute. command/link/checkbox items use `tabIndex=-1`. honour `defaultPrevented` and composition; editing keys in editable descendants remain theirs.

tab exits from ready, loading, failed, empty and disabled-only menus. synchronously exclude the closing menu from focus order, focus its invocation context with `preventScroll`, close without return-focus work, and allow native tab continuation. reuse the overlay's modal-boundary handling so only an enclosing modal wraps. preserve propagation isolation; no synthetic tab, global focus manager or delayed focus restoration. qualify this mechanism in all three browser engines. if native continuation follows portal order or escapes a containing modal, repair this same owner before acceptance; no silent alternate focus policy.

escape returns to the invocation context; ordinary selection restores before execution so a new dialog captures a surviving opener; outside dismissal does not restore. retain navigation's existing no-return policy. desktop nexus supplies its input as `returnFocusTo` and deletes its unconditional close-time focus callback. use existing pane/modal settlement if the original context disappeared. closing while an action read is pending prevents any later response from reopening or focusing the menu.

canonical-main composition replaces reader menus with the passage composer on `FloatingActionSurface`. remove the unused `ActionMenu.anchored` mode and its wrapper exposure after that reader cutover. its old body-focused anchor test is historical; qualify actual native selection → passage composer → save/dismiss instead. do not restore a dead producer to exercise the old interface.

## pdf contract

widen existing `Reader.setZoom` and surface `setZoom` to `number | null`; numeric values use existing clamp/steps, null means fit width. pass null through to existing `page-width` scale/reflow and restore saved null as well as numeric zoom. compare chosen mode as well as effective scale: fixed numeric and fit can have the same percentage but different resize behavior. no new reader preference or locator schema.

visible group: `−`, `{n}% · fit width` (or `fit width` when fitted), `+`. accessible names: `zoom out`, `fit pdf to width; current zoom {n} percent`, `zoom in`. keep the group together; wrap after page navigation. fit is responsive width fitting, never an alias for 100%.

zoom/fit/reflow alone writes no reading progress and never adopts an inspected page. the next genuine reading movement saves the chosen numeric/null mode. leaving immediately may restore the previous saved mode. preserve location, cancellation and exploration ownership.

## exclusive work packages

implementation coordination, 2026-10-16: the authorized index owner in branch
`codex/index-reordering-20261016`, worktree `nexus-web-index-reordering-20261016`,
implements the bounded backend/lectern prerequisite and exposes its commit.
no competing implementation starts here. packages a and the overlapping lectern
part of b consume that sequential handoff; the index owner also owns required
wire/caller migration for its cutover. remaining principal-action presentation
and runtime work follows the reviewed commit, preserving this contract.

paths are under `apps/web/src/` unless prefixed otherwise. freeze contracts before parallel work; one writer per file, including generated wire. each lane has an implementer, a content designer and an independent adversarial reviewer. roles may share people, but nobody approves their own work.

| owner | exclusive files / responsibility | prerequisite |
|---|---|---|
| a: lectern domain | migration; `python/nexus/{db/models.py,schemas/collection_order.py,schemas/consumption.py,api/routes/consumption.py,services/consumption/lectern.py,services/consumption/state.py,services/media_deletion.py}`; `lib/api/wire.gen.ts` | revision/writer audit; backend designer owns conflict and uncertainty meaning |
| b: action and lectern runtime | `lib/lectern/lectern.tsx`; `lib/actions/{project.tsx,ResourceActionsProvider.tsx,catalog.ts}`; `lib/workspace/store.tsx` foreground token | a/d contracts; serialize store edits with tabs owner; designer owns pending/result copy |
| c: principal and row presentation | `lib/panes/paneChrome.tsx`; `components/workspace/PaneShell.{tsx,module.css}`; `components/collections/LecternAddControl.tsx`/css; `app/(authenticated)/{conversations/ConversationsPaneBody.tsx,libraries/[id]/LibraryPaneBody.tsx,podcasts/PodcastsPaneBody.tsx,search/SearchPaneBody.tsx}`; `components/collections/SuggestionsSection.tsx` and `app/(authenticated)/{media/[id]/Transcript.tsx,lectern/LecternPaneBody.tsx}` consume the migrated command api | b; designer owns labels, states, 320px geometry; no shared collection primitive rewrite |
| d: menu interaction | `components/ui/ActionMenu.tsx`/css; `lib/ui/overlay.ts`; `lib/actions/useResourceActionMenu.tsx`; `components/nexus/desktop/DesktopNexus.tsx` focus/direct-close integration; narrow scope-label changes in `components/ui/SurfaceHeader.tsx` / `components/appnav/MobilePaneBar.tsx` | independent of a; publishes interactive-open generation for b; sequential overlay/header handoff with inspector/tabs owners; designer owns unavailable/retry/subject copy |
| e: reader | `lib/documentReader/{runtime.ts,pdf/PdfSurface.tsx,chrome/ReaderNavigation.tsx,chrome/ReaderNavigation.module.css}` | independent; reader designer approves fit label, scale and bound states |
| f: adjacent slices | libraries owner implements its task and publishes c's slot; tabs owner handles `NexusRow`, `NexusPages`, `lib/nexus/{model.ts,rows.ts}`, controller/host activation and surviving-row focus; reorder owner handles grip/gesture/move | consume a/b/c/d contracts; no duplicate shell/menu/revision implementation |
| g: qualification/docs | disposable external runner; verification receipt; module docs and issue register | independent reviewer at every gate; checks actual rendered content |

serialize c’s `PaneShell` changes with the tabs owner; serialize shared pane-body edits with find/reorder owners. d owns the entire desktop nexus action-cell edit and consumes the tabs controller result; f does not edit that file.

rename the existing nexus row `menu` union to an explicit `secondary` union (`ResourceMenu` / `CloseTab`), retaining its existing subject data; no new registry. tab close must never register as a menu trigger: `useNexusRowMenus` programmatically clicks that trigger for cmd/ctrl+k. retain arrow selection of primary/actions cells; enter on a tab’s actions cell closes that named tab; prevent default on repeated enter so one held key cannot close surviving rows. cmd/ctrl+k does nothing for a tab row and still opens real resource menus. remove the close control’s menu aria and shortcut hint. preserve surviving-row focus. manage tabs already has direct close; fix its in-place management under its own plan. uncapping/maximize/strip reorder are not prerequisites.

for grip work, consume the index plan's dedicated handle and retained move commands; never leave menu-button drag listeners beside the new handle. this plan can land its independent changes before the grip work, but cannot claim that issue resolved until its owner qualifies it.

## red → green → refactor → delete

qualification adjustment, 2026-10-16: the user waived accessibility-specific
testing. retain ordinary task, keyboard-command, touch and state-correctness
checks; no screen-reader, forced-colors or accessibility conformance sweep.

the user's disposable-test instruction is a task-scoped exception to [testing standards](local-rules/testing-standards.md). keep `./scripts/test` unchanged as the permanent static gate. the specification phase added no application changes. implementation uses the task-scoped disposable tests described below; deployment remains separate.

1. **contract:** independent architecture, interaction and content review challenges every boundary and failure claim. resolve material objections before coding; record unrelated defects immediately in tickets.
2. **red:** use an isolated full stack with real auth, web, bff, api and storage, normal sign-in and task-owned data. put runner/dependencies/network controls outside checkout. prove observable baseline failures; missing future selectors or unavailable infrastructure are not reds. freeze the assertions before implementation.
3. **green:** implement a/b, then c; d/e and independent adjacent slices may proceed in parallel. run `./scripts/test` and the relevant real journeys. review each handoff against its contract and designer's states.
4. **refactor:** independent reviewers challenge delayed requests, focus races, false copy and surviving duplicate paths. simplify at existing owners; rerun affected cases and the static gate after changes.
5. **delete:** retain `docs/principal-actions-verification.md` with source/build identity, baseline/final observations, environments, limitations and cleanup manifest. delete only task-owned tests, fixtures/data, dependencies, proxies, profiles, credentials and processes after final green. rerun `./scripts/test`; independently review cleanup. no permanent suite or test-only production seams.

delay/abort real reads and forward real mutations before discarding their responses; never fabricate successful responses, bypass auth or seed react state. hold requests before upstream delivery to prove ordering, including after a newer accepted no-op. inspect results through normal apis. released-candidate smoke uses existing production content after the ordinary release process; this document does not authorize deployment. report unavailable checks as blocked, never passed.

| case | required observable acceptance |
|---|---|
| principal tasks | named control works during list loading/error; existing menu entry still works; library destination stays correct; mouse, keyboard and modified links preserve their meaning |
| row scope | only approved cohorts gain add; same resource in two panes shares pending state; unrelated actions remain live; no per-row menu request on mount; title remains a link |
| add/recovery | success followed by slow/failed/older read remains acknowledged; lost real response permits exact retry; opposite same-media command cannot bypass uncertainty; membership/capacity never erases recovery |
| revision fence | delayed old ensure and delayed old remove cannot reverse a newer accepted opposing command, including newer no-ops; simultaneous other-media edits conflict intelligibly; finish/undo/sync/agent/teardown advance the fence; hidden rows retain capacity/order semantics |
| late result | leave, leave-and-return, replace source under the same visit, navigate/close origin, edit or open-and-close another task while create/learn is pending; no automatic navigation or focus theft; retained explicit open reaches the returned result |
| menus | tab/shift-tab destinations in each load state, modal edges and nexus’s programmatic trigger; escape/outside/dialog handoff; focus still correct after animation frames and delayed responses; editor/composition keys remain isolated. current reader selection uses the actual passage composer, not the retired anchored menu |
| pdf | minus/plus bounds, numeric and null restoration, equal-scale fixed/fit modes after pane resize, no zoom-only progress write, genuine movement saves mode without adopting an inspection |
| adjacent slices | inactive-pane press succeeds once without target motion; direct close cannot be invoked by the menu shortcut or repeat through surviving rows on held enter; surviving focus and manage-tabs continuity; grip does not open menu and menu does not drag |
| presentation | 320px panes, mobile portrait, 200% text, long titles/reasons, existing themes, reduced motion and coarse targets; stable control positions and readable focus |

run relevant cases in chromium; repeat focus/portal/modal and geometry cases in firefox/webkit. check touch/back on physical android; screen-reader claims require an actual check. no broad replay of unrelated journeys after required evidence passes.

cutover deletes direct-add resource-menu preflight, checkbox-derived membership, unconditional lectern write helpers, old 204 assumptions, inverse-verb checkbox projection, menu tab loop/default tabbable items, nexus's delayed focus restoration and pdf zoom-only menu. sibling owners delete the inline library form, one-purpose tab menu and menu drag bindings. no feature flags or parallel legacy rendering. update `docs/modules/{workspace,resource-actions,overlays,reader-implementation,player}.md` where their contracts change; remove tickets only after their acceptance, not upon writing this plan.

accepted costs: controls consume width/height; existing menu commands are duplicated; reasons increase menu height; revision fencing adds a migration and writer coordination and can reject unrelated concurrent edits; add/remove/place receipts/recovery are session-local (the reorder plan separately persists unresolved moves); cancelled input may require explicit result opening; zoom may revert if no reading movement follows; native focus needs cross-engine qualification; deleting tests leaves no retained automated journey regression coverage. these costs buy explicit tasks, stable targets and truthful outcomes without a new platform.
