# Contextual Command Presentation Hard Cutover

**Status:** IMPLEMENTED — changed-code gate green; physical verification partial
**Date:** 2026-08-11
**Type:** hard cutover

Questions requiring a user answer: none. This spec fixes the requested
placement. Mobile Refresh is not a top-level button, but remains in **More** as
the required non-gesture alternative to pull-to-refresh.

## Decision

Keep command semantics in their current owners; compose their presentation.

> Separate command ownership. Unify command presentation.

The canonical resource plan remains unchanged. Pane, view, occurrence, and
resource owners contribute typed descriptors to one contextual `ActionMenu`.
No caller may add a non-resource command to the resource catalog or rebuild the
resource plan.

## Goals

- One overflow trigger per primary pane header and collection row.
- Mobile primary-header controls are Back, Forward, optional Companion, More.
- Desktop primary-header controls follow the same budget.
- Stats and import activity live in the shared Account menu, not fixed chrome.
- Preserve pull refresh, drag reorder, keyboard alternatives, focus, status,
  resource-action parity, and all domain owners.
- Delete every superseded trigger, publication field, style, test, and comment.

Follow `docs/rules/{cleanliness,simplicity,boundaries,frontend,testing}.md` and
`docs/local-rules/testing-standards.md`: one owner, one path, narrow typed
contracts, behavior proof, no speculative surface, and sensitivity evidence for
replacement tests.

## Scope And Final Behavior

| Surface | Persistent controls | One More menu |
|---|---|---|
| Desktop primary pane | Back, Forward, identity, optional Companion, More | Pane commands; published view commands; canonical resource actions |
| Mobile primary pane | Back, Forward, identity, optional Companion, More | Same semantic content as desktop |
| Refreshable mobile pane | Above plus top-edge pull-to-refresh | **Refresh** remains here as the accessible tap/keyboard path |
| Collection row | Primary row target, More | Move up/down; Connections/related disclosure; flat or canonical resource actions |
| Desktop Account | Account trigger, optional import-count badge | Stats; Import activity; Downloads when available; Settings; separator; Sign Out |
| Mobile Account in Nexus | Same shared Account menu | Same membership and order |

Back and Forward always occupy stable positions and are disabled when
unavailable. Companion is rendered only when published. More is absent only
when the composed menu is empty. A single marker on More represents any hidden
`Status` indicator; hidden statuses never create another header button.

Reader menu order is: Activity status, Credits when available, Reader settings,
format-specific appearance options, then canonical resource actions.
Pane order is: Find/Filter and Return when available, Refresh, Share, published
view commands, then canonical resource actions. Empty groups disappear.
Route Share exists only when `routeShareIdentity` exists; resource panes use
the canonical resource Share and never render a duplicate.

Collection-row order is: Move up, Move down, Connections/related, flat actions
or canonical resource actions. The single More trigger remains the drag
activator for sortable rows; tap opens the menu, drag reorders, and
Alt+ArrowUp/Down still reorders.

“Activity” is disambiguated in global chrome:

- **Import activity** opens the existing Nexus media-processing task.
- Reader **Activity: `<state>`** opens `/stats` and remains contextual.
- **Stats** remains a normal pane route and Nexus result; only fixed-nav
  membership changes.

## Rules And Invariants

1. One visible trigger does not imply one semantic owner.
2. `RESOURCE_ACTION_CATALOG`, `resolveResourceActionPlan`, action snapshots, and
   resource execution ports remain the sole resource-action policy.
3. Canonical resource descriptors are an identical ordered contiguous suffix
   of a composed menu. Only the separator before the suffix may be added.
4. Resource loading never disables ready pane/view/occurrence commands. While a
   composed menu is open, it shows a disabled **Resource actions are loading…**
   row; resource failure exposes the existing Retry descriptor.
5. Resource danger actions remain last. Non-resource danger actions are valid
   only in a menu with no resource subject and remain last in their final group.
6. Descriptor IDs are unique across a composed menu; duplicates are defects.
7. Promotion is closed: only the typed Companion action may be top-level.
   Promoted Companion is not duplicated in More.
8. Gestures never become the only path: Refresh remains in More; Move up/down
   remain in More; keyboard paths and live announcements remain.
9. Menu order is static. No telemetry, AI ranking, frequency reordering,
   responsive reshuffling, user pinning, or morphing icon meaning.
10. No compatibility props, dual publication fields, aliases, fallbacks, or
    legacy rendering branches survive the cutover.

## Final Architecture And Composition

