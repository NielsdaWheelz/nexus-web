# Spec: Reader Selection Chat Destination Cutover

Status: Proposed
Owner: reader + chat
Date: 2026-05-27
Hard cutover. No legacy Ask button, no Ask tab, no destination guessing, no
fallback to most-recent chat, no backward compatibility, no feature flag.

---

## 1. Problem Statement

The reader selection popup still belongs to the pre-cutover assistant model. It
shows highlight color swatches and a single generic "Ask" action. The reader
secondary rail has already moved to a three-mode structure:

1. `highlights`
2. `doc-chat`
3. `library-chat`

That mismatch makes selected text ambiguous. The user can see two explicit chat
destinations in the pane, but the popup exposes one generic chat action whose
implementation always routes through the document-chat path. It also prevents a
fast path for adding the selected quote to a currently open library chat.

The correct model is not "Ask about this somewhere." The correct model is:

- highlight the selection with a color
- add the selection to document chat
- add the selection to library chat

The selected text is a pending chat context until the user sends a message. It
is not automatically a persisted highlight unless the user explicitly chooses a
highlight color.

## 2. Goals

- G1. The selection popup exposes chat destinations that match the reader
  secondary rail: doc-chat and library-chat.
- G2. The popup keeps highlight colors as the only persisted-highlight creation
  actions.
- G3. Clicking a chat destination never creates a saved highlight by side
  effect.
- G4. If the selected destination's chat detail is already open, the selected
  quote is attached to that open chat composer immediately.
- G5. If no chat detail is open, the selected destination tab opens in list mode
  with the selected quote retained as pending context.
- G6. The next chat chosen from that destination list receives the pending
  context.
- G7. Library-chat selection never guesses a library when the document belongs
  to multiple libraries. The user chooses the library row.
- G8. Reader selection contexts remain source-version-backed and fail closed
  when source version or reliable locator data is unavailable.
- G9. The implementation reuses `SecondaryRail`, `ChatDetailSlideIn`,
  `ChatComposer`, `ComposerContextRail`, `mergeContextItems`,
  `fetchMediaLibraryMemberships`, and existing reader-selection builders.
- G10. The old "Ask" vocabulary is removed from the reader selection popup and
  stale E2E expectations.

## 3. Non-Goals

- NG1. No backend conversation model change.
- NG2. No new chat scope model and no return of conversation scope.
- NG3. No "most recent chat" fallback.
- NG4. No per-library last-used memory.
- NG5. No new secondary-rail tab.
- NG6. No creation of a saved highlight when choosing doc-chat or library-chat.
- NG7. No library picker embedded inside the selection popup.
- NG8. No support for attaching a selected quote to an arbitrary global chat
  from the popup.
- NG9. No compatibility shim for the old `onAsk` popup API.
- NG10. No degraded reader-selection context without `source_version`.
- NG11. No schema changes, migrations, or new FastAPI endpoints.

## 4. Terms

### 4.1 Selection Context

A selection context is a transient `ContextItem` built from the active reader
selection. It can be one of:

- `reader_selection` for fresh selected text from text, transcript, EPUB, or PDF
  reader surfaces.
- `object_ref` with `type: "highlight"` for an existing saved highlight.

Fresh selected text must use `reader_selection`. Saved highlights must keep
using `object_ref: highlight`.

### 4.2 Pending Context

Pending context is one or more `ContextItem` values held by the reader pane
before they are attached to a concrete chat composer.

Pending context is UI state. It is not persisted separately. It becomes durable
only when the user sends a chat run and `ChatComposer` includes it in
`ChatRunCreateRequest.contexts`.

### 4.3 Chat Detail

Chat detail is the slide-in chat surface inside a secondary-rail tab. It wraps
`ChatSurface` and `ChatComposer` through `ChatDetailSlideIn`.

### 4.4 Destination

A destination is one of:

```ts
type ReaderSelectionChatDestination = "doc-chat" | "library-chat";
```

