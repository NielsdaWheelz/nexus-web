# pane tabs implementation plan

status: implementation in progress on `codex/pane-tabs-20261016`.
origin: 2026-10-16 owner review. decisions: remove the pane-count cap;
session-local maximize; three browser engines plus targeted physical android.
implementation review removed dedicated accessibility testing; functional
keyboard, focus, menu, touch and continuity acceptance remains.
the canonical-main reader cutover subsequently retired directly anchored menus;
their old acceptance is historical. its passage-composer owner qualifies the
replacement; shared-menu removal must follow that reader cutover.

## scope and final state

make the pane strip a reliable map of the spatial workspace: readable identities,
predictable keyboard targeting, direct reordering, and maximize/restore. keep
simultaneously visible panes and [toolbar semantics](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/). implement the focus, close,
minimize, strip geometry, manage-tabs and entry defects linked below.

no tab groups, pinning, split trees, detached windows, arbitrary keybindings,
virtualization, automatic suspension, durable maximize preference, new undo
system, persistence redesign, browser-history redesign, deployment or release.
implementation authorized by the owner on 2026-10-16; the execution gates below
remain required.

## invariants and schemas

the existing python `WorkspaceState` remains the wire/schema owner. retain
`{active_primary_pane_id, panes}` and every pane's id, current visit, width,
visibility, back/forward history and secondary pane. change `panes` to a
nonempty array with no product maximum. retain unique pane/visit ids, a visible
active pane, 12 back/forward entries combined per pane, 48 overall, and five
session-local recently closed panes. no database migration or new wire field.

http contract stays unchanged: authenticated `GET /me/workspace-session`
returns `own` and `most_recent_elsewhere`; `PUT` replaces this device's whole
state, last write wins, and returns 204. widen pane-count validation only;
retain the serialized web saver. no reorder endpoint.

`state.panes` is the only order: strip, desktop canvas, adjacent traversal and
manage tabs project it. reorder changes only that array's order; exact pane
objects, active id, visits, histories, widths and companions survive. minimized
panes participate without being restored. no-op moves publish/save nothing.

`WorkspaceHost` owns one local `isMaximized` boolean. effective maximization is
desktop plus that flag, applied to the active pane. it follows activation and
close/minimize successors, suspends on mobile, resumes on desktop, and resets on
reload. it never writes stored widths or visibility. desktop pane wrappers and
primary bodies retain their keys and mounts; hidden siblings are inert.

retaining a react mount alone is insufficient: native keyed placement resets
nested browser scrollports. the canvas owns pre-mutation capture and synchronous
post-mutation restoration of the same descendant nodes on reorder. preserve both
axes. hidden panes retain their last visible offsets until reveal after relocation;
discard those offsets when the pane, mounted body or visit changes. ordinary
hide/show keeps native restoration. this local layout boundary never replays
history or writes reader progress.

derive effective pane visibility once in the host and pass it through
`PaneShell`/`PaneRuntimeProvider`; `usePaneIsVisible` reads that projection.
hidden panes cannot expose a companion portal. overlays remain the interaction
owner while open; editing, selection and composition retain their keys.
adjacent traversal and the last-visible minimize guard use stored visibility;
effective visibility controls rendering/activity only.

## capability and interaction contract

