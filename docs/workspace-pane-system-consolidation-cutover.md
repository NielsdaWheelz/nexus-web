# Workspace Pane System Consolidation Cutover

Status: implementation spec

This document is the hard cutover plan for the workspace pane system. It
consolidates the primary pane layout, secondary sidecar panes, mobile secondary
surfaces, and shell-owned fixed chrome into one coherent architecture.

It supersedes the scattered target statements in these documents where they
overlap:

- `docs/workspace-pane-layout-cutover.md`
- `docs/workspace-sidecar-pane-cutover.md`
- `docs/workspace-url-state-removal-cutover.md`

It keeps their correct core direction: one owner per layout concern, no legacy
compatibility paths, no compatibility shims, no dual old/new behavior, and no
silent fallback layout models.

## Repository Rules Applied

The cutover follows the repo rules rather than adding a special layout system.

- `docs/rules/cleanliness.md`: each concern has one owner, legacy paths are
  deleted, duplicate state is removed, and old tests are rewritten or removed
  rather than preserved as compatibility evidence.
- `docs/rules/module-apis.md`: each capability has one primary API. Sidecar
  capabilities, pane sizing, and fixed chrome are not represented by multiple
  interchangeable APIs.
- `docs/rules/simplicity.md`: the final design favors fewer code paths and no
  speculative flags. Route eligibility, active surface validity, and width
  bounds are deterministic.
- `docs/rules/testing_standards.md`: tests cover the public contract through
  the real host/store/pane APIs. Pane-sensitive E2E setup uses shared helpers
  instead of hand-encoded, stale workspace URL state.

## Problem Statement

The current system has the right broad shape but the ownership boundaries are
still messy.

Primary panes and sidecars are visually composed by `PaneShell`, but sidecar
identity, availability, sizing, UI metadata, route eligibility, and body
rendering are split across:

- `apps/web/src/lib/workspace/sidecarSizing.ts`
- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/components/workspace/PaneSidecar.tsx`
- per-pane bodies such as `MediaPaneBody`, `LibraryPaneBody`,
  `ConversationPaneBody`, and `ConversationNewPaneBody`
- tests with stale expectations for old chat context panes and mobile drawers

Fixed primary chrome is also split. The reader overview ruler contributes width
through `PaneRuntimeLayout.fixedPrimaryChromeWidthPx`, but the chrome node is
still rendered inside the reader body. That means the body is participating in
the shell's layout contract, which is the wrong layer.

Secondary panes are partially independent, but the contract is not complete.
The store already resizes a primary pane and a sidecar independently, and flex
layout translates siblings rather than resizing them. The code does not yet make
that a first-class capability contract with one central model, one publication
API, and direct test coverage for drag and keyboard resizing.

Mobile secondary surfaces are not a pane-system capability. Reader mobile
drawers are hand-rolled inside `MediaPaneBody`, while `PaneSidecarSurface` has a
`mobileBody` field that no host renders. Conversation and library secondary
surfaces do not share a comparable mobile host.

URL workspace state is a separate but connected source of confusion. Layout
state is currently serialized into `wsv` and `ws` URL params, including
`schemaVersion`. The target system has one runtime/session owner for pane
layout and URL state projects only the active pane href.

## Goals

- Make the workspace shell the only owner of pane composition.
- Make pane primary width, fixed chrome width, and sidecar width independent
  dimensions.
- Make drag and keyboard resizing mutate only the target dimension.
- Make every non-target pane translate only. It must not resize because another
  pane or sidecar resized.
- Make sidecar surfaces route-aware, group-aware, and centrally defined.
- Make sidecar availability explicit through one publication API.
- Make sidecar validity strict. Invalid persisted or requested sidecars are
  dropped or refused; they are not silently remapped.
- Render fixed primary chrome from the shell, not from pane bodies.
- Replace reader-only mobile drawers with a shell-owned mobile sidecar host.
- Consolidate duplicated chat/reference list behavior where the model is the
  same.
- Remove stale conversation context code paths or make them real sidecar
  surfaces.
- Remove URL-encoded workspace layout state as part of the same implementation
  train.
- Keep the final state professional, durable, and easy to test.

## Non-Goals

- Do not introduce a general-purpose window manager.
- Do not introduce nested pane splitters.
- Do not support old workspace URL layout params during or after the cutover.
- Do not preserve old sidecar identifiers, component props, or CSS classes for
  backwards compatibility.
- Do not add feature flags for old and new pane systems.
- Do not add a second mobile drawer system.
- Do not make sidecar panes independently draggable, detachable, or reorderable.
- Do not redesign the visual product experience beyond the structural cutover.
- Do not introduce speculative registries for surfaces that do not exist.

## Vocabulary

Primary pane:
The route-owned main content area for one workspace pane.

Fixed primary chrome:
Shell-owned chrome that belongs visually to a primary pane but is not part of
the route body. It contributes fixed width to the pane shell. The reader
overview ruler is the first fixed primary chrome slot.

Sidecar pane:
A secondary shell-owned pane attached to a primary pane. It has its own width,
tabs when multiple surfaces are available, and close/resize controls.

Sidecar group:
A route-level family of compatible sidecar surfaces. The group determines width
policy and route eligibility. Examples: reader tools, conversation context,
library tools.

Sidecar surface:
A concrete secondary capability inside a group. Examples: reader highlights,
reader doc chat, conversation references, library intelligence.

Publication:
The pane body's declaration that a given sidecar surface or fixed chrome body is
currently available for this pane instance.

Eligibility:
The static route-level rule that a route may use a sidecar group or fixed chrome
slot.

Availability:
The instance-level rule that a specific surface body is currently published for
this mounted pane/resource.

## Target Behavior

### Desktop Pane Composition

On desktop, every visible workspace pane is rendered by one `PaneShell`.

The shell composes the pane in this order:

1. primary body slot
2. optional fixed primary chrome slot
3. optional sidecar pane

The rendered shell width is:

```text
primaryWidthPx + fixedChromeWidthPx + visibleSidecarWidthPx
```

The primary body receives exactly `primaryWidthPx`.

The fixed chrome slot receives exactly `fixedChromeWidthPx`.

The sidecar pane receives exactly `visibleSidecarWidthPx`.

No body component manually adds width to the shell. No body component renders a
parallel sidecar column. No body component renders fixed primary chrome outside
the shell slot.

### Primary Resize

Primary resize changes only `WorkspacePaneState.primaryWidthPx` for the target
pane.

It must not change:

- any other pane's `primaryWidthPx`
- any sidecar width
- any fixed chrome width
- any route body internal width state

Other visible panes may shift horizontally because the canvas lays out panes in
a row. Their own measured widths must not change.

### Sidecar Resize

Sidecar resize changes only `WorkspacePaneState.sidecar.widthPx` for the target
pane.

It must not change:

- the target pane's `primaryWidthPx`
- the target pane's fixed chrome width
- any other pane's `primaryWidthPx`
- any other pane's sidecar width

Other visible panes may shift horizontally because the target shell's total
width changed. Their own measured widths must not change.

### Fixed Chrome Width

Fixed chrome width is derived from the published fixed chrome descriptor, not
from a route body's layout math.

For the reader overview ruler:

- `MediaPaneBody` publishes a `reader-overview-ruler` fixed chrome descriptor.
- `PaneShell` renders the overview ruler in the fixed chrome slot.
- `PaneShell` includes the overview ruler width in shell sizing.
- `MediaPaneBody` does not render a split layout column for the overview ruler.
- `PaneRuntimeLayout.fixedPrimaryChromeWidthPx` is removed.

### Sidecar Opening

Opening a sidecar requires both route eligibility and current publication.

A sidecar open request is valid only when:

- the route allows the surface's group
- the mounted pane instance has published that surface
- the surface belongs to the requested group

Invalid open requests do not mutate workspace state. They are defects in the
caller and should be visible to tests and development diagnostics. They must
not be silently mapped to a different surface.

### Sidecar Active Surface

The active surface must always be a published surface in the sidecar's group.

If persisted or session state references a surface that is not valid for the
current route/publication, the host closes or drops the invalid sidecar state.
It does not render the default surface while retaining an invalid
`activeSurfaceId`.

Switching surfaces requires the destination surface to be published. The store
must not accept a group-compatible but unpublished surface as active.

### Sidecar Closing

Closing a sidecar hides the sidecar for that pane. Width may remain in pane
state for reopening the same valid group/surface, but hidden sidecar width must
not contribute to the shell width.

Close behavior is the same from tab close controls, runtime commands, keyboard
controls, and mobile host controls.

### Mobile Secondary Surfaces

Mobile uses the same sidecar publication model as desktop.

There is one shell-owned mobile sidecar host. It renders mobile presentations of
published sidecar surfaces for the active pane. Pane bodies do not own private
mobile drawer systems for sidecar-equivalent capabilities.

The mobile host must support:

- reader highlights
- reader doc chat
- conversation references
- conversation forks when available
- library chat
- library intelligence

The `mobileBody` concept is either rendered by the mobile sidecar host or
deleted. It must not remain as an unused API field.

### URL And Session State

Workspace layout state is not encoded in the URL.

Final URL behavior:

- no `wsv` param
- no `ws` param
- no `schemaVersion` in URL state
- no `urlCodec.ts` layout serializer/deserializer
- the URL projects the active pane href only
- the workspace store/session owns pane list, pane widths, sidecars, history,
  visibility, and active pane identity

Tests that currently use encoded workspace URLs are rewritten to use the shared
workspace/session setup helper or direct UI flows.

## Final Architecture

### Ownership Matrix

| Concern | Owner | Notes |
| --- | --- | --- |
| primary pane width | workspace store | `WorkspacePaneState.primaryWidthPx` |
| primary width bounds | pane sizing model | route/runtime primary sizing only |
| fixed chrome identity | fixed chrome publication API | currently reader overview ruler |
| fixed chrome width | fixed chrome descriptor | shell consumes it |
| fixed chrome rendering | `PaneShell` | body publishes node, shell renders slot |
| sidecar identity/group/metadata | sidecar model | one central source |
| sidecar route eligibility | route model plus sidecar model | one route capability contract |
| sidecar instance availability | sidecar publication API | published by mounted pane body |
| sidecar width bounds | sidecar model | group policy in one place |
| sidecar width state | workspace store | target pane sidecar only |
| sidecar rendering | `PaneShell` and `SidecarPaneShell` | desktop shell-owned |
| mobile sidecar rendering | mobile sidecar host | shell-owned |
| URL active pane projection | workspace URL integration | no layout params |

### Central Sidecar Model

Add a central sidecar model:

```text
apps/web/src/lib/panes/paneSidecarModel.ts
```

This module is the only source of:

- sidecar group ids
- sidecar surface ids
- group membership
- route eligibility metadata or route eligibility helpers
- sidecar display metadata
- sidecar width policy
- sidecar state sanitization helpers

Target exported types:

```ts
export type PaneSidecarGroupId =
  | "reader-tools"
  | "conversation-context"
  | "library-tools";