It intentionally uses the same IDs as `SecondaryRailTab["id"]` for chat modes.

## 5. Current System To Reuse

### 5.1 Secondary Rail

`SecondaryRail` already owns the closed tab ID union:

```ts
type SecondaryRailTabId = "highlights" | "doc-chat" | "library-chat";
```

The selection popup must not create a separate mode enum with different names.
Any local destination type must be derived from, or explicitly aligned with,
this union.

### 5.2 Highlight Color Picker

`HighlightColorPicker` already centralizes color swatches, labels, disabled
states, and highlight color typing. The popup keeps using it for persisted
highlight creation.

### 5.3 Selection Popup Positioning

`SelectionPopover` already owns:

- desktop and mobile positioning against the selection rectangle
- visual viewport and safe-area handling
- outside pointer dismissal
- Escape dismissal
- pointerdown default prevention so the text selection survives interaction

The cutover must preserve those mechanics. It changes the action set, not the
positioning system.

### 5.4 Reader Selection Builders

`MediaPaneBody` already builds source-backed `reader_selection` contexts for
web, transcript, and EPUB selections. `PdfReader` builds PDF selection quotes
and passes them up to `MediaPaneBody`, which adds media metadata and
`source_version`.

These builders are the canonical source of selection context. The popup must
not construct locator payloads itself.

### 5.5 Chat Detail And Composer

`ChatDetailSlideIn` already owns pending contexts for a concrete detail surface
through local `pendingContexts` state, passes them to `ChatComposer`, and clears
them after chat-run creation.

`ChatComposer` already sends:

- `conversation_id`
- `singleton`
- `reader_context`
- `contexts`

No new send API is required.

### 5.6 Context Merging

`mergeContextItems` already deduplicates context items by stable identity. It
must be reused when pending context is added to an already open detail.

### 5.7 Doc Chat

`DocChatTab` already exposes:

- pinned document singleton row
- other chats referencing this document
- start-new-chat action

The cutover adds an optional pending context handoff to any row/action selected
from this list.

### 5.8 Library Chat

`LibraryChatTab` already lists non-default libraries containing the document and
each library row opens that library singleton.

The cutover adds an optional pending context handoff to the selected library
singleton.

### 5.9 Source Version Contract

Fresh reader selections require `source_version`. If source version is missing
or stale, the UI must show the existing warning and keep the user in the reader
without creating a degraded context.

## 6. Final State

### 6.1 Selection Popup

The popup renders three action groups in this order:

1. Highlight colors
2. Doc chat
3. Library chat

The color group is unchanged in purpose: selecting a color creates a saved
highlight immediately.

The chat actions are icon buttons:

| Action | Icon | Accessible label | Effect |
|---|---|---|---|
| doc-chat | `FileText` | `Add to document chat` | Attach selected quote to doc-chat flow |
| library-chat | `Library` | `Add to library chat` | Attach selected quote to library-chat flow |

The old `MessageSquare` Ask button is deleted from the reader selection popup.
The popup no longer has a generic `onAsk` callback.

### 6.2 Doc-Chat Button Behavior

When the user clicks `Add to document chat`:

1. Build a fresh `reader_selection` context from the active selection.
2. If a doc-chat detail is currently open, merge the context into that detail's
   composer pending contexts.
3. If no doc-chat detail is open, set reader pending context for `doc-chat`,
   switch `secondaryRailMode` to `doc-chat`, open the secondary rail, and show
   the doc-chat list.
4. The next selected doc-chat row/action receives the pending context:
   - pinned singleton row
   - referencing conversation row
   - start-new-chat button

Selecting a row/action opens `ChatDetailSlideIn` with the pending context
already attached to its composer.

### 6.3 Library-Chat Button Behavior

When the user clicks `Add to library chat`:

1. Build a fresh `reader_selection` context from the active selection.
2. If a library-chat detail is currently open, merge the context into that
   detail's composer pending contexts.
