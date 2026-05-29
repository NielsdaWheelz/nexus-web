# Workspace Sidecar Pane Cutover

## Status

This is the target contract and implementation plan for replacing fixed
secondary rails with independently resizable sidecar panes.

This cutover supersedes every target-behavior statement that treats reader
secondary rails, document chat rails, library chat rails, library intelligence,
or conversation reference rails as fixed runtime extra width.

The primary workspace width cutover remains valid for primary pane sizing:

- Non-PDF primary panes use the measured workspace reader text floor.
- PDF primary panes may publish intrinsic rendered page width.
- Primary width is still user-owned and route-resource-owned.
- The flat horizontal workspace canvas remains the desktop model.

The sidecar cutover changes the secondary surface model:

- Secondary surfaces are sidecar panes, not unnamed runtime extra width.
- Sidecar panes have their own width state.
- Sidecar panes have their own resize handles.
- Resizing a primary pane never resizes its sidecar.
- Resizing a sidecar never resizes its primary pane.
- Sibling workspace panes are repositioned only; their widths are never changed
  by another pane's primary or sidecar resize.
- No compatibility path preserves fixed secondary rail behavior.

Any code path that keeps a reader/document/library/conversation secondary
surface as a fixed `extraWidthPx` rail is wrong and should be deleted.

## Problem Statement

The workspace now has a mostly clean primary pane model, but secondary surfaces
are still fragmented:

- Reader highlights, document chat, and in-rail reader chat are embedded inside
  `MediaPaneBody`.
- Conversation references are duplicated between existing-chat and new-chat
  panes.
- Library chat has a tested component but no mounted production surface.
- Library intelligence is a primary library subview even though it behaves like
  an adjacent work surface.
- `SecondaryRail` is a fixed-width shell, not a pane.
- Runtime sizing publishes all secondary width as one anonymous scalar.
- The only resize handle sits at the far right of the rendered pane while it
  mutates only primary width.

That model is hard to reason about. It makes secondary surfaces visually pane-like
but behaviorally dependent on their primary. The user cannot independently size
the document and the adjacent tools. Adding another fixed rail or local width
constant would make the system worse.

The correct fix is a hard cutover to a sidecar pane model.

```text
rendered workspace item width =
  primary pane width
  + fixed primary-adjacent chrome width
  + visible sidecar pane width

primary resize mutates primary width only
sidecar resize mutates sidecar width only
other workspace items keep their own widths and move horizontally only
```

## Goals

- Make every secondary work surface use one sidecar pane contract.
- Give sidecar panes independent, user-owned width.
- Keep primary workspace panes independently resizable.
- Keep sidecar panes independently resizable.
- Keep the flat horizontal workspace canvas.
- Keep route-resource workspace panes as the primary navigation unit.
- Make sidecar width explicit in workspace state, URL state, and session state.
- Make sidecar availability/content a pane-body capability with one public API.
- Consolidate reader highlights, doc chat, library chat, library intelligence,
  and conversation references into the same sidecar host pattern.
- Delete fixed secondary rail width publication.
- Delete duplicated conversation reference rail sizing code.
- Delete unmounted or stale sidecar surfaces, or make them real.
- Keep mobile on the one-active-pane model with drawer/sheet sidecar rendering.
- Make tests assert user-visible resize independence.
- Update docs, tests, and code in the same cutover.

## Non-Goals

- Replacing the flat workspace with arbitrary nested split panes.
- Making arbitrary child panels resizable outside the sidecar contract.
- Allowing pane bodies to invent local resize state.
- Supporting both fixed secondary rails and sidecar panes.
- Keeping `SecondaryRail` as a compatibility wrapper.
- Keeping `extraWidthPx` as the model for secondary surface width.
- Migrating old workspace URL/session payloads.
- Supporting old and new workspace pane schemas at the same time.
- Making sidecars independent top-level routes unless the user opens the full
  route-resource pane explicitly.
- Letting sidecar content intrinsic width determine sidecar shell width.
- Letting primary content intrinsic width determine non-PDF primary shell width.
- Generalizing this into a plugin layout manager.
- Making the reader overview ruler resizable.

## Repository Rules

This cutover follows:

- `docs/rules/cleanliness.md`
- `docs/rules/module-apis.md`
- `docs/rules/simplicity.md`
- `docs/rules/testing_standards.md`

Applied here:

- One concern has one owner.
- A capability has one primary API.
- Sidecar sizing is derived in one place.
- Sidecar state is stored in one workspace shape.
- Duplicate rail wrappers are deleted.
- Dead fixed-rail components and tests are deleted.
- No compatibility branch handles old workspace schemas.
- Tests assert observable behavior at the owning surface.

## Vocabulary

### Workspace Pane

A workspace pane is a top-level route-resource item in the horizontal desktop
canvas.

Examples:

- `/media/:id`
- `/conversations/:id`
- `/conversations/new`
- `/libraries/:id`
- `/search`
- `/pages/:id`

Workspace panes own:

- route href
- route-resource identity
- pane-local history
- primary width
- optional sidecar state
- visibility/minimized state

### Primary Pane

The primary pane is the route body and shell chrome for a workspace pane.

Primary width is:

- user-resizable
- stored as primary width
- clamped by the workspace primary width rules
- independent of sidecar width

Primary width excludes:

- sidecar pane width
- overview ruler width
- transient overlays
- mobile drawers/sheets

### Sidecar Pane

