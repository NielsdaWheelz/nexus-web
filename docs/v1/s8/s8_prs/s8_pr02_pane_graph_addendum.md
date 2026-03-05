# PR-02 Pane Graph Addendum: Persistent In-App Multi-Pane Workspace

> **Superseded**: This document describes the v1 localStorage-based pane graph
> architecture (`PaneGraphProvider`, `InAppPaneWorkspace`, `nexus.paneGraph.v1`).
> That system has been replaced by a URL-encoded multi-group workspace (schema v2,
> `ws` query param). See the README "In-App Pane Workspace" section and
> `apps/web/src/lib/workspace/` for the current contract.

## purpose

Document the production contract for the in-app pane system introduced for quote-to-chat and shift-open flows.

## architecture (v1 — superseded)

The v1 authenticated layout composed:

1. `PaneGraphProvider` (`apps/web/src/lib/panes/paneGraphStore.tsx`) — **removed**
2. `InAppPaneWorkspace` (`apps/web/src/components/InAppPaneWorkspace.tsx`) — **removed**
3. `PaneRouteRenderer` (`apps/web/src/components/PaneRouteRenderer.tsx`) — still used
4. `PaneRuntimeProvider` (`apps/web/src/lib/panes/paneRuntime.tsx`) — still used

The current (v2) architecture uses `WorkspaceStoreProvider`, `WorkspaceV2Host`,
`WorkspaceRoot`, `PaneGroup`, and `TabStrip` (all under `apps/web/src/components/workspace/`
and `apps/web/src/lib/workspace/`).

Design constraints (current):

- side panes render route components directly (no iframe embedding)
- workspace state is URL-encoded in the `ws` query parameter (schema v2)
- groups capped at 4, tabs at 12 per group, 24 total
- pane-open requests use one boundary: `requestOpenInAppPane(href)`

## supported pane routes

Current explicit route map (13 routes):

- `/libraries`, `/libraries/{id}`
- `/media/{id}`
- `/conversations`, `/conversations/{id}`
- `/discover`, `/documents`, `/podcasts`, `/videos`
- `/search`
- `/settings`, `/settings/reader`, `/settings/keys`

Unsupported routes render a controlled fallback message inside the pane.

## open-pane transport contract

Top-level pane open requests are accepted through:

- `window.dispatchEvent(new CustomEvent("nexus:open-pane", { detail: { href } }))`
- `window.postMessage({ type: "nexus:open-pane", href }, origin)` from embedded contexts

Security/safety rules:

- only same-origin hrefs normalize successfully
- cross-origin `postMessage` events are ignored
- when pane graph listeners are not yet marked ready, requests are queued and replayed on listener startup

## pane runtime contract

Routes that can render in the primary view and in side panes must use pane-aware hooks:

- `usePaneRouter()`
- `usePaneSearchParams()`
- `usePaneParam(name)`

This keeps route logic shared while allowing pane-local navigation.

## validation

Component tests:

- `apps/web/src/__tests__/components/SplitSurface.test.tsx`
- `apps/web/src/__tests__/components/SurfaceHeader.test.tsx`
- `apps/web/src/__tests__/components/AppList.test.tsx`
- `apps/web/src/__tests__/components/Pane.test.tsx`
- `apps/web/src/__tests__/components/LinkedItemRow.test.tsx`

Unit tests:

- `apps/web/src/lib/workspace/schema.test.ts`
- `apps/web/src/lib/workspace/urlCodec.test.ts`
- `apps/web/src/lib/workspace/store.test.ts`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`

E2E coverage:

- `e2e/tests/non-pdf-linked-items.spec.ts` validates quote-to-chat opens an in-app pane in the same browser tab.

## known limits

- pane titles are currently derived from URL path segments; they are not yet hydrated from server metadata.
- only listed authenticated routes are pane-renderable; route registry must be extended explicitly.
- ActionMenu dropdown may be clipped by `overflow: hidden` ancestors in AppList/LinkedItemsPane (portal-based rendering is a planned follow-up).
