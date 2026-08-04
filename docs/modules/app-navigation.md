# App navigation

App navigation has two projections with distinct jobs:

- the desktop rail is a small, fixed projection of Nexus's highest-frequency
  destinations;
- mobile has one Nexus entrance. Its opaque full-screen `SwitchboardTask`
  renders the mobile projection of the shared Nexus intent router.

Neither is a directory of every feature.

## Product contract

- **Lectern is home.** `/lectern` is the canonical authenticated home, the brand
  destination, and the first visible navigation item.
- **Browse, Podcasts, and Chats remain primary.** Atlas and Oracle are present
  but do not displace discovery, listening, and conversation tasks.
- **Desktop rail order is exact and flat:** Lectern, Libraries, Browse, Podcasts,
  Chats, Notes, Stats, Atlas, Oracle.
- **Mobile Places order is exact:** Lectern, Libraries, Browse, Podcasts,
  Chats, Notes. Stats, Atlas, and Oracle remain retrievable through Nexus.
- **Fixed navigation is not customizable.** Pinning is not part of this
  contract. Personalized retrieval belongs in the Lectern Reading Slate and
  Nexus, where it can scale without destabilizing spatial memory.

On desktop, Account and Nexus remain rail actions. Quick Note and Today exist
only in Nexus. Both Nexus projections expose the same commands, results,
targets, workflows, history, and dispatch; the shared composer owns section
membership, order, caps, and the declared desktop/mobile layout policy.
Search, Authors, settings subpages, and other valid destinations remain
retrievable without becoming permanent navigation items.

Mobile Nexus is a temporary sustained task, not a drawer or bottom sheet. Root
owns the autofocused query; Choose Create, Choose Browse, Manage Tabs, Add, and
recovery pages replace one another inside one opaque viewport-fixed dialog.
There is no separate Find page, scope state, outside-click, or drag dismissal.

Compact presentation covers widths through 768 px and coarse-pointer landscape
phones through 900 px. Fine-pointer short desktop windows remain desktop.

## Nexus content grammar

Nexus is one typed intent router with platform-native renderers. Its input is
always labelled and placeholdered **Find anything…**. Blank desktop order is
Open, optional Continue, Recent, Quick Actions. Blank mobile order is Open,
Quick Actions, optional Continue, Recent, Places; mobile groups use compact
rails. Independent caps prevent one group from erasing another. Quick Actions
are Quick Note, Today, New Chat, New Page, New Library, and Import.

Typing removes blank groups. The shared composer admits at most eight owned
results, then exposes Ask Nexus, Add to Today, Browse, Create, and See All as
one fixed Query Actions group. Reserved verbs and slash aliases compile to
explicit typed intent; incomplete or unknown command text remains retrieval.
Selection is always required.

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

Desktop uses a combobox with a grid popup. DOM focus remains in the input;
Up/Down changes rows, Left/Right changes primary versus Actions cells, Enter
invokes the active cell, and Shift+Enter Forks a primary result. Each applicable
row has one pointer Actions button backed by the shared `ActionMenu`. Mobile
keeps a sibling action button and 48 px targets. Renderers never infer command,
ranking, target, or workflow meaning from copy or identifiers.

Desktop Nexus publishes named user-timing measures at input-ready, local rows
committed, accepted pane paint, and first usable provider rows. The benchmark
reports its sample size and p95 separately for warm and cold runs; it never
labels a warmed provider loop as cold. The p95 gates are respectively under
50 ms, 50 ms, 100 ms, and 250 ms.

## Ownership

