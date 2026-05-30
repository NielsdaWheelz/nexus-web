# Reader Table of Contents → sidecar — cutover spec

Status: proposed · Type: hard cutover (no legacy, no fallbacks, no back-compat)

## 1. Context & problem

The reader Table of Contents renders **inline, inside the scrolling document**. `MediaPaneBody`
passes a `ReaderContentsNav` node as the `contentsNav` prop of `TextDocumentReader`
(`MediaPaneBody.tsx` ~4690 for EPUB, ~4728 for web). `TextDocumentReader` mounts it as the
first child of `.textDocumentContainer`, *inside* `.documentViewport`
(`TextDocumentReader.tsx:83-85`). The TOC tree itself is a capped, independently scrolling box:

```
.tocTree { max-height: 300px; overflow-y: auto }   /* page.module.css:647-651 */
```

Consequences:

- **Two scrollbars.** `.documentViewport` (`overflow:auto`, `page.module.css:165-174`) is the
  intended single reader scroller. `.tocTree` is a second `overflow-y:auto` scroller nested inside
  it. When the TOC is expanded and taller than 300px, both scrollbars are visible at the top of the
  document — and the trackpad/wheel is captured by the inner box. This violates the reader's
  documented **single-scroll-owner** model (`reader-implementation.md`; the whole shell cascades
  `overflow:hidden` down to one `.documentViewport`).
- **Wrong home.** The TOC is navigation chrome living in the prose. The reader already has a
  dedicated secondary-surface system — the **`reader-tools` sidecar** (Highlights, Document chat) —
  plus an overview ruler. Navigation belongs there, not interleaved with body text.
- **Duplicated control surface.** Two near-identical "Contents" toolbar buttons (EPUB
  `MediaPaneBody.tsx:3802-3812`, web `3882-3891`) each toggle their own local boolean
  (`epubTocExpanded` :527, `webTocExpanded` :533), neither persisted.

This is the same anti-pattern as the transcript chapter/segment lists (`.chapterList`,
`.transcriptSegments`); this spec scopes **only the TOC** (see Non-goals).

## 2. Goals

1. The reader has exactly **one** scroll container again (`.documentViewport`); the TOC is no longer
   a nested scroller.
2. The TOC becomes a **`reader-tools` sidecar surface** ("Contents"), reusing the existing
   publication / open / close / resize / mobile-drawer machinery with **no new store actions, no new
   route config, no new layout primitives**.
3. TOC availability is **decoupled from highlights availability**: a document with a TOC but no
   highlights (e.g. focus mode on, or highlights disabled) still exposes Contents.
4. The two per-kind "Contents" toolbar toggles collapse to **one** behaviour that opens/closes the
   Contents sidecar surface, with correct `aria-pressed`.
5. Navigation behaviour (`navigateToSection` / `navigateToWebSection`, active-section tracking, EPUB
   internal links) is **reused verbatim** — this cutover changes no navigation or history code.
6. Hard cutover: the inline TOC path, its state, its styles, the `contentsNav` prop, the focus-mode
   sidecar-close effect, and the dead `tocWarning` state are **deleted and unreferenced**.

## 3. Non-goals

- Transcript `.chapterList` / `.transcriptSegments` nested scrollers — tracked separately; untouched
  here.
- The overview ruler, the Highlights surface, the Document chat surface, anchored highlight
  projection — unchanged.
- Doc-chat availability gating — unchanged (stays coupled to `showHighlightsPane`; see §8 D).
- TOC **data**: `/api/media/{id}/navigation`, `readerNavigation.ts` normalization, the TOC node
  shape — unchanged.
- **Pane-history / navigation routing** — `navigateToSection` / `navigateToWebSection` are reused
  verbatim; this cutover adds no history-routing change. Back/forward behaviour is exactly today's.
