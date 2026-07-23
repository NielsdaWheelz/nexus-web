# Pane Header Identity And Reader Action Hard Cutover

Status: IMPLEMENTED - 2026-07-21
Type: hard cutover
Date: 2026-07-20

> **Superseded (2026-07-23):** Document Map as the generic disclosure action was
> replaced by the universal Companion action in
> [`resource-inspector-and-universal-dossiers-hard-cutover.md`](resource-inspector-and-universal-dossiers-hard-cutover.md).
> The retained header-identity rules remain background, not current opener guidance.

## Decision

Ship one atomic cutover to:

- a typed header model;
- three distinct projections: pane label, section header, resource header;
- one semantic Document Map action with desktop and mobile projections;
- one persistent resource identity presentation;
- author administration and complete-credit inspection in Options.

Open questions: none. The contracts below are binding. No legacy API,
compatibility fallback, alias, feature flag, or dual render survives.

Governing standards: `docs/rules/simplicity.md`, `cleanliness.md`,
`frontend.md`, `tagged-unions.md`, `control-flow.md`, `boundaries.md`,
`codebase.md`, and `testing.md`.

## Goals

- Make media chrome say what the pane contains, never `Libraries`.
- Make title and credits the dominant, left-aligned resource identity.
- Separate navigation labels, section furniture, and resource identity.
- Give each capability one owner and one responsive action descriptor.
- Keep every pane named, every focus handoff deterministic, and every failure
  pane-local.
- Delete more ambiguity than the cutover adds.

## Scope

In scope:

- typed route/header, primary-chrome, action-state, and focus-return contracts;
- the end-to-end pane-title-to-pane-label rename;
- desktop/mobile header geometry;
- media identity, credits, author Options, and Document Map entry points;
- all directly affected producers, tests, styles, and docs.

Non-goals:

- no resource-header adoption for library, author, conversation, podcast,
  page, note, Atlas, Oracle, or settings panes;
- no contributor schema, mutation, enrichment, or deduplication redesign;
- no reader map content, marker, evidence, restore, or shortcut redesign;
- no workspace persistence, pane sizing, backend, database, or capability
  registry change;
- no global mobile-navigation density redesign; 390px remains the tested
  mobile visual contract for this cutover.

## Target Behavior

| Surface | Identity | Document Map | Reader row |
|---|---|---|---|
| Desktop media | title; compact credits below | one header icon | PDF/EPUB format navigation only |
| Mobile media | same model; each line ellipsizes independently | one Options item | PDF/EPUB format navigation only |
| Readable article | resource header | as above | none |
| Transcript-backed `podcast_episode` / `video` | resource header | Evidence-backed, when readable | none |
| Playback-only `podcast_episode` / `video` | resource header | absent | none |
| Section route | standing head plus typed folio | unchanged | unchanged |

The bordered media byline and the rail/list generic opener are deleted.
`Add/Edit authors…` and `Credits…` are Options commands, not persistent rows.

## Geometry And Visual Contract

Geometry has one CSS owner:

```css
--pane-section-header-height: 44px;
--pane-resource-header-height: 60px;
--appnav-bar-height: var(--pane-resource-header-height);
```

- Desktop section header: exactly 44px.
- Desktop resource header: exactly 60px.
- Mobile top bar: exactly 60px for every route; safe area is additional.
- Resource title and credit summary each reserve one line box, including an
  empty credit state, so loading/data transitions do not move chrome.
- Controls remain 32px desktop and 44px touch targets.
- At the repository's 390px mobile viewport, identity and controls do not
  overlap. Narrower widths may truncate harder but may not create horizontal
  overflow.

Typography:

| Line | Tokens |
|---|---|
| Title | `--text-base`, `--leading-tight`, `--weight-semibold`, `--ink` |
| Credits | `--text-xs`, `--leading-tight`, `--weight-regular`, `--ink-muted` |
| Gap | 2px |

`SurfaceHeader` and `NavTopBar` receive `data-header-kind`. CSS never infers
header kind from viewport or `bodyMode`.

All content-offset formulas continue to consume `--appnav-bar-height`:
`PaneShell.module.css`, `PdfReader.module.css`, and media `page.module.css`.
`TOP_REVEAL_ZONE_PX` becomes `TOP_ALWAYS_VISIBLE_SCROLL_PX = 60`, an explicitly
independent scroll-policy threshold; it no longer claims to mirror CSS
geometry and may diverge from it deliberately.

## Architecture

```text
PaneRouteModel.header + accepted current-route publication
  -> resolvePaneHeaderModel
  -> PaneHeaderModel
      -> desktop SurfaceHeader / PaneHeaderIdentity
      -> mobile NavTopBar / PaneHeaderIdentity

media DTO -> pane label publication -----------------> workspace navigation
media DTO -> structured resource header publication -> PaneShell
reader state -> documentMapAction -------------------> ActionBar | ActionMenu
```

`PaneShell` owns composition and responsive placement. Renderers never
reconstruct identity or capability state.

