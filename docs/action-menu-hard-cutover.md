# action menu hard cutover

This document defines the final action/menu architecture for Nexus resource
surfaces.

This is a hard cutover. The final state has no legacy inline resource-menu
construction, no compatibility shim, no fallback menu path, and no duplicated
resource action policy in route components.

## problem

Nexus already has a shared menu renderer, but resource actions are assembled in
multiple route components. That makes pane headers, list rows, context menus,
and future command surfaces drift from each other.

The concrete failure mode is media:

- the media pane header exposes source, reader, chat, library, and delete
  actions
- library media rows expose only library membership actions
- podcast episode rows expose a different subset of media-backed actions
- each surface owns its own menu array and gating logic

The renderer is shared. The action model is not.

## goals

- Define each resource capability in one canonical action model.
- Project the canonical model into each surface through explicit surface
  policy.
- Keep pane-header, row, context-menu, keyboard, and command-palette behavior
  coherent without forcing identical menus.
- Make action labels, IDs, ordering, grouping, disabled states, permission
  gates, and destructive styling consistent.
- Keep UI components presentational.
- Make action behavior testable without rendering every route component.
- Use current backend capabilities and authorization responses as the source of
  truth for permissions.
- Remove route-local duplicate resource action arrays.

## non-goals

- Do not add new product capabilities.
- Do not change backend authorization semantics.
- Do not preserve old menu construction as a fallback.
- Do not keep compatibility wrappers around old route-local option arrays.
- Do not introduce plugin or third-party action contribution support.
- Do not redesign `ActionMenu` visuals as part of this cutover.
- Do not add bulk-edit product behavior beyond the action model needed to
  express bulk-capable actions.

## target behavior

### universal behavior

- A resource action has one stable ID across every surface.
- A resource action has one canonical label unless a surface-specific label is
  explicitly part of the action definition.
- A surface renders only actions that apply to its subject and context.
- A surface disables an action only for temporary or state-dependent
  unavailability.
- A surface removes an action when the action does not apply to the subject,
  permissions, or surface.
- Destructive actions appear last in their group and use danger tone.
- Menu triggers do not render when the resolved action list is empty.
- All menu interactions use accessible menu-button semantics and keyboard
  behavior.

### pane headers

Pane headers expose actions for the active pane subject and shell-owned pane
actions.

Pane-header menus include:

- shell actions, such as `copy-pane-link`
- resource-level actions for the pane subject
- pane-only actions whose meaning depends on the active reader, route, or pane
  state

Pane-header menus do not inherit row-only actions.

### list rows

List rows expose contextual actions for the row subject.

List-row menus include all resource-level commands that can be performed safely
from the row with the row's available data. If a row needs more resource fields
to render canonical actions, the list read model must provide those fields.

List-row menus do not include:

- shell actions
- active-pane state actions
- reader viewport controls
- selection-only commands

### context menus

Context menus use the same resolved action list as the visible row action menu
for the same subject and surface.

Right-click is not the only path to an action. Every context-menu command must
also be available through a visible menu trigger, command palette, keyboard
shortcut, or pane action.

### command palette

The command palette reads from the same action registry.

The palette resolves actions for:

- the active pane subject
- the current selection, when one exists
- the focused row subject, when one exists

The palette does not create a second action taxonomy.

### bulk actions

Bulk surfaces read from the same action registry and render only actions marked
as bulk-capable.

Bulk action eligibility is computed from the full selection. If an action is
valid for the resource type but blocked by the current selection state, the
action is disabled with a reason.

## media behavior

### media pane header

The media pane header renders:

- `copy-pane-link` from pane shell
- `open-source` when `canonical_source_url` exists
- `chat-about-media` when the viewer can open the media-scoped conversation
- `manage-media-libraries` when library membership management applies
- `delete-media` when `media.capabilities.can_delete` is true
- `toggle-epub-toc` only for EPUB reader panes with a table of contents or TOC
  warning
- `reader-theme-light` and `reader-theme-dark` only for reflowable reader panes