```text
pane body ── PanePrimaryChromePublication ──> PaneShell
                  companionAction                 │
                  menuActions                     ├─ pane commands
                  refresh capability              ├─ view commands
                  actionSubject ── resource runtime ─ canonical descriptors
                                                   │
                                      ContextualActionMenu
                                                   │
                                           one ActionMenu

sortable row ─ occurrence/view descriptors ────────┘
resource row ─ actionSubject ─ resource runtime ───┘

APP_NAVIGATION account destinations ─┐
MediaActivityProvider / OfflineMedia ├─ AccountMenu ─ one ActionMenu
                                     ┘
```

Ownership remains:

| Concern | Sole owner |
|---|---|
| Pane capability publication and equality | `lib/panes/panePublications.ts` |
| Search, refresh lifecycle, route share, and local menu order | `PaneShell` |
| Desktop/mobile physical header layout | `SurfaceHeader` / `MobilePaneBar` |
| Mobile retreat/pinning and pull gesture | `MobileChromeProvider` / `PaneShell` |
| Resource membership/order/execution | existing resource-action runtime |
| Cross-owner menu projection | new `ContextualActionMenu` over existing `ActionMenu` |
| Occurrence movement and announcement | existing `SortableList` |
| Fixed/account destination membership | `appnav/navModel.ts` |
| Account menu composition | `AccountMenu` |

## Capability And API Contract

Hard-replace the primary-chrome publication fields; do not deprecate them:

```ts
type PaneCompanionAction = PaneHeaderAction & {
  readonly id: "resource-inspector-companion";
};

interface PanePrimaryChromePublication {
  readonly header?: PaneHeaderPublication;
  readonly search?: PaneSearchPublication;
  readonly instrument?: PaneInstrumentPublication;
  readonly companionAction?: PaneCompanionAction;
  readonly menuActions?: readonly ActionDescriptor[];
  readonly actionSubject?: ResourceActionSubject;
  readonly refresh?: PaneRefreshPublication;
}
```

Delete `actions`, `viewMenu`, and `PaneViewMenuPublication`. `menuActions`
contains owner-built descriptors only; trigger label/icon are presentation and
therefore not published. `MobilePaneChrome` carries `companionAction`,
`paneActions`, `menuActions`, and `actionSubject`; delete `actions`, `controls`,
and `viewMenu`.

The new presentation seam is deliberately small:

```ts
type ContextActionSection = {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly ActionDescriptor[];
};

type ContextualActionMenuProps = Pick<
  ComponentProps<typeof ActionMenu>,
  | "label"
  | "placement"
  | "align"
  | "renderTrigger"
  | "triggerAttributes"
  | "triggerRef"
> & {
  readonly sections: readonly ContextActionSection[];
  readonly actionSubject?: ResourceActionSubject;
};
```

It removes empty sections, defects on duplicate section/action IDs, adds one
separator between non-empty sections, and appends the canonical resource model.
It owns no labels, authorization, execution, or domain state. It renders one
persistent `ActionMenu` across local-command and optional-resource publication
changes so an open menu, focus, and accessibility identity survive pane
hydration. With no resource subject it performs no snapshot read; with no local
sections it preserves the resource-only loading, error, and ready semantics.

Extract the repeated mobile-menu pin lifecycle from `ResourceActionMenu`,
`MobilePaneBar`, and `CollectionRow` into one owner-backed
`useMobileChromeActionMenuLock`; do not move lock state out of
`MobileChromeProvider`.

`APP_NAVIGATION` becomes:

```ts
{
  destinations: [lectern, libraries, browse, podcasts, chats, notes, atlas, oracle],
  account: { stats, settings }
}
```

`AccountMenu` consumes that resolved account model, `MediaActivityProvider`,
and `OfflineMediaProvider`. It alone owns the exact menu order and import-count
badge. Both desktop rail and mobile Nexus render this component; neither
rebuilds its entries. The Account trigger is current when either Stats or
Settings owns the active pane; opening Import activity does not change pane
navigation.

No backend, database, wire, route, workspace-persistence, or resource-action
schema changes.

## Files

Unprefixed frontend paths below are relative to `apps/web/src/`.

Add:

- `apps/web/src/components/resources/ContextualActionMenu.tsx` and focused
  browser proof.

Primary pane contract/renderers:

- `lib/panes/panePublications.ts`, `lib/workspace/mobileChrome.tsx`;
- `components/workspace/PaneShell.tsx`;
- `components/ui/SurfaceHeader.tsx` and styles/proof;
- `components/appnav/MobilePaneBar.tsx` and styles/proof;
- `components/resource-inspector/companionAction.tsx`;
- all current `actions`/`viewMenu` publishers: Media, Library, Page, Podcasts,
  Conversations, Author, Podcast Detail, Note, and Conversation pane bodies.

Rows:

- `components/collections/CollectionRow.tsx`, styles, and browser proof;
- `lib/collections/types.ts` documentation;
- keep `components/sortable/SortableList.tsx` behavior unchanged.

Account/navigation:

- `components/appnav/navModel.ts`;
- `components/appnav/{AppNav,NavRail,NavAccount,AccountMenu}.tsx`;
- `components/switchboard/SwitchboardTask.tsx` and affected browser proofs.

Docs/journeys:

- `docs/modules/{workspace,app-navigation}.md`;
- supersession notes in the canonical resource-action, universal resource-action,
  Consumption Stats, and durable Consumption Activity cutovers;
- resource-action parity, durable activity, media-activity navigation, mobile
  reader geometry, and exact pane-chrome journeys/proofs.

## Non-Overlapping Work Slices

1. **Shared projection:** new contextual menu, mobile lock hook, resource-suffix
   parity proof, and `MobilePaneChrome` shape.
2. **Primary panes:** publication hard cut, `PaneShell`, both header renderers,
   all pane producers, and their component proofs. No row/account files.
3. **Rows:** one CollectionRow trigger, disclosure descriptor, drag activation,
   styles, and row proof. No pane/account files.
4. **Account/navigation:** fixed-nav removal, shared Account membership/status,
   desktop/mobile projections, and proofs. No pane/row files.
5. **Closure:** E2E journeys, docs supersession, residue gates, physical mobile
   acceptance. No production behavior changes.

Slices 2–4 may proceed after Slice 1 and touch no common files.

## Hard-Cut Deletions

- Dedicated pane Refresh and Share buttons.
- Separate pane view-menu trigger and its label/icon publication.
- Mobile import-activity header button and desktop rail item/styles/props.
- Stats fixed-nav membership.
- Forward-inside-Pane-options behavior.
- Separate row reorder menu and Connections button.
- Comments/tests asserting that owner separation requires trigger separation.
- Empty `actions: []`, compatibility adapters, old prop aliases, and dead CSS.

Keep `ResourceActionMenu` for resource-only surfaces and secondary-pane headers;
it is not legacy. Secondary-pane sheets, players, Nexus rows, selection tools,
batch actions, and editor toolbars are out of scope.

## Acceptance Criteria

- Desktop and mobile primary panes expose one More trigger; no Refresh, Share,
  Activity, Reader settings, Find, Browse, New Chat, or second resource trigger
  remains top-level in the primary header.
- Mobile renders Back, Forward, optional Companion, and More with no import
  activity control; 390px geometry does not overlap or reorder them.
- More contains the exact applicable groups/order above. Resource actions match
  the independent canonical oracle as an ordered contiguous suffix.
- Pull refresh starts only for eligible standard-scroll panes at scroll top;
  Refresh in More invokes the same fenced operation and progress/announcement.
- A sortable row has one More trigger. Tap, drag, Alt+Arrow, Move up/down, focus
  return, disabled edge positions, and live position announcement all work.
- Connections/related opens and closes from the row menu with correct
  `aria-expanded`/`aria-controls` state.
- Account has exact shared desktop/mobile membership; Stats and Import activity
  open through existing workspace/Nexus owners; Sign Out remains danger-last.
- Resource loading/error never blocks local commands and never triggers a
  menu-open network request beyond the existing mount prefetch/retry contract.
- Publishing local commands or a resource subject does not close an open menu
  or replace its focus/accessibility owner; the canonical suffix updates in
  place.
- No old field, trigger, control, style, assertion, or contradictory normative
  documentation survives.

## Verification

- Red-first browser proofs at `ContextualActionMenu`, `SurfaceHeader`,
  `MobilePaneBar`, `CollectionRow`, and `AccountMenu` boundaries.
- Focused real-stack journeys only where the cutover crosses an existing owner:
  resource suffix parity, reader Activity → Stats, Import activity, and
  mobile More. Row command semantics stay at the focused component boundary;
  real touch pull/drag behavior is physical-device acceptance, not a duplicate
  synthetic journey.
- `./scripts/test changed`, affected lint/typecheck, then `./scripts/test pr`.
- Physical authenticated Android/WebView acceptance for 390px header geometry,
  menu pinning/focus, pull-vs-scroll classification, and tap-vs-drag behavior.
  Synthetic Chromium is supporting evidence only.
- Residue greps for `PaneViewMenuPublication`, `viewMenu`, old primary-chrome
  `actions`, dedicated `Pane.Refresh` button rendering, mobile/rail Activity
  controls, Stats in fixed destinations, and separate row reorder controls.

## Non-Goals

- No command bus, plugin system, action database, server-defined UI, generic
  command registry, persisted toolbar schema, feature flag, or migration.
- No configurable/pinnable toolbar, adaptive ordering, telemetry platform,
  palette rewrite, shortcut rewrite, or new gesture.
- No resource policy, backend, ingestion, Stats, reader-settings, Companion,
  refresh-operation, route, or sortable-state redesign.
- No secondary-pane, player, editor, selection, batch, or broad visual restyle.
