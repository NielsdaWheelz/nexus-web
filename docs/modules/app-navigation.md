# App navigation

[recent resources](recent-history.md) owns device-local recall, accepted-use capture
and history feedback.

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

`AccountMenu` owns one decorative person-in-circle mark and its passive attention
dot, shared by the rail and mobile root header. mobile shows quiet icon-only
`account` and `close nexus` controls, in that order, with 20px glyphs and 48px
minimum targets. the root heading may wrap with enlarged text; controls never
shrink. close invokes the existing guarded full dismissal; search back/escape
returns to overview. account retains its trigger state, status description and
focus/navigation owners. the expanded desktop rail retains its visible label.

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
opens the keyboard-down overview with heading focus; explicitly entering search
focuses its query. choose create, choose browse and add replace root inside one
opaque viewport-fixed dialog. pane expansion and
recently-closed recovery are inline disclosures, not pages.
mobile's `new pane…` beside the open-pane heading enters `NewPane` in the same
root, retaining and selecting the query. its heading and dialog name are
`open in new pane`; `cancel` replaces account/close. entry and cancellation
allocate nothing. cancellation retains the query and returns focus to its
entrance, or the ordinary combobox after desktop handoff. the content-creation
entrance is `create…`. desktop adds no entrance or ordinary fork menu action,
but completes an already-active picker after resize.

the picker projects eligible destinations before composition caps, with unchanged
retrieval budgets. blank order is recent, places, then create and open: quick
note, page, chat, library. pane candidates become exact current-href destinations;
management, acquisition and playback commands are excluded. explicit excluded
input reports `this action isn’t available in this picker` and retains the query.
row and submission admission share one target contract. accepted picker actions
request `Fork`; choice/library/capture pages retain that opening intent and their
root origin. query edits, refresh, shortcut focus and responsive handoff preserve
purpose. accepted landing/dismissal or fresh programmatic opening retires it.

ordinary mobile destination rows have sibling `more actions for {label}` controls
with `open in new pane`; primary activation retains `Follow`. only pane-instance
rows have direct close controls. matching-place close actions belong inside the
destination menu. picker options contain only factual alternate destinations,
such as the exact matching passage, which also fork. guarded menu links retain
the menu on refused navigation. the workspace remains the sole placement,
writing-loss admission and focus owner.
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

nexus is one typed intent router with platform-native renderers. its input is
labelled and placeholdered **find anything…**. blank desktop shows `tabs · {total}`,
up to eight resource rows under `recent picks`, then `actions`: quick note, new chat, import, and
resume only for paused playback. recent retains deliberately accepted resource
use on this device, including open panes. unknown history is not empty; failure
exposes retry while usable rows remain visible.

the tabs heading discloses the complete ordered pane list. complete lists allow
drag or one-shot numbered placement, with only close as a row accessory.
recently closed uses native buttons outside query candidates. see
[panes](panes.md#mobile-contract) for disclosure and interaction lifetimes.

ordinary search shows at most eight principal results in one list. two rows sit
outside that cap: `search all results` and `use this text…`. the latter snapshots
its text and opening disposition, focuses a heading, and offers ask nexus, add
to today, browse and create. entering it performs no write or provider call.
browse/create return to that page; library returns through create; root return
restores query, selection and scroll. both platforms use this choice owner.

the command registry owns exact case-insensitive slash tokens followed by end of
input or whitespace. `/n`, `/p`, `/c` or `/a`, `/l`, `/i` and `/b` select note,
page, chat, library, import and browse. recognized commands show their prepared action without generic continuations.
`/` and unknown heads retain a literal-search escape and show all six commands,
without a default; selecting one starts it empty. unknown text is never attached
to a guessed command or automatically sent to corpus search. unavailable preparation retains
the input and reason. import draft validation and capacity belong to add.

nonempty quick-note activation says `save note to today` and commits locally;
empty quick note opens insertion. page/chat/library/import/browse open their
existing draft or chooser and never submit it implicitly. natural-language
recognition is unchanged: `import policy` searches; `/i policy` opens an import
draft. literal search uses outer-trimmed input without interpreting filters.

navigation action labels describe their outcome: `open libraries`, `search
people`. the latter opens the existing empty people search and describes its
scope as `authors and contributors`; it remains distinct from any resource named
authors. match visible action labels and canonical names/keywords. resource
labels and exact activations remain authoritative. generic place/command badges
are omitted; meaningful hints and argument previews remain on both surfaces.

a result has one dominant canonical title or prose body. include only already
projected distinguishing facts: source, author, location, current/minimized state
or literal evidence. suppress generic pane/place/command/recent badges and ordinary open state; never
fetch metadata to decorate a row. preserve source paragraph boundaries, omission
marks and literal match ranges. essential identity and refusal reasons may wrap;
secondary evidence stays bounded, without selection-driven expansion.

captured highlights and passages use the admitted frozen excerpt and reading.
their primary is the selected literal; identical match evidence highlights there,
while distinct context uses the evidence line. `show excerpt` opens the existing
full-excerpt dialog explicitly. it is a separate native control after options,
outside the primary action's disabled state, with the row identity in its name.
opening it does not navigate or enrich the held row.

desktop is at most 640px wide with a 48px query and 36px ordinary rows; coarse
pointer targets remain 44px and mobile targets 48px. one scrollport owns results
and following notices. a reserved query slot shows delayed busy or explicit notice
access. no visible tutorial or empty status band. one polite owner announces
operational feedback; notices never automatically steal focus or scroll.
external retrieval uses existing typed browse/preview owners without implicit ingest.

desktop uses a combobox with a one-column grid popup. each candidate cell
contains its primary region and a native options or close control. the controller
owns initial selection: an available explicit intent first, otherwise the first available
principal result, then visible search-all when none exists. command lookup has no
default. deliberate interaction holds the whole displayed list and exact target.
raw query/scope/account changes invalidate preceding actions immediately.

both query inputs invoke the controller's submit capability. desktop accepts its
admitted selected row. a retired
same-context selection consumes enter and announces `selection no longer available`
until navigation or query change. disabled targets explain their refusal without
fallthrough. mobile input submits parsed intent/full search regardless of prior
row selection; native row buttons activate their exact row. lookup without a
selection only gives guidance. shift preserves the operation and requests its
existing fresh-pane disposition. repeat and composition never activate.

plain up/down browses the clamped result order and reveals only its scrollport.
space always edits the input; home/end and modified editing retain native meaning.
there is no editing/browsing mode or space-release command. only the selected
secondary is a result tab stop; tab followed by native enter/space operates it.
secondary focus selects its row. hover selects only while the query owns focus.
direct close retains its native initiator until the controller selects the
committed displayed successor; query is the missing-target fallback. live removal
repairs only lost focus and yields to surviving controls/overlays. menus retain query and selection.
`aria-activedescendant` names the mounted candidate whenever the query has focus.

lookup guidance follows the grid/list inside its scrollport and uses the same
polite status owner. lookup retains its literal-search recovery row. mobile keeps
sibling action buttons and 48px targets. desktop root escape closes empty,
whitespace and typed queries; child workflows and active pane moves retain their
guarded back/cancel precedence. enabled secondary menus never inherit primary
unavailability from an aria-disabled ancestor.
renderers project prepared content and forward gestures; they do not interpret
commands, choose defaults or repair navigation.

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
| Nexus retrieval, latency gate, and selection ranking                | `apps/web/src/lib/nexus/useNexusFind.ts`                                                                           |
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
4. Add a destination to mobile Places only through the closed projection in
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
