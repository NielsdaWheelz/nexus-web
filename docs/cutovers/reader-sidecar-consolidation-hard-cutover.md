# Reader Sidecar: Six Surfaces Become Two — Hard Cutover

**Status:** BUILT · outer-surface consolidation complete · 2026-07-20
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims.

## Current state and supersession

> **Superseded (2026-07-22):** the reader quote-to-chat mechanism described here
> — §4.5's `startResourceChat("highlight:<id>")` / the conversation pane carrying
> quote identity via `chat_subject`, and the implied claim that a context
> `ResourceEdge` substitutes for per-turn subject state — is replaced by the
> immutable per-message reader-selection snapshot. See
> [`reader-highlight-quote-chat-hard-cutover.md`](reader-highlight-quote-chat-hard-cutover.md).
> This document's outer-surface consolidation (two reader-tools surfaces, the
> Evidence merge) is unaffected.

The surviving reader-tools surfaces are exactly `reader-contents` and
`reader-evidence`; the five retired surface ids in this document remain dead.
`EvidencePaneSurface` and `MarginRail` are the current presenters.

The approved
[`reader-evidence-scope-associations-hard-cutover.md`](reader-evidence-scope-associations-hard-cutover.md)
supersedes this document's storage-shaped `EvidenceRow` union, three coarse
filters, and sidecar alignment behavior. This document remains authoritative
only for the completed outer-surface consolidation and deleted surface ids.
Prerequisite language and deleted component names below are historical cutover
context, not current implementation guidance.

## One-line

Collapse the six reader-tools secondary surfaces (Contents, Highlights, Embeds,
Citations, Connections, Chat) into two: **Contents** unchanged, and a new
**Evidence** surface that merges highlights, source-authored citations, and graph
connections into one locator-ordered, filterable sidecar list.

---

## 0. Prerequisites (hard, no fallback)

**P-1. `web-article-inline-embeds-hard-cutover` is shipped** (commit `d7ec06ca`).
Inline embeds render as typed slots in the document body. The `reader-embeds`
Document Map tab exists only as an inspection lens; this cutover removes it
because there is nothing to navigate to that the body does not already show.

**P-2. `resource-chat-subject-hard-cutover` is built** (status BUILT 2026-06-16).
`startResourceChat(subjectRef, companionRefs)` in
`apps/web/src/lib/resources/resourceChat.ts` creates a conversation with context
refs. `ResourceChatTab` and `ResourceChatDetail` survive as generic components.
`openInNewPane` on `paneRuntime` opens a conversation pane. These are the exact
primitives the new "G to chat" verb uses.

**P-3. `incoming-connections-reader-sidecar-hard-cutover` is implemented** (status
IMPLEMENTED). `AnchoredSidecarSurface<T>` (generic, `renderRow` dispatch),
`ReaderDocumentMapConnectionsLens.tsx`, and `ReaderDocumentMapCitationsLens.tsx`
all exist. `READER_CONNECTION_ORIGINS` in
`python/nexus/services/reader_connections.py` already includes `synapse`.