## Three Projections

1. **Pane label**: short text for the pane strip, resize announcement,
   launcher, and open-in-pane hints.
2. **Section header**: destination standing head plus typed folio.
3. **Resource header**: route-owned title plus structured credits.

They may derive from the same DTO; they are not interchangeable fields.
Contributor edits never rename a media pane.

### Pane-label hard rename

```text
staticTitle                     -> defaultLabel
titleMode                       -> labelMode
titleHint                       -> labelHint
paneTitleHint                   -> paneLabelHint
data-pane-title-hint            -> data-pane-label-hint
runtimeTitleByPaneId            -> runtimeLabelByPaneId
pendingTitleHintByRouteKeyRef   -> pendingLabelHintByRouteKeyRef
MAX_PANE_TITLE_LENGTH           -> MAX_PANE_LABEL_LENGTH
WorkspacePaneTitle*             -> WorkspacePaneLabel*
WorkspaceHostPane.title         -> WorkspaceHostPane.label
WorkspacePaneStripItem.title    -> WorkspacePaneStripItem.label
resolveWorkspacePaneTitle       -> resolveWorkspacePaneLabel
normalizePaneTitle              -> normalizePaneLabel
upsertPaneTitleRecord           -> upsertPaneLabelRecord
publishPaneTitle                -> publishPaneLabel
publishPaneTitleHint            -> publishPaneLabelHint
onSetPaneTitle                  -> onSetPaneLabel
setPaneTitle                    -> setPaneLabel
useSetPaneTitle                 -> useSetPaneLabel
titleState / titleSource        -> labelState / labelSource
titleTelemetryByPaneIdRef       -> labelTelemetryByPaneIdRef
```

Domain fields such as `media.title`, launcher result titles, and HTML `title`
attributes do not change.

## Route Header Contract

Every supported route declares exactly one header kind:

```ts
export type PaneRouteHeaderContract =
  | {
      readonly kind: "section";
      readonly destinationId: DestinationId;
      readonly defaultFolio: "none" | "pane-label";
    }
  | {
      readonly kind: "resource";
      readonly pendingLabel: string;
    };
```

Rules:

- omission is a type error;
- `bodyMode` owns layout only;
- only `media` is `resource` in this cutover;
- every other current route is explicitly `section`;
- a section header accepts only a section header publication;
- a resource route's **header field** accepts only a resource header
  publication; its toolbar, actions, and options remain orthogonal.
- resolved model/table types are discriminated supported/unsupported unions:
  every supported member has a non-null header and definition; only
  `id: "unsupported"` has nulls. `WorkspaceHost` branches on that discriminant
  and has no nullable-header fallback for a supported route.

`PaneChromeDescriptor`, every `getChrome`, and route-level toolbar/action
React nodes are deleted. Route icons remain in `paneRouteTable.ts`.

## Typed Header Model

Owner: `apps/web/src/lib/panes/paneHeaderModel.ts`.

```ts
export interface PaneHeaderCredit {
  readonly label: string;
  readonly href?: string;
}

export type PaneHeaderCreditGroup =
  | { readonly kind: "authors"; readonly credits: readonly PaneHeaderCredit[] }
  | {
      readonly kind: "role";
      readonly label: string;
      readonly credits: readonly PaneHeaderCredit[];
    };

export type PaneResourceHeaderPublication =
  | {
      readonly status: "ready";
      readonly title: string;
      readonly creditGroups: readonly PaneHeaderCreditGroup[];
    }
  | { readonly status: "unavailable"; readonly title: string }
  | { readonly status: "failed"; readonly title: string };

export type PaneHeaderPublication =
  | {
      readonly kind: "section";
      readonly folio: Folio;
      readonly pending: boolean;
    }
  | {
      readonly kind: "resource";
      readonly resource: PaneResourceHeaderPublication;
    };

export type PaneResourceHeaderState =
  | { readonly status: "pending"; readonly accessibleLabel: string }
  | PaneResourceHeaderPublication;

export type PaneHeaderModel =
  | {
      readonly kind: "section";
      readonly standingHead: string;
      readonly folio: Folio;
      readonly pending: boolean;
    }
  | {
      readonly kind: "resource";
      readonly resource: PaneResourceHeaderState;
    };
```

Absence is typed behavior, not fallback behavior:

- absent section publication -> declared default folio;
- absent resource publication -> `pending` with the route's non-empty
  `pendingLabel` (`Loading media…` for media).

Media publication mapping is exact:

| Input | Header state |
|---|---|
| initial request in flight/retrying | absent -> `pending` |
| media DTO returned, including still-processing media | `ready` |
| initial media-detail request returns 404 and no DTO exists | `unavailable`, `Media unavailable` |
| other terminal initial-load error and no DTO exists | `failed`, `Media failed to load` |
| EPUB/transcript subsection error after media loaded | keep `ready` identity |

A later canonical identity refetch may move `ready` to `unavailable` only on
confirmed 404 / `E_MEDIA_NOT_FOUND`. `E_MEDIA_NOT_READY` and subsection 404s
never do.

