# Quote-to-Chat Reader Assistant Hard Cutover

## Status

Implementation spec.

This cutover replaces desktop quote-to-chat as a route-opening highlight handoff
with a reader-native assistant in the media secondary pane. The target is the
best current product pattern: selected text opens an immediate grounded chat
surface beside the document, keeps the reader in place, cites source material,
and promotes to a full chat only by explicit user action.

External product signals used for this target:

- Readwise Reader Ghostreader: selected text can be used to "Chat about this",
  the chat lives in the right sidebar, `G` opens passage prompts, and document
  chat has access to metadata, reading position, history, presets, model
  choice, and save-to-note actions.
  - https://docs.readwise.io/reader/guides/ghostreader/overview
  - https://docs.readwise.io/reader/guides/ghostreader/chat
- NotebookLM: answers are source-grounded, citations expose quoted source text,
  citation activation jumps to the source location, and source inclusion is
  explicit.
  - https://support.google.com/notebooklm/answer/16179559
  - https://support.google.com/notebooklm/answer/16215270
- Adobe Acrobat AI Assistant: PDF chat is a side-pane workflow, citations jump
  to document sections, chat files are manageable, generation can be stopped,
  and pane width is adjustable.
  - https://helpx.adobe.com/acrobat/using/get-ai-generated-answers.html
- LiquidText and Zotero: durable reading tools keep excerpts, notes, and source
  jumps tightly linked to the original document instead of detaching them into
  remote panes.
  - https://www.liquidtext.net/features
  - https://www.zotero.org/support/pdf_reader
- Current HCI research on AI margin notes: integrated reader AI and manual text
  selection are preferred to detached chat surfaces for document reading.
  - https://arxiv.org/abs/2509.09840
- Human-AI interaction guidance: AI behavior must be clear initially, useful
  during interaction, recoverable when wrong, and adaptable over time.
  - https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/

## Goals

- Make desktop quote-to-chat feel instant: the visible assistant surface opens
  synchronously in the media secondary pane without waiting for highlight
  creation, PDF highlight refresh, conversation resolution, chat history, or
  model loading.
- Keep reading context in place: selecting text and asking must not activate a
  separate workspace chat pane by default.
- Make the secondary pane the stable desktop home for reader-adjacent work:
  `Highlights` and `Ask` are sibling modes in the media pane.
- Treat selected quote context as first-class data, not as a side effect of
  saving a highlight.
- Preserve saved-highlight quote-to-chat, but route it through the same reader
  assistant surface.
- Provide explicit context controls before send: show quote/source/scope, allow
  context removal, and avoid hidden attachments.
- Stream answers in the secondary pane with grounded citations and same-reader
  source jumps.
- Share embedded chat logic between desktop secondary pane and mobile sheet.
- Replace the old desktop flow completely. No legacy route-opening default path,
  no duplicate quote-chat implementation, no `context=` URL compatibility path.

## Non-Goals

- Do not redesign the global workspace pane system.
- Do not remove full conversation panes. Full chat remains available through
  explicit promotion.
- Do not replace `AnchoredHighlightsRail` projection rules or make it own chat
  behavior.
- Do not change durable saved-highlight semantics except removing the
  requirement that quote-to-chat first creates a saved highlight.
- Do not add feature flags or compatibility branches for the old flow.
- Do not support old quote-to-chat URLs that use `context=` after this cutover.
- Do not create fake durable objects just to represent transient text
  selections.
- Do not silently fall back when source locators or quote selectors fail. Show a
  typed error state.

## Final State

Desktop media panes have one right-side reader secondary rail.

- The rail has two modes: `Highlights` and `Ask`.
- `Highlights` renders the existing viewport-visible highlight pane.
- `Ask` renders a reader assistant backed by shared embedded chat logic.
- Selecting text and pressing Ask, or using the keyboard shortcut, switches the
  rail to `Ask`, attaches the selected quote, focuses the composer, and leaves
  the document pane active.
