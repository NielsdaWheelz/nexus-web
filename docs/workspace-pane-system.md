# Workspace Pane System Contract

This is the authoritative contract for workspace primary panes, attached
secondary panes, fixed primary chrome, pane runtime publication, mobile
secondary sheets, and session restore.

## Goals

- Keep primary workspace panes and attached secondary panes explicit, durable,
  and independently resizable.
- Keep all pane layout state out of the URL.
- Keep secondary identity, width policy, route eligibility, and display metadata
  centralized.
- Make secondary availability a mounted-pane publication, validated by the host.
- Make desktop and mobile secondary behavior use the same capability contract.
- Ensure opening, closing, resizing, minimizing, and restoring one pane never
  mutates any sibling pane width.

## Non-Goals

- No detachable secondary windows.
- No route-local secondary rail, sheet, split pane, width constant, or resize
  state.
- No URL workspace layout encoding.
- No workspace layout schema migration path.
- No parser for removed pane state shapes.
- No generic plugin system for secondary content. Secondary surfaces are a small
  typed registry owned by the workspace shell.

## State Shape

`apps/web/src/lib/workspace/schema.ts` owns the persisted shape:

```ts
interface WorkspaceState {
  activePrimaryPaneId: string;
  primaryPaneOrder: string[];
  primaryPanesById: Record<string, WorkspacePrimaryPaneState>;
  secondaryPanesById: Record<string, WorkspaceAttachedSecondaryPaneState>;
}

interface WorkspacePrimaryPaneState {
  id: string;
  href: string;
  primaryWidthPx: number;
  visibility: "visible" | "minimized";
  history: WorkspacePaneHistory;
  attachedSecondaryPaneId: string | null;
}

interface WorkspaceAttachedSecondaryPaneState {
  id: string;
  parentPrimaryPaneId: string;
  groupId: WorkspaceSecondaryGroupId;
  activeSurfaceId: WorkspaceSecondarySurfaceId;
  widthPx: number;
  visibility: "visible" | "collapsed";
}
```

Sanitization is strict:

- Missing or invalid primary topology resets to the default deep-link pane.
- Duplicate primary ids reset.
- Missing active visible primary resets.
- A primary attachment is retained only when its secondary exists, points back to
  that primary, has a valid group/surface pair, is route-eligible, and has valid
  visibility and width.
- Invalid attached secondary panes are dropped and the primary attachment is
  nulled.
- Extra unattached secondary panes are dropped.

## Secondary Model

`apps/web/src/lib/panes/paneSecondaryModel.ts` is the only source for:

- `WorkspaceSecondaryGroupId`
- `WorkspaceSecondarySurfaceId`
- surface titles and icons
- group membership
- group width policy
- width clamping and correction

`apps/web/src/lib/panes/paneRouteModel.ts` owns route eligibility only. It does
not render surfaces and does not own secondary metadata.

## Store API

`apps/web/src/lib/workspace/store.tsx` owns durable mutations:

```ts
openPane(input)
navigatePane(primaryPaneId, href, options)
resizePrimaryPane(primaryPaneId, widthPx)
minimizePane(primaryPaneId)
restorePane(primaryPaneId)
requestSecondarySurface(primaryPaneId, surfaceId)
closeSecondaryPane(secondaryPaneId)
setSecondarySurface(secondaryPaneId, surfaceId)
resizeSecondaryPane(secondaryPaneId, widthPx)
```

Rules:

- `openPane` never seeds secondary state.
- `requestSecondarySurface` validates route eligibility, creates or reuses the
  attached secondary pane for that primary, sets the requested surface active,
  and makes it visible.
- `closeSecondaryPane` collapses the attached secondary pane without changing
  primary width.
- `setSecondarySurface` only accepts surfaces in the attached secondary group.
- `resizeSecondaryPane` clamps by group policy and never writes a primary width.
- Host validation may drop invalid secondary topology through an internal store
  action. This is not exposed through pane runtime.

## Host Contract

`apps/web/src/components/workspace/WorkspaceHost.tsx` owns all ephemeral runtime
records:

- pane title publications
- primary layout publications
- secondary surface publications
- fixed primary chrome publications
- pending cross-pane secondary requests
- publication validation and stale-record pruning

Cross-pane secondary launch is host-mediated:

1. Runtime calls `openInNewPane(href, titleHint, secondarySurfaceId)`.
2. Host records an ephemeral pending request keyed to the target resource and,
   once known, the target primary pane id.
3. Store opens or reuses the primary pane without seeding secondary state. A
   newly opened pane has no attached secondary; a reused pane keeps its own.
4. The mounted route publishes its secondary surfaces.
5. Host validates the requested surface against the publication and then calls
   `requestSecondarySurface(primaryPaneId, surfaceId)`.
6. If the target pane changes resource or publishes a group without that
   surface, the pending request is discarded.

Host must never pass a visible secondary pane to runtime or shell rendering
unless the current publication can render its active surface. When a publication
exists whose group no longer matches the persisted secondary, host drops that
secondary pane. When the group still matches but the persisted active surface is
no longer published, host resets the secondary to the publication's default
surface. Until the secondary again matches the publication, it is neither
rendered nor exposed through pane runtime.

## Runtime Contract