Ready titles, state titles, pending labels, and credit labels are non-empty.
`creditGroups` may be empty; every present group is non-empty, and there is at
most one authors group. Names preserve literal credit, source order, canonical
role order, `href`, and `dir="auto"`.

### Route-key ordering and fault containment

Resolution order is mandatory:

1. Compare the publication record's `routeKey` to the pane's current key.
2. Ignore a stale publication or cleanup without normalization or kind checks.
3. Resolve absence to the route contract's typed default/pending state.
4. Normalize and validate only an accepted current-route publication.
5. Throw on an accepted kind/invariant defect.

Move the existing `PaneRouteErrorBoundary` to wrap each complete
`PaneRuntimeFrame`/`PaneShell`, reset by `paneId + routeKey`. A residual chrome
or body throw replaces only that pane; sibling panes and workspace chrome
survive. This is a defect surface, not a compatibility header.

## Primary Chrome Publication

Extend `panePublications.ts`; `PanePrimaryChrome.tsx` owns transport only:

```ts
export interface PanePrimaryChromePublication {
  readonly header?: PaneHeaderPublication;
  readonly toolbar?: ReactNode;
  readonly actions?: readonly PaneHeaderAction[];
  readonly options?: readonly ActionDescriptor[];
}
```

- `header` is identity only.
- `actions` are responsive primary commands.
- `options` are overflow-only commands.
- `toolbar` is the sole bounded `ReactNode` exception, for PDF/EPUB format
  navigation. Equality is `===`; producers must memoize it. No deep or value
  comparison is attempted.
- Header fields compare structurally. Descriptor scalar/state fields compare
  by value; elements, handlers, and render callbacks compare by identity.
- The transport record includes `routeKey`; stale cleanup cannot clear a newer
  record.

Delete `PaneChromeOverrides`, its context/equality code, and
`usePaneChromeOverride`. No bridge export remains.

## Action Model And Projections

Owner: `apps/web/src/lib/ui/actionDescriptor.ts`.

```ts
export type ActionControlState =
  | { readonly kind: "toggle"; readonly pressed: boolean }
  | {
      readonly kind: "disclosure";
      readonly expanded: false;
      readonly controls?: never;
      readonly menuLabels: {
        readonly collapsed: string;
        readonly expanded: string;
      };
    }
  | {
      readonly kind: "disclosure";
      readonly expanded: true;
      readonly controls: string;
      readonly menuLabels: {
        readonly collapsed: string;
        readonly expanded: string;
      };
    };

export interface ActionDescriptor {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactElement;
  readonly state?: ActionControlState;
  // existing render/onSelect/href/disabled/tone/focus/separator fields
}

type RequireIcon<Descriptor extends ActionDescriptor> =
  Descriptor extends ActionDescriptor
    ? Omit<Descriptor, "icon"> & { readonly icon: ReactElement }
    : never;

export type PaneHeaderAction = RequireIcon<ActionDescriptor>;

export interface ActionSelectDetail {
  readonly triggerEl: HTMLButtonElement | null;
}
```

`state + href` and `state + render` are invalid. `ActionMenuOption` and flat
`pressed` die.

The excerpt shows shared fields; the exported descriptor is a tagged
command/link/custom union, with `never` fields making those invalid
combinations unrepresentable.

| State | `ActionBar` | `ActionMenu` |
|---|---|---|
| command | named icon button | `menuitem` with descriptor label |
| toggle | `aria-pressed` | `menuitemcheckbox` + `aria-checked` |
| disclosure | `aria-expanded`; `aria-controls` only when expanded | ordinary `menuitem`; dynamic collapsed/expanded label; no disclosure/submenu ARIA |

This is the mobile stateful-Options subsystem. A Document Map menu item says
`Show Document Map` or `Hide Document Map`; it never pretends to own a submenu.
Lifted actions precede ordinary options and are separated once. While the
mobile secondary is modal, its header projects the same Options descriptors and
the menu derives that modal context and portals inside the dialog subtree, so the expanded `Hide` action remains
reachable without exposing background chrome. A nested Credits/Authors modal
becomes the sole `aria-modal` layer: the Map sheet is inert with a suspended
scrim, and Escape/Back close menu, nested modal, then Map one layer at a time.
Focus returns to the exact inner Options trigger before the outer sheet returns
to its top-bar trigger. Reader shortcuts operate when Map itself is topmost but
cannot mutate it through a nested modal or transient menu.

## One Document Map Capability

```ts
export function documentMapAction(input: {
  readonly expanded: boolean;
  readonly regionId: string;
  readonly onToggle: (detail: ActionSelectDetail) => void;
}): PaneHeaderAction;
```

The factory owns icon, base label, Show/Hide labels, disclosure state, and
handler. It includes `controls: regionId` only while expanded and suppresses
ActionMenu's own close-time refocus.

Availability is exact:

- the media reader capability is `Readable`; and
- the current publication includes a `reader-tools` secondary surface.

