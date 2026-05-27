# Pane Width Cutover

## Problem

The current workspace has two implicit rules that conflict:

- Pane shell width is durable slot state: pane.widthPx.
- Routed content often has its own preferred measure: reader 65ch, chat 700px,
  notes 76ch, cards/list surfaces.

That produces the reported artifact: a wide shell boundary with narrow/default
content inside it.

## Target Behavior

A pane route always receives a full-width routed content lane. Intentional inner
measures happen inside that lane.

Same-pane navigation uses semantic width transitions:

- Same resource/location changes preserve width: /media/a?loc=1 -> /media/a?loc=2.
- Same layout class changes preserve width within route min/max: list -> list,
  document -> document.
- Cross layout class changes adopt the target route default: media -> search, media
  -> libraries, document -> settings, list -> media.
- New panes still open at target route default width.
- Manual resize applies to the current semantic layout class; it does not poison
  unrelated future route classes.
- Runtime min/extra widths remain separate: reader/chat rails can expand rendered
  width without becoming persisted primary width.

## Architecture

The canonical owner is the workspace layer, not individual panes.

- Width constants, route layout kinds, route width contracts, clamping, and
  semantic transition width resolution stay in
  `apps/web/src/lib/workspace/schema.ts`.
- Route resolution continues merging width contracts in
  `apps/web/src/lib/panes/paneRouteRegistry.tsx`.
- Navigation transitions are enforced in
  `apps/web/src/lib/workspace/store.tsx`.
- Shell rendering stays numeric in
  `apps/web/src/components/workspace/PaneShell.tsx`.
- Runtime measured pressure stays in `setPaneMinWidth` and `setPaneExtraWidth`
  from `apps/web/src/lib/panes/paneRuntime.tsx`.

## API Design

Add a real workspace-level contract, not scattered conditionals:

```ts
export type PaneLayoutKind =
  | "standard"
  | "dense-list"
  | "document"
  | "podcast-detail"
  | "media-reader";

export interface PaneWidthContract {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  layoutKind: PaneLayoutKind;
}

export function resolvePaneTransitionWidth(
  previousHref: string,
  nextHref: string,
  previousWidthPx: number,
  preserveWidth: boolean
): number;
```

preserveWidth is computed by the store using hasSamePaneResource; schema.ts must
not import paneIdentity and create a cycle.

## Hard Cutover

Bump WORKSPACE_SCHEMA_VERSION from 5 to 6. This is a semantic persistence change
even if the JSON shape stays similar.

No v5 migration. No compatibility branch. No “if old schema then preserve old
width.” Old encoded/saved workspace state is invalidated through the existing
schema boundary and rebuilt under v6 rules.

Remove the old clamp-only navigation semantics everywhere. Every navigation path
must call the transition helper:

- applyPaneHrefTransition
- duplicate open reuse
- navigate_pane
- go_back_pane
- go_forward_pane
- restored/direct URL merge when it retargets an existing pane

## Route Fill Contract

`PaneContent` keeps one generic route shell. The shell is the host-level fill
contract: it flexes to the pane body, uses a column axis, and stretches routed
roots across the pane lane by normal flex cross-axis behavior.

Final rule: route shell fills the pane; routed roots fill the route shell's
width; prose, editor, and reader components may cap inner measure deeper down.

Do not fix this by adding random width: 100% rules to SearchPaneBody,
LibrariesPaneBody, SettingsPaneBody, or SectionCard.

## Composition

URL codec and workspace session continue storing a single widthPx; they do not gain
per-history width stacks.

Runtime widths remain transient and resource-key scoped. Existing pruning in apps/
web/src/components/workspace/WorkspaceHost.tsx:408 remains the model.

Reader contracts remain intact: EPUB `?loc` sync must not reset pane chrome or
remount media body, per `docs/reader-implementation.md`.

Mobile remains 100% width; this cutover targets desktop workspace panes.

## Acceptance Criteria

- Wide media pane navigated to /search, /libraries, /settings, or /conversations
  shrinks to target default.
- /media/a?loc=1 -> /media/a?loc=2 preserves width.
- /media/a -> /media/b preserves media-reader width class.
- /libraries -> /media/a adopts media default, then runtime min/extra can apply.
- Back/Forward use the same transition semantics as push/replace.
- Top-level card/list/search/settings routes fill the pane content lane.
- Reader/chat/note inner max-widths remain intentional and visible within full-
  width route lanes.
- No references to old clamp-only expectations remain in tests.