| input or action | target and result | focus |
|---|---|---|
| cmd/ctrl+shift+left/right | adjacent visible pane in array order; clamp; never restore or wrap | destination pane chrome, mobile landmark |
| strip left/right; home/end | focus all strip items, including minimized; wrap arrows; home/end choose ends | title only; no activation |
| title click; enter/space | restore if needed, activate, reveal even if already active | destination pane chrome |
| delete/backspace in strip | close the explicitly focused item once per physical press | next surviving title to its right, else left, else new lectern |
| shift-m in strip | if this item is the maximized active pane, restore layout; otherwise restore/activate it and maximize | invoking strip control |
| minimize menu action | hide named pane; refuse last visible pane; active successor chosen by store | invoking strip menu trigger |
| restore-pane menu action | make named pane visible and active | invoking strip menu trigger |
| close menu/direct button | same close command; closing a view does not delete its resource | same strip successor rule |
| move earlier/later menu action | move named pane by one position, including minimized panes; clamp | invoking menu trigger |
| drag tab body | preview locally; one valid drop commits order; background drag never activates | surviving dragged title; repair only lost focus after removal/breakpoint |
| manage-tabs menu close/minimize/restore/reorder | update the page in place, including closing the active/final pane | surviving row control; close uses next row then previous |
| manage-tabs open/restore recently closed | activate exact pane and dismiss nexus | destination pane |

no shift-w or shift-arrow pane bindings; no new global letter bindings. close
and maximize ignore key repeat. check exact modifiers, composition,
`defaultPrevented`, overlay ownership and actual DOM containment; portaled menu
events must not become strip commands. navigation may repeat.

each chip contains title, existing overflow-menu button, and a stable direct
close target. overflow replaces inline minimize. retain one toolbar tab stop:
roving state is `{paneId, control: "activate" | "menu"}`. left/right/home/end
visit titles from either control. down/context-menu/shift-f10 on a title opens
its menu: focus/register the button received through `ActionMenu.triggerRef`,
then call that button's `.click()`.
pointer menu opening also focuses more, including in safari; escape returns there.
tab/shift-tab exits the toolbar. direct close uses `tabIndex=-1` with the keyboard
equivalents above.
use `ActionDescriptor` and existing overlay/menu primitives; no new action schema.
when an action exposes a companion sheet, its modal focus overrides the table;
an existing overlay retains ownership as specified below.

## owners and internal interfaces

input adapters invoke named store commands; the existing synchronous commit
feeds the host and session saver.

```ts
// workspace store; existing commands otherwise retain their contracts
type WorkspaceSelection = { paneId: string; visitId: string };
movePane(input: { paneId: string; beforePaneId: string | null }): boolean;
closePane(paneId: string): WorkspaceSelection;
minimizePane(paneId: string): WorkspaceSelection;
// host-local callback; desktop strip only
toggleMaximize(paneId: string): void;
```

`beforePaneId: null` means end. resolve ids against current state; return false
for unchanged order or missing source/destination. cancel obsolete drag previews.
close/minimize return the exact committed active pane/visit, unchanged on refusal.
retain the store's successor rule: next visible pane right, else left; if none
survive, restore the nearest remaining pane; if none remain, create a lectern.
strip focus selection is a separate surface concern.

share the minimize/restore, move and close descriptors between strip and manage
tabs in one small workspace-specific builder. inputs are current workspace
state, target id, and the caller's command/focus callbacks; output is existing
`ActionDescriptor[]`. the desktop caller adds maximize. keep menu availability
and wording there; the store enforces state invariants.

host focus entry activates its containing pane without refocusing it; require
actual `wrapper.contains(event.target)` to exclude portals. use existing
`useLatestWorkspace()` for live state, not the render snapshot. only an actual
content-origin active-id change creates a host-local, one-transition reveal
suppression; release the canvas's held target. pointer activation must not move
its target before release. consume matching suppression once; explicit navigation
clears it and reveals, including already-active tab clicks. cancel pending focus
when the user establishes another owner.

strip management callbacks own strip focus; host reveals a changed active
successor without also requesting content focus. menu close uses
`restoreFocusOnClose: false`; surviving-menu actions use the primitive's normal
return-before-command behavior. the launcher's own tab commands absorb exactly
the command result's `paneId + "\0" + visitId` into its navigation baseline on
root and manage tabs; external navigation still dismisses it. no blanket
suppression or post-command read of captured state.
its menu restore activates the minimized open pane and stays in manage tabs;
read the live `useLatestWorkspace()` getter afterward to absorb that selection.
primary open and recently closed restore activate and dismiss nexus.
the Open group always exposes manage tabs, even with one pane; mobile management
must not depend on exceeding the root's five-row display budget. this costs one
permanent launcher row.

