# App navigation

[recent resources](recent-history.md) owns device-local recall, accepted-use capture
and history feedback.

App navigation has two projections with distinct jobs:

- the desktop rail is a small, fixed projection of Nexus's highest-frequency
  destinations;
- mobile has one nexus entrance. `SwitchboardTask` renders the shared intent
  router in a bottom-anchored `MobileSheet`.

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
- **mobile places order is exact:** today, lectern, libraries, browse,
  podcasts, chats, notes, atlas, oracle. the sheet presents one horizontal
  chip row; stats remains in account and retrievable through nexus.
- **Fixed navigation is not customizable.** Pinning is not part of this
  contract. personalized retrieval belongs in lectern suggestions and
  Nexus, where it can scale without destabilizing spatial memory.

on desktop, imports belongs under account; it has no standalone rail action.
the shared account menu is exactly stats, imports, downloads when available,
settings, a separator, and danger-last sign out. imports retains its canonical
`/imports` link, query/deep links, inspector and contextual acquisition entrances.
the mobile nexus account projection renders that same component and order;
mobile attention remains inside nexus, without a closed-launcher badge.

`AccountMenu` owns its decorative person-in-circle mark and passive attention
dot. the desktop rail retains its expanded label. the mobile sheet places the
same account menu behind its farthest `account` row; the root has no header.
account retains its trigger state, status description and focus/navigation owners.

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

