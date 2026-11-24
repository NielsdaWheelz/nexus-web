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
- **browse, podcasts, and librarian remain primary.** Atlas and Oracle are present
  but do not displace discovery, listening, and conversation tasks.
- **desktop rail order is exact and flat:** lectern, libraries, browse,
  podcasts, librarian, notes, atlas, oracle.
- **mobile places order is exact:** today, librarian, lectern, libraries,
  podcasts, notes, browse, feeds, atlas, oracle, then import. the thumb index
  presents signs on a horizontally scrolling rule.
- **Fixed navigation is not customizable.** Pinning is not part of this
  contract. personalized retrieval belongs in lectern suggestions and
  Nexus, where it can scale without destabilizing spatial memory.

the shared account menu lists reading record, imports, downloads when available,
settings, a separator and danger-last sign out after any status, remedy and
preparation rows. reading record follows bare `/stats`. nexus accepts
`go to reading record` and `go to stats`. on phones, holding the typed destination
result opens beside. account uses conventional links.
the footer's `Import` action opens intake. its unsettled count (`Import · {n}`)
is distinct from the account's needs-attention count. imports retains its
canonical `/imports` link, query/deep links, inspector and contextual entrances.
the phone nexus account mark ends the legend while the field is empty and
renders the shared menu. mobile attention is visible only while nexus is open.

the settings section row lists account, librarian, appearance, reader and
keyboard in that order. the registry owns destination names for pane titles,
the reader menu and nexus. account keywords include
google and time zone; librarian settings includes brief and undo. linked
identities lives in account; `/settings/identities` is unsupported, with no
redirect. account's session row is the second home of the shared guarded
sign-out command.

`AccountMenu` owns its decorative person-in-circle mark and passive attention
dot. the desktop rail retains its expanded label. the mobile sheet places the
same account menu behind an icon-only trigger at the legend's inline end while
the field is empty; the root has no header.
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
targets, workflows, history, and dispatch; the controller owns surface-specific
membership and the engine owns typed order and caps. renderers own geometry.
Search, Authors, settings subpages, and other valid destinations remain
retrievable without becoming permanent navigation items.