`apps/web/src/lib/panes/paneRuntime.tsx` exposes primary-pane-scoped commands to
route bodies:

```ts
requestSecondarySurface(surfaceId)
closeSecondaryPane()
setSecondarySurface(surfaceId)
openInNewPane(href, titleHint?, secondarySurfaceId?)
```

Route bodies do not import workspace store APIs. They publish capabilities and
request surfaces through pane runtime.

## Publication Contract

`apps/web/src/components/workspace/PaneSecondary.tsx` is a publication API:

```ts
interface PaneSecondaryPublication {
  groupId: WorkspaceSecondaryGroupId;
  defaultSurfaceId: WorkspaceSecondarySurfaceId;
  surfaces: readonly PaneSecondarySurfacePublication[];
}
```

Rules:

- Publication belongs to the mounted pane resource that emitted it.
- Publication records are pruned when a pane id changes resource or unmounts.
- A secondary request is valid only when route eligibility and current
  publication both allow the surface.
- Surface body components receive data and callbacks as props. Only thin
  route-owned publisher/adapters call pane hooks.

## Desktop Layout

`PaneShell` composes one compound pane:

```txt
compound width = primaryWidthPx + fixedChromeWidthPx + visibleSecondaryWidthPx
```

Rules:

- Primary resize mutates only `WorkspacePrimaryPaneState.primaryWidthPx`.
- Secondary resize mutates only `WorkspaceAttachedSecondaryPaneState.widthPx`.
- Fixed primary chrome width is runtime-published and not persisted.
- Opening, collapsing, switching, or resizing a secondary pane does not mutate
  primary width.
- Sibling panes are repositioned by flex/canvas translation and scroll. They are
  never resized as a side effect.
- Minimized primary panes hide the whole compound pane and preserve attached
  secondary state.

## Mobile Layout

`MobileSecondaryPaneHost` renders published secondary surfaces as modal sheets.

Rules:

- Mobile secondary panes contribute no width.
- The active pane owns the runtime/provider context for mobile secondary bodies.
- The sheet uses body scroll lock, focus trap, initial focus, Escape close, and
  focus return.
- Desktop and mobile secondary tabs use roving focus, ArrowLeft/ArrowRight,
  Home/End, `aria-controls`, and active `tabpanel` linkage.
- Mobile has no secondary resize handle.

## Capability Composition

Reader:

- Reader overview ruler remains fixed primary chrome.
- Highlights and document chat are `reader-tools` secondary surfaces.
- Reader document chat is embedded content and must not publish pane chrome.

Conversation:

- References and forks are `conversation-context` secondary surfaces.
- Existing and new conversation panes share one publication adapter.
- Conversation reference data remains conversation data, not secondary-local
  state.

Library:

- Library chat and intelligence are `library-tools` secondary surfaces.
- Library list actions may open a library primary pane and request a pending
  secondary surface through host-mediated `openInNewPane`.

Chat:

- Shared chat behavior belongs in the chat engine/view layer.
- Embedded reader chat and full conversation panes may share engine/view code,
  but only pane-level adapters publish secondary surfaces or pane chrome.

## File Ownership

- `schema.ts`: persisted state shape, topology sanitization, history trimming.
- `store.tsx`: durable primary/secondary mutations and session-facing state.
- `sessionSync.ts`: session fetch/store, restore filtering, equality, non-trivial
  detection.
- `paneSecondaryModel.ts`: group/surface ids, metadata, width policy.
- `paneRouteModel.ts`: route eligibility.
- `paneRuntime.tsx`: route-body command bridge.
- `PaneSecondary.tsx`: publication context.
- `WorkspaceHost.tsx`: publication records, validation, pending requests,
  mobile/desktop orchestration.
- `PaneShell.tsx`: compound desktop/mobile primary shell.
- `SecondaryPaneShell.tsx`: desktop secondary tabs, body, close, resize.
- `MobileSecondaryPaneHost.tsx`: mobile secondary modal sheet.

## Acceptance Criteria

- No live web or e2e code references removed secondary-era names or old flat pane
  state fields.
- TypeScript passes with the normalized state shape.
- Invalid open or switch requests do not mutate state.
- Invalid persisted secondary topology is dropped.
- A visible secondary without a matching current publication is not rendered and
  is not exposed through pane runtime.
- Pending cross-pane secondary requests are discarded when the target pane no
  longer matches or publishes without the requested surface.
- Opening, collapsing, switching, and resizing one secondary pane leaves every
  non-target primary and secondary width unchanged.
- Session restore persists attached secondary panes only in the top-level
  normalized shape.
- Reader, conversation, and library secondary surfaces use the same desktop shell
  and mobile host.
- Desktop secondary tabs, mobile secondary tabs, mobile modal behavior, and
  secondary resize handle keyboard behavior are covered by tests.
- Host publication validation is covered by tests: a visible secondary without a
  matching publication is not rendered or exposed, a group-mismatched secondary
  is dropped, an unpublished active surface is reset to the published default,
  and pending cross-pane secondary requests are launched or discarded by
  publication.

## Verification

Run at minimum:

```sh
cd apps/web
bun run typecheck
```

Before merging a pane-system change, also run the frontend check and focused
unit/browser/e2e suites that cover workspace state, host validation, secondary
shells, reader panes, conversation panes, library panes, and session restore.