- Consolidating the two `SIDE_CAR_ICONS` maps (`SidecarPaneShell` + `MobileSidecarHost`) — pre-existing
  duplication, kept; the shared `Record<PaneSidecarIconId, …>` type already forces both to stay in sync.
- New TOC capabilities (search, collapse-subtree, drag, pinning). No speculative surface
  (`docs/rules/simplicity.md`).

## 4. Target behaviour

**Desktop**

- A reader with a TOC shows one **Contents** button in the pane toolbar (one button for both EPUB
  and web).
- Clicking **Contents**:
  - opens the `reader-tools` sidecar with **Contents** active, if the sidecar is closed or showing a
    different surface;
  - closes the sidecar, if **Contents** is already the active visible surface (toggle).
- The Contents surface is a sidecar tab beside **Highlights** and **Document chat**. The sidecar
  body is the single scroll owner for the TOC (`SidecarPaneShell .body { overflow:auto }`); the tree
  has **no** `max-height`/`overflow` of its own.
- Selecting an entry runs `navigateToSection` / `navigateToWebSection` **unchanged** (EPUB anchors
  included). All section-navigation and pane-history behaviour is identical to the current inline TOC
  because the same functions are called. The sidecar **stays open**; the active entry is marked
  `aria-current="location"` and follows scroll-driven active-section tracking.
- `.documentViewport` shows a single scrollbar. No TOC appears in the prose.

**Mobile**

- The **Contents** toolbar button opens the existing **mobile sidecar drawer**
  (`MobileSidecarHost`) with Contents active — the same drawer model already used for Highlights.
- Selecting an entry navigates **and closes the drawer** (so the reader is visible at the target).

**Availability**

- The Contents button and surface are published **iff the document has TOC nodes** (`hasEpubToc ||
  hasWebToc`). There is no separate empty/unavailable state: the surface is published only when nodes
  exist, so its body always has nodes to render. (The current `tocWarning` flag is dead state — never
  set true — and is deleted; see §8 I.)

## 5. Architecture & final state

```
PaneShell (bodyMode="document" → .body overflow:hidden)
└ TextDocumentReader
  └ .readerFrame
    └ .documentViewport (overflow:auto)         ← the ONE reader scroller
      └ readerSurface → .readerContentInner
        └ { error | loading | empty | .fragments }   ← TOC no longer here

reader-tools sidecar (desktop: SidecarPaneShell · mobile: MobileSidecarHost)
├ tab: Highlights        (unchanged)
├ tab: Contents          ← ReaderContentsNav tree (NEW surface)
└ tab: Document chat     (unchanged)
```

Ownership after cutover:

| Concern | Owner |
| --- | --- |
| TOC presence / visibility | `reader-tools` sidecar state (`open_sidecar`/`close_sidecar`) — **not** local component state, **not** a focus-mode effect |
| TOC scrolling | `SidecarPaneShell .body` (desktop) / `MobileSidecarHost` body (mobile) — single owner |
| TOC tree rendering | `ReaderContentsNav` (tree only; no heading/expanded wrapper) |
| TOC styling | co-located `ReaderContentsNav.module.css` — **not** `page.module.css` |
| Section/anchor navigation | `navigateToSection` / `navigateToWebSection` (unchanged) |
| Active-section tracking | `activeSectionId` / `activeWebSectionId` (unchanged) |
| Surface registry / sizing / icons | `paneSidecarModel.ts` + both `SIDE_CAR_ICONS` maps (type-synced) |

## 6. Capability contract & API design

### 6.1 New sidecar surface (registry + both icon maps)

`apps/web/src/lib/panes/paneSidecarModel.ts` — add one id and one registry entry. The
`satisfies Record<WorkspaceSidecarSurfaceId, …>` constraint makes the registry entry mandatory.

