# Library Placement Resource Action — Hard Cutover

**Status:** IMPLEMENTED AND VERIFIED · Rev 2 · 2026-07-24

**Type:** Hard cutover; one final path, no compatibility aliases or fallbacks.

## Goal

Make item-to-library placement a direct resource relationship action.
`Share…` owns links and access. `Libraries…` owns organization.

This document supersedes every current rule that embeds media or podcast
placement inside Share.

## Scope

- Media resources, including episode media.
- Podcast resources.
- Standing resource menus rendered by `CollectionRow` and `PaneShell`.
- The placement capability, controller, responsive overlay, client, and
  existing library-entry service contract.
- Removal of the obsolete Share branch, composite Share mode, duplicate
  clients, hooks, names, tests, and documentation.

## Final Product Contract

```text
resource menu
  core            Open / Share / Chat
  operations      source and lifecycle commands
  relationships   Libraries… / Lectern and other relationships
  view             renderer-local view commands
  danger           consequential commands, composer-derived and always last

Libraries…
  -> LibraryPlacementController
  -> responsive LibraryPlacementOverlay
  -> LibraryEntryEditor
  -> library placement client
  -> existing media/podcast library-entry APIs
  -> library_entries service
```

- `Libraries…` is one first-level overflow-menu item. It is not inside Share,
  a submenu, or a persistent header action.
- The label and `Library` icon are stable; menu construction performs no
  relationship fetch.
- The overlay remains open for multiple independent toggles.
- Share for media manages links and resource grants.
- Share for podcasts copies the Nexus link.
- Share for a library continues to manage people, invitations, roles, and
  ownership. `LibraryMemberEditor` remains there.
- Inbound `/share` capture and destination selection are unchanged.

## Decisions

| Question | Decision |
|---|---|
| Action identity | `RelationshipAction.LibraryPlacement.Edit` |
| Catalog key / label | `EditLibraryPlacement` / `Libraries…` |
| Action group | `relationships`, before other relationship actions |
| Supported schemes | `media`, `podcast` only |
| Placement mode | `None \| ManageEntries` |
| Desktop surface | Existing `Dialog` primitive |
| Mobile surface | Existing `MobileSheet` primitive |
| Mutation model | Server-confirmed, one mutation at a time |
| Default/system libraries | Excluded by the existing service |
| New-library creation | Not present |
| Launcher/header promotion | Not present |
| New route or persistence | None |

Shared/public names use `membership` only for user-to-library governance and
`entry` or `placement` for resource-to-library organization.

## Capability Contract

Add one orthogonal field to the backend, wire schema, and frontend projection:

```text
LibraryPlacementMode = None | ManageEntries

ResourceItemCapability {
  sharing: ShareMode
  libraryPlacement: LibraryPlacementMode
  ...
}
```

The backend field is `library_placement`; its wire alias and frontend field are
`libraryPlacement`.

Assignments:

| Scheme | `sharing` | `libraryPlacement` |
|---|---|---|
| `media` | `ResourceGrants` | `ManageEntries` |
| `podcast` | `CopyOnly` | `ManageEntries` |
| all others | unchanged | `None` |

Delete the obsolete composite Share-and-file mode from backend literals,
schemas, frontend types, decoders, copy, fixtures, and tests. Do not alias or
accept it.

Static capability answers whether a scheme supports the action. The list
response answers what this viewer may do now. Resource menus never infer
authorization, subscription state, or library roles.

## Frontend Types

```ts
type LibraryPlacementTarget =
  | { kind: "Media"; id: string }
  | { kind: "Podcast"; id: string };

interface LibraryPlacementOption {
  id: string;
  name: string;
  color: string | null;
  isInLibrary: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

type LibraryPlacementSession = {
  key: number;
  target: LibraryPlacementTarget;
  options: LibraryPlacementOpenOptions;
};
```

- Parse the canonical resource ref once when executing the action.
- A `ManageEntries` capability on any other scheme is a defect.
- The session key resets query, request, and error state between openings.
  An active command remains globally serialized and reconciles the current
  session after it settles.
- Owned API responses are strictly decoded once. Unknown keys, values, or
  modes are defects; there is no permissive parsing.

## API Contract

Reuse the existing routes without aliases or replacements:

```text
GET    /api/media/{mediaId}/libraries
POST   /api/media/{mediaId}/libraries
DELETE /api/media/{mediaId}/libraries/{libraryId}

GET    /api/podcasts/{podcastId}/libraries
POST   /api/libraries/{libraryId}/podcasts
DELETE /api/libraries/{libraryId}/podcasts/{podcastId}
```

