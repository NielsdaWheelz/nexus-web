# App navigation

App navigation has two projections with distinct jobs:

- the desktop rail is a small, fixed projection of Nexus's highest-frequency
  destinations;
- mobile has one Nexus entrance. Its opaque full-screen `SwitchboardTask`
  renders the mobile projection of the shared Nexus intent router.

Neither is a directory of every feature.

destination controls share the [workspace opening contract](workspace.md#target-activation):
shift-click/shift-enter create and focus a fresh adjacent pane; ordinary activation
follows the matching pane or navigates its origin. global controls capture the active origin at
activation; pane controls retain their bound origin. queue and metadata portal
hosts bind the same adapter with explicit runtimes. recovery and delayed-result
openings retain their own fresh gesture. multiline editing keeps newline.
one-shot launcher urls use `nexus/urlIntent.ts`; workspace entry strips their
control params from pane visits/history, while the hydrated receiver dispatches
the incoming command once. restored data never dispatches commands.

## Product contract

- **Lectern is home.** `/lectern` is the canonical authenticated home, the brand
  destination, and the first visible navigation item.
- **Browse, Podcasts, and Chats remain primary.** Atlas and Oracle are present
  but do not displace discovery, listening, and conversation tasks.
- **Desktop rail order is exact and flat:** Lectern, Libraries, Browse, Podcasts,
  Chats, Notes, Atlas, Oracle.
- **Mobile Places order is exact:** Lectern, Libraries, Browse, Podcasts,
  Chats, Notes. Stats, Atlas, and Oracle remain retrievable through Nexus.
- **Fixed navigation is not customizable.** Pinning is not part of this
  contract. personalized retrieval belongs in lectern suggestions and
  Nexus, where it can scale without destabilizing spatial memory.

on desktop, imports belongs under account; it has no standalone rail action.
the shared account menu is exactly stats, imports, downloads when available,
settings, a separator, and danger-last sign out. imports retains its canonical
`/imports` link, query/deep links, inspector and contextual acquisition entrances.
the mobile nexus account projection renders that same component and order;
mobile attention remains inside nexus, without a closed-launcher badge.

`AccountMenu` reads the existing `ImportsProvider` summary once. a known positive
`needs_attention_count` paints a passive warning dot inside account and a warning
`Pill` inside its imports item. the pill caps at `99+`; the imports link's complete
accessible name and account's persistent description retain the exact count.
account keeps its stable name and collapsed tooltip, `account`; description ids
compose with existing menu and tooltip ids. dot and pill geometry stay reserved
at unknown, zero and every displayed count, so updates preserve menu and focus.
opening either menu or page does not acknowledge attention.

loading or failure without data is unknown, not zero. refresh retains the last
observation; failed refresh retains its dot/count and qualifies positive status
as `couldn’t refresh imports; last update: {attentionPhrase(count)}`. retained
error outranks a retry's refreshing state until success. zero hides the marker
and count without claiming freshness; unavailable summaries add no global
warning, spinner or live announcement. the imports workspace owns errors and
recovery; navigation adds no observation or polling policy. quick note and today exist
only in Nexus. Both Nexus projections expose the same commands, results,
targets, workflows, history, and dispatch; the shared composer owns section
membership, order, and caps, while each renderer owns platform geometry.
Search, Authors, settings subpages, and other valid destinations remain
retrievable without becoming permanent navigation items.

Mobile Nexus is a temporary sustained task, not a drawer or bottom sheet. Root
owns the autofocused query; Choose Create, Choose Browse, Manage Panes, Add, and
recovery pages replace one another inside one opaque viewport-fixed dialog.
There is no separate Find page, scope state, outside-click, or drag dismissal.
the nexus control opens through native button activation: pointer click,
keyboard and assistive technology. primary button-0 presses are captured so
input blur restoring the player band cannot retarget their release. mouse, pen
and touch share the 8 css px movement threshold: reaching it cancels activation,
even if the pointer returns inside. only a primary-touch horizontal swipe can
invoke the adjacent-pane workspace command; it adds no second nexus ingress,
navigation event or full-screen-task gesture. admitted touch presses suppress
compatibility mouse focus so it cannot move nexus between release and click.
without a committed swipe, a cancelled touch preserves the existing input focus;
an accepted click transfers focus into nexus, and a committed swipe uses normal
destination focus. mouse/pen focus and keyboard activation remain native.
When task activation occurs during an already-acquired physical contact,
`SwitchboardTask` rejects the retargeted pointer click unless the same pointer
began inside the already-active task. That task-local provenance check carries
no gesture vocabulary or command and always admits keyboard/assistive native
activation.

Compact presentation covers widths through 768 px and coarse-pointer landscape
phones through 900 px. Fine-pointer short desktop windows remain desktop. The
server renders the desktop rail; the same media query hides it, so a phone never
paints it before hydration.

The rail's collapse is per browser, in the first-party cookie
`nexus.nav.collapsed` (`"1"` collapsed, `"0"` expanded; `path=/`, one year,
`samesite=lax`), written by the collapse control and read on the server into
`RenderEnvironment.navCollapsed`, so the skeleton, the server render and the
first client render already have the reader's width. During a session `AppNav`
holds it above its mobile switch, so a resize or rotation across the
breakpoint, which unmounts the rail, keeps the reader's latest choice.

## desktop launcher and collapsed help

the desktop entrance is a native `Search` button: a 20px magnifier, the same
row geometry/type as destinations, and the existing platform shortcut. its
transparent rest state has no field border or destination-selection marker.
activation opens the existing nexus root; its `Find anything…` query owns input
and focus. the launcher has no query state.

collapsed help names the launcher plus its shortcut and retains destination
labels: each is the shared `Tooltip` placed right, opening at once on mouse/pen
entry or keyboard-visible focus, disabled while the rail is expanded. its
trigger keeps its name; escape, a press, blur, expansion and modal coverage
close it. footer controls and mobile keep their existing entrances. the passive
overlay contract is documented in
[overlays](overlays.md#passive-navigation-help).

## Nexus content grammar

Nexus is one typed intent router with platform-native renderers. Its input is
always labelled and placeholdered **Find anything…**. Blank desktop order is
Open, optional Continue, Recent, Quick Actions. Blank mobile order is Open,
Quick Actions, optional Continue, Recent, Places; mobile renders every group as
one sectioned vertical list inside a single content scroller. Independent caps
prevent one group from erasing another. Quick Actions are Quick Note, Today,
New Chat, New Page, New Library, and Import.
the Open group always ends with Manage panes, including a one-pane workspace.

Typing removes blank groups. The shared composer admits at most eight owned
Results, then reuses the `QuickActions` section labelled **Do with query** for
Ask Nexus, Add to Today, Browse, Create, and See All. Those actions remain
outside the Results cap. Reserved verbs and slash aliases compile to explicit
typed intent; incomplete or unknown command text remains retrieval. Selection
is always required.

A result has one required primary label. It may add only facts already carried
by its projection, in this hierarchy:

1. a factual type label;
2. an owner or source;
3. `Open` only for an existing workspace pane;
4. an existing matched excerpt.

The primary label remains dominant. Nexus never invents a summary, confidence,
activity state, or type decoration merely to fill a row. Search-source failures
say either **Couldn’t search your resources** or **Couldn’t search inside your
library**, retain successful rows, and expose a source-specific **Retry** outside
the Results grid. External retrieval leaves Nexus through a typed Browse target.
Article and Podcast discovery target their explicit Browse kinds; no ambiguous
query invokes a provider-spending bare All query. Browse candidates open owned
content directly or a read-only Preview. They are never silently ingested.

desktop uses a combobox with a one-column grid popup. each candidate cell
contains its primary region and a native options or close control. the query
automatically highlights the first eligible existing result, excluding create,
import, ask and query actions. the focused input exposes the same candidate enter
accepts in both modes; raw query/scope changes immediately invalidate old actions.
reconciliation and scoped reveal use the shared collection owners; grid keyboard
commands stay here. the query
starts in editing mode; unmodified up/down with rows enters browsing using the
existing clamped order. text, composition, caret/selection editing and query
pointerdown restore editing without taking native keys. focus restoration and
hover preserve mode. mac control+a/b/e/f/n/p retain native caret/selection
movement and restore editing. enter always invokes the selected primary action; shift
retains the same destination/write and requests a fresh adjacent pane.

in browsing mode, plain space opens the selected resource's options on release.
the press captures one mounted trigger and never retargets: another key, text,
pointerdown, selection/trigger replacement, composition or page change cancels
its target; repeats remain consumed until release, and blur clears ownership.
release clears ownership before checking the original trigger, root, mode,
selection, query focus and interaction owner. a close-only or absent secondary
does nothing. there is no key relay or global keyup listener.

only the selected secondary is a result tab stop. secondary focus selects that
row, and hover can select only while the query owns focus. direct close focuses
the query before its row disappears; live removal repairs only lost focus and
yields to surviving controls or overlays. native enter/space activates the
secondary's named action. menus own their state and return-to-query behavior;
opening/closing options preserves query, selected row and mode.
`aria-activedescendant` names only the candidate while browsing with query focus.
one contextual help line names available gestures, adding `space options` only
for a selected resource menu. readable key descriptions accompany the query and
secondary controls; soft selection, browsing and native focus remain distinct.
mobile keeps sibling action buttons and 48 px targets. renderers never infer
command, ranking, target or workflow meaning from copy or identifiers.

browse and create choices retain their initiating opening intent until landing;
shifted confirmation upgrades it, and ordinary confirmation cannot downgrade it.
delayed creation/lookup uses the shared attention owner and canonical placement,
then the controller preserves destination or entry focus. later explicit add
result controls capture a fresh gesture rather than replaying add's opener.

## keyboard shortcuts

app shortcuts are fixed product behavior. `lib/shortcuts.ts` owns their keys,
labels, reference descriptions, matching, and `aria-keyshortcuts` projection.
command is the modifier on mac/ios; control is the modifier elsewhere. extra
modifiers, composing input, and already-handled events do not match. keys follow
the keyboard layout's `event.key` rather than a physical key position.

- command/control+k opens nexus and focuses the query. an already-open desktop
  palette consumes the chord without changing query, selection, page or focus.
  repeated keydown does not perform a second action.
  the chord yields to any other active overlay owner, including a nested menu.
- command/control+f belongs to the active pane. it yields to overlays and only
  prevents browser find when the pane accepts search.
- command/control+shift+left/right moves between visible panes without wrapping.
  it yields while typing or while an overlay owns interaction. the pane strip's
  plain arrow keys only move focus; modified keys reach the shortcut owner.
- the desktop strip has its own fixed keys: left/right/home/end browse titles
  and controls, enter/space activates, delete/backspace closes
  once per press, and shift-m maximizes or restores the named pane. tab leaves
  its single roving stop. these keys never become global letter bindings.

the same table supplies the read-only `/settings/keybindings` reference, linked
from settings and searchable in nexus. there is no shortcut preference,
capture, reassignment, provider, or persistence. old browser-local assignments
are ignored; they need no migration or cleanup code. destinations and quick
actions remain accessible through nexus and ordinary controls.

## Ownership

| Concern                                                           | Owner                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Authenticated home href                                           | `apps/web/src/lib/routes/defaults.ts`                                                                             |
| Destination identity (`id`, label, href, keywords, optional icon) | `apps/web/src/lib/navigation/destinations.ts`                                                                     |
| Rail membership/order and account destination classification       | `apps/web/src/components/appnav/navModel.ts` |
| Rail collapse cookie name and its server read                     | `apps/web/src/lib/renderEnvironment/{types,server}.ts`                                                            |
| Shared account membership, summary projection, attention and description | `apps/web/src/components/appnav/AccountMenu.tsx` |
| Passive imports menu label/count and complete status copy          | `apps/web/src/components/imports/ImportsBadge.tsx` and `lib/imports/copy.ts` |
| Nexus commands and typed intent                                  | `apps/web/src/lib/nexus/query.ts`                                                                                  |
| Nexus sections, Places projection, ranking, caps, and stability  | `apps/web/src/lib/nexus/rows.ts`                                                                                   |
| Nexus retrieval, latency gate, and history writes                | `apps/web/src/lib/nexus/useNexusFind.ts`                                                                           |
| Route-to-semantic-section ownership                               | section `header.destinationId`, or resource `sectionDestinationId`, in `apps/web/src/lib/panes/paneRouteModel.ts` |
| The rail itself: activation, collapse, indicator, commands | `apps/web/src/components/appnav/AppNav.tsx`                                                                     |
| collapsed rail help and dismissal | `Tooltip` (`placement: "right"`) in `apps/web/src/components/appnav/AppNav.tsx` |
| Mobile top bar                                                     | the active pane's `SurfaceHeader` (`projection: "Mobile"`) in `apps/web/src/components/workspace/PaneShell.tsx`, over `lib/mobileShell/chrome.tsx` |
| Internal-link gesture policy                                      | `apps/web/src/lib/panes/targetLinkActivation.ts`                                                                  |
| Target selection, restoration, creation, and activation           | `activateWorkspaceTarget` in `apps/web/src/lib/workspace/store.tsx`                                               |
| Server-restored deep-link merge                                   | `enterWorkspace` in `apps/web/src/lib/workspace/model.ts`                                                         |
| Nexus semantic contract                                          | `apps/web/src/lib/nexus/model.ts`                                                                                  |
| Desktop Nexus renderer                                           | `apps/web/src/components/nexus/desktop/DesktopNexus.tsx`                                                           |
| Mobile Nexus renderer                                            | `apps/web/src/components/switchboard/SwitchboardTask.tsx` and `NexusButton.tsx`                                   |
| Nexus workflow pages and row parts (both surfaces)               | `apps/web/src/components/nexus/NexusPages.tsx` and `NexusRow.tsx`                                                 |
| Nexus ingress and direct action session                          | `apps/web/src/lib/nexus/events.ts` and `apps/web/src/components/nexus/useNexusController.ts`                      |
| Daily Page location and note entries                             | `/daily/{date}` (`dailyDateFor` in `lib/notes/api.ts`) with `AppendNote` / `FocusNote`; the store delivers the entry to the visit the target lands on |
| fixed shortcut definitions and projections                      | `apps/web/src/lib/shortcuts.ts`                                                                                   |
| read-only shortcut reference                                     | `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx`                                   |
| Nexus history href canonicalization                              | `python/nexus/services/nexus_history.py`                                                                          |

The separations are deliberate. A destination can exist without occupying
fixed navigation; a pane route can identify its owning section without
reimplementing path-prefix matching; and Nexus ranking can change without
reordering the rail.

## Active-state semantics

Active state follows the active pane's semantic section, not URL-prefix guesses.
Section routes derive it from their one `header.destinationId`; resource routes
declare `sectionDestinationId` because their header has no section identity:

- `/media/{id}` and `/libraries/{id}` keep **Libraries** active;
- `/browse` and `/browse/preview` keep **Browse** active;
- `/podcasts/{id}` keeps **Podcasts** active;
- chat detail and new-chat panes keep **Chats** active;
- pages and note blocks keep **Notes** active;
- Atlas, Oracle, and Lectern map to their own destinations;
- Stats, Imports (including query variants), and Settings mark account current
  without creating a selected rail destination. `activeId` also marks the shared
  account menu's corresponding item current.

Routes that are intentionally absent from fixed navigation, such as Search and
Authors, do not fabricate a selected rail item. Section pane titles resolve
their orientation context from the route's typed `header.destinationId` through
the same destination registry, so pane identity and navigation cannot drift
through parallel maps.

## Activation and pane reuse

A plain primary-button activation of a supported app link is `Follow`. It
restores and activates an exact matching pane, including a minimized pane; when
none exists, it navigates the active pane. shift-click/shift-enter are `Fork`: create
and focus a fresh pane after the active pane even when an exact pane is
already open.

The activation boundary returns an explicit focus-owner result, never a boolean:

- `unhandled`: the browser owns the link gesture;
- `consumed`: owned repeat dispatches nothing and leaves its presenter open;
- `handled-source-focus`: the exact destination was already active, so a closing
  sheet/menu restores its trigger;
- `handled-destination-focus`: another pane was opened or reactivated, so the
  workspace destination owns focus.

AppNav derives the focus owner from the workspace activation result. Only an
unchanged activation retains source focus; navigation, restoration,
and creation hand focus ownership to the destination. an ordinary rail link keeps
the clicked link focused; shift-fork uses the workspace focus request. a choice
from the Account menu, whose item is gone once
the menu closes, focuses the landed pane's chrome target next frame.

On mobile, destination focus lands on the active pane landmark, never the
top bar or the contextual row. The landmark is stable while reader chrome retreats, so
route activation cannot pin or strand transient controls. Desktop retains its
explicit pane-chrome focus target.

The click policy leaves already-prevented events, non-primary buttons, and
Meta/Ctrl/Alt activations untouched so browser-native open-in-new-tab and
related link gestures still work. The rendered anchor always retains a real
`href` for semantics, copy-link behavior, and no-JavaScript fallback. Touch and
`Enter` use `Follow`.

The mobile Nexus task closes only after the workspace accepts navigation. A real
destination handoff suppresses return focus; nonnavigating dismissal restores
the Nexus trigger. workspace creation has no pane-count refusal. the launcher's
own close/minimize/layout commands stay in place on root or manage panes,
including final close; primary open and recently closed restore dismiss it and
focus the destination. external navigation still dismisses the task. the desktop Account
menu retains its existing focus contract.

manage-panes shares direct control content with the desktop strip. there are no
management menus or move-earlier/later commands. mobile omits layout controls and
reorder; its minimized title restores through ordinary activation. see
[panes](panes.md) for the state table and focus contract.

In the collapsed desktop rail, the brand and Expand control remain separate,
non-overlapping hit targets. The expand control must never be stretched over the
brand mark, because that makes an apparent Home activation trigger rail chrome.
account's warning dot stays inside its existing control, with no separate
target. the exact imports count belongs inside the account menu.

## Home and workspace restore

`APP_AUTHENTICATED_HOME_HREF`, the auth default, workspace empty-state fallback,
and brand href all derive from `/lectern`. There is no root redirect.

`/` is the authenticated **Resume** entry. Server bootstrap restores the saved
workspace unchanged, including its active primary pane; when no usable session
exists it creates the one-pane Lectern empty state. Root Nexus query intents
are consumed before the workspace projects that active pane back into the URL,
so they open over the restored workspace and never become panes.

`/lectern` is the explicit Home route intent, not a neutral placeholder for
“whatever workspace was active.” It keeps saved panes and then either:

1. restores and activates an existing Lectern pane, or
2. appends and activates a Lectern pane.

A lone, history-free Lectern pane remains a trivial persisted session for
cross-device restore selection. That storage heuristic does not erase an
explicit `/lectern` request.

## Change checklist

When adding or changing a destination:

1. Change identity once in the registry in `lib/navigation/destinations.ts`.
2. Change rail membership/order and account classification in `navModel.ts`;
   change account membership/order in `AccountMenu.tsx`.
3. Give a section route one `header.destinationId`; give a resource route one
   `sectionDestinationId`.
4. Add a destination to mobile Places only through the closed projection in
   `lib/nexus/rows.ts`; do not duplicate its identity outside the registry.
   Nexus history accepts any relative href, so the
   backend needs no change.
5. Verify desktop and mobile projection membership separately, semantic
   detail-route activity, native modified clicks,
   exact-pane reuse, minimized-pane restoration, and focus handoff.

This is the production-shaped 80/20 solution: a typed identity registry, one
small curated projection, semantic route metadata, and the existing pane store.
It avoids both duplicated conditionals and a premature configurable-navigation
system.