```ts
export type WorkspaceSidecarSurfaceId =
  | "reader-highlights"
  | "reader-doc-chat"
  | "reader-contents"          // + add
  | "conversation-references"
  | "conversation-forks"
  | "library-chat"
  | "library-intelligence";

export type PaneSidecarIconId =
  | "bar-chart-3"
  | "file-text"
  | "git-branch"
  | "highlighter"
  | "link-2"
  | "list-tree"                // + add
  | "message-square";

// in PANE_SIDECAR_SURFACES:
"reader-contents": {
  groupId: "reader-tools",
  title: "Contents",
  iconId: "list-tree",
},
```

Register the `ListTree` lucide icon in **both** icon maps (each is a
`Record<PaneSidecarIconId, …>`, so adding the union member fails typecheck until both are updated):

- `apps/web/src/components/workspace/SidecarPaneShell.tsx` (`SIDE_CAR_ICONS`, desktop).
- `apps/web/src/components/workspace/MobileSidecarHost.tsx` (`SIDE_CAR_ICONS`, mobile drawer).

No change to `PANE_SIDECAR_GROUP_BASE`: Contents joins `reader-tools` and inherits its width policy
(`default 360 / min 280 / max 720`). No `paneRouteModel` change: `media` already allows
`reader-tools`. No new store action: reuse `openSidecar` / `closeSidecar` /
`setActiveSidecarSurface` (`store.tsx` :468-529, exposed via `paneRuntime` :186-194).

### 6.2 Publication assembly (decoupled gating) — `MediaPaneBody`

Replace the single `showHighlightsPane ? { … } : null` descriptor with a **surface-driven** build, so
each surface gates independently and the descriptor publishes whenever ≥1 reader-tools surface
qualifies. `contentsAvailable = hasEpubToc || hasWebToc` (a media item is one kind, so at most one is
true).

```ts
const readerSidecarSurfaces = useMemo<PaneSidecarSurfacePublication[]>(() => {
  const surfaces: PaneSidecarSurfacePublication[] = [];
  if (showHighlightsPane) surfaces.push({ id: "reader-highlights", body: highlightsSurfaceBody });
  if (contentsAvailable)  surfaces.push({ id: "reader-contents",  body: contentsSurfaceBody });
  if (showHighlightsPane) surfaces.push({ id: "reader-doc-chat",  body: docChatSurfaceBody });
  return surfaces;
}, [showHighlightsPane, contentsAvailable, highlightsSurfaceBody, contentsSurfaceBody, docChatSurfaceBody]);

const readerSidecarDescriptor = useMemo<PaneSidecarPublication | null>(() =>
  readerSidecarSurfaces.length === 0
    ? null
    : {
        groupId: "reader-tools",
        // highlights stays the primary default; falls back to first available (Contents)
        defaultSurfaceId: showHighlightsPane ? "reader-highlights" : readerSidecarSurfaces[0].id,
        surfaces: readerSidecarSurfaces,
      },
  [readerSidecarSurfaces, showHighlightsPane]);

usePaneSidecar(readerSidecarDescriptor);
```