## geometry and dragging

give each chip a `12rem` floor and `15rem` maximum, then scroll the strip.
use 32px controls (`--size-md`) within the existing 40px strip
(`--tabsbar-height`); coarse pointers use 44px controls (`--size-xl`) and a 52px
strip. preserve theme/type tokens, active/in-view/minimized distinctions, visible
focus and stable controls. reveal active/focused items by scrolling only the
strip; ellipsized titles retain their full accessible names.

use installed `@dnd-kit/core` and `@dnd-kit/sortable` directly in a strip-local
horizontal adapter. reuse existing mouse/touch activation values (8px movement;
250ms hold with 8px tolerance), without adapting the resource-list component.
title/body is the drag surface; menu and close are excluded. preserve native
horizontal touch scrolling before pickup. use an inert, aria-hidden overlay
without duplicate ids/sortable registration, translation without scaling,
an insertion preview, and autoscroll limited to the strip. escape, pointer
cancellation, outside-strip drop, missing source/target and mobile breakpoint
changes cancel. `over: null` cancels; it never means `beforePaneId: null`.
map a valid insertion slot to its surviving right neighbor, or explicit end.
suppress the release click only for an actual drag. pin core6.3.1 through the
existing bun dependency-patch mechanism: its retired document blockers and timer
must end on a fresh pointer press; keydown and selectionchange end synchronously
when the drag ends. keep ordinary release suppression and the
strip's guard for a delayed physical release after escape/unmount; do not replace
native button activation or depend on private sensor fields. declare sortable
and utilities directly. reduced motion removes
decorative displacement animation. move menu actions provide keyboard and
[single-pointer access](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
without a second keyboard drag mode.

extend the existing canvas measurement owner with
input `mode: "Disabled" | "Canvas" | "Maximized"`; return
`availableWidthPx: number | null` and `releaseHeldTarget(): void`.
mobile measures nothing; desktop measures in layout and through the existing
observer. until the first/resumed measurement, retain current presentation;
never transiently open a sheet or move focus from an unknown width.
only canvas mode enables pan, fades and held-target scrolling; leaving it clears
the target. do not add another workspace-width observer.

maximized wrapper, error boundary and shell fill the available workspace;
`slotMinWidth` becomes `100%`. the primary track flexes; reader prose retains
its existing measure; pdf overflow stays in its reader scrollport. omit the
outer primary resize handle. account
for the published document rail and actual borders in one width calculation.

ordinary desktop canvas retains companion columns. only the maximized active
pane uses the following fit rule; mobile retains its existing sheet.
let `w` be shell content-box width after shell borders and `r` the published
rail width; companion width already includes its own border. show an inline
companion only when `w >= 320 + r + COMPANION_MIN_WIDTH_PX`; clamp its rendered
width to `min(stored/default width, COMPANION_MAX_WIDTH_PX, w - 320 - r)`.
otherwise present it through the existing sheet. this is responsive composition,
not a persisted visibility change. companion rendering and controller both take
the same `"Column" | "Sheet"` presentation instead of inferring it from
`isMobile`; keep global mobile chrome classification separate. inline resize
values/limits use effective geometry; only intentional resizing writes width.

sheet activity requires effective pane visibility; at most one companion sheet
is active. promotion captures the live opener and focuses the selected inspector
tab. demotion skips modal return-focus and transfers focus only if the inspector
owned it: the same logical input, falling back to its selected tab.
host/strip cannot reclaim modal focus.

the shared overlay owner exposes `useInteractionBlocked(scope): boolean` from
its existing subscription: true when another scope owns interaction, including
an unscoped menu. while blocked, retain the last committed column/sheet
presentation and defer new sheet admission. an already-open sheet stays mounted
under covering overlays; never multiply its activity by this blocking flag.
recheck live ownership before admission in layout. visibility loss or explicit
close retires the sheet immediately; hidden panes cannot reclaim focus, and
visibility loss does not collapse the stored companion. explicit open dismisses
nexus before the destination sheet owns focus. no polling or second overlay stack.

column/sheet changes retain one local companion-owned portal subtree. its empty
destination slot supplies the actual overlay context; closed menu layers bind
to that current parent before reopening. transitions already defer under an
open menu. this preserves dossier, forks, members and nested search drafts
without moving layout state into domain forms. no reusable retention framework,
second modal registration or DOM draft scraping. primary bodies stay mounted.
restoring canvas reveals the active pane; prior canvas offset is not retained.

## hard cutover and reuse

remove `MAX_PANES` in python/web and `WorkspaceState.panes.max_length`;
unmatched cold links append without slicing. fork/adopt and reopen never refuse
for pane count.
delete `PaneLimitReached`, cap-only `Rejected` result variants, store cap callback
and warning. retain minimum length, history limits and other schema validation.

remove nexus cap-only `MaterializedNexusTarget`, `RetainedTarget`,
`NexusDispatchOutcome`, `Retained`, `Blocked`, manage-tabs retained/restore-blocked
fields, retry/cancel branches, `Completion` plumbing, warning copy and orphaned
`.recovery` styles. dispatch becomes void; collapse successful completion without
an accepted-only wrapper. remove the cap branches in app navigation and sharing;
preserve genuine import/add/chat/auth rejection and creation-error recovery.

delete inline minimize markup/styles and persisted-only runtime visibility
derivation when their replacements land. no feature flags, duplicate renderers,
compatibility paths or silent truncation. regenerate wire through its owner.

reuse `ActionMenu`, `OverflowMenuButton`, `ActionDescriptor`, `MobileSheet`,
`ResizeHandle`, pane DOM focus helpers and the shortcut reference. shared menus
own two prerequisites: visible wrapping `disabledReason` text, retaining
`aria-describedby`; and tab/shift-tab exit from the invoking control.

for menu tab exit, synchronously make the departing menu inert, directly focus
its live trigger/opener with `preventScroll`, and close without return-focus.
do not use `restoreFocus`'s delayed retry. extract the existing modal tab-boundary
branch in `lib/ui/overlay.ts` for reuse; wrap only at the enclosing modal edge,
otherwise leave native tab default intact. retain propagation suppression,
arrow/typeahead/escape behavior and menu-to-dialog handoff. command/link items
use `tabIndex=-1`; custom controls retain their native behavior until menu exit.
narrow manage-tabs broad button selectors before adding shared controls.

## content and designer ownership

each lane names a content designer to author existing-schema copy and review
rendered narrow layouts. content names the target/action, distinguishes closing
from deletion, explains disabled actions and announces completion once; preserve
sentence-case ui, compact enabled controls and no redundant toasts.

| feature designer | required content |
|---|---|
| keyboard and close | `Tab actions for {title}`, `Close {title}`, `Close tab`; normal tone. shared strip description: `Arrow keys browse tabs. Enter opens. Down opens actions. Delete closes. Shift+M maximizes or restores.`; reference also gives scope/home/end |
| visibility and maximize | `Minimize pane`, `Restore pane`, `Maximize pane`, `Restore layout`; disabled reason `Keep at least one pane visible.`; restore never means maximize |
| reorder | `Move earlier`, `Move later`; reasons `Already the first tab.` / `Already the last tab.`; polite completion `Moved {title} to position {n} of {count}.` |
| manage tabs and cap removal | subtitle `Open, close, restore, or reorder workspace tabs.`; retain recent-close language; delete every capacity warning and make-room instruction |

reuse shortcut formatting/aria projection; extend the reference with a separate
strip-scoped section. do not force shift-m into the matcher that requires
cmd/ctrl, add arbitrary chord configuration, or put shortcut text into menu labels.

## non-overlapping work packages

paths below are under `apps/web/src` unless prefixed otherwise. one owner per
file; freeze interfaces above before parallel implementation. each owner has the
corresponding designer; an independent peer reviews every gate.

| package | exclusive files and responsibility | dependencies |
|---|---|---|
| a state and count removal | `lib/workspace/{model.ts,store.tsx,targetActivation.ts}`, `python/nexus/schemas/workspace_session.py`, `lib/api/wire.gen.ts`, cap consumers in `components/appnav/AppNav.tsx` and `components/sharing/ShareOverlay.tsx` | contracts first |
| b host and presentation | `components/workspace/{WorkspaceHost,WorkspacePaneCanvas,PaneShell,Companion,PaneRouteErrorBoundary,usePaneCanvas}` and their css; `lib/panes/paneRuntime.tsx`; `lib/workspace/{paneDom,paneSizing,adjacentPaneKeybindings}.ts` as needed | a/e contracts |
| c strip and content | `components/workspace/WorkspacePaneStrip.{tsx,module.css}` and strip-local sortable item if needed; new `lib/workspace/paneActions.ts`; `lib/shortcuts.ts`; `app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx` | a/b contracts; e |
| d manage tabs | `lib/nexus/{model,rows}.ts`, `components/nexus/{useNexusController.ts,NexusPages.tsx,Nexus.module.css}`; count-path deletion, permanent entrance and in-place management | a narrowed results; c shared descriptors |
| e shared menus/ownership | `components/ui/ActionMenu.tsx`, its css; `lib/ui/overlay.ts` tab-boundary helper and reactive scope query | first; no unrelated overlay rewrite |
| integration and proof | this plan, relevant module docs, verification receipt and issue register; temporary external harness | all packages |

integrate a, then b/e, then c/d. preserve unrelated dirty work; serialize shared
file edits with the inspector work, without absorbing its tooltip work.
update `docs/modules/{workspace,panes-tabs,app-navigation,
imports,overlays,visual-system}.md` at implementation cutover.

## live acceptance and execution

the owner's temporary red/green/refactor/delete instruction is a task-scoped
exception to [testing standards](local-rules/testing-standards.md). keep
`./scripts/test` as the unchanged permanent static gate. no permanent tests or
test-only production seams survive the change.

use a task-owned directory outside the checkout for pinned browser dependencies,
drivers and private artifacts. use [playwright role/name locators](https://playwright.dev/docs/locators).
exercise browser → web/bff → api → real isolated database/auth through normal
sign-in and product APIs. create only task-owned
fixtures: reader, note/chat draft, companion, collection and varied pane titles.
no fake successes, mocked owners, auth bypass, seeded react state or test exports.
[network controls](https://playwright.dev/docs/network) may delay/abort real
requests; successful bodies remain real.

| case | observable acceptance |
|---|---|
| 1 targeting | tab into a sibling pane: active styling and search agree; pointer press on inactive more succeeds once without target motion; activating an already-active offscreen pane reveals it |
| 2 keyboard | strip focus/activation separation, wrap versus clamp, minimized entries, exact modifiers, composition, held close/maximize; pane commands respect playback and overlay ownership |
| 3 management | close active/inactive/final panes; minimize last-visible refusal; minimized successor focus; recent-close restoration; manage tabs retains focus during own management, including restore with a stored-open companion; external navigation dismisses it |
| 4 reorder | foreground/background/minimized panes, both directions, explicit end, menu moves, overflow autoscroll; outside/null drop, escape, touch cancellation, source/target removal and breakpoint cancel without workspace change; one changed drop commits once, unchanged drops publish/save nothing; focus survives, drag never activates |
| 5 continuity | reorder/maximize preserves main-pane draft, caret, reader position, visit/history, widths and inspector selection/input; primary bodies do not remount or write unintended progress |
| 6 maximize | switch/close/minimize; restored widths and active reveal; reload reset; mobile round trip; 720px companion, rail, pdf, fit threshold and unknown-width lifecycle; sheet promotion/demotion with and without nexus/nested-menu ownership; loading/error/unsupported bodies also fit |
| 7 uncapped sessions | open at least 30 mixed panes; cross twelve through fork/adopt/cold link/reopen; save/reload preserves ids/order and evicts nothing; page/library/import completion and members navigation still work |
| 8 persistence | delayed saves then newer reorders converge; failed save retains live order and retry persists it; confirmed save reloads exact ids/order; ambiguous response reloads last server-committed state, never fabricated rollback; record unload behavior and payload size |
| 9 layout and content | long/duplicate/pending titles and narrow desktop; names/control targets remain usable; only the strip scrolls on strip focus; physical touch controls remain usable |
| 10 shared menus | tab/shift-tab exit triggered menus, including inside a modal; loading/error/disabled-only menus; escape and dialog handoff; visible long disabled reasons fit narrow layouts |

run all cases in chromium. repeat keyboard/focus, drag, geometry and menu cases
in firefox/webkit. physical android chrome and the existing app shell qualify
manage-tabs open/close/minimize/reorder, focus and rotation; actual wide-touch
drag needs a physical wide layout. record any unavailable device distinction
as blocked, never as a pass. 30 panes is a qualification sample, not a new cap.

1. **contract:** independent architecture, interaction and content
   review resolves contradictions and owner overlaps before tests.
2. **red:** immutable baseline, genuine failing journeys and preservation cases;
   unavailable setup is blocked, not red. do not count cascading failures twice.
3. **green:** implement by owner; independent review challenges identity, focus
   races, hidden portals, save ordering, rendered copy and count-path deletion.
4. **refactor:** consolidate actual duplication, delete replaced paths; rerun
   affected live cases and `./scripts/test`; reviewer verifies exact served build.
5. **remove:** write `docs/pane-tabs-verification.md` with baseline/final sha or
   diff digest, served identity, environments, outcomes and limits; delete only
   task-owned tests/dependencies/fixtures/services/seams, rerun `./scripts/test`,
   and independently review cleanup. blocked acceptance remains open.

## tradeoffs and release constraints

uncapped count retains more mounted bodies, background work and larger saves;
there is no infinite-resource guarantee. measure the 30-pane run and repair a
demonstrated regression without inventing a suspension platform. normal saves
remain authoritative; browser-unload delivery is best effort, including its
existing payload budget and [open delivery issue](tickets/workspace-session-unload-can-send-empty-body.md).

readable widths trade simultaneous visibility for scrolling; secondary actions
cost a menu step. scoped shortcuts protect input ownership at the cost of global
convenience. menu moves avoid a keyboard drag mode. the canvas scans descendant scroll offsets on layout transitions to avoid coupling
to reader internals. narrow maximize makes the
inspector modal; its scroll may reset, and canvas offset is not retained.
session-local maximize resets on reload; history/recent-close retention stays
bounded. deleting temporary tests forfeits repeatable regression coverage;
the contract, receipt and static gate remain.

api widening must precede or accompany the web cutover. once more than twelve
panes are saved, old api code rejects the row and old web entry can truncate it.
rollback must retain the widening/non-evicting entry or use an explicit,
backup-preserving operator conversion. no compatibility shim or database
migration is part of this work; release itself remains separately authorized.

resolved at implementation cutover: active focus ownership, held-close repeat,
keyboard minimize, strip compression, management close continuity, cap eviction,
pointer target motion, menu tab exit and visible disabled explanations. their
tickets/register entries were removed after qualification. outcomes and remaining
limits live in [verification](pane-tabs-verification.md); unrelated issues remain
open.