3. If no library-chat detail is open, set reader pending context for
   `library-chat`, switch `secondaryRailMode` to `library-chat`, open the
   secondary rail, and show the library-chat list.
4. The next selected library row receives the pending context.

Selecting a library row opens that library singleton in `ChatDetailSlideIn`
with:

```ts
singletonTarget: { kind: "library", target_id: libraryId }
readerContext: { media_id: media.id, library_id: libraryId }
attachedContexts: pendingContexts
```

If the document belongs to zero non-default libraries, the existing empty state
is shown and the pending context remains pending until the user dismisses it,
switches destination, or leaves the media pane.

### 6.4 Existing Open Detail Priority

The currently open matching detail wins.

- If `chatDetail.kind === "doc"` and the user clicks doc-chat, attach to that
  open doc detail.
- If `chatDetail.kind === "library"` and the user clicks library-chat, attach
  to that open library detail.
- If a different detail kind is open, switching destinations closes or replaces
  that detail according to the existing tab-switch rule and opens the target
  list with pending context.

The system does not attach a doc-chat quote into an open library detail or a
library-chat quote into an open doc detail.

### 6.5 Pending Context Visibility

When a destination list has pending context, the tab body shows a compact
pending-context strip above the list content.

The strip uses the same display primitives as composer context chips:

- `ComposerContextRail` where practical, or
- a small shared pending-context row that reuses `getContextChipLabel`,
  `contextSwatch`, and `getContextIdentityKey`.

The strip must include a remove action. Removing the pending context leaves the
user on the same tab/list.

No instructional paragraph is added. The UI text is limited to concise labels
already needed for controls.

### 6.6 Dismissal And Clearing

Pending context is cleared when:

- the context is handed to a chat detail
- the user clicks remove on the pending-context strip
- the user dismisses the selection popup without choosing a chat action
- the media pane unmounts
- the source media changes
- the selected source version no longer matches active source data

Pending context is not cleared merely by switching between `doc-chat` and
`library-chat`; switching moves the pending context to the newly selected
destination unless the user removes it.

### 6.7 Mobile

Mobile keeps the modal sheet pattern for chat detail. The same destination
actions appear in the selection popup.

Doc-chat on mobile:

- If a doc detail sheet is open, merge into it.
- Otherwise open the doc-chat sheet/list flow with pending context.

Library-chat on mobile:

- If a library detail sheet is open, merge into it.
- Otherwise open the library-chat sheet/list flow with pending context.

No new mobile route is introduced. No mobile-only destination semantics are
introduced.

If the current mobile surface cannot render the destination list, the cutover
must extend the existing mobile assistant sheet/chrome to support the same
doc-chat and library-chat list/detail state. It must not keep the old generic
Ask sheet as a fallback.

## 7. Architecture

### 7.1 Reader Selection Destination State

Add a single reader-pane state object in `MediaPaneBody`:

```ts
type ReaderSelectionPendingDestination = "doc-chat" | "library-chat";

interface ReaderSelectionPendingContext {
  destination: ReaderSelectionPendingDestination;
  contexts: ContextItem[];
}
```

Rules:

- The state lives in `MediaPaneBody`, because the pending context coordinates
  selection, secondary rail mode, doc-chat tab, library-chat tab, desktop rail,
  and mobile sheet behavior.
- `DocChatTab` and `LibraryChatTab` receive pending context as props. They do
  not own reader selection conversion.
- `SelectionPopover` emits destination intent. It does not know about media,
  source versions, libraries, chat IDs, or singleton targets.

### 7.2 Chat Detail State

Extend `chatDetail` so both doc and library variants can carry attached
contexts:

```ts
type ReaderChatDetail =
  | {
      kind: "doc";
      isSingleton: boolean;
      conversationId: string | null;
      attachedContexts: ContextItem[];
    }
  | {
      kind: "library";
      libraryId: string;
      libraryName: string;
      conversationId: string | null;
      attachedContexts: ContextItem[];
    };
```

