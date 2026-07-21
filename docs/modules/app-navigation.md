# App navigation

The app navigation is a small, fixed projection of Nexus's highest-frequency
destinations. It is not a directory of every feature and it is not a second
Launcher. Its job is to keep the daily loop—resume, find, listen, and chat—one
gesture away on desktop and mobile.

## Product contract

- **Lectern is home.** `/lectern` is the canonical authenticated home, the brand
  destination, and the first visible navigation item.
- **The order is exact and flat:** Lectern, Libraries, Podcasts, Chats, Notes,
  Atlas, Oracle. There are no “Library” or “Tools” headings.
- **Podcasts and Chats remain primary.** Atlas and Oracle are present but do not
  displace the frequent listening and conversation tasks.
- **Desktop and mobile share one model.** The rail and sheet differ only where
  their containers require different interaction mechanics.
- **Fixed navigation is not customizable.** Pinning is not part of this
  contract. Personalized retrieval belongs in Lectern recents and the Launcher,
  where it can scale without destabilizing spatial memory.

Account, Add, and Launcher controls are shell actions outside the ordered
destination list. Search, Authors, settings subpages, and other valid
destinations remain available through the Launcher and keybindings without
becoming permanent rail items.

## Ownership

| Concern | Owner |
|---|---|
| Authenticated home href | `apps/web/src/lib/routes/defaults.ts` |
| Destination identity (`id`, label, href, keywords, optional icon) | `apps/web/src/lib/navigation/destinations.ts` |
| Fixed-nav membership, order, and decoration | `apps/web/src/components/appnav/navModel.ts` |
| Route-to-semantic-section ownership | `sectionDestinationId` in `apps/web/src/lib/panes/paneRouteModel.ts` |
| Rail/sheet projection and pane dispatch | `apps/web/src/components/appnav/AppNav.tsx` |
| Plain-click interception policy | `apps/web/src/components/appnav/navActivation.ts` |
| Pane reuse, restoration, and activation | `openPane` in `apps/web/src/lib/workspace/store.tsx` |
| Server-restored deep-link merge | `apps/web/src/lib/workspace/workspaceRestore.ts` |
| Launcher projection | `apps/web/src/lib/launcher/providers.ts` |
| Keybinding projection | `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx` |
| Palette-history href allowlist | `python/nexus/services/command_palette.py` |

The separations are deliberate. A destination can exist without occupying
fixed navigation; a pane route can identify its owning section without
reimplementing path-prefix matching; and Launcher ranking can change without
reordering the rail.

## Active-state semantics

Active state follows the active pane's semantic section, not URL-prefix guesses.
Every supported pane route declares a `sectionDestinationId`:

- `/media/{id}` and `/libraries/{id}` keep **Libraries** active;
- `/podcasts/{id}` keeps **Podcasts** active;
- chat detail and new-chat panes keep **Chats** active;
- pages and note blocks keep **Notes** active;
- Atlas, Oracle, Lectern, and settings map to their own destinations.

Routes that are intentionally absent from fixed navigation, such as Search and
Authors, do not fabricate a selected rail item. `standingHeadForRoute` consumes
the same semantic section owner, so running heads and navigation cannot drift
through parallel maps.

## Activation and pane reuse

A plain primary-button activation of a supported app link is claimed by the
workspace and dispatched through `openPane({ href })`. `openPane` restores and
activates an exact matching pane—including a minimized pane—or opens a new pane
when none exists. It does not replace the currently active pane.

The activation boundary returns an explicit focus-owner result, never a boolean:

- `unhandled`: the browser owns the link gesture;
- `handled-source-focus`: the exact destination was already active, so a closing
  sheet/menu restores its trigger;
- `handled-destination-focus`: another pane was opened or reactivated, so the
  workspace destination owns focus.

AppNav decides between the handled results with `hasSamePaneRoute`, the same
identity contract the workspace uses for exact pane reuse.

The click policy leaves already-prevented events, non-primary buttons, and
Meta/Ctrl/Alt/Shift activations untouched so browser-native open-in-new-tab and
related link gestures still work. The rendered anchor always retains a real
`href` for semantics, copy-link behavior, and no-JavaScript fallback.

The mobile sheet closes only after the workspace claims a navigation event. A
real destination handoff and Launcher/Add handoffs suppress return-focus; an
already-active destination restores the sheet opener. The desktop Account menu
uses the same result, restoring its trigger only for already-active Settings.
Escape, backdrop, history, and close-button dismissal also restore focus.

In the collapsed desktop rail, the brand and Expand control remain separate,
non-overlapping hit targets. The expand control must never be stretched over the
brand mark, because that makes an apparent Home activation trigger rail chrome.

## Home and workspace restore

`APP_AUTHENTICATED_HOME_HREF`, the auth default, root redirect, workspace
fallback, and brand href all derive from `/lectern`.

Lectern is an explicit route intent, not a neutral placeholder for “whatever
workspace was active.” On login or a bare authenticated landing, restore keeps
the saved panes and then either:

1. restores and activates an existing Lectern pane, or
2. appends and activates a Lectern pane.

A lone, history-free Lectern pane remains a trivial persisted session for
cross-device restore selection. That storage heuristic does not erase the
current request's Lectern intent.

## Change checklist

When adding or changing a destination:

1. Change identity once in `DESTINATION_REGISTRY`.
2. Change fixed membership/order/presentation only in `APP_NAVIGATION`.
3. Give every new pane route a semantic `sectionDestinationId`.
4. If the backend records Launcher history for the href, update its canonical
   allowlist and integration coverage.
5. Keep desktop and mobile projections sourced from the same `NAV_MODEL`.
6. Verify flat order, semantic detail-route activity, native modified clicks,
   exact-pane reuse, minimized-pane restoration, and focus handoff.

This is the production-shaped 80/20 solution: a typed identity registry, one
small curated projection, semantic route metadata, and the existing pane store.
It avoids both duplicated conditionals and a premature configurable-navigation
system.
