# App navigation

App navigation has two projections with distinct jobs:

- the desktop rail is a small, fixed projection of Nexus's highest-frequency
  destinations;
- mobile has one Nexus Switchboard entrance whose Places projection exposes the
  bounded destination subset defined below.

Neither is a directory of every feature.

## Product contract

- **Lectern is home.** `/lectern` is the canonical authenticated home, the brand
  destination, and the first visible navigation item.
- **Podcasts and Chats remain primary.** Atlas and Oracle are present but do not
  displace the frequent listening and conversation tasks.
- **Desktop rail order is exact and flat:** Lectern, Libraries, Podcasts, Chats,
  Notes, Stats, Atlas, Oracle.
- **Mobile Places order is exact and flat:** Lectern, Libraries, Podcasts,
  Chats, Notes. Stats, Atlas, and Oracle remain retrievable through Find.
- **Fixed navigation is not customizable.** Pinning is not part of this
  contract. Personalized retrieval belongs in the Lectern Reading Slate and the
  Launcher, where it can scale without destabilizing spatial memory.

On desktop, Account, Add, and Launcher controls are rail actions outside the
ordered destination list. On mobile, Account, Find, Add/Create, open panes, and
recently closed panes live inside Switchboard. Search, Authors, settings
subpages, and other valid destinations remain retrievable without becoming
permanent navigation items.

Desktop Add is a direct Launcher detail, not a Launcher lane or mode chooser.
Mobile Import opens the same source-first Add workbench from Switchboard Quick;
an editable non-default Library may still seed its full destination object.

## Ownership

| Concern                                                           | Owner                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Authenticated home href                                           | `apps/web/src/lib/routes/defaults.ts`                                                                             |
| Destination identity (`id`, label, href, keywords, optional icon) | `apps/web/src/lib/navigation/destinations.ts`                                                                     |
| Fixed-nav membership, order, and decoration                       | `apps/web/src/components/appnav/navModel.ts`                                                                      |
| Mobile Places membership and order                               | `SWITCHBOARD_PLACE_IDS` in `apps/web/src/lib/switchboard/places.ts`                                                |
| Route-to-semantic-section ownership                               | section `header.destinationId`, or resource `sectionDestinationId`, in `apps/web/src/lib/panes/paneRouteModel.ts` |
| Desktop rail projection and pane dispatch                         | `apps/web/src/components/appnav/AppNav.tsx`                                                                       |
| Mobile global-access projection                                  | `apps/web/src/components/switchboard/*`                                                                           |
| Internal-link gesture policy                                      | `apps/web/src/lib/panes/targetLinkActivation.ts`                                                                  |
| Target selection, restoration, creation, and activation           | `activateWorkspaceTarget` in `apps/web/src/lib/workspace/store.tsx`                                               |
| Server-restored deep-link merge                                   | `apps/web/src/lib/workspace/workspaceRestore.ts`                                                                  |
| Desktop Launcher projection                                      | `apps/web/src/lib/launcher/providers.ts`                                                                          |
| Mobile quick-action projection                                   | `apps/web/src/lib/launcher/quickActions.ts`                                                                        |
| Direct Add intent/session                                         | `apps/web/src/lib/launcher/launcherEvents.ts` and `apps/web/src/components/launcher/useAddContentSession.ts`      |
| Keybinding projection                                             | `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx`                                   |
| Palette-history href allowlist                                    | `python/nexus/services/command_palette.py`                                                                        |

The separations are deliberate. A destination can exist without occupying
fixed navigation; a pane route can identify its owning section without
reimplementing path-prefix matching; and Launcher ranking can change without
reordering the rail.

## Active-state semantics

Active state follows the active pane's semantic section, not URL-prefix guesses.
Section routes derive it from their one `header.destinationId`; resource routes
declare `sectionDestinationId` because their header has no section identity:

- `/media/{id}` and `/libraries/{id}` keep **Libraries** active;
- `/podcasts/{id}` keeps **Podcasts** active;
- chat detail and new-chat panes keep **Chats** active;
- pages and note blocks keep **Notes** active;
- Atlas, Oracle, Lectern, and settings map to their own destinations.

Routes that are intentionally absent from fixed navigation, such as Search and
Authors, do not fabricate a selected rail item. Section headers resolve the
route's typed `header.destinationId` through the same destination registry, so
running heads and navigation cannot drift through parallel maps.

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

The click policy leaves already-prevented events, non-primary buttons, and
Meta/Ctrl/Alt activations untouched so browser-native open-in-new-tab and
related link gestures still work. The rendered anchor always retains a real
`href` for semantics, copy-link behavior, and no-JavaScript fallback. Touch and
`Enter` use `Follow`.

Switchboard closes only after the workspace accepts navigation. A real
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
exists it creates the one-pane Lectern empty state. Root Launcher query intents
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
4. If the backend records Launcher history for the href, update its canonical
   allowlist and integration coverage.
5. Add a destination to mobile Places only by changing
   `SWITCHBOARD_PLACE_IDS`; do not duplicate its identity.
6. Verify desktop and mobile projection membership separately, semantic
   detail-route activity, native modified clicks,
   exact-pane reuse, minimized-pane restoration, and focus handoff.

This is the production-shaped 80/20 solution: a typed identity registry, one
small curated projection, semantic route metadata, and the existing pane store.
It avoids both duplicated conditionals and a premature configurable-navigation
system.