mobile nexus opens keyboard-down in a bottom sheet, with the armed row focused.
tapping the field raises the keyboard. the field is the last child outside the
scrollport and follows the keyboard inset; rank one touches it, with subsequent
ranks above and continuations farthest away. blank order, nearest the field
first, is here, previous pane, other tabs, recent picks, actions, places chips,
then account. the sheet has a 44px handle strip, scrim dismissal and a guarded
96px downward drag. back clears root text before closing. nested overlays,
child pages and active pane moves retain their own dismissal precedence; see
[overlays](overlays.md#surfaces).

add, create library, use text, choices and capture today stay in the same sheet
with their own back/title headers and initial focus. pane expansion and
recently-closed recovery remain inline disclosures. `new pane` is a row verb,
with the workspace's `Fork` disposition; there is no new-pane picker mode.
ordinary row activation retains `Follow`. phone tab rows keep the independent
× and have no rail; fork an open pane through its resource row.

the nexus control opens through native button activation: pointer click,
keyboard and assistive technology. primary button-0 presses are captured so
input blur restoring the player band cannot retarget their release. mouse, pen
and touch share the 8 css px movement threshold: reaching it cancels activation,
even if the pointer returns inside. only a primary-touch horizontal swipe can
invoke the adjacent-pane workspace command and show the destination title for
600ms, or `first pane` / `last pane` at the clamp; it adds no second nexus ingress,
navigation event or additional sheet gesture. admitted touch presses suppress
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

the desktop entrance is a native `Nexus` button: the asterism, the same
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

## nexus content grammar

nexus is one intent router with platform-native renderers. dialog and rail entry
are named `Nexus`; the input is labelled and placeholdered `find anything…`.
blank opens on `here`, the current pane's resource, followed by other panes
under `tabs · {total}`, up to eight `recent picks` excluding the current
resource, and `actions`: quick note, new chat, import, plus resume only while
playback is paused. recent history is device-local; unknown history is not empty.
`loading recent…` and `resources you open will appear here.` retain their
recent-read meanings. failure exposes retry while usable rows remain visible.

blank arms the most recently active other pane; with one pane nothing is armed
and enter is a silent no-op. session-local activation order and the reorder
transaction are owned by [panes](panes.md#mobile-contract).

a nonempty dom selection surviving at open pre-arms `use this text…`, carrying
that literal and performing no write. page/note selections can survive this way.
reader pointer drag commits the selection into the highlight composer and clears
the dom selection; that path does not pre-arm nexus from the composer.

typed find has at most eight principal rows, followed by `search all results`
and `use this text…`. with no principals, search-all is armed with the detail
`nothing matched here`; no separate empty notice is inserted. the two
continuations are a fixed footer outside the desktop result scrollport; the
typed desktop card holds 70dvh so arrivals do not move them. both query inputs,
including mobile go, fire the armed row under the same
[arming contract](search.md#launcher). shift-enter requests a fresh pane.
repeat and composition never activate. retired selection consumes enter and
announces `selection no longer available` until a new query; unavailable
targets explain refusal without falling through.

the command registry owns exact case-insensitive slash tokens followed by end of
input or whitespace. `/n`, `/p`, `/c` or `/a`, `/l`, `/i` and `/b`
select note, page, chat, library, import and browse. recognized commands show their
prepared action without generic continuations. `/` and unknown heads show all
six commands in registry order with their first alias as a trailing kbd, no
default, literal search and lookup guidance. enter without a choice announces
that guidance. choosing a command starts it empty; unknown text never becomes
a guessed command or an implicit corpus request.

nonempty quick note says `save note to today` and commits locally; empty quick
note opens insertion. page/chat/library/import/browse open their existing draft
or chooser without submitting. `import policy` searches; `/i policy` opens an
import draft. literal search retains outer-trimmed text without filter parsing.
commands participate in latching. use-text's ask/browse/create choices do not.
the today place does not learn: its date-free identity would collide with quick
note; name matching still reaches it.

use-text snapshots text and opening disposition, focuses a heading, and offers
ask nexus, add to today, browse and create. entering it writes nothing and calls
no provider. browse/create return there; library returns through create; root
return restores query, selection and scroll. shifted confirmation upgrades the
opening disposition; ordinary confirmation cannot downgrade it. delayed work
retains its existing attention and workspace placement owners.

rows have a canonical title and at most one supplement: literal match evidence
outside the title, otherwise already-projected distinguishing facts. facts carry
contributors, source, location, related-match state or refusal reason; no kind
words or `current`. the current resource carries `here`; minimized is a
distinct state. no metadata is fetched to decorate a row. note titles are their
first line, with a separate matched window. passage titles are the work, with
the matched window below. highlights retain the quoted selected literal.
identical title evidence underlines in the title; matches never change weight.
the palette renderer clips long evidence to its first native match, rebases the
codepoint ranges and marks omitted context honestly. the full source excerpt,
its frozen identity and its activation remain unchanged.

right at the query's end with no selection, or tab, opens the armed row's verb
rail. the row's `…` opens the same disclosure. the rail projects existing action
descriptors, not another registry or executor. it presents `open ↵` and
`new pane ⇧↵` (`run ↵` for commands; no new-pane chip where disposition is
ignored), then preferred descriptors from `RAIL_VERBS` up to four chips, then
`more` when a contextual menu exists. danger-tone actions remain in that menu.
`show excerpt` is a rail verb opening the existing full-excerpt dialog.

initial rail focus is the first chip after the fixed pair. descriptor arrivals
retain focus by id. typing filters read verbs without running them; the pair
and more remain. letter hints appear only when that letter singles out a verb.
enter runs the focused verb once through the existing descriptor activation
owner. unavailable verbs retain their slots and reasons. left/escape closes the
rail and restores query text, caret and selection. more opens the existing
contextual menu, which prepares its own read: a server-backed rail followed by
more intentionally makes two action GETs. only the row's primary operation
learns; contextual descriptor actions do not.

desktop uses a combobox with a one-column grid; `aria-activedescendant` names
the mounted armed candidate while the query has focus. plain up/down browses
clamped result order and reveals only its scrollport. space edits the query;
home/end and modified editing retain native meaning. menus retain query and
selection. accepted close repairs only lost focus, yields to surviving controls
and overlays, and uses the committed displayed successor. renderers forward
gestures; the controller owns arming, dispatch, guards and announcements.

desktop root escape closes with or without text. mobile root back/escape clears
text, then closes; an open rail, nested overlay, child page or pane move wins
first. enabled secondary actions remain usable when the primary is unavailable.

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

the note editor's link command is `Mod-Shift-k`; nexus owns `Mod-k` even
with the caret in a note. firefox on linux/windows can reserve control+shift+k
for its web console, so that link chord is not guaranteed there; the formatting
menu remains the keyboard route to the command.

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
| nexus candidates, duplicate ownership, groups, places and caps | `apps/web/src/lib/nexus/rows.ts`                                                                                   |
| nexus retrieval, per-open usage map and selection records | `apps/web/src/lib/nexus/useNexusFind.ts`                                                                           |
| nexus name tiers, canonical href, latch and comparator | `apps/web/src/lib/nexus/rank.ts` |
| nexus held/arriving bands, arming and fire target | `apps/web/src/lib/nexus/list.ts` |
| nexus timing and rail preference constants | `apps/web/src/lib/nexus/policy.ts` |
| nexus verb presentation | `apps/web/src/components/nexus/NexusVerbRail.tsx` |
| contextual action source and shared descriptor activation | `apps/web/src/lib/actions/useContextualActions.ts` and `apps/web/src/lib/ui/actionDescriptor.ts` |
| device-local recent resource history                              | `apps/web/src/lib/recent/store.tsx`                                                                                |
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
| Nexus selection-ranking href canonicalization                              | `python/nexus/services/nexus_ranking.py`                                                                          |

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
own close/reorder commands stay in place, including final close;
primary open and recently closed restore dismiss it and
focus the destination. external navigation still dismisses the task. the desktop Account
menu retains its existing focus contract.

pane rows share the workspace command owners with the desktop strip. mobile
omits layout/minimize controls; its minimized title restores through ordinary
activation. both nexus presenters support full-order rearrangement. see
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
4. add a destination to mobile places only through the closed projection in
   `lib/nexus/rows.ts`; do not duplicate its identity outside the registry.
   resource recall requires an explicit route projection in
   `lib/panes/paneRouteModel.ts`; utility destinations do not enter recent.
5. Verify desktop and mobile projection membership separately, semantic
   detail-route activity, native modified clicks,
   exact-pane reuse, minimized-pane restoration, and focus handoff.

This is the production-shaped 80/20 solution: a typed identity registry, one
small curated projection, semantic route metadata, and the existing pane store.
It avoids both duplicated conditionals and a premature configurable-navigation
system.