export type PaneSidecarSurfaceId =
  | "reader-highlights"
  | "reader-doc-chat"
  | "conversation-references"
  | "conversation-forks"
  | "library-chat"
  | "library-intelligence";

export interface PaneSidecarWidthPolicy {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

export interface PaneSidecarSurfaceDefinition {
  id: PaneSidecarSurfaceId;
  groupId: PaneSidecarGroupId;
  title: string;
  icon: SidecarIconId;
  desktop: "tabbed-sidecar";
  mobile: "sheet";
}

export interface PaneSidecarGroupDefinition {
  id: PaneSidecarGroupId;
  title: string;
  width: PaneSidecarWidthPolicy;
  surfaces: readonly PaneSidecarSurfaceId[];
}
```

`sidecarSizing.ts` is deleted or collapsed into this model. There must not be a
second module that redefines the same ids, groups, or width policies.

The current width policies are retained unless product design chooses new
values during implementation:

- reader tools: default 360, min 280, max 720
- conversation context: default 320, min 260, max 640
- library tools: default 420, min 320, max 760

### Route Eligibility

Route eligibility remains part of the pane route model because route identity
already lives there. It consumes sidecar group ids from the central sidecar
model rather than defining sidecar ids itself.

Target route capabilities:

- `/media/:id`: reader tools
- `/conversations/new`: conversation context, references only by publication
- `/conversations/:id`: conversation context, references and forks by
  publication
- `/libraries/:id`: library tools

The route model can answer:

```ts
paneRouteAllowsSidecarGroup(href, groupId): boolean
paneRouteAllowsSidecarSurface(href, surfaceId): boolean
```

The surface helper derives group membership from `paneSidecarModel.ts`. It must
not duplicate the group map.

### Sidecar Publication API

`PaneSidecar.tsx` becomes a publication API only. It no longer owns canonical
surface metadata or width policy.

Target descriptor:

```ts
export interface PaneSidecarSurfacePublication {
  id: PaneSidecarSurfaceId;
  body: React.ReactNode;
  mobileBody?: React.ReactNode;
}

export interface PaneSidecarPublication {
  groupId: PaneSidecarGroupId;
  surfaces: readonly PaneSidecarSurfacePublication[];
  defaultSurfaceId: PaneSidecarSurfaceId;
}
```

Metadata such as title, icon, group membership, and width policy is read from
`paneSidecarModel.ts`.

`usePaneSidecar(publication)` publishes availability to the host. The host
stores publication by pane identity and resource key. `PaneShell` receives the
host-owned publication as a prop. `PaneShell` does not keep a private local
copy that can diverge from the host.

Publication invariants:

- every published surface id exists in the central model
- every published surface belongs to `publication.groupId`
- `defaultSurfaceId` is one of the published surfaces
- the pane route allows the publication group
- the publication is keyed by mounted pane/resource identity

Invalid publications fail fast in tests and development. Production behavior
must fail closed by withholding the invalid publication rather than rendering a
wrong surface.

### Sidecar Shell

`SidecarPaneShell` renders only validated, published surfaces.

It must not contain fallback active-surface logic that renders the default body
while the state still points at a missing surface. The active surface is
resolved by the host before render.

The sidecar shell owns:

- tab strip
- active surface body
- close button
- resize handle
- accessibility labels
- keyboard resizing

It does not own:

- surface identity definitions
- surface group membership
- width policy
- route eligibility
- publication state

### Runtime Sidecar Commands

`PaneRuntime` keeps sidecar commands as the route body's imperative bridge to
the host:

```ts
openSidecar(surfaceId: PaneSidecarSurfaceId): void
closeSidecar(): void
setActiveSidecarSurface(surfaceId: PaneSidecarSurfaceId): void
```

The host validates commands against the central sidecar model, route
eligibility, and current publication before dispatching store actions.

Invalid commands do not mutate store state and must be covered by tests.

### Workspace Store

The store owns durable pane state only.

Sidecar-related actions remain narrow:

- `open_sidecar`
- `close_sidecar`
- `set_active_sidecar_surface`
- `resize_sidecar`

Store rules:

- primary resize only changes `primaryWidthPx`
- sidecar resize only changes `sidecar.widthPx`
- sidecar open initializes or restores width from the group policy
- sidecar open never changes primary width
- sidecar close never changes primary width
- sidecar surface switches never change widths
- invalid sidecar state is removed during sanitize/reduce boundaries

The store does not know React bodies. It may know model ids, group ids, and
width policy.

### Fixed Chrome Publication API

Add a shell-owned fixed chrome publication API:

```text
apps/web/src/components/workspace/PaneFixedChrome.tsx
```

Target descriptor:

```ts
export type PaneFixedChromeSlotId = "reader-overview-ruler";

export interface PaneFixedChromePublication {
  id: PaneFixedChromeSlotId;
  widthPx: number;
  body: React.ReactNode;
}
```

Target hook:

```ts
usePaneFixedChrome(publication: PaneFixedChromePublication | null): void
```

Host behavior:

- stores fixed chrome publication by pane identity and resource key
- passes publication to `PaneShell`
- removes publication when the pane unmounts or resource key changes
- includes `publication.widthPx` in shell width

Shell behavior:

- renders the fixed chrome body in a fixed-width slot between primary body and
  sidecar
- includes the fixed chrome width in desktop pane sizing
- suppresses fixed chrome on mobile unless a later real mobile use case adds a
  mobile fixed chrome slot

Reader behavior:

- `MediaPaneBody` publishes `reader-overview-ruler`
- `MediaPaneBody` no longer renders an overview-ruler column in its local split
  layout
- `PaneRuntimeLayout.fixedPrimaryChromeWidthPx` is removed

There is no compatibility period where the reader both publishes fixed chrome
and renders the old local ruler column.

### Pane Sizing Model

`paneSizing.ts` continues to own primary sizing and shell width calculation.

Target input:

```ts
resolveEffectivePaneSizing({
  requestedPrimaryWidthPx,
  runtimePrimaryWidth,
  fixedChromeWidthPx,
})
```

`fixedChromeWidthPx` comes from the host's fixed chrome publication, not from
the route body's runtime layout publication.

The output should make the distinction explicit:

```ts
interface EffectivePaneSizing {
  primaryWidthPx: number;
  fixedChromeWidthPx: number;
  renderedShellWidthPx: number;
  minPrimaryWidthPx: number;
  maxPrimaryWidthPx: number;
}
```

Avoid ambiguous names such as `renderedPrimarySlotWidthPx` if they include
fixed chrome width.

### Mobile Sidecar Host

Add one mobile host for sidecar surfaces. It consumes the same host-owned
publication as desktop.

Likely location:

```text
apps/web/src/components/workspace/MobileSidecarHost.tsx
```

Responsibilities:

- render the active pane's published sidecar surfaces on mobile
- use central sidecar metadata for title/icon labels
- render `mobileBody` when provided, otherwise render `body` in the mobile
  container
- share open/close/active surface state with the workspace store
- remove reader-specific mobile drawer state from `MediaPaneBody`

It must not be a reader-specific wrapper. Reader, conversation, and library
surfaces all use the same mobile sidecar host.

### Conversation Context Surfaces

The final conversation context group includes:

- `conversation-references`
- `conversation-forks`

`ConversationForksPanel` is currently an orphaned production component with
tests but no mounted route. The cutover must choose one of two strict outcomes:

1. make it a real `conversation-forks` sidecar surface for existing
   conversations, or
2. delete the component and its tests.

This spec chooses option 1.

`/conversations/new` publishes `conversation-references` only.
`/conversations/:id` publishes `conversation-references` and
`conversation-forks` when fork data is available.

The reference sidecar descriptor is shared between new and existing
conversation panes. The duplicate descriptor construction in
`ConversationPaneBody` and `ConversationNewPaneBody` is removed.

### Reference Chat Consolidation

`DocChatTab` and `LibraryChatTab` currently repeat the same reference-backed
chat list pattern:

- fetch chats by `resourceUri`
- render referencing chat rows
- render an empty state
- start a new chat with a reference
- open an existing chat

Extract a shared reference chat list component or hook.

Target shared owner:

```text
apps/web/src/components/chat/ReferenceChatList.tsx
```

It should own the common list behavior and accept only the content differences
that are actually different:

- resource URI
- current chat id
- empty state copy
- new chat label
- reference metadata
- open chat callback
- start chat callback

Reader-specific chat detail behavior in `ReaderChatDetail` remains separate
unless a second caller has the same detail workflow. Do not generalize it
speculatively.

## File Scope

### Docs

Update or reconcile:

- `docs/workspace-pane-layout-cutover.md`
- `docs/workspace-sidecar-pane-cutover.md`
- `docs/workspace-url-state-removal-cutover.md`
- this document

The implementation should not leave contradictory docs that describe a
supported old layout model.

### Core Models

Expected additions:

- `apps/web/src/lib/panes/paneSidecarModel.ts`
- `apps/web/src/components/workspace/PaneFixedChrome.tsx`
- `apps/web/src/components/workspace/MobileSidecarHost.tsx`
- `apps/web/src/components/chat/ReferenceChatList.tsx`

Expected hard removals or collapses:

- `apps/web/src/lib/workspace/sidecarSizing.ts`
- `PaneRuntimeLayout.fixedPrimaryChromeWidthPx`
- unused `PaneSidecarSurface.mobileBody` if no mobile host consumes it
- stale encoded workspace URL layout codec

### Workspace Components

Update:

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/SidecarPaneShell.tsx`
- `apps/web/src/components/workspace/PaneSidecar.tsx`
- `apps/web/src/components/workspace/useResizeHandle.ts`
- `apps/web/src/components/workspace/WorkspaceHost.module.css`
- `apps/web/src/lib/workspace/paneSizing.ts`
- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRouteModel.ts`

### Route Bodies

Update:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`

### Chat And Context Components

Update:

- `apps/web/src/components/chat/DocChatTab.tsx`
- `apps/web/src/components/chat/LibraryChatTab.tsx`
- `apps/web/src/components/chat/ConversationReferencesSidecar.tsx`
- `apps/web/src/components/chat/ConversationForksPanel.tsx`
- `apps/web/src/lib/conversations/useConversationReferences.ts`

### Tests

Update or add:

- `apps/web/src/lib/workspace/store.test.tsx`
- `apps/web/src/lib/workspace/paneSizing.test.ts`
- `apps/web/src/lib/panes/paneSidecarModel.test.ts`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/__tests__/components/SidecarPaneShell.test.tsx`
- `apps/web/src/__tests__/components/MobileSidecarHost.test.tsx`
- `apps/web/src/__tests__/components/ReferenceChatList.test.tsx`
- `e2e/tests/reader-pane-width.spec.ts`
- `e2e/tests/reader-pane-tabs.spec.ts`
- `e2e/tests/workspace-canvas.spec.ts`
- `e2e/tests/workspace-tabs.spec.ts`
- `e2e/tests/workspace-history.spec.ts`
- `e2e/tests/workspace-pane-minimize.spec.ts`
- `e2e/tests/conversations.spec.ts`

## Implementation Sequence

This cutover should be implemented as one coordinated change set, but the work
should be staged internally in this order.

### 1. Centralize Sidecar Identity And Policy

- Add `paneSidecarModel.ts`.
- Move sidecar ids, group ids, group membership, metadata, and width policy into
  it.
- Add model tests for group membership, policy lookup, and invalid ids.
- Update route model to import sidecar group/surface types from the central
  model.
- Delete or collapse `sidecarSizing.ts`.

Done when no sidecar id, group membership map, or sidecar width policy is
defined outside the central model.

### 2. Make Publication Host-Owned

- Change `PaneSidecar.tsx` to publish availability only.
- Store sidecar publications in `WorkspaceHost` by pane/resource identity.
- Pass validated publication to `PaneShell`.
- Remove `PaneShell` local descriptor state.
- Make invalid active sidecar state close/drop instead of fallback-rendering a
  default body.
- Validate runtime sidecar commands against publication before dispatch.

Done when `SidecarPaneShell` only receives validated active surface data.

### 3. Implement Shell-Owned Fixed Chrome

- Add `PaneFixedChrome.tsx`.
- Add host storage for fixed chrome publication.
- Update pane sizing to accept host-owned `fixedChromeWidthPx`.
- Render fixed chrome slot in `PaneShell`.
- Move the reader overview ruler from `MediaPaneBody` into the fixed chrome
  publication.
- Remove `PaneRuntimeLayout.fixedPrimaryChromeWidthPx`.

Done when the overview ruler is rendered exactly once by `PaneShell` and the
reader body has no fixed-width side column.

### 4. Consolidate Mobile Secondary Surfaces

- Add `MobileSidecarHost`.
- Wire it to active-pane publication and workspace sidecar state.
- Replace reader-specific mobile highlights/doc-chat drawer state.
- Render conversation and library mobile sidecar surfaces through the same host.
- Remove unused `mobileBody` if the mobile host does not need separate bodies.

Done when no route body owns a private mobile drawer for a sidecar-equivalent
surface.

### 5. Consolidate Conversation Context

- Add `conversation-forks` to the central sidecar model.
- Mount `ConversationForksPanel` as a real sidecar surface for existing
  conversations or delete it if product scope changes before implementation.
- Share conversation references publication between new and existing
  conversation pane bodies.
- Update stale E2E expectations around old context pane test ids and mobile
  drawer names.

Done when conversation context is represented only by the sidecar system.

### 6. Consolidate Reference Chat Lists

- Add `ReferenceChatList`.
- Rewrite `DocChatTab` and `LibraryChatTab` to use it.
- Keep reader chat detail separate unless another route needs the same detail
  flow.

Done when common reference-chat list behavior has one implementation.

### 7. Remove URL Layout State

- Remove URL layout serialization/deserialization.
- Remove `WORKSPACE_SCHEMA_VERSION` and `schemaVersion` from URL workspace
  state.
- Rewrite E2E fixtures to use shared session setup or real UI flows.
- Ensure active pane href remains reflected in the URL.

Done when no source or test expects `wsv` or `ws` layout params.

### 8. Test The Capability Contract

- Add unit tests for central model validation.
- Add store tests for strict primary/sidecar/fixed-chrome independence.
- Add shell tests for fixed chrome composition.
- Add sidecar shell tests for no fallback active surface rendering.
- Add mobile sidecar host tests.
- Add E2E coverage for sidecar drag and keyboard resize:
  - primary width remains unchanged
  - sidecar width changes
  - sibling pane widths remain unchanged
  - sibling pane x positions may change
- Add E2E coverage for primary drag:
  - primary width changes
  - sidecar width remains unchanged
  - sibling pane widths remain unchanged

## Capability Contract

The pane system exposes these capabilities and no equivalents.

### Workspace State Contract

`WorkspacePaneState` is the durable pane state.

It owns:

- `id`
- `href`
- `primaryWidthPx`
- `sidecar`
- `visibility`
- `history`

It does not own React publication data or fixed chrome bodies.

Sidecar state owns:

- `groupId`
- `activeSurfaceId`
- `visibility`
- `widthPx`

It does not own title, icon, body, mobile body, or width policy.

### Pane Runtime Contract

Route bodies use `PaneRuntime` for host commands and layout observations.

It exposes:

- sidecar open/close/switch commands
- primary layout publication for intrinsic route width only
- current sidecar state for UI affordance state
- pane id/resource key when needed for stable hooks

It does not expose fixed chrome width publication.

Fixed chrome uses `usePaneFixedChrome`.

Sidecar availability uses `usePaneSidecar`.

### Shell Contract

`PaneShell` receives already validated data:

- pane state
- effective primary sizing
- fixed chrome publication
- sidecar publication
- active sidecar surface
- resize callbacks

It owns composition and accessibility. It does not infer product-specific
surface availability from route bodies.

### Store Contract

The store accepts narrow actions and enforces state-level invariants.

The host enforces render-level invariants that require publication data.

This separation is intentional:

- the store can validate ids, groups, route eligibility, and width policy
- the host can validate current publication and mounted resource identity
- React bodies remain outside durable store state

## Key Decisions

### Sidecars Are Attached But Independent

Sidecars are attached to a primary pane for positioning and lifecycle. They are
independent for width. Resizing a sidecar changes only sidecar width. Resizing a
primary changes only primary width.

### Fixed Chrome Is Not A Sidecar

The reader overview ruler belongs to the primary pane. It scrolls and composes
with the primary reader experience differently from a secondary tool pane. It
therefore uses a fixed chrome slot, not a sidecar surface.

### Publication Is The Runtime Availability Boundary

Route eligibility says a route can support a group. Publication says this
mounted resource currently has concrete surfaces. Both are required.

### No Default-Surface Fallback Rendering

Fallback rendering hides invalid state and creates confusing UI. The target
state is strict: invalid active surfaces are removed before render.

### Conversation Forks Become A Real Surface

The repo already contains a `ConversationForksPanel` and tests that imply a
conversation context UI. The professional cutover is to mount it as a real
sidecar surface or delete it. This spec mounts it.

### URL Layout State Is Removed

Pane layout is session/runtime state. URL layout encoding creates migration
burden and brittle tests. The final system removes it instead of adding another
schema version.

## Acceptance Criteria

### Structural Acceptance

- There is one central sidecar model.
- There is one sidecar publication API.
- There is one fixed chrome publication API.
- There is one mobile sidecar host.
- Sidecar metadata and width policy are not duplicated in route bodies.
- Pane bodies do not render sidecar columns.
- Pane bodies do not render fixed primary chrome columns.
- `PaneShell` does not own local sidecar descriptor state.
- `SidecarPaneShell` does not fallback-render a different surface than the
  active state.
- `PaneRuntimeLayout.fixedPrimaryChromeWidthPx` is gone.
- Encoded workspace URL layout state is gone.

### Behavioral Acceptance

- Opening reader highlights increases the target shell width by the sidecar
  width and does not change primary width.
- Opening reader doc chat reuses the reader tools sidecar group and does not
  change primary width.
- Switching reader sidecar tabs does not change widths.
- Opening conversation references uses the same sidecar system as reader and
  library surfaces.
- Opening conversation forks uses the conversation context sidecar group.
- Opening library chat and library intelligence uses the same library tools
  sidecar group.
- Closing any sidecar removes its rendered width contribution.
- Primary resize mutates only target primary width.
- Sidecar resize mutates only target sidecar width.
- Sibling panes are translated by flex/canvas layout but not resized.
- Mobile sidecar surfaces use the shared mobile host.
- Invalid sidecar state is dropped or refused before render.
- Active pane href remains reflected in the URL without layout params.

### Testing Acceptance

- Unit tests cover sidecar model lookup, group membership, width policy, and
  invalid ids.
- Store tests cover independent primary and sidecar mutations.
- Shell tests cover primary + fixed chrome + sidecar composition.
- Shell tests cover invalid active sidecar state not rendering fallback content.
- Mobile sidecar host tests cover reader, conversation, and library groups.
- E2E tests cover primary drag independence.
- E2E tests cover sidecar drag independence.
- E2E tests cover keyboard resizing for primary and sidecar handles.
- E2E tests no longer rely on `wsv` or `ws` URL layout state.

## Completion Definition

The cutover is complete when the old pane/sidecar/fixed-chrome/URL-layout code
paths are deleted, tests assert the new capability contract, and no source file
contains compatibility branches for the previous layout model.

Searches that should return no implementation hits except docs or tests that
intentionally assert removal:

```text
fixedPrimaryChromeWidthPx
WORKSPACE_SCHEMA_VERSION
wsv
ws=
sidecarSizing
conversation-context-pane
isMobileDocChatDrawerOpen
isMobileHighlightsDrawerOpen
```

Searches that should point to the new owners:

```text
paneSidecarModel
usePaneSidecar
usePaneFixedChrome
MobileSidecarHost
ReferenceChatList
conversation-forks
reader-overview-ruler
```