- Asking from an existing saved highlight row switches the same rail to `Ask`
  and attaches a saved-highlight context.
- Mobile renders the same assistant body in the local reader sheet/drawer
  container. The chat state machine is shared with desktop.
- Full chat is an explicit promotion action. It opens or activates the durable
  conversation pane after a conversation exists.
- The current route-opening desktop quote-to-chat behavior is deleted.

## Target Behavior

### Desktop Selection

1. User selects text in a web article, EPUB, transcript, or PDF.
2. `SelectionPopover` appears near the selection with highlight colors and one
   Ask action. It does not contain `new`, `document`, or `library` destinations.
3. User clicks Ask or presses `G`.
4. The media secondary rail immediately switches to `Ask`.
5. The assistant header shows the active scope, defaulting to the current
   document.
6. The attached quote appears as a context card/chip with exact text, source
   title, media kind, and remove control.
7. The composer is focused without changing the active workspace pane.
8. Conversation resolution, message history loading, model catalog loading, and
   PDF quote validation proceed after the assistant is visible.
9. Sending starts a durable chat run with the selected context and streams the
   answer in place.

### Desktop Saved Highlight

1. User focuses a row in the visible highlights pane.
2. User clicks Ask.
3. The secondary rail switches to `Ask` and attaches an object-ref context for
   that highlight.
4. The document stays visible and the workspace pane count does not change.
5. If the user returns to `Highlights`, highlight focus and projection behavior
   are preserved by the existing anchored pane.

### Scope Selection

- The default scope is `Document`.
- `New chat` and `Library` are selected inside the assistant surface, never in
  the selection popover.
- Library scope is shown only when the current media belongs to at least one
  library. Multiple libraries are selected from an inline menu in the assistant
  header.
- Changing scope before send re-resolves the background conversation and
  preserves pending quote contexts and composer text.
- Sending while a scoped conversation is still resolving uses
  `conversation_scope`; the backend resolves or creates the scoped conversation
  atomically.
- Stale background resolve results are ignored if the user has already sent or
  changed scope.

### Returning To Highlights

- `Highlights` and `Ask` are a segmented control or equivalent tab control in
  the secondary rail.
- A back button inside `Ask` returns to `Highlights`.
- Returning to `Ask` restores the current assistant session for that media pane
  until the media pane unmounts.
- Opening Ask for another quote adds that quote as a pending context unless it
  duplicates an existing pending context.

### Full Chat Promotion

- Full chat never opens automatically from quote selection or saved-highlight
  Ask.
- The assistant has an `Open full chat` action.
- Before a conversation exists, promotion is disabled with clear button state.
- After send, or after an existing scoped conversation is resolved, promotion
  opens `/conversations/:id`, preserving an active `run` param when streaming.
- Workspace resource dedupe must be respected: an existing conversation pane is
  activated and updated instead of duplicating the same conversation.

### Source Jumps And Citations

- User-message context chips expose exact quote text and source metadata.
- Assistant citations render with source labels, quoted snippets, and status
  metadata already supported by the evidence layer.
- Activating a citation whose target is the current media navigates the current
  reader pane to the cited locator and projects the temporary answer highlight.
- Activating a citation outside the current media uses normal in-app pane
  routing.
- Stale, unresolved, or permission-denied locators render explicit broken-source
  UI. They do not navigate to approximate text.

### Keyboard And Accessibility

- `G` asks about the current selection.
- `Shift+G` opens document-scope Ask without a selection.
- `Escape` closes only transient popovers/menus first. In the assistant, it
  returns focus predictably without destroying the chat session.
- `Cmd+Enter` or `Ctrl+Enter` sends from the composer if the composer already
  supports that pattern; otherwise Enter semantics stay consistent with
  `ChatComposer`.
- The rail mode control uses real tabs or segmented buttons with correct ARIA
  state.
- The assistant body has a named region, a named message log, and a focusable
  composer.

