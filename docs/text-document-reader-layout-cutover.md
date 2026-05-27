# Text Document Reader Layout Cutover

## Status

Accepted for hard cutover.

This document owns the frontend reader-layout contract for reflowable text
documents: `web_article` and `epub`. It complements the source/navigation
contract in `docs/web-article-reader-navigation.md` and the pane shell contract
in `docs/workspace-pane-architecture-cutover.md`.

## Problem

Web articles and EPUBs were visually similar but not architecturally identical.
EPUB content rendered through an EPUB-specific wrapper, while web articles
inlined the same reader frame, contents navigation, and `HtmlRenderer` path in
`MediaPaneBody`. That made layout bugs easier to fix for one kind while missing
the other.

The concrete symptom was pane expansion: when a reader pane grew wider than the
protected reading measure, the text column could remain pinned left inside the
reader compound layout instead of staying centered in the primary reader area.
The text measure itself must not widen; the reader column width is intentionally
bounded by reader research and user profile settings.

## Goals

- `web_article` and `epub` use one shared text-document reader surface.
- The shared surface owns the reader frame, scroll viewport, reader root,
  centered text column, contents-navigation placement, and sanitized HTML
  rendering.
- Source-specific behavior stays in adapters and route orchestration, not in
  duplicated layout branches.
- Runtime pane sizing follows the resource-scoped workspace runtime contract.
- Desktop secondary rails append width outside the protected primary reader
  width and never shrink or overlay the primary text column.
- Pane expansion recenters the fixed-measure text column inside the available
  primary reader area.
- The hard cutover removes EPUB-only layout wrappers and duplicate web article
  reader markup.

## Non-Goals

- No backend schema change.
- No new `/navigation` endpoint.
- No frontend DOM scraping to infer web article headings.
- No new `CapabilitiesOut` field.
- No change to PDF page geometry, PDF highlighting, or transcript rendering.
- No source-style preservation mode or original-page view.
- No compatibility wrapper around the deleted EPUB-only reader component.

## Target Behavior

### Reflowable Text Readers

`web_article` and `epub` render through the same component path:

```text
MediaPaneBody
  -> TextDocumentReader
     -> readerFrame
        -> documentViewport
           -> readerContentRoot
              -> readerContentInner
                 -> ReaderContentsNav, when source-backed contents exist
                 -> HtmlRenderer
```

The source kind supplies only the content state and navigation adapter:

| Kind | Source-specific responsibilities |
|---|---|
| `epub` | Resolve initial section, fetch section HTML, handle EPUB internal links, previous/next/select-section toolbar state |
| `web_article` | Resolve active fragment, load source-backed reader navigation, jump to heading locations by `?loc` and fragment/offset data |

Both kinds share:

- reader profile CSS variables
- focus mode root attributes
- hyphenation root attributes
- scroll container and mobile chrome scroll reporting
- contents navigation placement
- sanitized HTML rendering
- selection/highlight click path
- centered fixed-measure content column

### Pane Width

The resizable primary width and the contextual rail width are separate values.

```text
rendered pane width = rendered primary width + runtime extra width
```

The protected primary width includes the measured text column plus any always-on
reader overview ruler. The secondary rail is runtime extra width and is appended
outside the primary width.

When a pane is wider than the protected minimum, the primary reader area consumes
the available width and the text column remains centered inside it. The text
measure does not widen.

### Resource Scoping

Runtime min-width and runtime extra-width publication follows
`docs/workspace-pane-architecture-cutover.md`. The text reader relies on that
contract; this document does not define a second pane-runtime policy.

## Architecture

### `TextDocumentReader`

The shared text reader component owns only layout and render composition.

Inputs:

- media id
- reader root ref
- content ref
- reader surface class/style
- focus mode and hyphenation values
- document scroll handler
- content state: loading, empty, error, or ready
- optional contents navigation node
- highlight/content click handler
- optional internal-link resolver for source-specific links

Rules:

- It never fetches media or navigation.
- It never derives contents by parsing rendered DOM.
- It never sanitizes HTML.
- It never interprets EPUB CFI, web offsets, resume state, or source versions.
- It calls `HtmlRenderer` only with API-owned sanitized HTML.

### `MediaPaneBody`

