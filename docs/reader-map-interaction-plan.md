# reader map interaction

status: implemented 2026-09-22; see [verification](reader-map-interaction-verification.md)
origin: 2026-09-21 owner approval and geometry, overlay, content-design council

## outcome and scope

activating a mark’s center reaches its destination or a crowded-member chooser.
hover/focus previews selection and annotation in desktop overview, scoped detail,
mobile inspector and offline reuse. preserve source positions, navigation, return,
ranges and refresh. preview/disclosure writes no progress, completion or activity.

no backend/wire/database change, hover requests, persistence, new dependency,
general overlay framework, magnifier, note editor, mobile overview, or unrelated
cleanup. no legacy renderer, dual prop API, compatibility branch or feature flag.

## geometry contract

reuse semantic projection and the track-only resize observer; no reader-content
or scroll-extent measurement.

- retain the 52px rail; align glyph/range/track axes at x=12px for
  structure/current and x=40px for evidence. fine-only input uses nominal
  height `t=16px`, width 16px; `(any-pointer: coarse)` uses `t=48px`, width 24px.
  css owns these local properties and endpoint padding; read `t` alongside
  track height in the existing measurement. padding changes trigger remeasure.
- project destinations to track y; sort each lane by `(y, stable destination id)`.
  start a group at the first unassigned y; include following destinations only
  while `y - firstY < t`. never extend a group by chaining neighbor distances.
  group ids derive from lane/member ids; keyboard order is ascending group
  anchor, structure before evidence on ties.
- desired hit interval is `[(firstY + lastY)/2 - t/2, (firstY + lastY)/2 + t/2]`.
  clip its start to the midpoint between the previous group's last y and this
  group's first y; clip its end to the corresponding next-group midpoint.
  omit a boundary when no neighbor exists. preserve fractional css pixels.
- reserve `t/2` of rail space beyond both track endpoints for their targets.
  no target crosses a lane or the rail's horizontal boundary. zero-height
  tracks render no interactive geometry until measured.
- isolated targets center on their mark. crowded intervals may be asymmetric;
  every member center belongs to its group's disjoint interval. gaps stay inert.
  at `t=16`, y=23/25 groups; y=1/23 separates; 0/15/16 forms two groups.
  final heights exceed `t/2`: coarse targets remain at least 24px in both axes.
- keep exact ticks; show groups with a small bracket at the target's trailing
  edge, not a displaced destination glyph. outline the actual hit rectangle on
  hover/focus. group count belongs in its accessible name and popup heading.

geometry designer’s bar: honest position/density, legible grouping, no stolen clicks.

## content and component api

one frontend projection of the existing aggregate in `lib/reader/documentMap.ts`:

```ts
type ReaderMapContent =
  | { kind: "Highlight"; quote: Presence<string>;
      notes: readonly { noteBlockId: string; excerpt: Presence<string> }[] }
  | { kind: "Named"; label: string; excerpt: Presence<string> };
type ReaderMapMarkerPresentation = {
  marker: ReaderDocumentMapMarker; content: ReaderMapContent;
};
// projectReaderMapMarkers(map: ReaderDocumentMap)
//   -> readonly ReaderMapMarkerPresentation[]
```

replace rail/detail `markers` with required `destinations` of that type. retain
other inputs/callbacks; activation passes the original marker. current position
remains separate.

highlight lookup uses `findEvidenceItem` and requires passage scope, highlight
kind and resolution `Resolved`; mismatch is a defect, never a fallback. use its
quote and every `highlightNoteAssociations` entry. trim only to detect absence;
retain text verbatim and note order/identity. other kinds use marker label/preview.
both hosted instances share the projection; absent aggregate means `[]`. offline
wraps its markers as `Named`, preserving section-id activation.

one presenter serves preview and chooser. its props are
`{ kind: "Current"; positionLabel: string } | { kind: "Marker";
destination: ReaderMapMarkerPresentation; positionLabel: string }`.
the rail owns scoped position wording; the presenter owns these content rules:

| case | visible content |
| --- | --- |
| highlight | `highlight`; quote once, at most three lines; scoped position |
| no quote | `no text quote`; never borrow neighboring prose |
| one attached note | separate `note` label; at most two excerpt lines |
| several notes | `note 1 of n`; first excerpt; `n − 1 more notes` |
| note without excerpt | `no note preview`; do not call the note empty |
| no attached notes | omit note section |
| named marker | type, title up to two lines, excerpt up to three; suppress exact duplicate title/excerpt |
| current / clipped range | `current position` / `continues from before <scope>` |