A sidecar pane is a secondary work surface attached to a workspace pane.

Sidecar panes are not arbitrary child panels. A sidecar pane is created only by a
typed sidecar surface definition.

Sidecar panes own:

- active sidecar surface id
- sidecar width
- collapsed/visible state, if supported by that surface group
- tab selection, when a sidecar group has multiple surfaces

Sidecar panes do not own:

- the primary route href
- primary pane history
- primary pane width
- route-resource identity
- PDF intrinsic primary width

### Fixed Primary Chrome

Fixed primary chrome is non-resizable chrome attached to primary content.

The reader overview ruler is fixed primary chrome. It remains a map instrument,
not a sidecar pane.

Fixed primary chrome contributes to rendered width, but it has no user-owned
width state.

### Translation

When one workspace item changes width, sibling workspace items retain their own
primary and sidecar widths. They may move horizontally because their x-offsets in
the canvas change. They must not be auto-resized to absorb or compensate for the
changed width.

Implementation may use flex layout, explicit x-offset layout, or transforms, but
the product invariant is:

```text
only the resized target width changes
sibling item widths stay byte-for-byte unchanged
```

## Target Behavior

### Desktop Workspace

Desktop renders one horizontal canvas of workspace panes.

Each visible workspace pane renders as one compound item:

```text
+----------------------+----+----------------------+
| primary pane shell   | fx | sidecar pane shell   |
+----------------------+----+----------------------+
```

Where:

- `primary pane shell` is always present.
- `fx` is optional fixed primary chrome, such as the reader overview ruler.
- `sidecar pane shell` is present only when the pane has a visible sidecar.

The compound item width is:

```text
primaryWidthPx + fixedPrimaryChromeWidthPx + sidecarWidthPx
```

When no fixed chrome is visible, `fixedPrimaryChromeWidthPx` is `0`.

When no sidecar is visible, `sidecarWidthPx` is `0`.

### Primary Resize

The primary resize handle sits at the end of the primary pane shell, before fixed
primary chrome and before the sidecar pane.

Dragging or keyboard-resizing the primary handle changes only:

```text
WorkspacePaneState.primaryWidthPx
```

It does not change:

- sidecar width
- fixed primary chrome width
- sibling pane primary widths
- sibling pane sidecar widths
- URL route href
- pane history

If a sidecar is visible, it moves with the right edge of the primary pane but
retains its own width.

### Sidecar Resize

The sidecar resize handle sits at the end of the sidecar pane shell.

Dragging or keyboard-resizing the sidecar handle changes only:

```text
WorkspacePaneState.sidecar.widthPx
```

It does not change:

- primary width
- fixed primary chrome width
- sibling pane primary widths
- sibling pane sidecar widths
- URL route href
- pane history

### Opening A Sidecar

Opening a sidecar creates or updates sidecar state for that workspace pane.

Rules:

- Opening a sidecar does not mutate primary width.
- The default sidecar width is taken from the sidecar width policy.
- If the pane already has sidecar state for the same resource and surface group,
  its user-resized width is preserved.
- If the pane navigates to a different route resource, stale sidecar state is
  discarded.
- If a sidecar surface is unavailable for the current route resource, it cannot
  be restored from URL/session state.

### Closing A Sidecar

Closing a sidecar hides the sidecar pane.

Rules:

- Closing a sidecar does not mutate primary width.
- Closing a sidecar does not delete the route-resource pane.
- Closing a sidecar may keep its width in workspace state if the same pane can
  reopen the same sidecar without leaving the resource.
- Navigating to a different route resource discards incompatible sidecar state.

### Switching Sidecar Surfaces

Sidecar tabs switch the active surface inside the same sidecar pane shell.

Rules:

- Switching tabs does not change sidecar width.
- Switching tabs does not change primary width.
- A sidecar group owns which surfaces are mutually switchable.
- The active sidecar surface id is stored in workspace state.
- Surface bodies may load data independently.

### Mobile

Mobile keeps the existing one-active-pane model.

Mobile ignores:

- desktop primary width
- sidecar width
- fixed primary chrome width
- PDF intrinsic desktop width
- desktop horizontal canvas placement

Sidecar surfaces render as route-local drawers, sheets, or full-screen overlays.

Rules:

- Mobile sidecar rendering reuses the same sidecar surface body where practical.
- Mobile sidecar width state is not applied to layout.
- Mobile may preserve active sidecar surface state for continuity, but it must not
  create a desktop horizontal canvas.
- Mobile primary pane chrome stays local to the active pane.

## Sidecar Surface Inventory

### Reader Tools

Route: `/media/:id`

Surface group: `reader-tools`

Surfaces:

- `reader-highlights`
- `reader-doc-chat`

Rules:

- Reader highlights use `AnchoredHighlightsRail` content and visible-only
  projection.
- Reader doc chat uses reference-backed chat list/detail for `media:{id}`.
- Reader doc chat can open the full `/conversations/:id` pane as an explicit
  escape hatch.
- The reader overview ruler stays fixed primary chrome and opens the
  `reader-highlights` sidecar.
- Reader sidecar state is discarded when the media resource changes.
- PDF intrinsic primary width composes with sidecar width without sidecar
  participating in PDF measurement.

### Conversation Context

Routes:

- `/conversations/:id`
- `/conversations/new`

Surface group: `conversation-context`

Surfaces:

- `conversation-references`

Rules:

- Existing and new conversation panes use the same sidecar host.
- Conversation references render from `useConversationReferences`.
- `reference_added` events update the same state the sidecar renders.
- New-chat panes may show an empty references sidecar before the conversation
  exists.
- After first send, replacing `/conversations/new` with `/conversations/:id`
  preserves compatible sidecar width and active surface.

### Library Tools

Route: `/libraries/:id`

Surface group: `library-tools`

Surfaces:

- `library-chat`
- `library-intelligence`

Rules:

- Library chat must be real or deleted. The cutover target makes it real.
- Library chat uses reference-backed chat list/detail for `library:{id}`.
- Library chat can open the full `/conversations/:id` pane as an explicit
  escape hatch.
- Library intelligence moves from primary subview to sidecar surface.
- The library primary pane remains the contents/list view.
- The library action menu opens the relevant sidecar surface instead of creating
  a full chat pane immediately.
- A full chat pane can still be opened from within the library-chat sidecar.

### Future Surfaces

New sidecar surfaces must be added to the typed sidecar registry.

They must define:

- id
- surface group
- eligible route ids
- resource compatibility rule
- title
- icon
- default width
- minimum width
- maximum width
- mobile rendering mode

They must not define local width state.

## Capability Contract

### Workspace State

The workspace state shape changes in one schema cutover.

Target shape:

```ts
interface WorkspacePaneState {
  id: string;
  href: string;
  primaryWidthPx: number;
  sidecar: WorkspaceSidecarState | null;
  visibility: "visible" | "minimized";
  history: WorkspacePaneHistory;
}

interface WorkspaceSidecarState {
  groupId: WorkspaceSidecarGroupId;
  activeSurfaceId: WorkspaceSidecarSurfaceId;
  widthPx: number;
  visibility: "visible" | "collapsed";
}
```

Rules:

- `widthPx` is renamed to `primaryWidthPx`.
- `primaryWidthPx` stores primary content width only.
- `sidecar.widthPx` stores sidecar shell width only.
- Old `widthPx` payloads are not migrated.
- Old fixed-rail session/url payloads are rejected with the schema version check.
- State sanitization validates sidecar compatibility with the current pane href.
- Invalid sidecar state is dropped; invalid pane state is rejected and replaced
  with a fresh workspace state under the new schema.

### Primary Width Metrics

The existing workspace primary metrics remain:

```ts
interface WorkspacePrimaryMetrics {
  primaryMinWidthPx: number;
  primaryDefaultWidthPx: number;
}
```

Rules:

- This capability owns primary non-PDF defaults and floors only.
- It does not own sidecar width.
- It does not know which sidecar is active.
- It remains measured before workspace state is created or sanitized.

### Sidecar Width Policy

Add one sidecar width owner.

Target file:

```text
apps/web/src/lib/workspace/sidecarSizing.ts
```

Target types:

```ts
interface WorkspaceSidecarWidthPolicy {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

interface WorkspaceSidecarSizing {
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  storedWidthCorrectionPx: number | null;
}
```

Rules:

- Sidecar width policy is finite and positive.
- `defaultWidthPx` is clamped inside min/max.
- Sidecar widths are not derived from sidecar content.
- Sidecar widths are not derived from primary pane width.
- Sidecar widths are not derived from reader typography.
- Sidecar width clamping lives in `sidecarSizing.ts`.
- No component owns a local sidecar clamp helper.

Initial policies:

```text
reader-tools default/min/max = 360 / 280 / 720
conversation-context default/min/max = 320 / 260 / 640
library-tools default/min/max = 420 / 320 / 760
```

The exact values may be tuned during implementation, but the final values must
live in the sidecar width owner and tests must assert behavior, not duplicated
constants.

### Pane Runtime Layout

Replace anonymous `extraWidthPx` with explicit fixed chrome publication.

Target types:

```ts
type PaneRuntimePrimaryWidth =
  | { kind: "workspace" }
  | { kind: "intrinsic"; widthPx: number };

interface PaneRuntimeLayout {
  primaryWidth: PaneRuntimePrimaryWidth;
  fixedPrimaryChromeWidthPx: number;
}
```

Rules:

- `primaryWidth` keeps the current workspace-vs-intrinsic model.
- PDF is still the only shipped intrinsic primary-width publisher.
- `fixedPrimaryChromeWidthPx` is for non-resizable primary-adjacent chrome.
- The reader overview ruler is the first fixed primary chrome publisher.
- Sidecar width is not published through pane runtime layout.
- There is no `extraWidthPx`.
- There is no secondary rail width publication.
- The runtime API is atomic.

Default runtime layout:

```ts
const DEFAULT_PANE_RUNTIME_LAYOUT = {
  primaryWidth: { kind: "workspace" },
  fixedPrimaryChromeWidthPx: 0,
} satisfies PaneRuntimeLayout;
```

### Effective Workspace Item Sizing

`resolveEffectivePaneSizing` remains the only primary/fixed-chrome calculation,
but it no longer owns sidecar width.

Target calculation:

```ts
effectivePrimaryFloorPx =
  runtime.primaryWidth.kind === "intrinsic"
    ? runtime.primaryWidth.widthPx
    : workspacePrimaryMetrics.primaryMinWidthPx;

primaryMinWidthPx = ceil(effectivePrimaryFloorPx);
primaryDefaultWidthPx = primaryMinWidthPx;
primaryMaxWidthPx = max(routeMaxWidthPx, primaryMinWidthPx);

primaryWidthPx = clamp(
  storedPrimaryWidthPx,
  primaryMinWidthPx,
  primaryMaxWidthPx,
);

fixedPrimaryChromeWidthPx = ceil(runtime.fixedPrimaryChromeWidthPx);

renderedPrimarySlotWidthPx =
  primaryWidthPx + fixedPrimaryChromeWidthPx;
```