`MediaPaneBody` remains the route owner.

Responsibilities:

- media fetch and retry state
- reader resume and URL synchronization
- EPUB section fetches and EPUB toolbar state
- web article navigation loading and heading jump state
- active content selection
- highlight selection, mutation, and chat context composition
- pane chrome and reader toolbar publication
- secondary rail mode/state

## API Design

No public API changes.

The route-body pane runtime API remains:

```ts
setPaneMinWidth(widthPx: number | null): void
setPaneExtraWidth(widthPx: number): void
```

Resource scoping is attached by `PaneRuntimeProvider` and enforced by
`WorkspaceHost` under the workspace pane architecture contract.

## Composition

- Reader navigation composes with the existing generalized
  `/api/media/{id}/navigation` path.
- `HtmlRenderer` remains the only `dangerouslySetInnerHTML` sink.
- Highlights and quote-to-chat continue to use active content fragment ids and
  source versions from `MediaPaneBody`.
- `SecondaryRail` remains visual-only; pane width publication stays with the
  compound reader layout owner.
- Mobile keeps drawers/sheets for contextual tools and does not reserve desktop
  secondary rail width.

## Files

### Frontend

| File | Change |
|---|---|
| `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx` | New shared reader surface for `web_article` and `epub` |
| Former EPUB-only content wrapper | Delete; no compatibility component remains |
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` | Route both text document kinds through `TextDocumentReader`; keep source-specific orchestration only |
| `apps/web/src/app/(authenticated)/media/[id]/ReaderContentsNav.tsx` | Use centralized navigation href anchor parsing |
| `apps/web/src/app/(authenticated)/media/[id]/epubHelpers.ts` | Keep EPUB-only link resolution; reuse centralized anchor parsing |
| `apps/web/src/lib/media/readerNavigation.ts` | Own generic reader navigation helpers |
| `apps/web/src/lib/panes/paneRuntime.tsx` | Publish runtime widths with resource key attached |
| `apps/web/src/components/workspace/WorkspaceHost.tsx` | Store/apply runtime widths by pane id and resource key |
| `apps/web/src/app/(authenticated)/media/[id]/page.module.css` | Rename EPUB-only layout class to text-document layout; make split layout full-width |

### Tests

| File | Coverage |
|---|---|
| `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx` | Internal link handling, contents navigation, and fixed-measure centering |
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx` | Web, EPUB, and PDF runtime width publications still work |
| `apps/web/src/components/workspace/WorkspaceHost.test.tsx` | Runtime width applies to matching resource and is ignored/cleaned for stale resources |
| `apps/web/src/lib/media/readerNavigation.test.ts` | Anchor parsing helper remains deterministic |
| `apps/web/src/app/(authenticated)/media/[id]/epubHelpers.test.ts` | EPUB internal link and location helper behavior |

## Acceptance Criteria

- No imports or references to an EPUB-only text-reader wrapper remain in active
  code.
- Web articles and EPUBs both render one `TextDocumentReader` surface.
- Web article contents navigation and EPUB TOC use the same `ReaderContentsNav`.
- EPUB internal links still route through same-pane `?loc` navigation.
- Web article heading navigation still resolves `?loc` and fragment changes.
- Pane expansion keeps the fixed text measure centered in the primary reader area.
- Opening the reader secondary rail increases runtime extra width only.
- Closing the reader secondary rail removes runtime extra width.
- Runtime min/extra width from a previous resource cannot affect a later resource
  rendered in the same pane id.
- PDF and transcript readers keep their existing format-specific rendering.
- Tests prove the shared text reader path and resource-scoped runtime width
  behavior.

## Key Decisions

- Use one shared text-document component, not an EPUB component reused by web
  articles. EPUB is a source adapter, not the base abstraction.
- Keep source-specific orchestration in `MediaPaneBody` until the whole reader
  route owner is split; do not move fetch/resume state into the layout component.
- Make the pane runtime provider attach `resourceKey` automatically so route
  bodies keep the existing simple width API.
- Prefer source-backed navigation from `/navigation`; never derive canonical
  reader contents from rendered DOM.
- Fix centering at the compound layout contract (`splitLayout` fills the pane)
  rather than by widening text or adding web-only CSS.