position and counts remain outside clipped text. cluster preview shows count,
first three summaries, then `n more destinations — activate to choose` when
needed. chooser contains every member in that same order, as native buttons
with at least 32px row height (44px with coarse input). constrain both popup
bodies to the viewport and scroll overflow; headings/counts remain outside the
scroller. no silent whole-card clipping or nested note actions.

content designer’s bar: distinguish quote from annotation; expose omissions;
never repeat text or invent recency. full notes/editing stay in evidence.

## popup and interaction contract

one local popup state per rail: `null | { kind: "Preview" | "Chooser";
groupKey: string }`. groups derive from current destinations; retain identity,
not stale objects or array indices. retain `activeDestinationId` for roving
focus, updated by trigger/member focus. chooser suppresses other hover previews.

- hover/focus opens preview without moving focus. associate `role="tooltip"`
  with the trigger using an id and `aria-describedby`.
- singleton click/enter/space activates immediately. grouped activation opens
  a labelled ordinary list of buttons and focuses its first member. retain
  vertical roving arrows/home/end through the rail; tab through chooser rows.
- pointer may enter the preview. place its interactive outer box directly
  adjacent to the trigger (`gap: 0`), with visual separation inside that box;
  no dead crossing gap, delay timer or invisible sheet over other markers.
- leaving both hover/focus regions closes preview. escape closes either mode;
  chooser cancellation returns focus to its trigger. suppress automatic
  preview reopening until that trigger is left and re-entered/refocused.
  outside pointer or focus departure closes without stealing focus. chooser
  activation suppresses reopening, focuses its surviving trigger, closes, then
  calls navigation; destination focus wins. never restore focus afterward.
- regrouping, scope/source replacement, detached anchor or hidden/ineligible
  host closes the popup. preserve roving focus by destination identity; if it
  disappears, choose the next surviving destination, then previous, then rail.
  move focus only when the closing/regrouped control owned it.

render `ReaderDocumentMapPopup` in place beside its active trigger with
`popover="manual"`. native top-layer painting escapes clipping/transforms while
dom order and modal ancestry remain correct. no portal or `source` option is
needed. reset browser margin/inset; no backdrop, modal semantics, scroll lock or
native auto-dismiss. call `showPopover()` while hidden, measure, then reveal;
hide/cleanup on close. browser floor: chromium/webview 114+, firefox 125+,
safari/ios 17+; verify actual runtime behavior during red.

popup inputs: `anchor`, `mode`, `id`, `label`, `children`, `onDismiss(reason)`;
reasons distinguish escape, outside pointer, focus departure and ineligibility.
the rail owns open state, focus return and history; the popup owns rendering,
positioning and dismissal notification.

reuse `useAnchoredPosition` (left, centered, flip, viewport clamp) and
`useDismissOnOutsideOrEscape`. add its concrete opt-in `trackAnchorMovement`
to positioning: while open, one animation-frame loop compares the live anchor
rect and repositions only when changed; cancel on close. this covers sheet
entrance and pane movement that resize/scroll listeners cannot observe.

expose `useTopmostModalLayerToken` from the existing modal registry; reuse it
inside the old topmost helper without changing that helper's semantics. rail
eligibility requires actual top token equal to containing token, including
null. close in layout phase when eligibility is lost; never leave a native
top-layer preview above a newly opened custom modal. preserve existing modal
back behavior; a modal-local chooser uses `useHistoryDismiss`, kept mounted at
the rail root across popup changes. preview creates no history entry.

overlay designer’s bar: quiet token-based card, complete choices, visible focus;
no clipping, stale anchors, focus theft or unrelated-modal overlap.

## work boundaries and files

paths: `apps/web/src/`. agree contracts first; each track has its designer above
and a different adversarial reviewer.

| track / owner | exclusive files and deliverable |
| --- | --- |
| a: geometry | new `components/reader/readerDocumentMapLayout.ts`: pure layout over `{id,lane,y}`, track height and `t`; return stable group id, ordered member ids, hit top/height. no react, content or navigation. |
| b: content | `lib/reader/documentMap.ts`; new `components/reader/ReaderDocumentMapDestination.tsx` and css: typed projection and one presenter. |
| c: popup | new `components/reader/ReaderDocumentMapPopup.tsx` and css; `lib/ui/{useAnchoredPosition,useModalLayer}.ts`: rendering/lifetime and the two bounded shared capabilities above. |
| d: integration | `ReaderDocumentMapOverviewRail.tsx`/css, `ReaderDocumentMapDetail.tsx`, `app/(authenticated)/media/[id]/MediaPaneBody.tsx`, `offline-reading/OfflineDocumentReader.tsx`; wire a–c and existing activation/refresh. owns documentation and issue closure. |