Sidecar calculation is separate:

```ts
sidecarSizing =
  sidecar
    ? resolveEffectiveSidecarSizing({
        storedWidthPx: sidecar.widthPx,
        policy: sidecarSurface.widthPolicy,
      })
    : null;

renderedWorkspaceItemWidthPx =
  renderedPrimarySlotWidthPx + (sidecarSizing?.widthPx ?? 0);
```

Rules:

- Primary/fixed chrome and sidecar sizing are separate calculations.
- The host composes them into one rendered item descriptor.
- Primary width correction writes only `primaryWidthPx`.
- Sidecar width correction writes only `sidecar.widthPx`.
- Mobile short-circuits both calculations to viewport rendering.

### Sidecar Descriptor API

Pane bodies publish available sidecar surfaces through one React capability,
modeled after `usePaneChromeOverride`.

Target file:

```text
apps/web/src/components/workspace/PaneSidecar.tsx
```

Target types:

```ts
interface PaneSidecarSurface {
  id: WorkspaceSidecarSurfaceId;
  groupId: WorkspaceSidecarGroupId;
  title: string;
  icon: ComponentType<{ size?: number }>;
  body: ReactNode;
  mobileBody?: ReactNode;
}

interface PaneSidecarDescriptor {
  groupId: WorkspaceSidecarGroupId;
  surfaces: PaneSidecarSurface[];
  defaultSurfaceId: WorkspaceSidecarSurfaceId;
}

function usePaneSidecar(descriptor: PaneSidecarDescriptor | null): void;
```

Rules:

- `usePaneSidecar` is the only pane-body-to-shell sidecar content API.
- `PaneShell` owns rendering the sidecar shell.
- Pane bodies do not render sidecar shells locally.
- Pane bodies do not call workspace resize actions directly for sidecars.
- Pane bodies may request that a sidecar surface opens through pane runtime.
- The descriptor is render content, not persisted state.
- Persisted state stores ids and width only.

### Pane Runtime Sidecar Commands

Pane runtime exposes narrow commands for sidecar visibility and active surface.

Target API:

```ts
interface PaneRuntimeContextValue {
  openSidecar: (surfaceId: WorkspaceSidecarSurfaceId) => void;
  closeSidecar: () => void;
  setActiveSidecarSurface: (surfaceId: WorkspaceSidecarSurfaceId) => void;
}
```

Rules:

- Commands operate on the current pane id.
- Commands validate against the current sidecar descriptor.
- Commands do not accept width.
- Width is changed only by the sidecar resize handle.
- Opening a sidecar through runtime does not mutate primary width.

## API Design

### Route Model

`paneRouteModel.ts` remains the route identity and primary width policy owner.

It must not own sidecar width values.

It may expose which sidecar groups are eligible by route id:

```ts
type WorkspaceSidecarGroupId =
  | "reader-tools"
  | "conversation-context"
  | "library-tools";

interface PaneRouteModelDefinition {
  sidecarGroups: WorkspaceSidecarGroupId[];
}
```

Rules:

- `/media/:id` allows `reader-tools`.
- `/conversations/:id` allows `conversation-context`.
- `/conversations/new` allows `conversation-context`.
- `/libraries/:id` allows `library-tools`.
- Other routes start with no sidecar groups.
- Route model does not import React.
- Route model does not render sidecar content.

### Workspace Store

`store.tsx` owns sidecar state transitions.

New actions:

```ts
| { type: "open_sidecar"; paneId: string; surfaceId: WorkspaceSidecarSurfaceId }
| { type: "close_sidecar"; paneId: string }
| { type: "set_active_sidecar_surface"; paneId: string; surfaceId: WorkspaceSidecarSurfaceId }
| { type: "resize_sidecar"; paneId: string; widthPx: number }
```

Rules:

- `resize_pane` becomes `resize_primary_pane`.
- `resize_sidecar` never writes `primaryWidthPx`.
- `resize_primary_pane` never writes `sidecar.widthPx`.
- Pane navigation preserves sidecar only for the same pane resource and compatible
  sidecar group.
- Pane navigation to a different resource drops sidecar state.
- Opening a pane creates no sidecar unless a caller explicitly requests one or
  route-owned default behavior says it should open.
- Default route navigation does not automatically open secondary UI.
- Open-pane plumbing is single-pane, not array-shaped, unless a real call site
  opens multiple panes in one action.

### Workspace URL And Session

Workspace URL/session encoding stores sidecar state inside each pane.

Rules:

- Increment workspace schema version.
- Reject old workspace schemas at the boundary.
- Do not migrate `widthPx` to `primaryWidthPx`.
- Do not infer sidecar width from old `extraWidthPx`.
- Do not preserve fixed rail collapsed/expanded state.
- URL/session decode sanitizes sidecar surface ids against route eligibility.
- Encoding omits sidecar state when no sidecar is open and no compatible dormant
  sidecar state exists.

### Workspace Host

`WorkspaceHost` builds compound workspace item descriptors.

It owns:

- runtime primary/fixed-chrome layout records
- rendered primary slot descriptors
- rendered sidecar slot descriptors
- primary width correction dispatch
- sidecar width correction dispatch
- stale runtime record pruning by `paneId + resourceKey`

It does not own:

- sidecar React bodies
- sidecar data fetching
- sidecar content state
- sidecar tab visuals

### Pane Shell

`PaneShell` renders:

- primary chrome
- primary body
- primary resize handle
- fixed primary chrome slot
- sidecar shell
- sidecar resize handle

Rules:

- The primary resize handle is adjacent to the primary shell, not hidden behind
  the sidecar.
- The sidecar resize handle is adjacent to the sidecar shell.
- Both handles use `role="separator"`.
- Both handles expose `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`.
- Primary handle labels name the primary pane.
- Sidecar handle labels name the sidecar surface.
- Keyboard resizing uses the same step size for primary and sidecar unless a
  specific accessibility reason requires a different step.

### Sidecar Shell

`SidecarPaneShell` replaces `SecondaryRail`.

It owns:

- sidecar header
- sidecar tabs
- sidecar collapse/close control
- sidecar body scrollport
- sidecar resize handle target element
- mobile drawer/sheet handoff where applicable

It does not own:

- sidecar width state
- data fetching
- primary pane runtime
- route navigation

### Resize Handle

The existing `useResizeHandle` pattern should be reused, not duplicated.

Target options:

- generalize `useResizeHandle` to accept a label/source and `onResize`.
- or add `useHorizontalResizeHandle` if the resulting type is clearer.

Rules:

- There is one pointer/keyboard resize implementation.
- It supports primary and sidecar handles.
- It clamps with caller-provided min/max.
- It never reads or writes workspace state directly.

## Composition With Existing Systems

### Reader

Reader primary sizing remains:

- non-PDF uses workspace primary floor
- PDF may publish intrinsic primary width

Reader sidecar behavior changes:

- Highlights and doc chat are sidecar surfaces.
- `MediaPaneBody` publishes sidecar descriptors instead of rendering
  `SecondaryRail`.
- `AnchoredHighlightsRail` remains content/projection logic.
- `AnchoredHighlightsRail` is not merged into the shell.
- The overview ruler remains fixed primary chrome.
- The overview ruler opens the highlights sidecar surface.
- Highlight projection measurement keys include sidecar width, because row
  projection depends on rendered sidecar geometry.

### Conversation References

Conversation references become the `conversation-context` sidecar surface.

Rules:

- `ConversationReferencesRail` becomes sidecar body content or is renamed to
  `ConversationReferencesSidecar`.
- Existing and new conversation panes use the same component/hook.
- `useConversationReferences` remains the pane-level reference state owner.
- `reference_added` upserts into the same state rendered by the sidecar.
- Collapsed fixed rail width is deleted.

### Document Chat

Document chat remains reader-adjacent by default.

Rules:

- `DocChatTab` becomes a sidecar body or is renamed to `ReferenceChatList`.
- `ReaderChatDetail` remains the inline chat detail body.
- The full conversation pane remains available through "open full chat".
- Sending from reader chat creates or updates ordinary conversations with
  `initial_references`.
- No singleton chat API returns.

### Library Chat

Library chat becomes real sidecar behavior.

Rules:

- `LibraryChatTab` is either renamed and mounted as `library-chat`, or deleted if
  replaced by a shared reference-chat component.
- Library actions open the `library-chat` sidecar, not an immediate full chat
  pane.
- The sidecar creates conversations with `initial_references: ["library:<id>"]`.
- Full chat remains an explicit action from inside the sidecar.

### Library Intelligence

Library intelligence moves from primary subview to sidecar surface.

Rules:

- The library primary pane keeps contents as the primary view.
- `?view=intelligence` is removed from the target library pane contract.
- `LibraryIntelligenceView` becomes sidecar body content or is renamed to
  `LibraryIntelligenceSidecar`.
- Library action menu opens the `library-intelligence` sidecar.
- Intelligence refresh/build state stays inside the intelligence content owner.

### Chat Contexts

Chat context UI uses sidecar surfaces, not separate context panes.

Rules:

- Conversation references are the first chat context sidecar.
- Future branch/fork/context inspectors must use `conversation-context`.
- Prompt context state remains conversation-reference state, not sidecar-local
  copied payloads.

### Conversation References Backend

No backend reference model changes are required.

Rules:

- `conversation_references` remains the durable conversation-resource relation.
- `GET /conversations?has_reference=...` remains the reference-backed chat list
  path.
- `POST /conversations` with `initial_references` remains the creation path.
- No singleton chat API returns.
- No message context item API returns.

### Command Palette And Actions

Command palette and resource action menu entries must open sidecar surfaces when
the action is sidecar-native.

Examples:

- "Chat about this document" opens `reader-doc-chat` on the media pane.
- "Chat about this library" opens `library-chat` on the library pane.
- "Intelligence" opens `library-intelligence` on the library pane.
- "Open in full chat" opens `/conversations/:id` as a workspace pane.

Rules:

- Sidecar-native actions do not create full route panes as their first step.
- Full route pane actions remain explicit.
- Shift-click/open-in-new-pane behavior remains for route links, not sidecar
  surface switches.

### Focus Mode

Reader focus mode may hide or dim sidecar chrome, but it must not resize sidecar
state.

Rules:

- Focus mode can close, hide, or visually suppress sidecar rendering only if the
  product behavior explicitly says so.
- Focus mode never mutates `sidecar.widthPx`.
- Focus mode never mutates `primaryWidthPx`.
- Restoring focus mode off returns to the previous sidecar width.

### Global Player

The global player remains outside workspace pane sizing.

Rules:

- Sidecar resizing does not affect player layout.
- Player footer height is not part of sidecar width calculations.

## Extant Patterns To Reuse

Reuse:

- `useWorkspacePrimaryMetrics` for primary floor measurement.
- `paneSizing.ts` as the primary effective sizing owner.
- `WorkspaceHost` descriptor construction and stale runtime record pruning.
- `PaneShell` as the primary shell and chrome owner.
- `useResizeHandle` pointer/keyboard resize mechanics.
- `usePaneChromeOverride` as the model for a pane-body-to-shell React
  descriptor capability.
- `useConversationReferences` for conversation reference state.
- `useChatsByReference` for reference-backed chat lists.
- `ReaderChatDetail` and `ChatSurface` for inline chat detail composition.
- `AnchoredHighlightsRail` for highlight content/projection only.
- `LibraryIntelligenceView` data fetching/rendering, after moving it into a
  sidecar shell.

Do not reuse:

- `SecondaryRail` as a compatibility shell.
- `extraWidthPx` for sidecar width.
- local `referencesRailExpanded` effects in conversation panes.
- unmounted `library-chat` test-only surface.
- `?view=intelligence` as the library intelligence target surface.

## Files To Change

Documentation:

- `docs/workspace-sidecar-pane-cutover.md`
- `docs/workspace-pane-layout-cutover.md`
- `docs/reader-implementation.md`
- `docs/conversation-references-cutover.md`

Workspace state and sizing:

- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/schema.test.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/workspace/store.test.tsx`
- `apps/web/src/lib/workspace/urlCodec.ts`
- `apps/web/src/lib/workspace/urlCodec.test.ts`
- `apps/web/src/lib/workspace/sessionSync.ts`
- `apps/web/src/lib/workspace/useWorkspaceSession.ts`
- `apps/web/src/lib/workspace/paneWidth.ts`
- `apps/web/src/lib/workspace/paneSizing.ts`
- `apps/web/src/lib/workspace/paneSizing.test.ts`

Pane runtime and route model:

- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRuntime.test.tsx`
- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/lib/panes/paneRouteModel.test.ts`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
- `apps/web/src/lib/panes/paneIdentity.ts`
- `apps/web/src/lib/panes/paneIdentity.test.ts`

Workspace shell:

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/components/workspace/useResizeHandle.ts`
- `apps/web/src/components/workspace/WorkspaceHost.module.css`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`

Sidecar components:

- `apps/web/src/components/secondaryRail/SecondaryRail.tsx`
- `apps/web/src/components/secondaryRail/SecondaryRail.module.css`
- `apps/web/src/components/secondaryRail/SecondaryRail.test.tsx`
- `apps/web/src/components/secondaryRail/railSizing.ts`
- `apps/web/src/components/chat/ConversationReferencesRail.tsx`
- `apps/web/src/components/chat/ConversationReferencesRail.module.css`
- `apps/web/src/components/chat/DocChatTab.tsx`
- `apps/web/src/components/chat/DocChatTab.module.css`
- `apps/web/src/components/chat/LibraryChatTab.tsx`
- `apps/web/src/components/chat/LibraryChatTab.module.css`
- `apps/web/src/components/chat/ReaderChatDetail.tsx`
- `apps/web/src/components/chat/ReaderChatDetail.module.css`
- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`