## Architecture

### Frontend Ownership

`MediaPaneBody` owns:

- Current reader assistant mode: `highlights` or `ask`.
- Current reader assistant session for the media pane.
- Selection-to-context builders for web, EPUB, transcript, and PDF.
- Scope options derived from media and library membership.
- The promotion callback that opens full chat explicitly.

`AnchoredHighlightsRail` owns:

- Highlight projection, row visibility, row alignment, row focus, row actions.
- It does not import chat components, resolve conversations, or manage assistant
  state.

`SelectionPopover` owns:

- Selection action UI only.
- Highlight color selection.
- A single Ask command.
- It does not choose chat scope and does not create a highlight for Ask.

`PdfReader` owns:

- PDF rendering, selection geometry, page state, PDF highlight creation, and PDF
  controls.
- It emits a quote selection context to `MediaPaneBody` for Ask.
- It does not create a saved highlight for Ask.

Shared embedded chat owns:

- Loading existing scoped conversation history after the UI is already visible.
- Tailing active runs through `useChatRunTail`.
- Maintaining pending contexts.
- Clearing contexts after successful send.
- Promoting to full chat after a conversation exists.

### New Frontend Modules

Create focused modules rather than expanding `MediaPaneBody` further:

- `apps/web/src/components/chat/EmbeddedChatPanel.tsx`
  - Shared chat state machine and renderer for embedded assistant surfaces.
  - Uses `ChatSurface`, `ChatComposer`, and `useChatRunTail`.
- `apps/web/src/components/chat/EmbeddedChatPanel.module.css`
  - Layout for embedded chat without modal/backdrop assumptions.
- `apps/web/src/components/chat/ReaderAssistantPane.tsx`
  - Reader-specific header, scope selector, quote context card, back/promote
    actions, and source-jump callbacks.
- `apps/web/src/components/chat/ReaderAssistantPane.module.css`
  - Secondary-rail-specific assistant styling.
- `apps/web/src/lib/conversations/readerContexts.ts`
  - TypeScript builders, validation helpers, dedupe keys, labels, and display
    helpers for object-ref and reader-selection contexts.
- `apps/web/src/lib/conversations/useConversationModels.ts`
  - Cached model catalog hook used by `ChatComposer` or its extracted model
    selector logic so opening the assistant does not refetch models for every
    mount.

Refactor:

- `QuoteChatSheet` becomes a mobile container around `ReaderAssistantPane` or is
  deleted and replaced by `ReaderAssistantSheet`.
- `ChatComposer` keeps one primary send API but consumes cached model catalog
  data. It should not fetch `/api/models` independently on every mount after the
  cutover.
- `MessageRow`/citation rendering accepts an optional source-open handler so
  the reader assistant can intercept same-media evidence jumps.

### Context Contract

Hard cutover from object-ref-only contexts to a discriminated context input.

Frontend input shape:

```ts
type ChatContextInput =
  | {
      kind: "object_ref";
      type: ObjectType;
      id: string;
      evidence_span_ids?: string[];
    }
  | {
      kind: "reader_selection";
      client_context_id: string;
      media_id: string;
      media_kind: "article" | "epub" | "pdf" | "podcast_episode" | "video" | string;
      media_title: string;
      exact: string;
      prefix?: string;
      suffix?: string;
      locator: ReaderSelectionLocator;
    };
```

Rules:

- Saved highlights use `kind: "object_ref", type: "highlight"`.
- Unsaved selections use `kind: "reader_selection"`.
- `client_context_id` is a UUID generated when the Ask action is invoked.
- `exact` is required for text-backed selection contexts. Area-only PDF
  selections are not valid quote-to-chat contexts.
- The locator is media-kind-specific and follows the evidence-layer locator
  shape as closely as possible:
  - Web text: fragment id, start/end offsets, exact/prefix/suffix selector.
  - EPUB text: section id, fragment id or EPUB locator, start/end offsets,
    exact/prefix/suffix selector.
  - PDF text: page number, text quote selector, page-local offsets when
    available, and geometry only as projection aid.
  - Transcript: transcript fragment/segment ids, time range when available,
    exact/prefix/suffix selector.