delete grid grouping, index-owned focus, legacy inline popups, quarter-position
placement, css hover and orphaned code. migrate every caller together. reuse
lower-level owners; do not retrofit `HoverPreview`, `FloatingActionSurface` or
`ActionMenu` policies. retain pane containment and navigation/data owners.

## red / green / refactor / delete

the explicit owner request authorizes temporary live tests as an exception to
the [static-only rule](local-rules/testing-standards.md). keep `./scripts/test`
unchanged. this planning step authorizes no application changes or tests.

1. **red:** write a temporary browser integration script in a scratch directory
   against the real local web/bff/api/database with ordinary authentication and
   disposable documents/highlights/notes. no mocked map response, production
   writes, test-only application seams or permanent harness. prove current
   misalignment/clipping/content failures through actual pointer/keyboard use.
2. **green:** implement a–d; run the same behavior assertions against the full
   composed application. review each track adversarially before integration.
3. **refactor:** remove old paths and duplication; independently review geometry,
   content, lifecycle and all callers. rerun changed behavior plus the full
   temporary script and `./scripts/test` after the final application edits.
4. **delete:** remove temporary tests, fixtures and temporary dependencies; keep
   a brief observed-results note with candidate revision, browser/device and
   limitations. inspect final diff for test seams/legacy paths; rerun the static
   gate if tracked inputs changed. remove resolved tickets/register entries only
   after their acceptance passes. do not erase outstanding device acceptance.

each step requires independent adversarial review. assert actual destination
identity and hit ownership; css values/screenshots alone do not prove success.

## acceptance and explicit trade-offs

- isolated, 23/25px, 1/23px, coincident, dense-chain, mixed-lane and endpoint
  marks select their own destination/group at the painted center. real rects
  remain disjoint after resize, 200% zoom, input-mode and local-scope changes.
- preview/chooser are readable at viewport edges and short heights in overview, narrow
  detail, mobile inspector and offline reuse. cover sheet entry/drag, a newer
  modal, host removal, escape, tab, pointer transfer and focus return. native
  popover support must be verified on the actual browser/webview; no polyfill
  or old rendering branch. unsupported required runtime blocks completion.
- verify quote-only, note, multiple notes, missing note excerpt, geometry-only
  pdf highlight, long text and groups over three members. count and membership
  stay exact; existing note save/delete refresh updates both hosted instances.
- every available kind remains reachable by pointer and keyboard, including
  contents, embeds and current position. opening/hovering/dismissing produces
  no progress/activity mutation attributable to those interactions; unrelated
  scheduled flushes are not failures. activation uses existing navigation.
- fine-pointer precision trades target size for accurate selection; coarse and
  hybrid devices group more destinations to retain 24px minimum targets.
  group choice costs one extra click. exact centers have unique ownership;
  overlapping painted glyph pixels cannot. verify both centers at a dense
  group boundary. record physical touch/screen-reader results in the
  [existing acceptance ticket](tickets/reader-map-inert-position-and-mobile-controls.md).
- brackets replace cramped permanent count badges; counts remain on hover,
  focus and in the chooser. first-note/three-member summaries bound reading
  cost and explicitly disclose omissions.
- manual native popovers require supported browsers and explicit layer
  eligibility; active-only anchor sampling adds one rect read/frame while open.
  these replace fragile clipping/transform assumptions without a new framework.
- deleting tests gives up automated regression coverage; retain the concise
  acceptance record and canonical module contracts, as requested.

final state: one layout, presenter, popup owner and input contract; all callers
migrated. update reader/overlay contracts, including group span `<t` replacing
`<24px`. close the four linked tickets only after acceptance; unrelated missing
cutover documentation remains separately tracked.

platform basis: [manual popovers](https://html.spec.whatwg.org/multipage/popover.html),
[top-layer geometry](https://drafts.csswg.org/css-position-4/#top-layer-styling),
[browser support](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/showPopover#browser_compatibility).