This removes the current asymmetry where doc chat supports attached contexts
and library chat does not.

### 7.3 Selection Popover API

Replace the generic `onAsk` prop with explicit destination callbacks:

```ts
interface SelectionPopoverProps {
  selectionRect: DOMRect;
  selectionLineRects?: DOMRect[];
  containerRef: React.RefObject<HTMLElement | null>;
  onCreateHighlight: (color: HighlightColor) => void | Promise<void | string | null>;
  onAddToDocChat?: () => void | Promise<void>;
  onAddToLibraryChat?: () => void | Promise<void>;
  onDismiss: () => void;
  isCreating?: boolean;
}
```

The callback does not receive `HighlightColor`. Chat context color comes from
the selection context builder default, not from a selected highlight swatch. The
highlight swatch selection and chat destination actions are separate commands.

### 7.4 Selection Context Builder

Extract the context-building part of `handleQuoteToChat` into a helper local to
`MediaPaneBody`, or a reader module if it becomes shared by more than one
component.

The helper should be shaped as:

```ts
function buildActiveReaderSelectionContext(): ContextItem | null
```

Rules:

- It returns `null` after showing the existing warning for invalid selection,
  missing source version, missing transcript timing, or stale content.
- It never clears selection by itself. The caller decides whether a successful
  destination action clears retained selection.
- It preserves existing locator shapes:
  - `web_text_offsets`
  - `epub_fragment_offsets`
  - `transcript_time_range`
  - `pdf_page_geometry`
- It preserves `source_version`.

For PDF, keep `PdfReader` responsible for PDF range and quad extraction. The
parent still adds media metadata and source version.

### 7.5 Pending Context Handoff

`MediaPaneBody` owns a handoff function:

```ts
function attachSelectionContextToDestination(
  destination: ReaderSelectionPendingDestination,
  contexts: ContextItem[],
): void
```

Behavior:

1. If a matching chat detail is open, merge into `chatDetail.attachedContexts`.
2. Otherwise set `pendingSelectionContext`, set `secondaryRailMode` to the
   destination, open the rail or mobile sheet, and leave `chatDetail` null.
3. Clear retained reader selection after successful handoff.

### 7.6 Doc Chat Tab API

Extend `DocChatTab`:

```ts
interface DocChatTabProps {
  mediaId: string;
  pendingContexts?: ContextItem[];
  onRemovePendingContext?: (index: number) => void;
  onOpenChat: (
    target:
      | { kind: "singleton"; conversationId: string | null; contexts?: ContextItem[] }
      | { kind: "reference"; conversationId: string; contexts?: ContextItem[] }
      | { kind: "new"; contexts?: ContextItem[] },
  ) => void;
}
```

The tab displays pending context when provided and passes it back on row/action
selection.

### 7.7 Library Chat Tab API

Extend `LibraryChatTab`:

```ts
interface LibraryChatTabProps {
  mediaId: string;
  pendingContexts?: ContextItem[];
  onRemovePendingContext?: (index: number) => void;
  onOpenChat: (
    conversationId: string | null,
    libraryId: string,
    libraryName: string,
    contexts?: ContextItem[],
  ) => void;
}
```

The tab displays pending context when provided and passes it to the selected
library row.

### 7.8 ChatDetailSlideIn

`ChatDetailSlideIn` already accepts `attachedContexts`. It must continue to own
the concrete detail's pending contexts after the handoff.

When `attachedContexts` changes for the same active conversation, the component
must merge new contexts into local `pendingContexts`, not replace unsent local
draft context accidentally.

`mergeContextItems` is the required merge primitive.

### 7.9 Library Membership Loading

Do not add a parallel library query for the popup. Library availability belongs
to `LibraryChatTab`, which already uses `fetchMediaLibraryMemberships(mediaId,
{ excludeDefault: true })`.