**P-4. `machine-hand-hard-cutover` (#1 in the sibling slate) must land before this
cutover ships.** Synapse connection rows in the Evidence pane render their
rationale text through `MachineText` (inline mode, `origin="Synapse"`). The
component and its `--font-machine`/`--ink-machine` tokens do not exist yet.

---

## 1. Problem

### 1.1 Six surfaces, one ontological thing

`PANE_SECONDARY_SURFACE_DEFINITIONS` in
`apps/web/src/lib/panes/paneSecondaryModel.ts` (lines 33–99) lists six surfaces
under the `"reader-tools"` group (titled "Document Map",
`paneSecondaryModel.ts:12`):

| Surface ID | Title | Icon |
|---|---|---|
| `reader-contents` | Contents | list-tree |
| `reader-highlights` | Highlights | highlighter |
| `reader-embeds` | Embeds | file-text |
| `reader-apparatus` | Citations | quote |
| `reader-connections` | Connections | link-2 |
| `reader-resource-chat` | Chat | file-text |

Three of those — Highlights, Citations, Connections — answer the same question:
*what is this passage connected to?* They share anchoring (each uses
`AnchoredSidecarSurface<T>`) and the same document-position coordinate space
(`document_order_key` / `document_fraction` on every `ReaderDocumentMapItem`).
They are rendered as three bureaucracies because they accreted one at a time.

Embeds went inline (`d7ec06ca`). The `reader-embeds` surface
(`MediaPaneBody.tsx:5635–5640`) is gated on `documentMapEmbedItems.length > 0`
and appears only to browse a list that duplicates what is already visible in the
body. It has no value as a navigation surface.

Chat is not an annotation on the text. The `reader-resource-chat` surface
(`MediaPaneBody.tsx:5663–5715`) is an inline mini-chat — `ResourceChatTab` /
`ResourceChatDetail` — embedded in the Document Map. The resource-chat-subject
cutover built the right model: `startResourceChat("media:<id>")` creates a
conversation with the resource as subject, opened via `openInNewPane`. Keeping a
mini-chat tab in the sidecar is a second chat UI owner.

### 1.2 The default-surface priority chain is broken

`defaultDocumentMapSurface` (`MediaPaneBody.tsx:4010–4018`) falls through:
`reader-contents` → `reader-embeds` → `reader-highlights` → `reader-apparatus`
→ `reader-resource-chat`. A document with embeds but no ToC defaults to the Embeds
tab, not Highlights. A document with no ToC, no embeds, no highlights, and no
apparatus defaults to Chat — not connections. The chain has no principled order.

### 1.3 Mobile tabs multiply

`MobileSecondaryPaneHost.tsx` renders `SecondarySurfaceTabs` over the published
surfaces inside a `MobileSheet`. Six tabs on a phone is unusable. Two tabs
(Contents, Evidence) is a usable mobile Document Map.

---

## 2. Target behavior (user-facing)

Opening a document shows a Document Map secondary pane with exactly two tabs:
**Contents** and **Evidence**.

**Contents** is unchanged: ToC for EPUB/web articles, section headers.

**Evidence** is one sidecar. All highlights, source-authored citations, and graph
connections for the current reader context appear in a single list sorted by
document position. A header row offers three quiet text filter toggles (no chips,
no pills): **Highlights · Citations · Connections**. Toggling hides rows of that
kind; the default is all visible.

Machine-generated connection rows (Synapse, `origin="synapse"`) render their
rationale in `MachineText` inline mode with `origin="Synapse"`. A dismiss button
on each Synapse row fires the existing suppression endpoint.

Opening the Document Map when no Contents are available defaults to Evidence.

Pressing `G` (the keyboard verb for Document Map) opens the map to the last
active surface, or defaults to Contents → Evidence. A new `G c` chord (or action
menu item "Chat about this") calls `startResourceChat("media:<id>")` and opens a
conversation pane via `openInNewPane` — it does not open a secondary surface.

On mobile, the secondary sheet shows two tabs: Contents and Evidence. The embed
inspection capability is gone (embeds are inline). Chat from mobile follows the
same `openInNewPane` verb.

---

## 3. Goals / Non-goals

### Goals

G1. Exactly two `reader-tools` surfaces after cutover: `reader-contents` and
`reader-evidence`.

G2. Evidence shows highlights + apparatus + connections in one
`AnchoredSidecarSurface`, merged by `document_order_key`.

G3. Kind filters are quiet text toggles in the Evidence header — no pill chips.

G4. Machine rows (synapse) render through `MachineText` inline; dismissal-with-memory
uses the existing `synapse_suppressions` endpoint.

G5. Remove the inline reader mini-chat tab. Chat from reader opens a full
conversation pane.

G6. Remove the `reader-embeds` tab. Inline embed inspection belongs in the body.

G7. Default surface is Contents when available, otherwise Evidence.

G8. Mobile: two tabs, unchanged `MobileSecondaryPaneHost` / `MobileSheet` plumbing.

G9. Backend document map API is **unchanged** — it still returns all six lens
IDs, all item kinds, and all markers. The consolidation is purely frontend.

G10. The `ReaderDocumentMapLensId` TypeScript union and backend Literal are
unchanged. The `readerSurfaceForLens()` helper maps three lenses to
`"reader-evidence"` and two to `null`.

G11. No new API routes, no migration, no new backend files.

### Non-goals

N1. No redesign of the Contents surface.
N2. No change to the overview rail marker rendering (markers from all lenses
remain visible on the rail; clicks route to `reader-evidence` for evidence
markers).
N3. No new connection kinds or origins.
N4. No machine-output-in-place behavior (sibling #10 scope).
N5. No removal of the backend `"chat"` and `"embeds"` lenses or their item types.
N6. No pagination for the Evidence pane in this slice (document map is already
bounded).

---

## 4. Architecture and final state

### 4.1 Surface model final state

```text
PANE_SECONDARY_SURFACE_DEFINITIONS — reader-tools group after cutover:

  reader-contents   title: "Contents"    iconId: "list-tree"
  reader-evidence   title: "Evidence"    iconId: "link-2"       ← NEW
```

The five removed IDs (`reader-highlights`, `reader-embeds`, `reader-apparatus`,
`reader-connections`, `reader-resource-chat`) are deleted from the const array.
Any place in the codebase that references those string literals is a compile
error after the type narrowing. Five entries become two.

### 4.2 Lens-to-surface mapping

```ts
// MediaPaneBody.tsx — readerSurfaceForLens (final form)
function readerSurfaceForLens(lensId: ReaderDocumentMapLensId) {
  switch (lensId) {
    case "contents":
      return "reader-contents";
    case "highlights":
    case "citations":
    case "connections":
      return "reader-evidence";
    case "embeds":
    case "chat":
      return null; // no secondary surface; markers scroll body
  }
}
```

`ReaderDocumentMapLensId` type is not narrowed; lenses without a surface mapping
return `null`, and callers that need a surface treat `null` as "do not open
secondary pane".

### 4.3 Default surface

```ts
// MediaPaneBody.tsx — defaultDocumentMapSurface (final form)
const defaultDocumentMapSurface: WorkspaceSecondarySurfaceId =
  contentsAvailable ? "reader-contents" : "reader-evidence";
```

### 4.4 EvidencePaneSurface component

New component:
`apps/web/src/components/reader/document-map/EvidencePaneSurface.tsx`

Props contract:

```ts
export type EvidenceRowKind = "highlight" | "apparatus" | "connection";

export interface EvidenceFilterState {
  highlight: boolean;
  apparatus: boolean;
  connection: boolean;
}

export interface EvidencePaneSurfaceProps {
  contentRef: React.RefObject<HTMLElement | null>;
  // All three sources; component merges and sorts internally
  highlights: MediaHighlight[];
  pdfDocumentHighlights: PdfHighlightOut[];
  readerApparatusRows: ReaderApparatusRow[];
  connectionRows: ReaderConnectionRow[];
  // Existing rendering dependencies
  readerApparatus: ReaderApparatusResponse | null;
  readerApparatusItemIdsForRow: (rowId: string | null) => string[];
  focusedApparatusItemId: string | null;
  focusedHighlightId: string | null;
  isReflowable: boolean;
  isEditingBounds: boolean;
  hoveredId: string | null;
  canQuoteToChat: boolean;
  // Loading / error state from the document map resource
  loading: boolean;
  error: FeedbackContent | null;
  measureKey: string | number;
  layoutVersion: number;
  isMobile: boolean;
  isPdf: boolean;
  // Highlight interaction callbacks (forwarded from MediaPaneBody; match
  // the ReaderDocumentMapHighlightsLens contract exactly, with
  // onQuoteToNewChat/onQuoteToExtantChat merged into onQuoteToChat)
  onHighlightClick: (id: string, event: MouseEvent) => void;
  onFocusHighlight: (highlightId: string) => void;
  onHoverHighlight: (highlightId: string | null) => void;
  onQuoteToChat: (highlightId: string) => void;
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  onDelete: (highlightId: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    clientMutationId: string
  ) => Promise<HighlightLinkedNoteBlock>;
  onNoteDelete: (
    highlightId: string,
    noteBlockId: string,
    clientMutationId: string,
    shouldApply: () => boolean
  ) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
  onOpenNoteLink: (href: string, options: { newPane: boolean }) => void;
  // Apparatus + connection callbacks
  onApparatusItemClick: (itemId: string, event: MouseEvent) => void;
  onOpenConnectionSource: (row: ReaderConnectionRow, event?: MouseEvent) => void;
  onActivateConnectionTarget: (row: ReaderConnectionRow) => void;
  // Synapse dismiss (new UI — dismiss button is not present in
  // ReaderDocumentMapConnectionsLens; this is added in S5)
  onDismissSynapse: (edgeId: string) => void;
}
```

Rendering contract:

- Builds an `EvidenceRow[]` union from all three sources, each tagged with
  `kind: EvidenceRowKind`.
- Sorts by `stable_order_key` composed from `document_order_key` from
  `ReaderDocumentMapItem` (for apparatus and connections, the item's
  `document_fraction` is used as a sort tie-breaker when no fragment anchor
  exists; highlights use the existing `stable_order_key` from
  `toTextAnchoredReaderRow` / `toPdfAnchoredReaderRow`).
- Applies `filter` state (each kind independently togglable).
- Passes merged `anchoredRows: AnchoredReaderRow[]` to a single
  `AnchoredSidecarSurface<EvidenceRow>`.
- `renderRow` dispatches on `row.kind`:
  - `"highlight"`: existing highlight card rendering (color chip, exact, linked
    notes/conversations — same as `ReaderDocumentMapHighlightsLens`).
  - `"apparatus"`: existing apparatus row rendering (`ReaderDocumentMapCitationsLens`
    style — citation marker, body_text preview, target link).
  - `"connection"`: existing connection row rendering
    (`ReaderDocumentMapConnectionsLens` style — source category icon, title,
    excerpt; Synapse origin renders rationale through `MachineText` inline with
    `origin="Synapse"`; Synapse rows carry a dismiss button).

The header inside `EvidencePaneSurface`:

```tsx
<header>
  <h2>Evidence</h2>
  <nav aria-label="Evidence filter">
    <button onClick={() => toggle("highlight")}
            aria-pressed={filter.highlight}>Highlights</button>
    <button onClick={() => toggle("apparatus")}
            aria-pressed={filter.apparatus}>Citations</button>
    <button onClick={() => toggle("connection")}
            aria-pressed={filter.connection}>Connections</button>
  </nav>
</header>
```

No pill chips. `aria-pressed` toggles. Style: plain text, same weight as body
copy. Active state is an underline or weight change, not a filled badge.

### 4.5 Chat verb replacement

`revealResourceChatSecondary` and `openResourceChat` in `MediaPaneBody.tsx`
(lines 3599–3610) are deleted.

Replacement: one `openChatForMedia` callback:

```ts
const openChatForMedia = useCallback(async () => {
  const conversationId = await startResourceChat(`media:${id}`);
  openInNewPane?.(`/conversations/${conversationId}`, "Chat");
}, [id, openInNewPane]);
```

`Shift+G` (`g c` chord or action menu "Chat") calls `openChatForMedia`. Quote-to-chat
(highlight action verb) works the same way: `startResourceChat("highlight:<id>")`,
open the returned conversation.

Pending quote state (`pendingQuoteUri`, `pendingQuoteLabel`,
`pendingQuoteSelection`, `secondaryChat`) is removed entirely — the conversation
pane carries the quote identity via `chat_subject`.

`resourceChatSurfaceActivatedRef` is removed.

### 4.6 Surface publication in MediaPaneBody

Final `readerSecondarySurfaces` memo builds exactly:

```ts
const surfaces: PaneSecondarySurfacePublication[] = [];
if (contentsAvailable) {
  surfaces.push({ id: "reader-contents", body: contentsSurfaceBody });
}
surfaces.push({
  id: "reader-evidence",
  body: (
    <div className={styles.readerSecondaryBody}>
      <EvidencePaneSurface
        contentRef={isPdf ? pdfContentRef : contentRef}
        highlights={mediaHighlights}
        pdfDocumentHighlights={pdfDocumentHighlights}
        readerApparatusRows={readerApparatusRows}
        connectionRows={readerConnectionRows}
        readerApparatus={readerApparatus}
        readerApparatusItemIdsForRow={readerApparatusItemIdsForRow}
        focusedApparatusItemId={focusedApparatusItemId}
        focusedHighlightId={focusState.focusedId}
        isReflowable={isReflowable}
        isEditingBounds={isEditingBounds}
        hoveredId={hoveredHighlightId}
        canQuoteToChat={canQuoteToChat}
        loading={readerDocumentMapResource.status === "loading"}
        error={documentMapConnectionsError}
        measureKey={documentMapConnectionsMeasureKey}
        layoutVersion={pdfHighlightsPaneState.version}
        isMobile={isMobileViewport}
        isPdf={isPdf}
        onHighlightClick={handleHighlightClick}
        onFocusHighlight={handleFocusHighlight}
        onHoverHighlight={handleHoverHighlight}
        onQuoteToChat={quoteHighlightToChat}
        onColorChange={handleHighlightColorChange}
        onDelete={handleHighlightDelete}
        onStartEditBounds={handleStartEditBounds}
        onCancelEditBounds={handleCancelEditBounds}
        onNoteSave={handleHighlightNoteSave}
        onNoteDelete={handleHighlightNoteDelete}
        onOpenConversation={handleOpenConversation}
        onOpenNoteLink={handleOpenNoteLink}
        onApparatusItemClick={handleReaderApparatusItemClick}
        onOpenConnectionSource={handleOpenReaderConnectionSource}
        onActivateConnectionTarget={handleActivateReaderConnectionTarget}
        onDismissSynapse={handleDismissSynapse}
      />
    </div>
  ),
});
return surfaces;
```

`showHighlightsPane`, `showApparatusPane`, `documentMapEmbedItems` guards are
removed. Evidence is always published; it shows an empty state when no rows
exist.

---

## 5. Data model / migration

None. The backend document map API, `reader_apparatus_*` tables,
`resource_edges`, `synapse_suppressions`, highlights tables, and connection
schemas are unchanged.

---

## 6. API

No new or changed API routes. All data for the Evidence pane comes from the
existing `GET /api/media/{id}/document-map` response and the existing highlights
response already fetched by `MediaPaneBody`.

---

## 7. Frontend

### 7.1 paneSecondaryModel.ts

Remove five entries from `PANE_SECONDARY_SURFACE_DEFINITIONS`:
`reader-highlights`, `reader-embeds`, `reader-apparatus`,
`reader-connections`, `reader-resource-chat`.

Add one entry:

```ts
{
  id: "reader-evidence",
  groupId: "reader-tools",
  title: "Evidence",
  iconId: "link-2",
},
```

`WorkspaceSecondarySurfaceId` type narrows automatically via `satisfies`.

### 7.2 documentMap.ts

`ReaderDocumentMapLensId` type is unchanged. Add helper:

```ts
export function readerSurfaceForLens(
  lensId: ReaderDocumentMapLensId,
): "reader-contents" | "reader-evidence" | null {
  switch (lensId) {
    case "contents": return "reader-contents";
    case "highlights":
    case "citations":
    case "connections": return "reader-evidence";
    case "embeds":
    case "chat": return null;
  }
}
```

Move `readerSurfaceForLens` out of `MediaPaneBody.tsx` (where it is inlined)
into `documentMap.ts` so tests can cover it independently.

### 7.3 MediaPaneBody.tsx

- Delete `readerSurfaceForLens` local function (moved to `documentMap.ts`).
- Delete `revealResourceChatSecondary`, `openResourceChat`,
  `openChatInSecondary`, `startChatInSecondary`.
- Delete `secondaryChat`, `pendingQuoteUri`, `pendingQuoteLabel`,
  `pendingQuoteSelection`, `resourceChatSurfaceActivatedRef` state/refs.
- Delete the `useEffect` at lines 4375–4397 that managed chat surface activation.
- Replace `quoteHighlightToNewChat` and `quoteHighlightToExtantChat` with a
  single `quoteHighlightToChat(highlightId)` that calls
  `startResourceChat("highlight:<id>")` and opens a conversation pane. Update
  all callers (lines 5500, 5534, 6021, 6145, 6181) and collapse `onQuoteToNewChat`
  / `onQuoteToExtantChat` props to `onQuoteToChat` in every downstream component.
- Add `handleDismissSynapse` callback: calls `dismissSynapseEdge(edgeId)` from
  `lib/synapse.ts` and then refreshes `readerDocumentMapResource`. This is new
  behavior — `ConnectionRowCard` in `ReaderDocumentMapConnectionsLens` has no
  dismiss button; the dismiss button on Synapse rows in `EvidencePaneSurface` is
  built in S5.
- At `activateDocumentMapMarker` (line 5265), guard the surface call after
  `readerSurfaceForLens` is updated to return `null` for `embeds` and `chat`:
  `const surface = readerSurfaceForLens(lensId); if (surface) requestSecondarySurface?.(surface);`
- `openDocumentMap` uses `defaultDocumentMapSurface` (now
  `contentsAvailable ? "reader-contents" : "reader-evidence"`).
- Replace the five-entry surface publication with the two-entry publication
  above.
- Import `EvidencePaneSurface` and `readerSurfaceForLens` from their new owners.
- Import `ResourceChatTab`, `ResourceChatDetail`, `resourceChatStyles` imports
  are deleted.

### 7.4 EvidencePaneSurface.tsx (new)

`apps/web/src/components/reader/document-map/EvidencePaneSurface.tsx`

Builds the unified evidence row list from three sources, hosts the filter toggle
state, wraps a single `AnchoredSidecarSurface<EvidenceRow>`, dispatches per-kind
rendering. See §4.4 for full contract.

Module CSS: `EvidencePaneSurface.module.css` — filter nav uses `display: flex;
gap: var(--space-3); font-size: var(--text-sm)`. No pill chip styles.

### 7.5 Keyboard

`openResourceChat` (Shift+G / action menu item) is replaced by
`openChatForMedia`. The action still appears in the reader's action menu under
the label "Chat about this document"; its handler now opens a new pane rather
than a secondary surface.

Keyboard chord table after cutover:

| Chord | Action |
|---|---|
| `G` (bare) | Toggle Document Map to last active surface (default: Contents → Evidence) |
| `G c` | Chat — calls `openChatForMedia`; opens a new conversation pane |
| `G e` | Evidence — calls `requestSecondarySurface("reader-evidence")` |

Contents has no dedicated chord; it is the default surface and is reached by
`G` alone when available. Add an AC that tests all three verbs independently.

### 7.6 Deep-link / publishSecondarySurface callers

Callers of `requestSecondarySurface?.("reader-apparatus")` (line 3356, 3794) and
`requestSecondarySurface?.("reader-highlights")` must be updated to
`requestSecondarySurface?.("reader-evidence")`.

Callers of `requestSecondarySurface?.("reader-resource-chat")` (line 3600) are
deleted (replaced by `openChatForMedia`).

The deep-link surface routing uses `paneRouteAllowsSecondarySurface` which
resolves through `getSecondaryGroupForSurface`. Old surface IDs removed from the
model will not be resolvable. When the stored `activeSurfaceId` is not a valid
`WorkspaceSecondarySurfaceId`, `schema.ts` `sanitizeAttachedSecondaryPane` returns
`null`, discarding the secondary pane entirely — the user will need to re-open
the Document Map manually. There is no fallback to the group default surface; the
pane is simply absent. This is the existing graceful-degradation path (no crash,
secondary just does not restore). Add a test for this degradation path in S9.

### 7.7 Test fallout

The following tests reference removed surface IDs and must be updated:

- `paneSecondaryModel.test.ts`: remove assertions for `reader-highlights`,
  `reader-embeds`, `reader-apparatus`, `reader-resource-chat`; add for
  `reader-evidence`; update `getSecondarySurfaceIdsForGroup` count.
- `panePublications.test.ts`: replace `reader-resource-chat` fixture IDs.
- `paneRuntime.test.tsx`: replace `reader-resource-chat` surface ID.
- `SecondaryPaneShell.test.tsx`: replace surface ID fixtures.
- `SecondarySurfaceTabs.test.tsx`: rebuild fixtures for two-surface model.
- `WorkspaceHost.test.tsx`: rebuild secondary surface fixtures; remove chat
  secondary surface test cases.
- `MobileSecondaryPaneHost.test.tsx`: keep; fixture already uses `reader-contents`
  which survives.
- `workspaceRestore.test.ts`: update type usage from `reader-resource-chat` to
  `reader-evidence`.
- `apps/web/src/lib/workspace/schema.test.ts`: replace `reader-highlights`
  literals (lines 200, 213, 232) with `reader-evidence`. S1 removes the ID from
  the `WorkspaceSecondarySurfaceId` union; these literals become TypeScript errors
  immediately.
- `apps/web/src/lib/workspace/store.test.tsx`: replace `reader-highlights` and
  `reader-resource-chat` literals (lines 383, 394, 403, 414, 440, 441, 471, 479,
  508, 525) with `reader-evidence`. Same TypeScript breakage on S1.
- `MediaPaneBody.test.tsx` / `MediaPaneBody.ac4.test.tsx`: update secondary
  surface publication assertions.
- `e2e/tests/workspace.ts`: update `WorkspaceAttachedSecondaryPaneState.activeSurfaceId`
  union to replace `"reader-highlights"` and `"reader-resource-chat"` with
  `"reader-evidence"` (lines 43–48).
- `e2e/tests/reader.ts`: rename/rewrite `openHighlightsPane()` helper (line 39)
  to `openEvidencePane()` pointing to the "Evidence" tab.
- `e2e/tests/reader-pane-tabs.spec.ts`: rewrite tab assertions (lines 30–37) for
  two tabs (Contents, Evidence); remove "Highlights" and "Chat" tab assertions;
  update count to 2.
- `e2e/tests/notes.spec.ts`: update imports and call sites (lines 14, 365, 596)
  from `openHighlightsPane` to `openEvidencePane`.
- `e2e/tests/non-pdf-linked-items.spec.ts`: update import and call sites (lines 5,
  143, 181–182) from `openHighlightsPane` to `openEvidencePane`; remove hardcoded
  "Highlights" tab assertion.
- `e2e/tests/real-media/quote-to-chat.spec.ts`: update assertion at lines 77–88
  (which asserts a "Chat" secondary tab + `ResourceChatDetail`) to assert that a
  new conversation pane opens instead; use `openInNewPane` result.
- `e2e/tests/pdf-reader.spec.ts`: update `openHighlightsPane` call sites (lines
  8, 404, 523) to `openEvidencePane`; remove any "Chat" tab assertions (line 193,
  216).

---

## 8. Key decisions

**D-1. One Evidence surface, not three.** Highlights, Citations, and Connections
are one ontological thing — annotations on the text sorted by position. Three tabs
fragment navigation for no gain. *Rejected: keep three tabs but add cross-tab
linking* — cross-tab linking is complexity that dissolves if the three are one.

**D-2. `reader-embeds` dies.** Inline embeds render in the body (`d7ec06ca`).
A Document Map tab that lists what is already visible inline creates a navigation
surface with no independent value. *Rejected: keep as an inspection panel for
failed/pending embeds* — failed embeds show status in the body slot; Document
Map markers already flag them on the rail.

**D-3. `reader-resource-chat` dies; chat opens a real pane.** The resource-chat-subject
cutover built the correct model: `startResourceChat("media:<id>")` creates a
real conversation. An inline mini-chat in the secondary pane is a second chat UI
owner that the cutover explicitly eliminated (`DocChatTab` died, `ReaderChatDetail`
died). *Rejected: preserve as a "quick chat" shortcut* — "quick chat" that creates
a real conversation but hides it in a secondary pane is worse UX than a pane.

**D-4. Backend API unchanged.** The document map already returns a unified `items`
list with `document_order_key` / `document_fraction` on every item, and separate
`highlights`, `apparatus`, `connections` projections. No backend change is needed
to merge the surfaces. *Rejected: add a backend `/evidence` projection* — the
data is already there; a new projection adds a round trip.

**D-5. `ReaderDocumentMapLensId` unchanged.** Lenses and their markers exist for
the overview rail regardless of whether they map to a surface. Rail markers from
`"embeds"` and `"chat"` still render; their click behavior scrolls the body.
*Rejected: remove `"embeds"` and `"chat"` from the lens enum* — markers are
independent of surface existence.

**D-6. Filter toggles, not chips.** Per binding editorial guidance: "kind filters as
quiet text toggles — no pill chips". Filter state lives in `EvidencePaneSurface`
component state. No URL persistence in the first slice.

**D-7. `readerSurfaceForLens` moves to `documentMap.ts`.** It is a pure mapping
function, not a MediaPaneBody concern, and is now independently testable.

**D-8. MachineText for Synapse rationales requires sibling #1.** Synapse rows exist
today in `reader-connections`; their rationale is set prose. After consolidation
into Evidence, those rows must render through `MachineText inline`. This spec does
not implement `MachineText`; it declares the dependency. *If this cutover ships
before #1: Synapse rationale is rendered in normal body text as a temporary
defect, not a design choice.* Ship order: #1 then #8.

**D-9. Default Evidence surface is always published.** Unlike the current model where
`reader-highlights` is gated on `canRead && !focusModeEnabled` and
`reader-apparatus` on `showApparatusPane`, Evidence is always in the surfaces
list. An empty Evidence pane shows an empty state ("No annotations yet.") rather
than hiding the tab. This is cleaner than a tab that appears and disappears.

---

## 9. What dies

**Secondary surface IDs (deleted from `PANE_SECONDARY_SURFACE_DEFINITIONS`):**
- `reader-highlights` (Title: "Highlights", iconId: "highlighter")
- `reader-embeds` (Title: "Embeds", iconId: "file-text")
- `reader-apparatus` (Title: "Citations", iconId: "quote")
- `reader-connections` (Title: "Connections", iconId: "link-2")
- `reader-resource-chat` (Title: "Chat", iconId: "file-text")

**MediaPaneBody state / callbacks deleted:**
- `secondaryChat` state (lines 911–918)
- `pendingQuoteUri` state (line 905)
- `pendingQuoteLabel` state (line 906)
- `pendingQuoteSelection` state (line 908–909)
- `resourceChatSurfaceActivatedRef` ref (line 918)
- `revealResourceChatSecondary` callback (lines 3599–3601)
- `openResourceChat` callback (lines 3604–3610)
- `openChatInSecondary` callback (lines 3651–3679)
- `startChatInSecondary` callback (lines 3683–3707)
- `quoteHighlightToNewChat` callback (lines 4324–4342) and all callers passing
  it as `onQuoteToNewChat` (lines 5500, 6021, 6145, 6181)
- `quoteHighlightToExtantChat` callback (lines 4348–4369) and all callers passing
  it as `onQuoteToExtantChat` (lines 5501, 5533, 6026, 6150, 6185)
- The `useEffect` managing chat surface activation (lines 4375–4397)
- The `showHighlightsPane`, `showApparatusPane`, `documentMapEmbedItems` guards
  in the surface publication memo

**Imports deleted from MediaPaneBody:**
- `ResourceChatDetail` (`@/components/chat/ResourceChatDetail`)
- `ResourceChatTab` (`@/components/chat/ResourceChatTab`)
- `resourceChatStyles` (`@/components/chat/ResourceChatTab.module.css`)
- `type ReaderConnectionRow` (re-imported transitively through `EvidencePaneSurface`)

**Standalone lens components retired (no new callers after cutover):**
- `ReaderDocumentMapHighlightsLens.tsx` — replaced by `EvidencePaneSurface`
- `ReaderDocumentMapCitationsLens.tsx` — replaced by `EvidencePaneSurface`
- `ReaderDocumentMapConnectionsLens.tsx` — replaced by `EvidencePaneSurface`

These three files are **deleted** in the same commit. Their rendering logic is
inlined into `EvidencePaneSurface`'s `renderRow` dispatch.

---

## 10. Sibling cutovers and sequencing

**#1 machine-hand-hard-cutover.md** — MUST LAND FIRST. `MachineText` component
and tokens (`--font-machine`, `--ink-machine`) must exist before Evidence can
render Synapse rationales correctly. This spec cross-references §4.4.

**#10 machine-output-in-place-hard-cutover.md** — touches `paneSecondaryModel.ts`
for `notes-tools`; scopes are disjoint (reader-tools vs notes-tools). Both modify
`paneSecondaryModel.ts`; merge order matters, but there are no semantic conflicts
if they land in sequence.

**#8 (this spec) and #10** — both explicitly exclude each other's reader/non-reader
scopes. #10 touches `library-intelligence` and `notes-connections`, which are
`library-tools` and `notes-tools` surfaces. No shared file conflict except
`paneSecondaryModel.ts`.

**`incoming-connections-reader-sidecar-hard-cutover.md`** — already IMPLEMENTED;
its `AnchoredSidecarSurface`, `ReaderDocumentMapConnectionsLens`, and
`ReaderDocumentMapCitationsLens` are the components this cutover consolidates and
then deletes.

**`resource-chat-subject-hard-cutover.md`** — already BUILT; its
`startResourceChat` is the opener this cutover uses.

---

## 11. Slices

**S0 — Move `readerSurfaceForLens` to `documentMap.ts` and add `null` cases.**
No behavior change. Verify: existing `paneSecondaryModel.test.ts` passes;
add unit test for the helper with all six lens IDs.

**S1 — Surface model: add `reader-evidence`, remove five entries.**
Update `paneSecondaryModel.ts`. Fix all TypeScript compile errors caused by
removed IDs. Update model tests. Verify: `bun run typecheck` clean, model tests
pass.

**S2 — EvidencePaneSurface skeleton.**
New `EvidencePaneSurface.tsx` with filter state and empty body. Stub `renderRow`
dispatches. `MediaPaneBody.tsx` publishes it. Verify: browser test with empty
Evidence pane; filter toggles appear; no console errors.

**S3 — Merge highlights into Evidence.**
Implement highlight row path in `EvidencePaneSurface`. Port rendering from
`ReaderDocumentMapHighlightsLens`. Verify: highlights appear in Evidence;
existing highlight click/focus/note behavior unchanged. Browser test: highlight
shows in Evidence at correct position.

**S4 — Merge apparatus into Evidence.**
Implement apparatus row path. Port from `ReaderDocumentMapCitationsLens`.
Verify: Citations rows appear; apparatus focus/hover/pulse behavior unchanged.

**S5 — Merge connections into Evidence.**
Implement connection row path. Port from `ReaderDocumentMapConnectionsLens`.
Add Synapse dismiss handler. Verify: connection rows appear; Synapse rows have
dismiss button; `synapse_suppressions` endpoint called on dismiss.

**S6 — MachineText adoption for Synapse rows (requires #1 landed).**
Wrap Synapse rationale text in `MachineText` inline with `origin="Synapse"`.
Verify: visual screenshot test; `MachineText` gate test passes.

**S7 — Delete retired lens components.**
Remove `ReaderDocumentMapHighlightsLens.tsx`, `ReaderDocumentMapCitationsLens.tsx`,
`ReaderDocumentMapConnectionsLens.tsx` and their CSS/test files. Update all
imports. Verify: no import of deleted files; all tests pass.

**S8 — Kill `reader-resource-chat`.**
Delete chat state, callbacks, refs. Implement `openChatForMedia`.
Update quote-to-chat flow. Verify: Shift+G chat action opens a new conversation
pane; highlight "Chat" verb creates a conversation with the highlight as subject.

**S9 — Test sweep, keyboard, deep-link, mobile.**
Fix all failing tests enumerated in §7.7. Verify keyboard verb `G e` for Evidence.
Verify mobile two-tab sheet. Update `panePublications.test.ts`, `paneRuntime.test.tsx`,
workspace restore tests. Full gate: `bun run typecheck && bun run lint && bun test`.

---

## 12. Acceptance criteria

**AC-1.** `PANE_SECONDARY_SURFACE_DEFINITIONS` has exactly two `reader-tools`
entries after cutover: `reader-contents` and `reader-evidence`.

**AC-2.** The Document Map secondary pane on a media item with highlights,
apparatus, and connections shows exactly two tabs labeled "Contents" and
"Evidence".

**AC-3.** The Evidence pane displays highlights, citations, and connections
merged and sorted by document position.

**AC-4.** The Evidence header contains exactly three kind filter controls
(`aria-pressed` buttons): "Highlights", "Citations", "Connections". Toggling
off a kind removes its rows from the sidecar.

**AC-5.** A Synapse-origin connection row in Evidence carries a dismiss button
that calls the suppression endpoint and removes the row.

**AC-6.** No `reader-highlights`, `reader-embeds`, `reader-apparatus`,
`reader-connections`, or `reader-resource-chat` tab is rendered in any browser
context after the cutover.

**AC-7.** The "Chat" action from the reader (keyboard, action menu, highlight
verb) opens a full conversation pane and does not reveal a secondary surface.
Verify: `openInNewPane` is called; `requestSecondarySurface` is not.

**AC-8.** A reader with no ToC (PDF, non-EPUB web article) defaults to
`reader-evidence` as the Document Map surface.

**AC-9.** Mobile secondary sheet shows exactly two tabs (Contents, Evidence) for
a readable document.

**AC-10.** Highlight click/focus/pulse, apparatus hover/pulse, and connection
row activation all work inside Evidence with the same behavior as the three
former separate surfaces.

**AC-11.** `readerSurfaceForLens` is in `documentMap.ts`, is exported, and is
covered by unit tests for all six lens IDs.

**AC-12.** No import of `ReaderDocumentMapHighlightsLens`,
`ReaderDocumentMapCitationsLens`, or `ReaderDocumentMapConnectionsLens` exists
outside their own test files (those files are deleted in S7).

**AC-13.** `pendingQuoteUri`, `pendingQuoteLabel`, `secondaryChat`,
`resourceChatSurfaceActivatedRef` do not appear in `MediaPaneBody.tsx`.

**AC-14.** Overview rail markers from all six lenses still render on the rail;
clicking an evidence-category marker opens `reader-evidence`; clicking an embeds
marker scrolls the reader body to the embed.

**AC-15.** When a document has no highlights, no apparatus items, and no
connection rows, the Evidence tab is still visible in the Document Map and its
body contains an empty-state message ("No annotations yet." or equivalent). Add
a browser test in `EvidencePaneSurface.test.tsx` that renders the component with
all three source arrays empty and asserts the empty-state message is present.

---

## 13. Negative gates

Add or extend `python/tests/test_cutover_negative_gates.py`:

```python
# No: old reader surface IDs survive in the TypeScript surface model
def test_no_reader_resource_chat_surface():
    ...grep("reader-resource-chat", ts_surface_model)...  # must be absent

def test_no_reader_highlights_surface():
    ...grep("reader-highlights", ts_surface_model)...  # must be absent

def test_no_reader_embeds_surface():
    ...grep("reader-embeds", ts_surface_model)...  # must be absent

def test_no_reader_apparatus_surface():
    ...grep("reader-apparatus", ts_surface_model)...  # must be absent

def test_no_reader_connections_surface():
    ...grep("reader-connections", ts_surface_model)...  # must be absent
```

Frontend negative gates (grep-based assertions in
`apps/web/src/lib/panes/paneSecondaryModel.test.ts`):

```ts
// These surface IDs must not appear in the model
it("does not include removed reader-tools surfaces", () => {
  const ids = PANE_SECONDARY_SURFACE_DEFINITIONS.map((d) => d.id);
  expect(ids).not.toContain("reader-highlights");
  expect(ids).not.toContain("reader-embeds");
  expect(ids).not.toContain("reader-apparatus");
  expect(ids).not.toContain("reader-connections");
  expect(ids).not.toContain("reader-resource-chat");
});

// reader-tools must have exactly two surfaces
it("reader-tools has exactly two surfaces", () => {
  const readerTools = PANE_SECONDARY_SURFACE_DEFINITIONS
    .filter((d) => d.groupId === "reader-tools");
  expect(readerTools).toHaveLength(2);
  expect(readerTools.map((d) => d.id)).toEqual(
    expect.arrayContaining(["reader-contents", "reader-evidence"]),
  );
});
```

Add to `MediaPaneBody.test.tsx`:

```ts
// No secondary chat state in published surfaces
it("does not publish reader-resource-chat surface", () => {
  // render MediaPaneBody, assert no surface with id reader-resource-chat
  // in the usePaneSecondary call
});
```

---

## 14. Test plan

### Targeted (run first, iterate fast)

```text
# Model
bun test apps/web/src/lib/panes/paneSecondaryModel.test.ts

# Publication contract
bun test apps/web/src/lib/panes/panePublications.test.ts

# New helper
bun test apps/web/src/lib/reader/documentMap.test.ts

# Evidence pane unit
bun test apps/web/src/components/reader/document-map/EvidencePaneSurface.test.tsx

# Workspace surface fixtures
bun test apps/web/src/components/workspace/SecondarySurfaceTabs.test.tsx
bun test apps/web/src/components/workspace/WorkspaceHost.test.tsx
bun test apps/web/src/components/workspace/SecondaryPaneShell.test.tsx

# Pane runtime (surface ID types)
bun test apps/web/src/lib/panes/paneRuntime.test.tsx

# MediaPaneBody integration
bun test apps/web/src/app/'(authenticated)'/media/'[id]'/MediaPaneBody.test.tsx
```

### Full gate

```text
bun run typecheck
bun run lint
bun test   # all unit + browser projects
```

### E2E

```text
bunx playwright test e2e/tests/pdf-reader.spec.ts -g "evidence"
bunx playwright test e2e/tests/web-reader.spec.ts -g "evidence"
bunx playwright test e2e/tests/highlight-actions.spec.ts
bunx playwright test e2e/tests/chat-from-reader.spec.ts
```

---

## 15. Files

### Created

```text
apps/web/src/components/reader/document-map/EvidencePaneSurface.tsx
apps/web/src/components/reader/document-map/EvidencePaneSurface.module.css
apps/web/src/components/reader/document-map/EvidencePaneSurface.test.tsx
```

### Changed

```text
apps/web/src/lib/panes/paneSecondaryModel.ts          remove 5 surfaces, add reader-evidence
apps/web/src/lib/panes/paneSecondaryModel.test.ts     assertions for new model
apps/web/src/lib/reader/documentMap.ts                add readerSurfaceForLens export
apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx  surface publication, chat verb
apps/web/src/lib/panes/panePublications.test.ts       fixture IDs
apps/web/src/lib/panes/paneRuntime.test.tsx           fixture IDs
apps/web/src/lib/workspace/workspaceRestore.test.ts   type reference
apps/web/src/lib/workspace/schema.test.ts             replace reader-highlights literals
apps/web/src/lib/workspace/store.test.tsx             replace reader-highlights/reader-resource-chat literals
apps/web/src/components/workspace/SecondarySurfaceTabs.test.tsx  fixture rebuild
apps/web/src/components/workspace/WorkspaceHost.test.tsx         fixture rebuild
apps/web/src/components/workspace/SecondaryPaneShell.test.tsx    fixture rebuild
apps/web/src/components/workspace/MobileSecondaryPaneHost.test.tsx  verify two-tab
e2e/tests/workspace.ts                               update activeSurfaceId union
e2e/tests/reader.ts                                  rename openHighlightsPane → openEvidencePane
e2e/tests/reader-pane-tabs.spec.ts                   rewrite for two-tab model
e2e/tests/notes.spec.ts                              update to openEvidencePane
e2e/tests/non-pdf-linked-items.spec.ts               update to openEvidencePane
e2e/tests/real-media/quote-to-chat.spec.ts           update chat-pane assertion
e2e/tests/pdf-reader.spec.ts                         update helper + tab refs
```

### Deleted

```text
apps/web/src/components/reader/document-map/ReaderDocumentMapHighlightsLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapHighlightsLens.module.css
apps/web/src/components/reader/document-map/ReaderDocumentMapHighlightsLens.test.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapCitationsLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapCitationsLens.module.css
apps/web/src/components/reader/document-map/ReaderDocumentMapCitationsLens.test.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapCitationsLens.fixture.test.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapConnectionsLens.tsx
apps/web/src/components/reader/document-map/ReaderDocumentMapConnectionsLens.module.css
apps/web/src/components/reader/document-map/ReaderDocumentMapConnectionsLens.test.tsx
```

---

## 16. Risks

**R1. AnchoredReaderRow shape mismatch.** Apparatus and connection rows have
different anchor types than highlight rows. `AnchoredSidecarSurface<T>` is
generic and takes `anchoredRows: AnchoredReaderRow[]` separately from `rows: T[]`.
The merge step must correctly convert each source to `AnchoredReaderRow` format.
Mitigation: reuse existing `toTextAnchoredReaderRow` / `toPdfAnchoredReaderRow`
for highlights; the connection and apparatus sidecar already convert their rows
to `AnchoredReaderRow` internally — extract those adapters as standalone
functions and unit-test them before wiring into `EvidencePaneSurface`.

**R2. Sort key heterogeneity.** Highlight `stable_order_key` uses
`fragment_id + start_offset`; apparatus uses `locator`; connections use
`anchor.order_key`. A unified sort requires normalizing to a comparable key.
Mitigation: use `document_fraction` from `ReaderDocumentMapItem` (backend
already provides it for apparatus and connections) as the primary sort key;
fall back to creation time for unanchored rows.

**R3. Filter state lost on pane re-mount.** Filter state is in
`EvidencePaneSurface` local state; navigating away and back resets it.
Mitigation: acceptable for v1; persist in URL search params in a follow-up.

**R4. Test count explosion.** Merging three lens test files into one
`EvidencePaneSurface.test.tsx` risks coverage regressions for each source type.
Mitigation: port the existing fixture cases from each lens test before deleting
the source files (S7 ships after S3–S5 are verified).

**R5. Workspace restore with stale surface ID.** A stored workspace state with
`activeSurfaceId = "reader-highlights"` will not resolve after the model update.
`sanitizeAttachedSecondaryPane` in `schema.ts` returns `null` when the stored ID
is not a valid `WorkspaceSecondarySurfaceId`, discarding the secondary pane
entirely (no fallback to group default — the pane is simply absent). This is
safe (no crash), but the user must re-open the Document Map. Add a test for this
degradation path in S9.

**R6. Quote-to-chat flow breaks during partial migration.** S8 removes the
secondary chat state before the new `openChatForMedia` verb is fully wired to
all call sites. Mitigation: complete S8 atomically; do not split the deletion
and the replacement into separate commits.
