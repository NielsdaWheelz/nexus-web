# PR-02 Pane Graph Addendum: Persistent In-App Multi-Pane Workspace

## purpose

Document the production contract for the in-app pane system introduced for quote-to-chat and shift-open flows.

## architecture

The authenticated layout composes:

1. `PaneGraphProvider` (`apps/web/src/lib/panes/paneGraphStore.tsx`)
2. `InAppPaneWorkspace` (`apps/web/src/components/InAppPaneWorkspace.tsx`)
3. `PaneRouteRenderer` (`apps/web/src/components/PaneRouteRenderer.tsx`)
4. `PaneRuntimeProvider` (`apps/web/src/lib/panes/paneRuntime.tsx`)

Design constraints:

- side panes render route components directly (no iframe embedding)
- pane state persists in `localStorage` under `nexus.paneGraph.v1`
- pane count is bounded (`MAX_PANES = 8`)
- pane-open requests use one boundary: `requestOpenInAppPane(href)`

## supported pane routes

Current explicit route map:

- `/libraries`
- `/libraries/{id}`
- `/media/{id}`
- `/conversations`
- `/conversations/{id}`

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

- `apps/web/src/__tests__/components/InAppPaneWorkspace.test.tsx`
- `apps/web/src/__tests__/components/AppList.test.tsx`
- `apps/web/src/__tests__/components/PdfReader.test.tsx`
- `apps/web/src/__tests__/components/LinkedItemsPane.test.tsx`
- `apps/web/src/__tests__/components/LinkedItemRow.test.tsx`

E2E coverage:

- `e2e/tests/non-pdf-linked-items.spec.ts` validates quote-to-chat opens an in-app pane in the same browser tab.

## known limits

- pane titles are currently derived from URL path segments; they are not yet hydrated from server metadata.
- only listed authenticated routes are pane-renderable; route registry must be extended explicitly.
- no versioned storage migration path exists yet for future pane graph schema revisions.