mobile nexus opens keyboard-down in a bottom sheet, with nothing armed and the
screen-reader heading focused. tapping the field raises the keyboard without
changing the blank page. the thumb index reads down: surviving selection,
every open pane in strip order, then the always-present folded `earlier` line.
the page alone scrolls; the legend and field form its fixed foot. blank height
follows content; typed height fills the available viewport. the sheet has a
44px handle strip, scrim dismissal and a guarded
96px downward drag. back clears root text before closing. nested overlays,
child pages and active pane moves retain their own dismissal precedence; see
[overlays](overlays.md#surfaces).

the legend end stays pinned while its actual width contributes to the strip's
scroll extent. every place and import can scroll clear of account or the typed
keys. opening resets the strip to its start.

import, create library, use text, choices and capture today stay in the same sheet
with their own back/title headers and initial focus, without the foot. `earlier`
unfolds recent picks and session-closed panes, excluding recents held by any
open pane. a tap follows; a stationary 500ms touch hold opens beside with
`Fork`, consuming its release click. open pane lines reserve hold for the
250ms drag; typed resource rows can fork. × marks a non-current pane for close
on sheet dismissal; tapping its line keeps it open. current × closes at once.

primary button-0 presses are captured. a stationary touch opens nexus at
captured release, even if the outline row withdraws and moves the button during
the press. touch suppresses compatibility mouse focus and consumes the same
contact's follow-up click even if it retargets. mouse, pen, keyboard and
assistive technology open through native button click. mouse, pen and touch
share an 8 css px movement threshold.
reaching it cancels tap activation even if the pointer returns inside.
only a primary-touch horizontal swipe invokes the adjacent-pane workspace
command. it shows the destination title for 600ms, or `first pane` / `last pane`
at the clamp. a cancelled touch preserves the existing input focus. an accepted
activation transfers focus into nexus, and a committed swipe uses normal
destination focus.
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
the desktop headword is a fixed page: query, seven-word command legend, eight-line
name block, three-line apparatus and foot. blank lists up to eight recent picks,
excluding the current resource, with no default arm. a surviving selection
leads the block unarmed. down arms the first line; up enters commands; enter
with nothing armed does nothing. late recent snapshots never arm a row.
recent history is device-local; loading, failure with retry and empty are distinct.
a recent held only by a session-closed pane reads `closed` and restores its
newest matching pane with its position and history. up to three closed panes
not represented by listed recents occupy the apparatus. closed lines have no
menu and ignore the fork disposition.

mobile lists every pane under `open · {n}` in strip order, with `here` in the
current line's trailing column. `earlier` follows even with one pane and no
recents. nothing is armed at open. reorder is drag-only, including the current
pane; no row menu or verb rail is mounted. the desktop owns no pane-closing or
reordering controls.

typed order is the best named row known at the keystroke, then `do` (two),
`places` (three), and `resources`, to eight names in all. the first line does
not consume its band's cap; a latch there reads `usual`. three passages sit
below, independently capped. arrivals preserve shown positions; only a named
arrival within the arming window can take enter. the catchword is the last
arrow stop and is armed when no named row is armed. desktop paints
`all results for “{text}”`; the phone paints its search sign at the legend's
end, followed by `ask` and `note` for a plain search. its field echoes
`go · {armed name}`, or `go · all results`; unarmed lookup and an absent arm have no
echo. typed use-text is absent. both empty name blocks read
`nothing by that name.` after device and names settle. both surfaces use the
[arming contract](search.md#launcher).
repeat and composition never activate. retirement announces
`selection no longer available`; unavailable targets explain refusal.

the registry owns exact case-insensitive slash heads: `/n`, `/p`, `/c` or `/a`,
`/l`, `/i`, `/b`. `/t` alone is the today place; `/t` with an argument is unknown.
recognized commands show one armed row. desktop `/` or unknown heads show only
lookup guidance and literal search, with nothing armed. mobile retains the six
registry-ordered choices. enter without a choice announces the guidance.

beneath the desktop query, the legend is `note`, `ask`, `import`, `today`,
`page`, `library`, `browse`. up from the first stop reaches note; left/right
clamp, home/end reach the ends, enter runs, shift-enter forks, down/escape
returns to the field. printable keys append once; backspace removes one
character. tab in either legend or field is consumed. unknown slash heads
light every word with its alias; recognized heads light their word, links light
import, and the held platform modifier lights ask. the legend is a toolbar
with no tab stops. import carries its unsettled count.

legend commands and the note/ask chords take a recognized command's argument,
otherwise plain text; unknown slash text supplies no argument. today takes none.
nonempty quick note commits locally under one retained note id: ordinary
activation closes nexus without moving a pane and announces `added to today`
with an `open` action; fork opens the day at the note in a new pane. empty note
opens today at a new line. this holds for slash, legend, chord and use-text or
create choices on both surfaces. quick note never learns; today learns under
`/daily`. other eligible row picks retain learning; legend runs and chords do
not. empty ask opens the librarian; nonempty ask uses its retained composer.
the phone's `ask` key follows an existing librarian pane or forks one when none
is open; both keys take the field's text as typed, including filters.
page/library/import/browse open existing drafts or choosers without submitting.
`import policy` searches; `/i policy` opens an import draft. literal search
preserves outer-trimmed text without filter parsing.

a whole query of links has one explicit `import {pointer}` or `import {n} links`
row. activating it sends the links and shows their lines. more than 100 is a
refusal with no send. the slash-command import row only opens the field, even
when its argument is links. a multi-line paste flattens breaks to spaces in both
root and the import field, preserving link boundaries.

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
first line, with a separate matched window. phone passages show the matched
window then the italic work, without a glyph; desktop
passages use a concordance with the work at the line end. highlights retain the quoted selected literal.
identical title evidence underlines in the title; matches never change weight.
the palette renderer clips long evidence to its first native match, rebases the
codepoint ranges and marks omitted context honestly. the full source excerpt,
its frozen identity and its activation remain unchanged.
phone passages wait until device, names and texts have all settled or the
eight-name block is full. once drawn for a query they remain through rereads;
the polite status counts only drawn rows.

on desktop, tab or right at the query's end opens the armed row's contextual
menu. its occurrence section starts with open and new pane (only new pane for
the current row). the menu exists only for a resource or occurrence verbs;
commands, places and closed lines have none. only the armed row mounts `…`.
closing restores the field's caret and selection. desktop menus omit pane close.
mobile holds activate `Fork` directly; its palette has no contextual menu or
full-excerpt dialog. resource-specific verbs remain in their own panes.
only primary row activation learns.

desktop uses a combobox with a one-column grid; `aria-activedescendant` names
the mounted armed candidate while the query has focus. plain up/down browses
clamped block, apparatus and catchword order; up from the first reaches the
legend. only the block scrolls. the grid owns apparatus and catchword rowgroups
outside that scrollport. the foot states the armed action, fork and menu hints;
held shift restates the fork and held mod restates ask, clearing on focus loss.
space edits the query;
home/end and modified editing retain native meaning. menus retain query and
selection. accepted close repairs only lost focus, yields to surviving controls
and overlays, and uses the committed displayed successor. renderers forward
gestures; the controller owns arming, dispatch, guards and announcements.

desktop root escape closes with or without text. mobile root back/escape clears
text, then closes; a nested overlay, child page or running drag wins
first. enabled secondary actions remain usable when the primary is unavailable.

## the import page

email discovery belongs here, outside account settings. a mount-scoped `/me` read uses `usePaneFreeServerValue`: pending shows a local ruling, null omits the row, initial failure owns retry, and retained data remains usable on refresh failure. the owner’s address adds an `email import` button after file choice. its inline `PickerSurface` is a separate nonselectable grid row with a scrolling body, selectable wrapping address, ordinary copy feedback and manual recovery. opening focuses the named region; closing returns to the desktop combobox or phone trigger. the address/account scopes the disclosure, while draft, destination and intake keep their existing owner. email always files into all, independently of the link/file destination.

the import page is one nexus page through `NexusPages`, inside the shared desktop
frame or phone sheet. child pages retain their own 40px gutter inside the
fixed desktop frame; their back arrow has its own edge. on a phone
the child header holds the arrow and `import`, with `into` below the field.
the combobox (`links to import`) owns focus and names the selected cell in the
`import options` grid. its field and destinations belong to the intake visit:
palette open to close, including navigation closes. arrow back keeps the visit.

rows, in order: the field's send row while it holds links; lines, newest batch
first and each batch in paste order; each settled batch of two or more closed
by its colophon; `choose a file…`; with no lines, the viewer's five newest own
imports (`view=Recent`), retained and reread on imports observations while shown;
then `all imports` with its attention count. with no lines and an empty field,
`choose a file…` is selected. `ImportLine` paints `lineView`; a settled line's
menu is its media's existing resource menu.

| action | effect |
| --- | --- |
| root enter on a whole query of links | sends, opens the page, selects the first line; another enter opens it, armed until accepted |
| root shift-enter | sends and arms the first new line to open in a fresh pane |
| page enter | submits field text until an arrow is pressed after the last edit; thereafter invokes the selected row, even after a clamped arrow |
| field send | takes links, leaves other text with `not a link`; over 100 says `100 at a time. this has {n}.` and sends nothing |
| a link already listed | adds no line; selects its existing line |
| enter on an unaccepted line | arms its open; failure, selection movement, input and leaving the page disarm |
| enter on `choose a file…` | opens the native picker inside that gesture |
| arrows, tab | arrows select; tab reaches `into`, then the selected row's controls |

the arrow and dismissals use one table. sent work stays in the intake, so these
transitions do not prompt. a covering picker takes escape first, then field
feedback regardless of the focused descendant, then the page transition.

| origin and visit | arrow | escape, scrim, android back |
| --- | --- | --- |
| palette, nothing admitted | restore origin | restore origin |
| palette, an admission | clear root query | close |
| outside, such as rail or library | blank root | close to opener |

the origin retains query, root mode and invoking control. desktop returns to the
combobox; a blank return arms nothing. phone returns to the typed query or
blank root's invoking control. after admission the query is cleared; only the
phone retains import as its return control. explicit field replacement clears
feedback;
arrow back preserves it. closing retires the visit. deferred admissions retain
filing work but cannot revive an open intent after input, selection or exit.
the desktop legend reads `import · {n}` while the intake has unsettled lines.
the phone's final place sign paints digits and is named `import, {n} importing`;
it remains the return control from the import page.

document ingress yields to existing editable, attachment and overlay owners.
an unclaimed file drop opens the page and admits up to 100 files; the same cap
refuses the whole oversized batch. unclaimed all-link paste opens a filled root
without sending. the drop veil names the same bounded destinations as `into`.
the doors stay mounted across both shells and hydration; they own no acquisition
lifecycle. library creation uses the shared creation hold and refusal owner.

the controller publishes import start and settlement speech through one polite
region. pending sentences retain occurrence order and repetitions until their
committed publication. intake settlement order, rather than React observation
order, determines which batch speaks first. unseen outcomes keep the shared
feedback owner; reopening does not replay old settled history.

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
- command/control+enter asks with the root argument, or opens the librarian
  when empty. alt+enter saves the argument to today in place; shift+alt+enter
  opens the saved note in a new pane. with no argument both open a new line.
- command/control+f belongs to the active pane. it yields to overlays and only
  prevents browser find when the pane accepts search.
- command/control+shift+left/right moves between visible panes without wrapping.
  it yields while typing or while an overlay owns interaction. the pane strip's
  plain arrow keys only move focus; modified keys reach the shortcut owner.
- the desktop strip has its own fixed keys: left/right/home/end browse titles
  and controls, enter/space activates, delete/backspace closes
  once per press; shift-m maximizes/restores and shift-h minimizes the focused
  chip's pane. middle-press closes without activation. tab leaves
  its single roving stop. these keys never become global letter bindings.

the note editor's link command is `Mod-Shift-k`; nexus owns `Mod-k` even
with the caret in a note. firefox on linux/windows can reserve control+shift+k
for its web console, so that link chord is not guaranteed there; the formatting
menu remains the keyboard route to the command.

the same table supplies the read-only `/settings/keybindings` reference, reached
through the settings section links and searchable in nexus. settings opens
`/settings/account`; `/settings` has no index route. there is no shortcut preference,
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
| import page, lines and visit presentation | `apps/web/src/components/nexus/ImportPage.tsx`, `ImportLine.tsx` and `lib/imports/intake.tsx` |
| unclaimed document file and link ingress | `apps/web/src/components/imports/ImportDoors.tsx` |
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
- the librarian and message anchors keep **librarian** active;
- pages and note blocks keep **Notes** active;
- atlas, oracle and lectern map to their own destinations;
- reading record (all `/stats` views), imports (including query variants) and
  settings mark account current and leave the rail with no selected destination.
  `activeId` marks the corresponding shared account row current.

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
the Nexus trigger. workspace creation has no pane-count refusal. the thumb
index's non-current × marks a pane without moving its line. dismissal commits
marks in order, skipping the active pane; unsaved writing asks once per pane
and refusal does not stop the other closes. current × commits marks first,
then closes the current pane and sheet, focuses the successor and offers
`closed {title}` with `reopen`. refusal keeps the sheet open with marks already
committed. primary open and closed-pane restore dismiss it and
focus the destination. external navigation still dismisses the task. the desktop Account
menu retains its existing focus contract.

pane rows share the workspace command owners with the desktop strip. mobile
omits layout/minimize controls; its minimized title restores through ordinary
activation. only the phone's complete blank pane list offers drag reorder. see
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

## collation

`Pane.Search`, bare `/` outside editable targets and the desktop magnifier open
and select the active pane query. slash is consumed only when opening succeeds
and no interaction owner stands. phone more supplies the command; its header
statement unfolds views and words. disclosures belong to the source visit.
invalid libraries/library/lectern urls offer reset view; ordinary collation
reset preserves the view.