| Concern                                                           | Owner                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Authenticated home href                                           | `apps/web/src/lib/routes/defaults.ts`                                                                             |
| Destination identity (`id`, label, href, keywords, optional icon) | `apps/web/src/lib/navigation/destinations.ts`                                                                     |
| Fixed-nav membership, order, and decoration                       | `apps/web/src/components/appnav/navModel.ts`                                                                      |
| Nexus commands and typed intent                                  | `apps/web/src/lib/nexus/commands.ts` and `apps/web/src/lib/nexus/intent.ts`                                        |
| Nexus sections, Places projection, ranking, caps, and stability  | `apps/web/src/lib/nexus/results.ts` and `apps/web/src/lib/nexus/ranking.ts`                                        |
| Route-to-semantic-section ownership                               | section `header.destinationId`, or resource `sectionDestinationId`, in `apps/web/src/lib/panes/paneRouteModel.ts` |
| Desktop rail projection and pane dispatch                         | `apps/web/src/components/appnav/AppNav.tsx`                                                                       |
| Internal-link gesture policy                                      | `apps/web/src/lib/panes/targetLinkActivation.ts`                                                                  |
| Target selection, restoration, creation, and activation           | `activateWorkspaceTarget` in `apps/web/src/lib/workspace/store.tsx`                                               |
| Server-restored deep-link merge                                   | `apps/web/src/lib/workspace/workspaceRestore.ts`                                                                  |
| Nexus semantic contract                                          | `apps/web/src/lib/nexus/model.ts`                                                                                  |
| Desktop Nexus renderer                                           | `apps/web/src/components/nexus/desktop/`                                                                           |
| Mobile Nexus renderer                                            | `apps/web/src/components/switchboard/SwitchboardTask.tsx` and sibling presentation components                    |
| Nexus ingress and direct action session                          | `apps/web/src/lib/nexus/events.ts` and `apps/web/src/components/nexus/useNexusController.ts`                      |
| Daily Page location and append entry                             | `apps/web/src/lib/notes/openDailyPage.ts` and workspace pane-entry delivery                                       |
| Keybinding projection                                             | `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx`                                   |
| Nexus history href allowlist                                     | `python/nexus/services/nexus_history.py`                                                                          |

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
- Atlas, Oracle, Lectern, and settings map to their own destinations.

Routes that are intentionally absent from fixed navigation, such as Search and
Authors, do not fabricate a selected rail item. Section pane titles resolve
their orientation context from the route's typed `header.destinationId` through
the same destination registry, so pane identity and navigation cannot drift
through parallel maps.

## Activation and pane reuse

A plain primary-button activation of a supported app link is `Follow`. It
restores and activates an exact matching pane, including a minimized pane; when
none exists, it navigates the active pane. `Shift`+click is `Fork`: it creates
and activates a fresh pane after the active pane even when an exact pane is
already open.

The activation boundary returns an explicit focus-owner result, never a boolean:

- `unhandled`: the browser owns the link gesture;
- `handled-source-focus`: the exact destination was already active, so a closing
  sheet/menu restores its trigger;
- `handled-destination-focus`: another pane was opened or reactivated, so the
  workspace destination owns focus.

AppNav derives the focus owner from the workspace activation result. Only an
unchanged or rejected activation retains source focus; navigation, restoration,
and creation hand focus ownership to the destination.

On mobile, destination focus lands on the active pane landmark, never the
AppBar or pane toolbar. The landmark is stable while reader chrome retreats, so
route activation cannot pin or strand transient controls. Desktop retains its
explicit pane-chrome focus target.

The click policy leaves already-prevented events, non-primary buttons, and
Meta/Ctrl/Alt activations untouched so browser-native open-in-new-tab and
related link gestures still work. The rendered anchor always retains a real
`href` for semantics, copy-link behavior, and no-JavaScript fallback. Touch and
`Enter` use `Follow`.

The mobile Nexus task closes only after the workspace accepts navigation. A real
destination handoff suppresses return focus; nonnavigating dismissal restores
the Nexus trigger. Pane-cap rejection keeps the target in the shell-owned
recovery state. The desktop Account menu retains its existing focus contract.

In the collapsed desktop rail, the brand and Expand control remain separate,
non-overlapping hit targets. The expand control must never be stretched over the
brand mark, because that makes an apparent Home activation trigger rail chrome.

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

1. Change identity once in `DESTINATION_REGISTRY`.
2. Change fixed membership/order/presentation only in `APP_NAVIGATION`.
3. Give a section route one `header.destinationId`; give a resource route one
   `sectionDestinationId`.
4. If the backend records Nexus history for the href, update its canonical
   allowlist and integration coverage.
5. Add a destination to mobile Places only through the closed projection in
   `lib/nexus/results.ts`; do not duplicate its identity outside
   `DESTINATION_REGISTRY`.
6. Verify desktop and mobile projection membership separately, semantic
   detail-route activity, native modified clicks,
   exact-pane reuse, minimized-pane restoration, and focus handoff.

This is the production-shaped 80/20 solution: a typed identity registry, one
small curated projection, semantic route metadata, and the existing pane store.
It avoids both duplicated conditionals and a premature configurable-navigation
system.