- Context display fields are persisted as snapshots on send. They are not only
  URL state.

### Backend Persistence

`message_context_items` becomes the canonical table for both object refs and
reader selections.

Hard migration target:

- Add `context_kind`: `object_ref` or `reader_selection`.
- Keep `object_type` and `object_id` required only for `object_ref`.
- Add `source_media_id` nullable UUID for media-backed contexts.
- Add `locator_json` JSONB for reader-selection source locators.
- Keep `context_snapshot` JSONB as the immutable display/rendering snapshot.
- Enforce check constraints for each `context_kind`.
- Backfill existing rows as `object_ref`.
- Drop the old object-type-only constraint and replace it with kind-specific
  constraints.

Object links:

- `object_ref` context rows continue creating `used_as_context` links to the
  referenced object.
- `reader_selection` context rows create a `used_as_context` link from message
  to media with the selection locator stored on the link locator JSON and
  `context_item_id` in metadata.
- No object link points to a fake selection object.

### Backend Services

`python/nexus/schemas/conversation.py`:

- Replace `MessageContextRef` object-only input with discriminated chat context
  input.
- Keep response snapshots able to represent both `object_ref` and
  `reader_selection`.
- Remove schema acceptance of legacy object-only payloads without `kind`.

`python/nexus/services/contexts.py`:

- Insert object-ref and reader-selection context rows through one primary
  service API.
- Validate media permissions for selection contexts.
- Validate locator and quote selector at ingress.
- Persist immutable snapshots.

`python/nexus/services/context_rendering.py`:

- Render reader-selection contexts from their exact quote, surrounding text, and
  locator.
- For PDF, require PDF quote text readiness when selector validation needs page
  text.
- Return typed blocking errors for unresolved/stale selectors. Do not silently
  omit the selected quote.

`python/nexus/services/context_assembler.py`:

- Include both object-ref and reader-selection context refs in mandatory context
  blocks.
- Include selection source refs in prompt assembly ledgers.

`python/nexus/services/retrieval_planner.py`:

- Treat reader-selection contexts as strong scoped signals.
- For media-scoped chats, keep app search constrained to the media.
- For library-scoped chats, use the selected media as an initial signal without
  excluding other library evidence.

`python/nexus/services/conversations.py`:

- Return persisted message context snapshots with `kind`, quote display fields,
  source media metadata, route, and locator where safe for the client.

## Rules

- The default desktop quote-to-chat path must never call `requestOpenInAppPane`.
- Asking about selected text must never create a saved highlight.
- Existing saved highlights remain askable as object refs.
- The selection popover must not contain chat destination choices.
- The assistant surface must render before any network request resolves.
- Conversation resolution and history loading are background work.
- Model catalog loading is cached and non-blocking for panel visibility.
- Contexts are validated at ingress and trusted after that boundary.
- No duplicate embedded chat state machines.
- No `context=` URL params. Route-attached chat state uses the `attach_*`
  contract described by `docs/rules/testing_standards.md`.
- No old quote-to-chat E2E expectations that assert a chat pane opens by
  default.
- No raw quote text in telemetry or logs.
- All timing values added by this cutover are named constants.
- Expected transient failures render typed UI states; unexpected invariant
  failures fail loudly.

## File Map