List response:

```ts
{
  data: Array<{
    id: UUID;
    name: string;
    color: string | null;
    is_in_library: boolean;
    can_add: boolean;
    can_remove: boolean;
  }>;
}
```

Rules:

- `library_entries.list_item_libraries` remains the sole list-policy owner.
- It returns the viewer’s non-default, non-system libraries.
- `can_add` and `can_remove` are the only UI mutation truth.
- Podcast `can_add` also requires an active viewer subscription.
  `can_remove` remains `admin && is_in_library`; unsubscribe teardown behavior
  is unchanged.
- Every mutation reauthorizes in the service transaction.
- Existing shared-library entitlement enforcement remains unchanged.
- Commands return `204`. Expected API failures render in the overlay; malformed
  same-system responses and impossible capability states defect.

One shared frontend client owns:

```ts
listLibraryPlacements(target, { signal })
addLibraryPlacement(target, libraryId)
removeLibraryPlacement(target, libraryId)
addMediaToLibraries(mediaId, libraryIds) // existing Add Content batch use
```

It adapts route asymmetry internally. Move only placement symbols out of
`mediaLibraries.ts` and `podcastSubscriptions.ts`; preserve media deletion and
podcast subscription/settings behavior in their existing owners. The overlay
refetches the authoritative list after each `204`; it never guesses new
`can_add`/`can_remove` values. Add Content may retain a media-only local patch
helper in this same owner for its already-authorized intake session.

## Composition

1. `RESOURCE_ACTION_CATALOG` owns action id, label, icon, and focus policy.
2. A pure universal relationship resolver:
   - rejects contradictory refs as defects;
   - returns nothing for missing or unsupported resources;
   - emits `EditLibraryPlacement` for `ManageEntries`;
   - requires the controller executor as a non-optional port.
3. `CollectionRow` and `PaneShell`, the two final standing `ResourceMenu`
   renderers, prepend the universal relationships before
   `composeResourceMenu`. This includes connection, evidence, and context
   representations that project through `CollectionRow`; no rich-surface
   exception exists.
4. `executeResourceLibraryPlacement` narrows the subject to
   `LibraryPlacementTarget` and opens the controller.
5. `LibraryPlacementControllerProvider` is mounted beside
   `ShareControllerProvider` at the authenticated workspace boundary.
6. `LibraryPlacementOverlay` directly owns desktop `Dialog` and mobile
   `MobileSheet`, plus loading, mutation, and focus return.
   `LibraryEntryEditor` remains presentational. `LibraryEntryPanel` remains the
   Add Content-only desktop wrapper and is never nested in this overlay.

Do not restore optional placement callbacks in resource builders.
Do not add the action independently in page bodies.

## Interaction Rules

- Title: `Libraries`.
- Search filters by library name and resets on each session.
- Desktop focuses search on open. Mobile focuses overlay chrome and does not
  summon the keyboard.
- Rows preserve library color, name, selected check, and a 44px minimum target.
- Each toggle’s accessible name is only the stable library name;
  `aria-pressed` exposes state.
- A non-actionable row stays visible and says `You can’t change this library.`
- Loading uses `role="status"`; errors use `role="alert"` and offer Retry.
- A successful command refetches after `204`. A failed command preserves the
  prior list.
- One mutation runs at a time. All rows disable; the initiating row retains
  focus and exposes `aria-busy`.
- Closing aborts only the list GET. An active command may finish, but a stale
  result cannot update another session; reopening always refetches.
- Empty inventory: `No additional libraries available.` Filter miss:
  `No matching libraries.` No inline create action.
- Close returns focus to the invoking menu trigger, then pane chrome.

Reuse the responsive composition used by existing destination and credits
overlays. Do not extract a generic overlay framework.

## Ownership And Files