The popup action does not need to know whether zero, one, or many libraries are
available. It routes to the library-chat destination; the destination tab owns
the list and empty state.

### 7.10 BFF Route Drift

The reader pane hooks call:

- `/api/chat-singletons/media/{media_id}`
- `/api/chat-singletons/library/{library_id}`
- `/api/chat-references/media/{media_id}`

If these Next.js BFF routes are still absent, add them as transport-only proxy
routes as part of the implementation. They must contain no business logic.

This is not a new product API. It is completion of the existing frontend/BFF
topology required by `docs/rules/layers.md`.

## 8. Capability Contract

### 8.1 Selection Popup Capability

Input:

- selection geometry
- highlight creation callback
- destination callbacks that are already source-context-aware

Output:

- persisted highlight creation intent
- doc-chat destination intent
- library-chat destination intent
- dismissal intent

The popup does not output:

- chat IDs
- media IDs
- library IDs
- source versions
- locators
- singleton targets

### 8.2 Reader Pane Capability

Input:

- active media
- active reader content
- active source version
- active selection snapshot
- current secondary rail mode
- current chat detail state

Output:

- valid source-backed `ContextItem`
- pending destination state
- concrete `chatDetail` state

The reader pane owns all destination decisions because it is the only component
with enough context to coordinate selection, rail, chat, and mobile sheet state.

### 8.3 Chat Tab Capability

Input:

- media ID
- optional pending contexts
- row selection callback

Output:

- selected chat target plus pending contexts

The tabs do not build reader selection contexts.

### 8.4 Composer Capability

Input:

- conversation ID or singleton target
- reader context hint
- pending contexts

Output:

- `POST /api/chat-runs` request

The composer does not distinguish whether a context came from doc-chat,
library-chat, existing highlight action, source citation action, or global chat
context attachment.

## 9. API Design

### 9.1 Frontend Component API Changes

Change `SelectionPopover` props:

- remove `onAsk`
- add `onAddToDocChat`
- add `onAddToLibraryChat`

Change `PdfReader` props and handler names:

- replace `onAskSelection` with explicit chat-destination callbacks, or keep a
  parent-level adapter that receives destination and selection quote:

```ts
type PdfSelectionChatDestination = "doc-chat" | "library-chat";

onAddSelectionToChat?: (
  destination: PdfSelectionChatDestination,
  selection: PdfReaderSelectionQuote,
) => void;
```

The second shape is preferred for PDF because `PdfReader` owns selection quote
construction.

Change `DocChatTab` and `LibraryChatTab` to accept optional pending contexts and
remove callbacks.

Change `chatDetail` state to make `attachedContexts` available on both branches.

### 9.2 Backend API

No backend request shape changes.

`ChatRunCreateRequest` already has the required fields:

```json
{
  "conversation_id": "UUID | null",
  "singleton": {
    "kind": "media | library",
    "target_id": "UUID"
  },
  "reader_context": {
    "media_id": "UUID | null",
    "library_id": "UUID | null"
  },
  "contexts": []
}
```

Exactly one of `conversation_id` or `singleton` remains required.

### 9.3 BFF API

If missing, add these route handlers:

```text
GET /api/chat-singletons/media/[mediaId]
GET /api/chat-singletons/library/[libraryId]
GET /api/chat-references/media/[mediaId]
```

Each route proxies to the matching FastAPI path. No caching, transformation, or
business logic.

## 10. Data Model

No database migration.

No new table.

No persisted "pending context" record.

No per-user last-destination setting.

No per-library last-used setting.

## 11. Error And Edge Behavior

### 11.1 Missing Source Version

If a fresh text selection has no active source version, destination actions show
the chat-specific warning:

```text
Source version unavailable. Refresh this source before adding to chat.
```

This is a copy correction only. It must not introduce a fallback context.

### 11.2 Stale Selection

If the selection no longer maps to active content, show the existing "Selection
changed. Select text again." warning and do not open a chat destination.

### 11.3 No Library Rows