Primary frontend files to modify:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
- `apps/web/src/components/SelectionPopover.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/chat/QuoteChatSheet.tsx`
- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/chat/ContextChips.tsx`
- `apps/web/src/lib/api/sse.ts`
- `apps/web/src/lib/conversations/attachedContext.ts`
- `apps/web/src/lib/conversations/useAttachedContextsFromUrl.ts`
- `apps/web/src/lib/conversations/display.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/workspace/store.tsx`

Primary backend files to modify:

- `python/nexus/schemas/conversation.py`
- `python/nexus/db/models.py`
- `python/nexus/services/contexts.py`
- `python/nexus/services/context_rendering.py`
- `python/nexus/services/context_lookup.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/retrieval_planner.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/media_deletion.py`
- `migrations/alembic/**`

Primary tests to update or add:

- `apps/web/src/__tests__/components/SelectionPopover.test.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsRail.test.tsx`
- `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx`
- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
- New `apps/web/src/__tests__/components/ReaderAssistantPane.test.tsx`
- New `apps/web/src/lib/conversations/readerContexts.test.ts`
- `apps/web/src/lib/conversations/attachedContext.test.ts`
- `python/tests/test_conversations.py`
- `python/tests/test_contexts.py`
- `python/tests/test_context_rendering.py`
- `python/tests/test_context_lookup.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_media_deletion.py`
- `python/tests/test_migrations.py`
- `e2e/tests/non-pdf-linked-items.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/epub.spec.ts`
- Add focused E2E coverage for desktop reader assistant open/send/promote and
  mobile shared assistant behavior.

## Deletion Checklist

Delete or replace these active legacy concepts:

- `quoteDestinations` in `MediaPaneBody`.
- Destination menu support in `SelectionPopover`.
- Desktop `openChatRouteWithHighlight`.
- Desktop `openResolvedConversationWithHighlight`.
- Desktop quote-to-chat `requestOpenInAppPane` default behavior.
- Ask-selected-text code paths that call `handleCreateHighlight` before Ask.
- PDF Ask-selected-text code paths that call `handleCreateHighlight` before Ask.
- Modal-only embedded chat implementation duplicated in `QuoteChatSheet`.
- `context=` URL parsing/serialization in `attachedContext.ts`.
- Tests that assert quote-to-chat increments chat pane count.

## Implementation Plan

### Phase 1: Context Data Cutover

- Add the discriminated context input/output schemas.
- Migrate `message_context_items` to support `context_kind`.
- Update context insertion, permission checks, snapshots, object links, and media
  deletion cleanup.
- Add backend unit and migration tests before touching UI behavior.

### Phase 2: Shared Embedded Chat

- Extract the state machine from `QuoteChatSheet` into `EmbeddedChatPanel`.
- Add cached model loading.
- Keep `ChatSurface`, `ChatComposer`, and `useChatRunTail` as the shared
  primitives.
- Refactor the mobile sheet to use the same embedded panel body.

### Phase 3: Reader Secondary Rail

- Replace the fixed desktop highlights-only column in `MediaPaneBody` with a
  reader secondary rail that switches between `Highlights` and `Ask`.
- Keep `AnchoredHighlightsRail` focused on
  highlights.
- Add `ReaderAssistantPane` to the rail.

### Phase 4: Selection And PDF Cutover

- Replace destination-based selection Ask with a single Ask command.
- Build transient reader-selection contexts for non-PDF text readers.
- Build transient reader-selection contexts for PDF text selections with valid
  exact quote text and locator metadata.
- Preserve saved-highlight Ask as object-ref context.

### Phase 5: Full Chat Promotion And URL Attach

- Implement explicit full-chat promotion with workspace resource dedupe.
- Replace `context=` route state with `attach_*` route state for non-reader
  route-attached chat contexts.
- Update tests to match `docs/rules/testing_standards.md`.

### Phase 6: Source Jumps, Polish, And Telemetry

- Intercept same-media citation activation from the reader assistant and route it
  through current reader navigation/focus behavior.
- Add typed empty/loading/error states.
- Add privacy-preserving telemetry:
  - assistant open latency
  - first send latency
  - first token latency
  - context kind
  - media kind
  - scope type
  - promotion count
  - explicit error codes
- Do not log selected quote text.

### Phase 7: Hard Cleanup

- Remove legacy code paths and obsolete tests.
- Run TypeScript, frontend unit tests, backend tests, and targeted E2E tests.
- Verify `rg "context=" apps/web/src e2e docs/rules/testing_standards.md` only
  finds intentional documentation or deleted history references after the
  cutover.
- Verify `rg "quoteDestinations|openChatRouteWithHighlight|openResolvedConversationWithHighlight" apps/web/src`
  returns no active references.

## Acceptance Criteria

### Desktop UX

- Selecting text and clicking Ask opens the secondary-rail assistant without
  opening or activating a workspace chat pane.
- The assistant rail is visible within one animation frame of the Ask action.
- The composer receives focus after the rail opens.
- The selected quote is visible as attached context before any network response
  completes.
- No saved highlight is created by selected-text Ask.
- Asking from an existing highlight row attaches that highlight and opens the
  same assistant rail.
- Returning to `Highlights` restores the viewport-visible highlights surface and
  preserves highlight focus/projection behavior.
- Reopening `Ask` restores the active embedded chat session.
- Full chat opens only through explicit promotion.

### Mobile UX

- Mobile selected-text Ask opens the local reader assistant sheet/drawer.
- The reader pane remains active until send.
- The mobile assistant uses the same embedded chat state machine as desktop.
- After send, linked context is visible on the user message.
- Promotion follows the same explicit full-chat rule.

### Data And Backend

- A reader-selection context can be sent without any saved highlight row.
- Sent reader-selection contexts persist immutable quote/source/locator
  snapshots.
- Saved-highlight contexts still persist object-ref snapshots and
  `used_as_context` links.
- Reader-selection contexts link messages to source media without fake objects.
- Permission-denied, stale, missing, and unresolved locator states produce typed
  errors.
- Chat prompt assembly includes reader-selection context as mandatory attached
  context.
- Scoped retrieval uses reader-selection context as a retrieval signal.

### Evidence And Source Navigation

- Assistant answers in the embedded rail render existing evidence/citation UI.
- Current-media citations navigate the current reader pane and project the
  temporary answer highlight.
- External-media citations open through normal in-app pane routing.
- Broken citations do not approximate a source location.

### Performance

- UI open is not blocked by:
  - highlight creation
  - PDF highlight refresh
  - `/api/conversations/resolve`
  - `/api/conversations/:id/messages`
  - `/api/models`
- Model loading is cached across embedded and full chat composers.
- Background scope resolution is cancellable or stale-result guarded.
- Sending before scoped resolve completion is safe and creates or resolves the
  scoped conversation exactly once.

### Tests

- Frontend unit tests cover:
  - single Ask action in `SelectionPopover`
  - rail mode switch
  - pending quote context display/removal
  - no workspace-pane open on default Ask
  - full chat promotion after conversation creation
  - cached model loading
  - mobile container using shared embedded panel
- Backend tests cover:
  - discriminated context schema validation
  - reader-selection context persistence
  - object-ref context persistence
  - prompt rendering
  - permission failures
  - media deletion cleanup
  - migration constraints
- E2E tests cover:
  - desktop non-PDF selection Ask
  - desktop PDF selection Ask
  - desktop saved-highlight Ask
  - returning from Ask to Highlights
  - explicit full-chat promotion
  - mobile Ask sheet/drawer
  - citation source jump in current media

## Key Decisions

- The product primitive is a reader assistant, not a faster route to chat.
- The desktop home for quote-to-chat is the media secondary rail.
- Selected quote context is not a saved highlight.
- Scope is chosen inside the assistant, not in the selection popover.
- Full chat is promotion, not default navigation.
- `AnchoredHighlightsRail` remains highlight projection infrastructure.
- Embedded chat logic is shared across desktop and mobile.
- URL-attached context moves to `attach_*`; `context=` is removed.
- Reader-selection context is persisted as message context with source media
  locator, not as a fake object ref.
- Error states are explicit and typed. Silent fallback is not part of the
  production contract.