PDF zoom actions remain toolbar actions, not media resource actions.

### media list rows

A media list row renders:

- `open-source` when `canonical_source_url` exists
- `chat-about-media` when the viewer can open the media-scoped conversation
- `manage-media-libraries` when library membership management applies
- `delete-media` when `media.capabilities.can_delete` is true

A media list row does not render:

- `copy-pane-link`
- EPUB TOC controls
- reader theme controls
- PDF zoom controls
- highlight or selection actions

### podcast episode rows

Podcast episode rows are media-backed rows. They use media resource actions for
media behavior and episode actions for episode behavior.

The row renders:

- media actions that apply to the episode media
- `toggle-episode-played` when listening state can be changed
- queue actions as visible row actions or row actions from the same registry

Transcript request controls remain row workflow controls until they become
canonical media actions.

## other resources

### libraries

Library detail and library list rows share library resource actions:

- `chat-about-library`
- `view-library-intelligence`
- `edit-library`
- `delete-library`

List rows render the subset that applies to row context. Detail panes render the
same resource actions plus pane shell actions.

### podcasts

Podcast detail and podcast list rows share podcast resource actions:

- `manage-podcast-libraries`
- `open-podcast-settings`
- `refresh-podcast-sync`
- `unsubscribe-podcast`

Follow and import actions for browse results are browse-result actions, not
saved podcast resource actions.

### conversations

Conversation detail and conversation list rows share conversation resource
actions:

- `delete-conversation`

Future archive, rename, or pin actions must be added once in the conversation
action model.

## architecture

### action model

Add a frontend action module:

```text
apps/web/src/lib/actions/
  types.ts
  actionIds.ts
  surfacePolicy.ts
  mediaActions.ts
  libraryActions.ts
  podcastActions.ts
  conversationActions.ts
  resolveActions.ts
```

`types.ts` defines:

```ts
type ActionSurface =
  | "pane-header"
  | "list-row"
  | "context-menu"
  | "selection-toolbar"
  | "command-palette"
  | "bulk-toolbar";

type ActionGroup =
  | "open"
  | "organize"
  | "reader"
  | "playback"
  | "chat"
  | "settings"
  | "management"
  | "danger";

interface ResourceAction<Subject, Env> {
  id: string;
  group: ActionGroup;
  label: string | ((ctx: ActionContext<Subject, Env>) => string);
  tone?: "default" | "danger";
  separatorBefore?: boolean;
  appliesTo: (ctx: ActionContext<Subject, Env>) => boolean;
  disabledReason?: (ctx: ActionContext<Subject, Env>) => string | null;
  run: (ctx: ActionRunContext<Subject, Env>) => void | Promise<void>;
}
```

Action definitions are declarative. Route components supply `Env` callbacks for
navigation, mutation, toast, panel opening, and local state.

### resolver

`resolveActions.ts` converts resource actions into `ActionMenuOption[]`.

The resolver owns:

- surface filtering
- disabled-state mapping
- group ordering
- separator placement
- danger ordering
- stable key generation

The resolver does not own resource permissions. Permissions come from subject
capabilities or API responses.

### rendering

`ActionMenu` remains the shared accessible renderer.

`SurfaceHeader` and `AppListItem` continue to accept resolved menu options.

Route components stop building resource-specific `ActionMenuOption[]` arrays.
They call resource action builders and pass the resolved options to renderers.

### pane shell

`PaneShell` keeps ownership of shell actions such as `copy-pane-link`.

Shell actions are composed after resource action resolution. They are not added
to resource action builders.

## rules

- Add a new resource command only by adding a resource action definition.
- Add a new surface only by adding an `ActionSurface` value and policy tests.
- Do not hand-build resource `ActionMenuOption[]` arrays in route components.
- Do not duplicate action labels in route components.
- Do not check backend permissions in route components when a capability field
  or API response already expresses the permission.
- Do not hide unavailable actions with CSS. Resolve the action list before
  rendering.