Route bodies:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/__tests__/components/ConversationPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/conversations/page.module.css`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryIntelligenceView.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/page.module.css`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`

Actions:

- `apps/web/src/lib/actions/resourceActions.ts`
- `apps/web/src/lib/actions/resourceActions.test.ts`

E2E:

- `e2e/tests/reader-pane-width.spec.ts`
- `e2e/tests/workspace-canvas.spec.ts`
- `e2e/tests/workspace-tabs.spec.ts`
- `e2e/tests/workspace-history.spec.ts`
- `e2e/tests/workspace-pane-minimize.spec.ts`
- `e2e/tests/quote-attach-references.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/epub.spec.ts`
- add `e2e/tests/workspace-sidecar-panes.spec.ts`

## Files To Add

Add only if they remain real owners after implementation:

- `apps/web/src/lib/workspace/sidecarSizing.ts`
- `apps/web/src/lib/workspace/sidecarSizing.test.ts`
- `apps/web/src/lib/workspace/sidecarState.ts`
- `apps/web/src/lib/workspace/sidecarState.test.ts`
- `apps/web/src/lib/panes/paneSidecarModel.ts`
- `apps/web/src/lib/panes/paneSidecarModel.test.ts`
- `apps/web/src/components/workspace/PaneSidecar.tsx`
- `apps/web/src/components/workspace/PaneSidecar.test.tsx`
- `apps/web/src/components/workspace/SidecarPaneShell.tsx`
- `apps/web/src/components/workspace/SidecarPaneShell.module.css`
- `apps/web/src/components/workspace/SidecarPaneShell.test.tsx`
- `apps/web/src/components/chat/ReferenceChatSidecar.tsx`
- `apps/web/src/components/chat/ReferenceChatSidecar.module.css`

## Files Or Symbols To Delete

Delete after replacement:

- `SecondaryRail`
- `SecondaryRailTab`
- `SecondaryRail.module.css`
- `SecondaryRail.test.tsx`
- `SECONDARY_RAIL_EXPANDED_WIDTH_PX`
- `SECONDARY_RAIL_COLLAPSED_WIDTH_PX`
- `CONVERSATION_REFERENCES_RAIL_WIDTH_PX`
- `extraWidthPx` as sidecar width
- `referencesRailExpanded`
- `isHighlightsRailOpen`
- fixed reader rail width publication
- fixed conversation references rail width publication
- library `?view=intelligence`
- tests that assert fixed secondary rail widths
- docs that state user-resizable secondary rails are a non-goal

Keep or rename:

- `OVERVIEW_RULER_WIDTH_PX`, as fixed primary chrome width.
- `AnchoredHighlightsRail`, as reader highlight sidecar body content.
- `ConversationReferencesRail`, if renamed or scoped as sidecar body content.

## Implementation Plan

### 1. Establish Sidecar Model

Add typed sidecar ids, groups, and width policies.

Implement:

- sidecar surface ids
- sidecar group ids
- sidecar width policies
- sidecar clamp/default helpers
- route eligibility checks

No UI changes should land before this model exists.

### 2. Change Workspace Schema

Increment workspace schema version.

Rename:

```text
WorkspacePaneState.widthPx -> WorkspacePaneState.primaryWidthPx
```

Add:

```text
WorkspacePaneState.sidecar
```

Delete compatibility parsing for old schemas by relying on the existing schema
version rejection path.

Update URL/session tests before wiring UI.

### 3. Split Primary And Sidecar Resize Actions

Replace `resizePane` with explicit actions:

- `resizePrimaryPane`
- `resizeSidecarPane`

Rules:

- Call sites must choose one.
- No generic resize action remains.
- Tests prove the wrong width is not mutated.

### 4. Replace Runtime Extra Width

Replace `PaneRuntimeSizing` with `PaneRuntimeLayout`.

Rules:

- Keep `primaryWidth`.
- Replace `extraWidthPx` with `fixedPrimaryChromeWidthPx`.
- Update media PDF/ruler publication.
- Delete secondary rail width publication.

### 5. Build Sidecar Shell

Add the sidecar descriptor context and shell rendering.

`PaneShell` should render primary and sidecar as siblings inside one compound
workspace item.

The primary body should no longer render `SecondaryRail`.

### 6. Migrate Conversation References

Move conversation references into the sidecar host for both:

- existing conversation panes
- new conversation panes

Delete duplicated sizing effects and fixed collapsed rail width.

### 7. Migrate Reader Tools

Move reader highlights and doc chat into the sidecar host.

Rules:

- The overview ruler remains fixed primary chrome.
- The ruler opens `reader-highlights`.
- Existing doc-chat mobile drawer behavior maps to mobile sidecar rendering.
- `AnchoredHighlightsRail` projection accounts for sidecar width changes.

### 8. Migrate Library Tools

Move library chat and intelligence into the sidecar host.

Rules:

- Library primary pane contents remain primary.
- Library action menu opens sidecar surfaces.
- Delete `?view=intelligence`.
- Make `LibraryChatTab` real through shared reference-chat sidecar, or delete it
  after replacement.

### 9. Consolidate Reference Chat

Extract shared reference-backed chat list/detail behavior if it reduces real
duplication.

Do not create a hollow abstraction.

Good extraction boundary:

- input resource URI
- labels for document/library
- `onOpenFullChat`
- optional pending quote URI

Bad extraction boundary:

- a generic "context pane manager"
- a route-aware chat supercomponent
- a wrapper that only renames props

### 10. Delete Fixed Rail Code

Delete `SecondaryRail`, fixed rail constants, and tests that preserve fixed rail
behavior.

Search targets:

```bash
rg "SecondaryRail|SECONDARY_RAIL|CONVERSATION_REFERENCES_RAIL|extraWidthPx" apps/web/src docs
```

Remaining `extraWidthPx` matches are not allowed unless they refer to historical
text in removed migration notes.

### 11. Update E2E

Add real browser coverage for:

- primary resize with sidecar visible
- sidecar resize with primary visible
- sibling pane translation/no-width-change
- URL/session restore of primary and sidecar widths
- reader sidecar surfaces
- conversation references sidecar
- library chat sidecar
- library intelligence sidecar
- mobile sidecar drawer/sheet behavior

## Acceptance Criteria

### Product Behavior

- Opening highlights creates a reader sidecar pane.
- Opening document chat creates or switches to a reader sidecar pane.
- Opening conversation references creates a conversation sidecar pane.
- Opening library chat creates or switches to a library sidecar pane.
- Opening library intelligence creates or switches to a library sidecar pane.
- Resizing primary while sidecar is visible changes only primary width.
- Resizing sidecar changes only sidecar width.
- Closing sidecar does not change primary width.
- Reopening compatible sidecar restores the previous sidecar width.
- Navigating the primary pane to a different resource drops incompatible sidecar
  state.
- Sibling panes retain their own widths when any other pane or sidecar is
  resized.
- Mobile shows sidecar surfaces as drawer/sheet/full-screen UI, not as a desktop
  sidecar width.

### Architecture

- `WorkspacePaneState` has `primaryWidthPx`, not ambiguous `widthPx`.
- `WorkspacePaneState` has typed sidecar state.
- Sidecar width policy has one owner.
- Primary sizing has one owner.
- Runtime layout has no secondary rail width scalar.
- Pane body sidecar content uses one descriptor API.
- `PaneShell` owns sidecar shell placement.
- Route bodies do not render sidecar shells directly.
- `SecondaryRail` is deleted.
- Fixed secondary rail constants are deleted.
- `LibraryChatTab` is either mounted through the new sidecar contract or deleted
  after replacement.
- Library intelligence is not a `?view=` primary subview.

### Tests

- Unit tests cover sidecar state sanitization.
- Unit tests cover sidecar width clamping.
- Unit tests cover primary/sidecar resize action separation.
- Component tests cover primary and sidecar resize handles.
- Component tests cover sidecar tab switching without width mutation.
- Conversation pane tests cover references sidecar layout publication/state.
- Media pane tests cover overview ruler fixed chrome plus reader sidecar.
- Library pane tests cover chat/intelligence sidecar actions.
- E2E covers resize independence and sibling no-width-change.
- E2E covers URL/session restore of sidecar state.
- Pane-sensitive E2E uses encoded `ws=` state or shared helpers.

### Cleanup

- No source imports from `components/secondaryRail`.
- No fixed secondary rail width constants remain.
- No code path publishes sidecar width through `extraWidthPx`.
- No tests assert fixed `320`, `360`, or `36` rail widths.
- No docs describe user-resizable rails as a non-goal.
- No docs describe library intelligence as a target primary subview.
- No compatibility parser accepts old workspace sidecar/rail state.

## Validation Commands

Targeted frontend tests:

```bash
cd apps/web
bun test src/lib/workspace/sidecarSizing.test.ts
bun test src/lib/workspace/schema.test.ts src/lib/workspace/store.test.tsx
bun test src/lib/panes/paneRuntime.test.tsx src/lib/panes/paneRouteModel.test.ts
bun test src/components/workspace/SidecarPaneShell.test.tsx
bun test src/__tests__/components/PaneShell.test.tsx
bun test src/__tests__/components/ConversationPaneBody.test.tsx
bun test src/app/'(authenticated)'/conversations/new/ConversationNewPaneBody.test.tsx
bun test src/app/'(authenticated)'/media/'[id]'/MediaPaneBody.test.tsx
```

E2E:

```bash
make test-e2e PLAYWRIGHT_ARGS="tests/workspace-sidecar-panes.spec.ts tests/reader-pane-width.spec.ts tests/workspace-canvas.spec.ts"
```

Full routine gate:

```bash
make verify
```

## Key Decisions

### Sidecar Panes Are Not Workspace Panes

Sidecars are pane-attached surfaces, not top-level route-resource panes.

Reason:

- Reader doc chat should stay reader-adjacent by default.
- Conversation references are context for the conversation pane.
- Library intelligence is adjacent to library contents, not a replacement for
  them.
- Full route panes remain available as explicit actions.

### Sidecar Width Is Persisted

Sidecar width is user-owned and persisted because independent resize without
persistence creates a weak and surprising model.

The persistence boundary is workspace URL/session state, under the same schema
cutover as primary pane state.

### Fixed Chrome Is Not Sidecar Width

The reader overview ruler remains fixed primary chrome.

Reason:

- It is a navigation instrument, not a work surface.
- It has no meaningful user width.
- It exists to open and orient the highlights sidecar.

### No Compatibility Schema

Old workspace payloads are rejected and replaced under the new schema.

Reason:

- The old `widthPx` meaning is ambiguous once sidecar width exists.
- Old fixed rail expanded/collapsed state cannot be faithfully mapped to the new
  sidecar model.
- Repository rules prefer hard cutover over compatibility branches.

### Sidecar API Is Descriptor-Based

Pane bodies publish sidecar content descriptors to the shell, following the
existing pane chrome override pattern.

Reason:

- Body components own data and content.
- The shell owns layout, resize, and accessibility.
- This avoids a second route registry for sidecar React content.

## Risks

- Changing workspace schema touches URL/session restore.
- Moving sidecars into `PaneShell` changes layout around large route bodies.
- Reader highlight projection depends on sidecar width and must remeasure.
- PDF intrinsic width plus sidecar width can create very wide workspace items.
- Library intelligence moving out of primary view changes navigation tests and
  user muscle memory.
- Removing `SecondaryRail` will invalidate many fixed-width assertions.

## Risk Controls

- Land schema and sidecar state tests before route migrations.
- Migrate one sidecar group at a time, but do not keep fixed rail compatibility
  code.
- Keep `AnchoredHighlightsRail`, `ReaderChatDetail`, and
  `LibraryIntelligenceView` content components intact while moving shells.
- Use browser/E2E tests for measured width and actual resize behavior.
- Run search audits for deleted concepts before completion.

## Final State

The final system has:

- one flat workspace canvas
- one primary pane width model
- one sidecar pane width model
- one primary runtime layout API
- one sidecar descriptor API
- one resize implementation
- one sidecar shell
- no fixed secondary rail model
- no duplicate conversation reference rail wiring
- no unmounted library-chat surface
- no library intelligence primary subview
- no old workspace schema compatibility

At that point, panes are simple:

```text
workspace pane = route resource + primary width + optional sidecar
primary pane = route body, independently resizable
sidecar pane = typed adjacent surface, independently resizable
sibling panes = repositioned only, never resized by another pane
```