- **Tab order**: Highlights, Contents, Document chat. Highlights stays leftmost and default
  (the ruler's open button targets it). Contents sits second.
- **Delete the focus-mode close effect** (`MediaPaneBody.tsx` ~3905: the `useEffect` that calls
  `paneRuntime.closeSidecar()` whenever `showHighlightsPane` is false). With Contents decoupled, that
  effect would immediately re-close a Contents surface opened in focus mode. Hiding is already owned
  by the publish guards: when Highlights leaves the published set, `PaneShell`'s
  `surfaces.some(s => s.id === sidecar.activeSurfaceId)` check (`PaneShell.tsx:417-424`) and the
  equivalent `MobileSidecarHost` guard hide the sidecar with no imperative close.

### 6.3 `contentsSurfaceBody` + navigation wiring — `MediaPaneBody`

`contentsAvailable` gates publication, so the body always has nodes — no empty-state branch
(`docs/rules/control-flow.md`: no code paths for states that cannot occur).

```ts
const closeSidecarOnMobile = useCallback(() => {
  if (isMobileViewport) paneRuntime?.closeSidecar();
}, [isMobileViewport, paneRuntime]);

const contentsSurfaceBody = useMemo(() => (
  <div className={styles.readerSidecarBody}>
    {isEpub ? (
      <ReaderContentsNav
        nodes={epubToc ?? []}
        activeSectionId={activeSectionId}
        onNavigate={({ sectionId, anchorId }) => {
          navigateToSection(sectionId, anchorId);
          closeSidecarOnMobile();
        }}
      />
    ) : (
      <ReaderContentsNav
        nodes={webToc ?? []}
        activeSectionId={activeWebSectionId}
        onNavigate={({ sectionId }) => {
          navigateToWebSection(sectionId);
          closeSidecarOnMobile();
        }}
      />
    )}
  </div>
), [isEpub, epubToc, webToc, activeSectionId, activeWebSectionId,
    navigateToSection, navigateToWebSection, closeSidecarOnMobile]);
```

EPUB internal links (`resolveEpubInternalLinkTarget` → `navigateToSection`) remain on
`TextDocumentReader`'s `onInternalLinkClick` and are unaffected.

### 6.4 `ReaderContentsNav` — narrowed contract, relocated

Move to `apps/web/src/components/reader/ReaderContentsNav.tsx` (+ `ReaderContentsNav.module.css`) to
sit beside the other reader sidecar/chrome surfaces (`AnchoredHighlightsSidecar`,
`ReaderOverviewRuler`). Drop the `expanded`/`warning` props and the `<nav>`/heading wrapper — the
sidecar header supplies the "Contents" title and the open/closed state. It renders the navigable tree
only.

```ts
export default function ReaderContentsNav({
  nodes,
  activeSectionId,
  onNavigate,
}: {
  nodes: NormalizedNavigationTocNode[];
  activeSectionId: string | null;
  onNavigate: (target: { sectionId: string; anchorId: string | null }) => void;
}): JSX.Element;          // renders the recursive TocNodeList <ul> only
```

`TocNodeList`, `parseReaderNavigationHrefAnchorId`, `aria-current="location"` on the active link —
all preserved.

### 6.5 Consolidated toolbar control — `MediaPaneBody`

One button, shared by EPUB and web toolbars, replacing both local-state toggles:

```ts
const contentsSurfaceActive =
  activeReaderSidecarSurface === "reader-contents";   // activeReaderSidecarSurface already derived ~3230

const toggleContents = useCallback(() => {
  if (contentsSurfaceActive) paneRuntime?.closeSidecar();
  else paneRuntime?.openSidecar("reader-contents");
}, [contentsSurfaceActive, paneRuntime]);

const contentsToolbarButton = contentsAvailable ? (
  <Button
    variant="ghost"
    size="sm"
    leadingIcon={<ListTree size={16} aria-hidden="true" />}
    onClick={toggleContents}
    aria-pressed={contentsSurfaceActive}
  >
    Contents
  </Button>
) : null;
```

`openSidecar("reader-contents")` both reveals the sidecar and sets the active surface in one action
(`store.tsx:468-499`), so the toggle works from closed, from another surface, and from Contents-active.

### 6.6 Styling & scroll ownership

- `ReaderContentsNav.module.css` owns `.tocList`, `.tocItem`, `.tocLink`, `.tocActive`, `.tocLabel`
  (carried over verbatim from `page.module.css`).
- The tree wrapper has **no** `max-height` and **no** `overflow` — scrolling is owned by the sidecar
  body. This is the change that eliminates the second scrollbar.
- `.documentViewport` and the reader surface classes are unchanged.

## 7. How it composes with other systems

- **Sidecar runtime**: identical contract to Highlights/Doc-chat — `usePaneSidecar` publication,
  `SidecarPaneShell` tabs + resize, `MobileSidecarHost` drawer rendering `mobileBody ?? body` (we
  supply only `body`; the tree is mobile-safe).
- **Overview ruler**: independent. Ruler opens Highlights; the toolbar opens Contents. Both route
  through `paneRuntime` → store. Ruler/fixed-chrome publication is untouched.
- **Pane history**: section/TOC jumps reuse `navigateToSection` / `navigateToWebSection` verbatim, so
  history behaviour (per `reader-implementation.md` §pane history, driven downstream by
  `useReaderTarget`) is byte-for-byte the current behaviour. This cutover adds no routing change.
- **Focus mode**: Highlights/Doc-chat are still hidden when `focusModeEnabled` (via
  `showHighlightsPane`), but the imperative sidecar-close effect is **removed**; the sidecar's
  visibility now follows surface availability through the publish guards. Contents remains available
  and stays open in focus mode. The "Focus mode enabled: highlights pane hidden" pill is unchanged.
- **Pane sizing**: Contents uses the `reader-tools` sidecar width policy; sidecar width stays
  independent of primary reader width (`reader-implementation.md` §workspace pane sizing). No primary
  reflow when Contents opens.

## 8. Key decisions

| # | Decision | Why |
| --- | --- | --- |
| A | TOC is a **sidecar surface**, not fixed chrome or inline | Reuses the existing on-demand secondary-surface system; the ruler's fixed ~28px chrome is too narrow for chapter labels. |
| B | Reuse the **`reader-tools`** group (no new group) | TOC is a reader tool beside Highlights/Doc-chat; inherits width policy and route allowance. |
| C | **Decouple** Contents availability from `showHighlightsPane`; build the publication per-surface **and delete the focus-mode close effect** | A TOC-bearing document with no highlights (or focus mode on) must still expose Contents; the close effect would otherwise re-close it instantly. Publish guards already own hide/show. |
| D | Leave **doc-chat** gating as-is (coupled to `showHighlightsPane`) | Out of scope; no behaviour change, no speculative refactor (`simplicity.md`). |
| E | **Toggle** semantics on one consolidated button (open if not active, close if active) | Preserves the "press to show/hide" affordance of the two deleted buttons, as one owner. |
| F | Highlights stays **default + leftmost**; Contents is second | The ruler is the primary highlights entry point; minimise change to the default-open surface. |
| G | **Relocate** `ReaderContentsNav` to `components/reader/` + own CSS module | Co-locates all reader sidecar/chrome surfaces; moves TOC styles out of the page module (one owner). |
| H | Mobile: navigating from Contents **closes the drawer** | The reader must be visible at the jump target; matches drawer dismissal expectations. |
| I | **Delete** dead `tocWarning` state; no empty-state branch | `tocWarning` is never set true (only reset false) — dead state. `contentsAvailable` ⟹ nodes exist, so the unavailable branch can't occur (`cleanliness.md` dead code; `control-flow.md` impossible branches). |

## 9. Scope

**In scope**: the TOC surface registration (+ both icon maps), the decoupled publication, deletion of
the focus-mode close effect, `contentsSurfaceBody`, the consolidated toolbar button, `ReaderContentsNav`
narrowing + relocation, deletion of the inline path / its state / styles / dead `tocWarning`, the test
update, and the `reader-implementation.md` update.

**Out of scope**: transcript nested scrollers; doc-chat gating; navigation/data internals; ruler;
projection; persistence model; icon-map consolidation.

## 10. Files

**New**
- `apps/web/src/components/reader/ReaderContentsNav.tsx` — narrowed tree renderer (moved).
- `apps/web/src/components/reader/ReaderContentsNav.module.css` — `.tocList/.tocItem/.tocLink/.tocActive/.tocLabel`.
- `apps/web/src/components/reader/ReaderContentsNav.test.tsx` — relocated behaviour test (click node → `onNavigate` with parsed anchor).

**Modified**
- `apps/web/src/lib/panes/paneSidecarModel.ts` — add `reader-contents` id, `list-tree` icon id, registry entry.
- `apps/web/src/components/workspace/SidecarPaneShell.tsx` — add `ListTree` to `SIDE_CAR_ICONS`.
- `apps/web/src/components/workspace/MobileSidecarHost.tsx` — add `ListTree` to its `SIDE_CAR_ICONS`.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` — surface-driven publication;
  delete focus-mode close effect; `contentsSurfaceBody`; `toggleContents` + single `contentsToolbarButton`
  in both toolbars; remove `epubTocExpanded`/`webTocExpanded`, `tocWarning`, and their resets; remove
  the `contentsNav` props.
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx` — remove the `contentsNav`
  prop and its render slot; collapse the redundant `.textDocumentContainer` wrapper.
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx` — drop the
  `ReaderContentsNav` import, the `contentsNav` prop fixtures, and the "renders source-backed contents
  navigation…" test.
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css` — delete the TOC section
  (`.tocSection/.tocHeading/.tocWarning/.tocTree/.tocList/.tocItem/.tocLink/.tocActive/.tocLabel` +
  the `.tocSection > .tocTree > .tocList` and mobile `.tocTree` rules) and `.textDocumentContainer`.
- `docs/reader-implementation.md` — document Contents as a `reader-tools` surface.

**Deleted**
- `apps/web/src/app/(authenticated)/media/[id]/ReaderContentsNav.tsx` — relocated (old path unreferenced).

## 11. Deletion / cutover list (hard cutover — must end unreferenced)

- `epubTocExpanded`, `setEpubTocExpanded`, `webTocExpanded`, `setWebTocExpanded` — all declarations,
  setters, toggles, and the media-change resets.
- `tocWarning`, `setTocWarning`, and its reset (dead state).
- The focus-mode `useEffect` that closes `reader-tools` when `!showHighlightsPane` (~`MediaPaneBody.tsx:3905`).
- The two old "Contents" toolbar buttons (EPUB ~3802-3812, web ~3882-3891).
- Both `contentsNav={ … <ReaderContentsNav … expanded=… /> }` props (~4690-4701, ~4728-4737).
- `TextDocumentReader`'s `contentsNav` prop (type + destructure + the `{contentsNav}` slot) and the
  `.textDocumentContainer` wrapper.
- In `TextDocumentReader.test.tsx`: the `./ReaderContentsNav` import, the `contentsNav` prop fixtures
  (default + the centered-column case), and the "renders source-backed contents navigation…" test.
- The old `ReaderContentsNav.tsx` under `media/[id]/`.
- `page.module.css`: the entire "Reader Table of Contents" block and `.textDocumentContainer`.
- The `expanded` / `warning` props of `ReaderContentsNav`.

## 12. Acceptance criteria

1. Opening an EPUB or web article with a TOC shows **one** scrollbar in `.documentViewport`; no TOC
   renders inside the prose; `data-testid="document-viewport"` has no descendant `overflow:auto`.
2. The pane toolbar shows a single **Contents** button iff `hasEpubToc || hasWebToc`; absent otherwise.
3. Clicking **Contents** opens the `reader-tools` sidecar with the Contents tab active; clicking it
   again closes the sidecar. `aria-pressed` tracks "Contents active and visible".
4. Selecting a TOC entry performs the **same** navigation as the current inline TOC (same
   `navigateToSection`/`navigateToWebSection` calls, EPUB anchors included); pane-history/Back behaviour
   is unchanged from today.
5. With focus mode enabled (Highlights/Doc-chat hidden), **Contents remains available**, opens, and
   **stays open** (the former focus-mode auto-close effect is gone).
6. On mobile, Contents opens the existing sidecar drawer; selecting an entry navigates **and** closes
   the drawer.
7. Resizing the sidecar resizes Contents within the `reader-tools` policy (280–720px); the primary
   reader width does not change when Contents opens/closes.
8. `rg "epubTocExpanded|webTocExpanded|tocWarning|contentsNav|textDocumentContainer|tocTree|tocSection"`
   returns **no** matches in `apps/web/src`.
9. `rg "ReaderContentsNav" apps/web/src` resolves only to `components/reader/ReaderContentsNav.tsx`,
   `components/reader/ReaderContentsNav.test.tsx`, and the import in `MediaPaneBody.tsx` — **no** match
   under `app/(authenticated)/media/[id]/`.
10. Type check passes: the `satisfies Record<…>` on the surface registry guarantees the new id is
    fully wired, and **both** `SIDE_CAR_ICONS` `Record<PaneSidecarIconId, …>` maps (`SidecarPaneShell`,
    `MobileSidecarHost`) include `list-tree`.
11. `npm run lint`, typecheck, and the reader test suite pass; no dead exports remain.

## 13. Rules adhered to (`docs/rules/`)

- **cleanliness**: inline TOC path, dead `tocWarning`, the focus-mode close effect, old file, styles,
  and broken test usages are deleted and unreferenced; no dual old/new path; TOC styling collapses to
  one owner.
- **control-flow**: no empty-state branch for an impossible state; no catch-all.
- **module-apis**: one TOC capability in one form (a sidecar surface); no duplicate nav mechanism.
- **simplicity**: fewer code paths (one toolbar button vs two; one publication build; no dead flag);
  no speculative TOC features.
- **conventions**: reuse existing width policy / group rather than new constants; no magic numbers
  introduced (sidecar sizing already centralised).

## 14. Cutover steps (ordered)

1. Register the surface + icon: `paneSidecarModel.ts`, **and both** `SIDE_CAR_ICONS` maps
   (`SidecarPaneShell.tsx`, `MobileSidecarHost.tsx`). Type check.
2. Relocate + narrow `ReaderContentsNav` and add its CSS module; add `ReaderContentsNav.test.tsx`.
3. In `MediaPaneBody`: add `contentsAvailable`, `contentsSurfaceBody`, the surface-driven publication,
   `toggleContents`, and the single `contentsToolbarButton`; wire it into both toolbars.
4. Remove the inline TOC: delete `contentsNav` props, `TextDocumentReader.contentsNav` + slot,
   `.textDocumentContainer`, and the two old toolbar buttons.
5. Delete `epubTocExpanded`/`webTocExpanded` + resets, `tocWarning` + reset, and the focus-mode
   sidecar-close effect.
6. Update `TextDocumentReader.test.tsx`; delete the TOC CSS block in `page.module.css`; delete the old
   `ReaderContentsNav.tsx`.
7. Update `reader-implementation.md`.
8. Verify against §12 (incl. the `rg` checks) on desktop + mobile, EPUB + web, focus-mode on/off.

## 15. Risks & mitigations

- **Persisted active surface = a now-removed surface** (e.g. focus mode hides Highlights): handled by
  the `PaneShell` / `MobileSidecarHost` publish guards — sidecar self-hides; no crash, no imperative
  close needed.
- **`defaultSurfaceId` not in the published set**: guarded by computing it from the assembled list
  (`showHighlightsPane ? "reader-highlights" : surfaces[0].id`).
- **Icon-map drift**: both `SIDE_CAR_ICONS` maps are `Record<PaneSidecarIconId, …>`; omitting
  `list-tree` from either is a compile error.
- **Active-section highlight drift in the sidecar**: `activeSectionId`/`activeWebSectionId` already
  update from scroll tracking; the surface body closes over them, so the active row updates on
  re-render exactly as the inline TOC did.

## 16. Docs to update

`docs/reader-implementation.md`: add **Contents** to the `reader-tools` sidecar surfaces (alongside
Highlights and Document chat); state it is on-demand (toolbar toggle, not always-on like the ruler),
available independent of highlights, mobile via the same drawer, navigation behaviour unchanged, and
that the reader prose has a single scroll owner.