If the user chooses library-chat and the document has no eligible non-default
libraries, open the library-chat list with the existing empty state and pending
context strip. The user can remove the pending context or switch destinations.

### 11.4 Existing Destination Detail Busy State

If the matching detail has an in-flight send, the pending context may still be
added to the composer draft, but `ChatComposer` remains responsible for send
disabled/busy behavior.

### 11.5 Duplicate Context

Use `mergeContextItems`. Duplicate contexts are ignored by identity.

### 11.6 Switching Tabs With Pending Context

Switching from doc-chat to library-chat or library-chat to doc-chat carries the
pending context to the newly selected destination. Switching to highlights does
not attach or discard the context. The pending strip is hidden on highlights
unless a specific compact reminder is added to reader chrome later.

### 11.7 Closing The Rail

Closing the secondary rail clears pending context. The selected text has already
been cleared after handoff, so there is no hidden pending operation after close.

## 12. Composition With Other Systems

### 12.1 Highlights

Highlight color selection remains a persisted mutation through the existing
highlight APIs.

Doc-chat and library-chat actions do not call highlight creation APIs.

Existing saved-highlight "Ask in chat" affordances in `AnchoredHighlightsRail`
should be renamed and aligned with destination semantics. The existing saved
highlight context remains `object_ref: highlight`.

### 12.2 Reader Overview Ruler

No change. The overview ruler remains a map and activation affordance for saved
highlights. It does not display pending chat contexts.

### 12.3 Anchored Highlights Rail

The rail can continue to offer chat attachment for saved highlights, but it must
use the same destination model:

- add saved highlight to document chat
- add saved highlight to library chat

If this is not implemented in the same patch, remove or defer the saved
highlight chat action rather than preserving old generic "Ask" language.

### 12.4 Chat Detail

`ChatDetailSlideIn` remains the single embedded chat detail surface for doc and
library chats. The cutover removes the doc/library asymmetry in attached context
support.

### 12.5 Conversation Context Pane

No change. Once the user sends a message with attached contexts, the full chat
context pane renders those contexts through existing message context snapshots.

### 12.6 QuoteChatSheet

The old generic `QuoteChatSheet` role is reduced or replaced by the same
destination-aware mobile state. It must not preserve an "Ask" flow that has no
doc/library destination.

### 12.7 Chat References

When a quote from media `M` is sent in any conversation, that conversation
continues to appear in `M`'s doc-chat "Other chats" list according to the
existing reference rule. This includes library singleton conversations when
they contain attached context from `M`.

### 12.8 Singleton Chats

Doc-chat singleton materialization remains lazy on first send with:

```json
{ "singleton": { "kind": "media", "target_id": "<media_id>" } }
```

Library-chat singleton materialization remains lazy on first send with:

```json
{ "singleton": { "kind": "library", "target_id": "<library_id>" } }
```

### 12.9 Retrieval And App Search

No retrieval constraint is introduced. `reader_context` remains a model prompt
hint, not backend enforcement.

### 12.10 Command Palette

No change. The command palette does not get new reader-selection destination
commands in this cutover.

### 12.11 Workspace Pane Titles

No change. Pending context, selected text, source version, and destination mode
do not own workspace pane titles.

## 13. Files

### 13.1 Primary Frontend Files