| Concern | Final owner / work |
|---|---|
| Normative behavior | this document |
| Resource capability | `python/nexus/services/resource_items/capabilities.py`, `python/nexus/schemas/resource_items.py`, `python/nexus/services/resource_items/surfaces.py`, `apps/web/src/lib/resources/resourceCapabilities.ts` |
| Action catalog/policy | `apps/web/src/lib/actions/resourceActions.ts` |
| Action execution | `apps/web/src/lib/resources/resourceActionExecution.ts` |
| Final menu composition | `apps/web/src/components/collections/CollectionRow.tsx`, `apps/web/src/components/workspace/PaneShell.tsx` |
| Controller/session | new `apps/web/src/lib/libraries/placementController.tsx` |
| Strict client/state | new `apps/web/src/lib/libraries/libraryPlacement.ts`, `useLibraryPlacement.ts` |
| Responsive UI | move/adapt under `apps/web/src/components/libraries/`: `LibraryPlacementOverlay`, `LibraryEntryEditor`, `LibraryEntryPanel`, CSS |
| Workspace provider | `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx` |
| Share simplification | `apps/web/src/components/sharing/ShareOverlay.tsx`, `apps/web/src/lib/sharing/{types,api,content}.ts` |
| Server permission truth | `python/nexus/services/library_entries.py`, `python/nexus/schemas/library.py` |
| Existing client consumers | Existing-item placement and Add Content batch calls import the new placement owner; behavior is unchanged |
| Living docs | `docs/modules/library.md`, `docs/modules/resource-sharing.md` |
| Superseded cutover text | `docs/cutovers/universal-resource-sharing-hard-cutover.md`, `universal-resource-actions-hard-cutover.md`, and stale identifier references found by `rg` |

No barrel or compatibility re-export may preserve an old import path.

## Extirpation

Delete:

- The obsolete Share-owned resource placement editor and Libraries section.
- The obsolete composite Share-and-file mode everywhere.
- The obsolete media placement hook and its import path.
- Superseded item-library response types and media/podcast placement transport
  symbols after their direct rename/move to the placement owner.
- Placement-specific membership names in touched Add Content state;
  user-to-library membership names remain.
- Placement components under `components/sharing`.
- Tests and comments that encode placement as Share or item placement as
  membership.

After the cutover, repository searches for obsolete composite Share modes,
legacy placement hooks and response types, and placement imports from
`components/sharing` must return no current source or normative-doc hits.

## Implementation Order

1. Write failing capability, action-policy, overlay, and service tests.
2. Add the capability field; remove the composite Share mode.
3. Centralize the placement client/types and correct podcast `can_add`.
4. Move the editor; add the controller and responsive overlay.
5. Inject the relationship action at the two final menu owners.
6. Remove Share placement and all superseded owners.
7. Update living and conflicting cutover docs; run extirpation searches.

Do not leave intermediate compatibility code between steps.

## Acceptance Criteria

- Every non-missing media or podcast `ResourceMenu` rendered by
  `CollectionRow` or `PaneShell` contains exactly one direct `Libraries…`
  relationship action.
- Other schemes, external targets, missing targets, Launcher, and pane headers
  do not expose it.
- Opening `Libraries…` starts the placement list request without requesting a
  Share snapshot; placement never calls a Share endpoint.
- Media and podcast add/remove work through the same overlay contract on
  desktop and mobile; deterministic focus, retry, stale-response suppression,
  close-during-mutation, and focus return work.
- Each successful mutation refetches server truth; no client-derived
  `canAdd`/`canRemove` transition exists in the overlay.
- Toggle names remain stable; inventory and filter empty states are distinct.
- Unsubscribed podcasts never receive `can_add: true`; `can_remove` continues
  to reflect only current admin-plus-entry truth.
- Media and podcast Share contain no library editor or library request.
  Podcast Share is `CopyOnly`; Library Share governance is unchanged.
- Backend/frontend capability parity remains exhaustive.
- No new API route, database object, permission path, fallback decoder,
  compatibility alias, or duplicate placement owner exists.
- The extirpation searches are clean and current docs describe only the final
  behavior.

## Verification

- Backend: 14 focused placement/capability/surface tests passed.
- Frontend: 111 focused unit and 60 focused browser tests passed; targeted
  TypeScript, ESLint, Ruff, Pyright, formatting, and diff checks passed.
- Real stack: authenticated media-row `Libraries…` add/refetch/remove,
  no-Share-request, cleanup, and focus-return flow passed.

## Non-Goals

- New libraries, Default/My Library placement, system-library placement, or
  library reordering.
- Batch placement across multiple resources.
- Audience counts, access-impact warnings, recent destinations, favorites,
  optimistic undo, offline state, or caching.
- Launcher commands, keyboard shortcuts, header buttons, or dynamic menu copy.
- New supported resource schemes.
- New routes, a unified generic-resource endpoint, schema migration, or
  authorization rewrite.
- A command bus, server-driven menu, generic modal framework, or design-system
  rebuild.

## Open Questions

None. The decisions above are the 80/20 boundary.