The media producer derives that secondary publication and the action from the
same capability value; they cannot drift independently.

Thus PDF, EPUB, readable web articles, and transcript-backed
`podcast_episode`/`video` can expose the action. There is no generic `audio`
kind. Unknown future kinds, playback-only media, processing without readable
content, and failed/unreadable media cannot.

Behavior:

- expanded means the reader-tools secondary is visible, independent of active
  Contents/Evidence tab;
- closed activation opens Contents when published, otherwise Evidence;
- PDF/EPUB/web prefer Contents then Evidence; `podcast_episode`/`video` open
  Evidence;
- open activation closes the secondary;
- `G` invokes the same `toggleDocumentMap` command;
- marker activation remains contextual and may open/focus its target;
- no generic opener remains in toolbar, transcript branch, or overview rail.

On mobile collapsed activation, the ephemeral secondary-open request carries
`detail.triggerEl` outside persisted workspace state. Options closes without
refocus; `MobileSecondaryPaneHost` passes that trigger as `returnFocusTo`,
focuses the selected tab, and returns there when the sheet closes. If the
trigger disconnects, focus falls back to that pane's chrome.

### Controlled-region ID

`paneSecondaryRegionId(primaryPaneId, groupId)` is group-level and per-pane:

- desktop: the visible `SecondaryPaneShell` `<aside>` carries the ID;
- mobile: the active `MobileSheet` `<section>` carries it through `panelId`;
- collapsed: presenter DOM is unmounted, desktop reports
  `aria-expanded="false"` and omits `aria-controls`; mobile has no IDREF;
- existing `useId()` tab/tabpanel IDs remain scoped beneath that container.

Two panes showing the same media therefore have distinct region and heading
IDs. Counts are asserted within each pane/chrome projection, never globally.

## Credits And Author Administration

Compact example:

```text
Ursula K. Le Guin, Brian Attebery · Editors: Susan Wood, Ann J. Lane · Translator: Margaret Chodos-Irvine
```

Formatting rules:

- names within a group: `, `;
- groups: ` · `;
- authors: visually unprefixed, with sr-only `Authors: `;
- other roles: canonical singular/plural label plus `: `;
- summary is non-focusable text, so ellipsis never hides a focusable link.

The compact line ellipsizes. Every ready resource includes `Credits…`, including
zero-credit resources; its read-only Dialog/MobileSheet shows the full wrapping
title, groups (possibly empty), and links. This avoids truncation measurement
and preserves a visual inspection path. Reuse the single typed contributor-role
registry and grouping owner; do not create a second vocabulary or formatter.

`Add author…` / `Edit authors…` appears separately only when
`can_edit_authors` and the editor command exist. Manual/reset state stays in
`MediaAuthorsEditor`. Save mutates once; label and header rederive from the
returned DTO.

### Explicit focus-return capability

```ts
export type ReturnFocusTarget = () => HTMLElement | null;

export interface ReturnFocusOptions {
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly skip?: () => boolean;
}

useReturnFocus(active: boolean, options?: ReturnFocusOptions): void;
```

- On inactive -> active, capture `returnFocusTo?.()` first.
- Otherwise capture connected `document.activeElement`, excluding `body`.
- On close, focus the captured target if still connected; otherwise resolve
  the fallback. `skip` wins.
- `Dialog`, `MobileSheet`, and `useDialogOverlay` expose/pass both targets.
- Media stores the `ActionMenu.onSelect` `triggerEl`, suppresses menu refocus,
  and passes it to the editor/details overlay as `returnFocusTo`.
- Authors, Credits, and mobile Document Map also pass pane-local chrome as the
  mandatory `returnFocusFallback`.
- Feature code performs no manual `.focus()` repair.

## Accessible Identity

- Every `PaneShell` section, section or resource, has a non-empty accessible
  name derived from the same model from first paint.
- `PaneShell` owns a local sr-only name node and `aria-labelledby` ID so naming
  survives desktop/mobile relocation; visual identity is not the only IDREF
  target.
- Pane-local label and heading IDs come from `useId()`, never resource IDs.
- `ResourceHead` owns the route `<h1>`.
- Pending resource markup is `aria-busy="true"`, with an aria-hidden skeleton
  and sr-only `Loading media…` inside the heading.
- Ready/unavailable/failed states remove `aria-busy`.
- The compact authors group includes sr-only `Authors: ` without replacing
  descendant semantics in the complete-credit surface.
- Imported document content does not own the route heading.

Desktop exact counts are scoped with `within([data-pane-id])`. Mobile counts
are scoped to the active `[data-pane-chrome-for]`. Multiple open copies of the
same resource legitimately yield one heading and one Map control per
projection.

## Ownership