| File | Change |
|---|---|
| `apps/web/src/components/SelectionPopover.tsx` | Replace generic Ask action with doc-chat and library-chat actions. |
| `apps/web/src/components/SelectionPopover.module.css` | Size and align two destination icon buttons while preserving placement constraints. |
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` | Own pending destination state, context builders, handoff, chat detail symmetry, and tab wiring. |
| `apps/web/src/components/PdfReader.tsx` | Emit destination-aware PDF selection chat actions. |
| `apps/web/src/components/chat/DocChatTab.tsx` | Accept/display/pass pending contexts. |
| `apps/web/src/components/chat/LibraryChatTab.tsx` | Accept/display/pass pending contexts. |
| `apps/web/src/components/chat/ChatDetailSlideIn.tsx` | Merge updated attached contexts for an open detail. |
| `apps/web/src/components/chat/ComposerContextRail.tsx` | Reuse for pending-context display if practical; otherwise extract shared context-chip rendering. |
| `apps/web/src/components/reader/AnchoredHighlightsRail.tsx` | Align saved-highlight chat action language and destination behavior or remove stale generic action. |

### 13.2 BFF Files If Missing

| File | Change |
|---|---|
| `apps/web/src/app/api/chat-singletons/media/[mediaId]/route.ts` | Transport-only FastAPI proxy. |
| `apps/web/src/app/api/chat-singletons/library/[libraryId]/route.ts` | Transport-only FastAPI proxy. |
| `apps/web/src/app/api/chat-references/media/[mediaId]/route.ts` | Transport-only FastAPI proxy. |

### 13.3 Tests

| File | Change |
|---|---|
| `apps/web/src/__tests__/components/SelectionPopover.test.tsx` | Flip old no-destination assertion; verify two destination buttons and callbacks. |
| `apps/web/src/__tests__/components/DocChatTab.test.tsx` | Verify pending context strip and row/action handoff. |
| `apps/web/src/__tests__/components/LibraryChatTab.test.tsx` | Verify pending context strip and library row handoff. |
| `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx` | Remove stale generic Ask assumptions or adapt to destination-aware mobile flow. |
| `apps/web/src/__tests__/components/PdfReader.test.tsx` | Verify PDF destination callback does not create saved highlight. |
| `apps/web/src/components/secondaryRail/SecondaryRail.test.tsx` | No semantic change; keep as guard for tab IDs/order. |
| `e2e/tests/reader-pane-tabs.spec.ts` | Add pending-context handoff assertions for doc and library paths. |
| `e2e/tests/quote-attach-references.spec.ts` | Ensure selected quote can be attached through doc-chat list flow and appears in references. |
| `e2e/tests/real-media/quote-to-chat.spec.ts` | Remove stale Ask tab / Reader assistant expectations. |
| `e2e/tests/pdf-reader.spec.ts` | Remove stale Ask tab expectations and assert destination-aware PDF flow. |

## 14. Acceptance Criteria

### 14.1 Popup

- AC1. Selecting text in a non-PDF reader shows highlight color swatches,
  `Add to document chat`, and `Add to library chat`.
- AC2. Selecting text in a PDF reader shows the same destination actions when
  text geometry is reliable.
- AC3. The popup no longer renders a button named `Ask`.
- AC4. Clicking a color creates a saved highlight and does not open chat.
- AC5. Clicking doc-chat or library-chat does not create a saved highlight.

### 14.2 Doc Chat

- AC6. If doc-chat detail is open, selecting text and clicking doc-chat adds a
  context chip to that open composer.
- AC7. If no doc-chat detail is open, clicking doc-chat opens the doc-chat tab
  list with pending context visible.
- AC8. Selecting the pinned doc singleton row opens chat detail with the pending
  context attached.
- AC9. Selecting an "Other chats" row opens that conversation with the pending
  context attached.
- AC10. Selecting "Start new chat" opens a new non-singleton detail with the
  pending context attached.

### 14.3 Library Chat

- AC11. If library-chat detail is open, selecting text and clicking library-chat
  adds a context chip to that open composer.
- AC12. If no library-chat detail is open, clicking library-chat opens the
  library-chat tab list with pending context visible.
- AC13. Selecting a library row opens that library singleton with the pending
  context attached.
- AC14. If multiple libraries are listed, no library is preselected by recency
  or position.
- AC15. If no libraries are listed, the existing empty state is shown and no
  chat run is created.

### 14.4 Contracts

- AC16. Fresh reader selections sent to chat include `source_version`.
- AC17. Missing or stale source version blocks chat attachment.
- AC18. Existing saved highlights sent to chat use `object_ref: highlight`.
- AC19. Duplicate pending contexts are deduplicated.
- AC20. Closing the rail clears pending context.

### 14.5 Tests And Cleanliness

- AC21. Unit/component tests no longer assert absence of destination choices.
- AC22. E2E tests no longer expect an `Ask` secondary-rail tab.
- AC23. No old `onAsk` prop remains on `SelectionPopover`.
- AC24. No generic "Ask" copy remains for reader selection destination actions.
- AC25. No new backend schema, migration, or route business logic is added.

## 15. Implementation Plan

### Phase 1: Popup Contract

1. Replace `SelectionPopover.onAsk` with destination callbacks.
2. Render `FileText` and `Library` icon buttons.
3. Preserve color picker behavior and placement behavior.
4. Update `SelectionPopover.test.tsx`.

### Phase 2: Reader Pending Context State

1. Add `ReaderSelectionPendingContext` state to `MediaPaneBody`.
2. Extract active non-PDF selection context building out of
   `handleQuoteToChat`.
3. Add destination handoff for doc-chat and library-chat.
4. Preserve source-version and stale-selection guards.

### Phase 3: PDF Destination Handoff

1. Replace PDF `onAskSelection` flow with destination-aware selection chat
   callback.
2. Keep PDF quote construction inside `PdfReader`.
3. Add parent handoff in `MediaPaneBody`.
4. Update `PdfReader` tests.

### Phase 4: Chat Tab Pending Context Handoff

1. Extend `DocChatTab` props to display and pass pending contexts.
2. Extend `LibraryChatTab` props to display and pass pending contexts.
3. Add or reuse pending-context chip rendering.
4. Clear pending context when a target is chosen.

### Phase 5: Chat Detail Symmetry

1. Add `attachedContexts` to library `chatDetail`.
2. Pass attached contexts into library `ChatDetailSlideIn`.
3. Ensure `ChatDetailSlideIn` merges incoming attached contexts for an already
   active detail.

### Phase 6: Saved Highlight Action Alignment

1. Replace generic saved-highlight "Ask in chat" action with destination-aware
   actions, or remove it from this cutover.
2. Keep saved-highlight context as `object_ref: highlight`.
3. Update `AnchoredHighlightsRail` tests.

### Phase 7: BFF Route Completion

1. Add missing BFF proxy routes for chat-singletons and chat-references if they
   are still absent.
2. Keep them transport-only.
3. Add route smoke tests only if existing route tests cover comparable BFF
   proxy behavior.

### Phase 8: E2E Cleanup

1. Update stale Ask-tab expectations.
2. Add one doc-chat pending handoff E2E.
3. Add one library-chat pending handoff E2E.
4. Keep source-version behavior covered at backend and focused frontend
   levels.

## 16. Verification Plan

Run focused frontend tests:

```bash
cd apps/web
bun run test:unit -- src/__tests__/components/SelectionPopover.test.tsx
bun run test:unit -- src/__tests__/components/DocChatTab.test.tsx
bun run test:unit -- src/__tests__/components/LibraryChatTab.test.tsx
bun run test:unit -- src/__tests__/components/PdfReader.test.tsx
```

Run type/lint gates:

```bash
cd apps/web
bun run typecheck
bun run lint
```

Run focused E2E after unit/type coverage:

```bash
npx playwright test e2e/tests/reader-pane-tabs.spec.ts
npx playwright test e2e/tests/quote-attach-references.spec.ts
npx playwright test e2e/tests/real-media/quote-to-chat.spec.ts
npx playwright test e2e/tests/pdf-reader.spec.ts
```

If BFF routes are added, run the closest existing BFF route tests and at least
one UI test that exercises `DocChatTab` and `LibraryChatTab` through `/api/*`.

## 17. Open Questions

None blocking.

The core decision is settled: destination is explicit, pending context is owned
by the reader pane, and no fallback to most-recent chat exists.