- Do not use a context menu as the only path to a command.
- Do not add compatibility adapters for old menu arrays.
- Do not mix local controls and resource commands in one menu.
- Keep local-control menus scoped to their owning component.

## final state

- Resource actions are defined once per resource module.
- Route components do not contain inline resource action arrays.
- Pane headers and rows use the same action resolver.
- Context menus and visible row menus resolve from the same row action request.
- Command palette integration consumes the action registry.
- Tests assert action IDs by surface and subject.
- Existing ad hoc menu arrays for resource actions are deleted.
- No compatibility layer maps old inline menu definitions into the new model.

Inline `ActionMenu` arrays remain allowed only for local controls that are not
resource actions, such as PDF zoom controls inside the PDF toolbar.

## files

### add

- `apps/web/src/lib/actions/types.ts`
- `apps/web/src/lib/actions/actionIds.ts`
- `apps/web/src/lib/actions/surfacePolicy.ts`
- `apps/web/src/lib/actions/mediaActions.ts`
- `apps/web/src/lib/actions/libraryActions.ts`
- `apps/web/src/lib/actions/podcastActions.ts`
- `apps/web/src/lib/actions/conversationActions.ts`
- `apps/web/src/lib/actions/resolveActions.ts`
- `apps/web/src/lib/actions/actions.test.ts`

### change

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/components/ui/AppList.tsx`
- `apps/web/src/components/ui/SurfaceHeader.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/CommandPalette.tsx`

### preserve

- `apps/web/src/components/ui/ActionMenu.tsx`
- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/LibraryTargetPicker.tsx`

These components remain renderers or interaction panels. They do not own
resource action policy.

## implementation plan

These steps are implementation order only. The branch is not complete until the
final state is reached.

1. Add action types, IDs, resolver, and ordering policy.
2. Add media action definitions and tests for pane header, list row, context
   menu, command palette, and bulk surfaces.
3. Cut media pane header and media list rows over to the media action model.
4. Add library, podcast, and conversation action definitions.
5. Cut library, podcast, and conversation panes and rows over to the action
   model.
6. Remove route-local resource action arrays.
7. Wire command palette action resolution for active pane and focused row
   contexts.
8. Add component and e2e coverage for menu parity, filtering, keyboard
   navigation, and destructive action placement.

## acceptance criteria

- Media pane header and media list rows share the same resource action IDs for
  actions that apply to both surfaces.
- Media row menus exclude pane-only, reader-only, toolbar-only, and
  selection-only actions.
- Library detail and library row actions resolve from one library action model.
- Podcast detail, podcast row, and episode row actions resolve from one podcast
  or media action model.
- Conversation detail and conversation row delete actions resolve from one
  conversation action model.
- `copy-pane-link` remains shell-owned and appears only in pane headers.
- Destructive actions are last and danger-toned in every menu.
- Empty action lists render no menu trigger.
- Menu tests use roles and menuitem queries, not styling selectors.
- `rg "ActionMenuOption\\[\\]|const .*Options =|options=\\[" apps/web/src/app`
  has no route-component matches except documented local-control menus that are
  not resource actions.
- Unit tests cover action-policy matrices for media, library, podcast, and
  conversation.
- Component tests cover keyboard opening, focus movement, disabled actions, and
  destructive action order.
- E2E tests cover media header/list-row action consistency for at least one
  web article, one EPUB, one PDF, and one podcast episode.
- `make verify` passes.

## key decisions

- Menus are not identical by surface. They are projections of one canonical
  action model.
- Resource actions live above route components.
- Shell actions live in shell code.
- Reader controls live in reader or toolbar code unless they are resource
  actions.
- Backend capability fields decide permissions.
- Route components provide execution callbacks; they do not decide action
  existence.
- Missing data in a list row is a read-model defect when it prevents a canonical
  row action from rendering.
- The cutover deletes old resource-menu construction instead of wrapping it.

## validation commands

```bash
make verify
make test-e2e
make test-e2e-ui
```