| Concern | Final owner |
|---|---|
| Route header kind/default | `paneRouteModel.ts` |
| Destination standing head | `destinations.ts`, resolved by `paneHeaderModel.ts` |
| Header types/resolution | `paneHeaderModel.ts` |
| Publication normalization/equality | `panePublications.ts` |
| Publication lifecycle | `usePanePublication.ts`, bound by the three semantic hooks |
| Primary React transport | `PanePrimaryChrome.tsx` |
| Responsive placement | `PaneShell.tsx` |
| Identity DOM | `PaneHeaderIdentity`, `RunningHead`, `ResourceHead` |
| Action schema | `actionDescriptor.ts` |
| Map descriptor | `documentMapAction.tsx` |
| Secondary state/region ID | existing workspace secondary owner |
| Credit vocabulary/formatting | `contributors/vocab.ts`, then `formatting.ts` |
| Author mutation | `MediaAuthorsEditor` + existing API |
| Focus capture/return | `useReturnFocus` via overlay primitives |

`ResourceRef`/`ResourceItem` remains durable resource identity. Header content
is a display projection and never parses `ResourceItem.label`.

## File Plan

### Create

- `apps/web/src/lib/panes/paneHeaderModel.ts`
- `apps/web/src/lib/panes/paneHeaderModel.test.ts`
- `apps/web/src/lib/ui/actionDescriptor.ts`
- `apps/web/src/components/workspace/PanePrimaryChrome.tsx`
- `apps/web/src/components/workspace/usePanePublication.ts`
- `apps/web/src/lib/workspace/paneDom.ts`
- `apps/web/src/components/ui/ResourceHead.tsx`
- `apps/web/src/components/ui/ResourceHead.module.css`
- `apps/web/src/components/ui/ResourceHead.test.tsx`
- `apps/web/src/components/ui/PaneHeaderIdentity.tsx`
- `apps/web/src/components/contributors/ResourceCreditsOverlay.tsx` and test
- `apps/web/src/components/reader/document-map/documentMapAction.tsx`

### Rename

- `apps/web/src/lib/panes/paneRouteTable.test.tsx` ->
  `paneRouteTable.test.ts` (pure logic; unit project includes `.test.ts` only).
- Apply the symbol table above without compatibility exports.

### Shared chrome, geometry, containment

- `apps/web/src/app/globals.css`
- `apps/web/src/components/ui/SurfaceHeader.tsx` and `.module.css`
- `apps/web/src/components/ui/RunningHead.tsx`, `.module.css`, and test
- `apps/web/src/components/appnav/NavTopBar.tsx`, `AppNav.module.css`, and test
- `apps/web/src/components/workspace/PaneShell.tsx`, `.module.css`, and test
- `apps/web/src/components/workspace/WorkspaceHost.tsx` and test
- `apps/web/src/components/workspace/PaneSecondary.tsx`
- `apps/web/src/components/workspace/PaneFixedChrome.tsx`
- `apps/web/src/lib/workspace/telemetry.ts` plus telemetry assertions in
  WorkspaceHost/store tests
- `apps/web/src/components/PdfReader.tsx` and `.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/lib/workspace/mobileChrome.tsx` and test

### Primary-chrome producer migration

All 12 live producers move from `usePaneChromeOverride` to
`usePanePrimaryChrome`:

- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx`
- `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/components/chat/Conversation.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`

Migrate their direct tests/mocks: `PaneShell.test.tsx`,
`LibraryPaneBody.ac4.test.tsx`, both `MediaPaneBody` test files,
`PodcastDetailPaneBody.test.tsx`, and
`lib/androidShell.podcastDetailPaneBody.test.tsx`.

### Action descriptor and stateful Options

- `components/ui/ActionMenu.tsx` and `__tests__/components/ActionMenu.test.tsx`
- `components/ui/ActionBar.tsx` and test
- `components/ui/SurfaceHeader.tsx`
- `components/workspace/PaneShell.tsx`, `WorkspaceHost.tsx`
- `lib/workspace/mobileChrome.tsx`
- `lib/actions/resourceActions.ts` and test
- `lib/collections/types.ts`
- `components/highlights/highlightActions.tsx`,
  `highlightActions.test.ts`, `highlightActions.test.tsx`, and
  `HighlightActionBar.test.tsx`
- `components/chat/forkNodeActions.tsx` and test
- `media/[id]/MediaPaneBody.tsx` and tests

`Chip` and `CollectionDisplayControls` keep their unrelated `pressed`
vocabulary.

### Secondary region and focus handoff

- `lib/panes/paneRuntime.tsx` and test
- `lib/panes/paneSecondaryModel.ts` and test
- `lib/panes/panePublications.ts` and test
- `components/workspace/WorkspaceHost.tsx` and test
- `components/workspace/SecondaryPaneShell.tsx` and test
- `components/workspace/MobileSecondaryPaneHost.tsx` and test
- `components/workspace/SecondarySurfaceTabs.tsx` and test
- `components/ui/Dialog.tsx` and test
- `components/ui/MobileSheet.tsx` and test
- `lib/ui/useReturnFocus.ts`
- `lib/ui/useDialogOverlay.ts` and test
- `lib/ui/useModalLayer.ts`
- `lib/ui/useInitialFocus.ts`
- `lib/ui/useEscapeKey.ts` and test
- `lib/ui/useBodyOverflowLock.ts`
- `lib/ui/useHistoryDismiss.ts` and test
- `lib/workspace/paneDom.ts`
- `components/contributors/MediaAuthorsEditor.tsx` and test
- `media/[id]/MediaPaneBody.tsx` and tests

Direct modal owners (`Dialog`, `MobileSheet`, `NavSheet`, `LauncherSurface`,
`HoverPreview`, `WalknoteReviewPanel`, podcast settings, and the podcast
episodes drawer) all consume the same topmost projection; no production owner
hardcodes `aria-modal`, and every backdrop consumes the shared suspended
underlay projection.

### Pane-label mechanical inventory

Owners and transport:

- `lib/panes/paneRouteModel.ts`, `paneRouteTable.ts`, and their tests
- `lib/panes/paneRuntime.tsx` and test
- `lib/panes/openInAppPane.ts`
- `lib/panes/paneLinkNavigation.ts` and test
- `lib/resources/activation.ts` and test
- `components/workspace/PaneRouteBoundary.test.tsx`
- `lib/workspace/schema.ts`, `store.tsx`, and tests
- `lib/workspace/telemetry.ts` plus WorkspaceHost/store test assertions
- `components/workspace/WorkspaceHost.tsx`, `WorkspacePaneStrip.tsx`, and tests
- `components/launcher/useLauncherController.ts`
- `components/ui/ResourceActivation.tsx`

Hint producers/consumers:

- `lib/launcher/{actions,dispatch,model,providers}.ts` and provider tests
- `lib/collections/presenters/{conversation,episode,lectern,library,media,note,podcast,search,settings}.ts`
- presenter tests for media/search
- `lib/search/{types,searchViewModel,searchApi.test}.ts`
- `lib/notes/openToday.ts`, `lib/conversations/useDocentWalk.ts`
- `components/contributors/ContributorChip.tsx` and test
- `components/GlobalPlayerFooter.tsx`, `components/reader/CitePicker.test.tsx`
- `components/library/LibraryBrief.tsx`,
  `components/connections/ConnectionsSurface.tsx`, and
  `components/chat/ConversationDistillate.tsx`
- `app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx`

Direct label-contract tests also include
`__tests__/components/{Conversation,ConversationsPaneBody,LecternPaneBody}.test.tsx`,
`__tests__/components/ui/ResourceRow.test.tsx`,
`components/contributors/ContributorChip.test.tsx`,
`lib/launcher/providers.test.ts`, `lib/workspace/store.test.tsx`, and
`components/workspace/WorkspaceHost.test.tsx` plus
`__tests__/components/WorkspacePaneStrip.test.tsx`.

Runtime label publishers and tests:

- `authors/[handle]/AuthorPaneBody.tsx`
- `libraries/[id]/LibraryPaneBody.tsx` and AC4 test
- `media/[id]/MediaPaneBody.tsx` and AC4 test
- `notes/NotesPaneBody.tsx`, `notes/[blockId]/NotePaneBody.tsx`
- `pages/[pageId]/PagePaneBody.tsx`
- `podcasts/[podcastId]/PodcastDetailPaneBody.tsx` and test
- `search/SearchPaneBody.test.tsx`
- `components/chat/Conversation.tsx` and conversation tests
- `__tests__/helpers/authenticatedPane.tsx`
- `lib/androidShell.podcastDetailPaneBody.test.tsx`

### Media, credits, reader, E2E

- `media/[id]/MediaPaneBody.tsx`, `mediaFormatting.ts`, styles, and tests
- `lib/panes/paneResourceLoaders.ts` and test (canonical media identity is
  authoritative; subordinate fragment failure is a typed outcome)
- `components/HtmlRenderer.tsx` and test
- `media/[id]/TextDocumentReader.tsx`, `TranscriptContentPanel.tsx`,
  `TranscriptPlaybackPanel.tsx`, and direct tests; imported heading levels use
  explicit offsets rather than an h1-only rewrite
- `lib/contributors/vocab.ts`, `formatting.ts`, and
  `ContributorRoleGroups.tsx`/styles/tests
- `components/contributors/ResourceCreditsOverlay.tsx` and test
- `ReaderDocumentMapOverviewRail.tsx`, styles, and tests
- `SecondarySurfacePanels.tsx`, `SecondaryPaneShell.tsx`,
  `MobileSecondaryPaneHost.tsx`
- rewrite `e2e/tests/reader-document-map-overview-rail.spec.ts`
- rewrite `e2e/tests/authors.spec.ts`
- rewrite affected selectors in `e2e/tests/epub.spec.ts` and
  `e2e/tests/pane-chrome.spec.ts`
- retain `e2e/tests/app-navigation.spec.ts` taxonomy: media may keep Libraries
  selected in navigation while its visible pane identity is resource-first.

### Guards and dead tests

- update `apps/web/src/lib/ui/paneSurfaceCutover.guards.test.ts`
- delete dead `apps/web/src/lib/navigation/standingHead.ts` and its self-test;
  standing heads resolve directly from the destination registry
- delete `apps/web/src/lib/panes/paneRouteTable.androidShell.test.tsx` with
  `getChrome`

### Docs

- `docs/architecture.md`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`
- `docs/cutovers/running-journal-hard-cutover.md`
- `docs/cutovers/reader-document-map-evidence-trail-hard-cutover.md`
- `docs/cutovers/lightweight-author-deduplication-hard-cutover.md`

## Deletions

- `PaneChromeDescriptor`, every `getChrome`, and dead route toolbar/actions;
- dead `standingHead.ts` indirection and its self-test;
- `paneRouteTable.androidShell.test.tsx`, whose only subject is dead `getChrome`;
- all old pane-title API and compound hint/state names;
- `PaneChromeOverrides`, context, hook, and equality owner;
- `ActionMenuOption` and ActionMenu-owned descriptor types;
- `buildCompactMediaPaneTitle` and dead contributor-summary code;
- media byline, inline author editing, manual marker, and related styles/tests;
- generic map toolbar/transcript option branches;
- rail `openDocumentMap`, `onOpenMap`, `ListOrdered`, open slot, and styles;
- the dead podcast mobile `actions: ReactNode` publication and orphaned CSS;
- tests/comments asserting `media -> Libraries`, document-mode inference,
  duplicate map entrances, or inline author editing.

## Cutover Sequence

1. Add failing pure/action/a11y/race/geometry tests.
2. Land route/header/action/focus types and the pane-label rename.
3. Cut primary publication and both projections; delete old APIs immediately.
4. Cut media identity, credit overlays, author Options, and Document Map.
5. Delete superseded DOM/styles/docs; run residue gates and focused tests.

These are build-order slices, not runtime coexistence phases.

## Acceptance Criteria

Architecture:

- Every supported route declares an exhaustive header contract.
- No header behavior reads `bodyMode`.
- Desktop and mobile consume the same `PaneHeaderModel` and descriptors.
- Route-key gate precedes normalization/kind validation.
- A current mismatch fails only its pane; stale invalid publications and stale
  cleanup are ignored.
- `toolbar: ReactNode` is the only free-form primary-chrome exception and has
  tested referential equality.

Identity and layout:

- Media shows resource pending/ready/unavailable/failed identity and never
  `Libraries`.
- Section/resource desktop heights are 44/60px; mobile is 60px plus safe area.
- Title and credits do not overlap controls at 390px.
- PDF/text targets align below app bar plus optional reader toolbar; hide/reveal
  leaves no gap.
- Title and credits independently ellipsize; full credits/title are visually
  inspectable through `Credits…`.
- Every pane landmark is named; pending is `Loading media…` and busy.
- Same-resource panes have distinct IDs.

Credits/authors/focus:

- Compact summary preserves every effective role/name/order once in persistent
  chrome and contains no clipped focusable link.
- Complete credits preserve links and wrap without truncation.
- No bordered Authors row, `No authors`, manual marker, or inline Add/Edit
  survives.
- Add/Edit Authors is authorization-gated; save/reset behavior is unchanged.
- Authors and Credits overlays enter focus and return to the Options trigger on
  desktop/mobile without feature-local focus repair.
- A nested modal has exactly one `aria-modal`; its underlay is inert with no
  second scrim, shared scroll locking remains active, and non-LIFO close cannot
  steal focus or unlock the body.
- Escape dismisses one topmost interaction layer per command. On mobile, Back
  dismisses the top history-enabled menu/sheet layer; desktop `Dialog` does not
  consume browser history. The history-enabled nested stack owns one synthetic
  marker across blocked, simultaneous, delayed-pop, and owner-handoff close
  paths.

Document Map/actions:

- Each eligible readable desktop media pane has exactly one generic Map icon;
  each eligible active mobile media projection has exactly one Show/Hide
  Options item. Ineligible panes have zero.
- Collapsed desktop action omits `aria-controls`; expanded action references the
  mounted group container.
- Toggle/disclosure ActionMenu ARIA mappings match this spec.
- Playback-only `podcast_episode`/video has no Map action; its readable
  transcript-backed form does.
- `G`, marker activation, previews, Contents, Evidence, progress, restore, and
  focus mode remain intact. Bare `G` closes topmost mobile Map but cannot close
  Map beneath Credits/Authors or its local Options menu.
- Overview rail has no generic opener and remains absent on mobile.

Cutover hygiene:

- Pane strip, resize labels, launcher, and hints use bare media title and do not
  change after author edits.
- Old chrome/title/action names and compatibility exports are absent.
- Exact-count tests are scoped per pane/projection; no `.first()` masks a
  duplicate.
- Docs describe only the final contract.

## Named Tests

- `paneHeaderModel`: all route defaults, pending, ready, 404 unavailable,
  non-404 failed, invariant mismatch.
- `WorkspaceHost`: stale invalid old-route publication ignored; stale cleanup
  cannot clear current chrome; current mismatch trips only affected pane.
- `MediaPaneBody`: initial 404 publishes unavailable; still-processing DTO
  publishes ready; `podcast_episode`/video/unknown map capability matrix.
- `ActionBar`/`ActionMenu`: toggle mapping; collapsed/expanded disclosure;
  Show/Hide labels; broken IDREF impossible.
- `SecondaryPaneShell`/`MobileSecondaryPaneHost`: group ID on outer container;
  tab IDs remain independent; collapsed DOM absent.
- `ResourceHead`/`PaneShell`: pending accessible name; section/resource landmark
  names; 44/60px geometry; same-resource concurrent IDs/counts.
- `Dialog`/`MobileSheet`/`MediaAuthorsEditor`: explicit trigger return,
  disconnected-trigger fallback, skip behavior, exclusive nested modality,
  lower-first scroll locking, and one-layer Escape.
- `useHistoryDismiss`: one marker; nested/blocked Back; lower-first,
  simultaneous, delayed-pop, and A-to-B handoff cleanup.
- `MobileSecondaryPaneHost`: Map opens without menu refocus, focuses its active
  tab, returns to the exact Options trigger, then uses pane-chrome fallback if
  that trigger disconnects.
- E2E: rewrite the two named specs for deleted DOM, per-pane Map uniqueness,
  author focus return, and reader offset/hide-reveal geometry at 390px; update
  EPUB and pane-chrome selectors in the same cutover.

## Negative Gates

```bash
rg 'PaneChromeDescriptor|getChrome|PaneChromeOverrides|PaneChromeOverrideContext|usePaneChromeOverride' apps/web/src
rg 'ActionMenuOption' apps/web/src
rg 'useSetPaneTitle|setPaneTitle|publishPaneTitle|onSetPaneTitle|titleHint|paneTitleHint|data-pane-title-hint|runtimeTitleByPaneId|pendingTitleHintByRouteKeyRef|WorkspacePaneTitle|normalizePaneTitle|upsertPaneTitleRecord|titleTelemetryByPaneIdRef' apps/web/src
rg 'buildCompactMediaPaneTitle|documentMapToolbarButton|onOpenMap|openSlot|ListOrdered' \
  'apps/web/src/app/(authenticated)/media/[id]' apps/web/src/components/reader
```

Every command returns no owned legacy match. Generic domain `title` and
unrelated component `pressed` fields are reviewed, not globally banned.

## Verification

```bash
cd apps/web && bun run test:unit -- \
  src/lib/panes/paneHeaderModel.test.ts \
  src/lib/panes/paneRouteTable.test.ts \
  src/lib/panes/panePublications.test.ts \
  src/lib/panes/paneSecondaryModel.test.ts

cd apps/web && bun run test:browser -- \
  src/components/ui/RunningHead.test.tsx \
  src/components/ui/ResourceHead.test.tsx \
  src/components/ui/ActionBar.test.tsx \
  src/__tests__/components/ActionMenu.test.tsx \
  src/__tests__/components/Dialog.test.tsx \
  src/components/ui/MobileSheet.test.tsx \
  src/components/ui/HoverPreview.test.tsx \
  src/lib/ui/useDialogOverlay.test.tsx \
  src/lib/ui/useEscapeKey.test.tsx \
  src/lib/ui/useHistoryDismiss.test.tsx \
  src/components/appnav/NavTopBar.test.tsx \
  src/lib/workspace/mobileChrome.test.tsx \
  src/__tests__/components/PaneShell.test.tsx \
  src/components/workspace/WorkspaceHost.test.tsx \
  src/components/workspace/SecondaryPaneShell.test.tsx \
  src/components/workspace/MobileSecondaryPaneHost.test.tsx \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' \
  'src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.test.tsx' \
  src/__tests__/components/HtmlRenderer.test.tsx \
  src/components/contributors/MediaAuthorsEditor.test.tsx \
  src/components/contributors/AuthorSearchField.test.tsx \
  src/components/contributors/ResourceCreditsOverlay.test.tsx \
  src/components/reader/document-map/documentMapAction.test.tsx \
  src/components/reader/ReaderDocumentMapOverviewRail.test.tsx

cd apps/web && bun run typecheck
cd apps/web && bunx eslint <touched-files> --max-warnings 0

cd e2e && bunx playwright test \
  tests/reader-document-map-overview-rail.spec.ts \
  tests/authors.spec.ts \
  tests/epub.spec.ts \
  tests/pane-chrome.spec.ts
```

## Final State

The workspace has one pane-label vocabulary, one typed header resolver, two
header archetypes, one route-keyed primary publication, one action-state model,
one explicit overlay focus contract, and one semantic Document Map action.
The overlay contract has one topmost modal projection, one Escape arbiter, one
reference-counted body lock, and one history marker across nested layers.

Media has one persistent identity. Credits remain completely inspectable.
Author editing is administration. The rail remains a map. Nothing legacy
remains.
