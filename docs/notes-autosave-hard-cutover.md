# Notes Autosave Stability Hard Cutover

## Status

Implemented hard cutover.

This document owns the notes autosave, editor focus, and note persistence
contract for page notes, focused note panes, daily notes, and highlight-linked
notes in reader rails.

The cutover is hard. There is no feature flag, no compatibility mode, no old
controlled-editor path, no post-save highlight refetch path for note body
changes, no PDF refresh-token fallback for note body changes, no legacy
per-block page-save loop, and no fallback behavior that reloads or remounts a
focused editor after autosave.

## Problem

Notes currently have two different persistence shapes.

Full page notes keep the loaded ProseMirror doc stable in the client and save
after a short debounce. That usually preserves focus, but one editor snapshot is
persisted as many independent block update, create, move, and delete requests.
The save is not atomic, does not use revision checks, and can update unchanged
blocks or move unchanged rows.

Highlight-linked notes have a sharper user-visible defect. The focused note
editor derives its live document from `note` props. Autosave updates or creates a
note block, then the media pane refetches highlights or refreshes PDF highlight
state. The refetched highlight payload creates fresh note body objects. Those
fresh props rebuild the editor document, and the shared ProseMirror component
destroys and recreates the `EditorView`. The user sees this as reload, defocus,
selection loss, and sometimes a first-save remount when a temporary note key
becomes a persisted note block id.

Autosave must feel like background sync. It must not be modeled as save,
refetch, rehydrate, and recreate the editor.

## Goals

- Preserve editor focus, selection, undo history, and live typing across
  autosave.
- Treat the ProseMirror editor instance as the owner of focused editing
  mechanics.
- Treat autosave as background persistence of the current editor state.
- Use one notes autosave session implementation for page notes, focused note
  panes, daily notes, and highlight-linked notes.
- Serialize saves by resource scope and collapse queued writes to the newest doc.
- Ignore stale save responses instead of letting them overwrite newer local
  edits.
- Save only meaningful note changes.
- Patch local highlight note summaries from mutation responses instead of
  refetching highlight lists after note body saves.
- Keep PDF highlight geometry refresh separate from note body persistence.
- Make new highlight-linked note identity stable before first save.
- Persist page document edits atomically through one backend service operation.
- Add explicit revision-based conflict handling for notes.
- Flush pending note edits on blur, unmount, route close, `pagehide`, and
  visibility loss.
- Use named timing constants for debounce, max-wait, and lifecycle flush
  behavior.
- Add behavior tests that prove autosave does not reload, defocus, over-save, or
  lose queued edits.

## Non-Goals

- Do not add a user setting for autosave cadence.
- Do not keep the old controlled ProseMirror `doc` prop path.
- Do not preserve the legacy page-save loop of per-block requests.
- Do not add React Query, SWR, Zustand, or another global cache dependency solely
  for notes.
- Do not implement Yjs, Automerge, CRDT collaboration, or multiplayer cursors in
  this cutover.
- Do not implement a complete offline-first product mode.
- Do not make reader highlight geometry, PDF rendering, or media ingestion depend
  on note body saves.
- Do not add polling to reconcile note saves.
- Do not hide conflicts by silently overwriting remote changes.
- Do not introduce compatibility routes for the old save behavior.

## Hard-Cutover Policy

- No feature flags.
- No environment toggles.
- No query toggles.
- No old/new editor branches.
- No compatibility wrapper around the controlled editor behavior.
- No fallback to refetching highlights after note body saves.
- No fallback to bumping `pdfRefreshToken` after note body saves.
- No duplicate autosave implementations after cutover.
- No raw inline timing values in notes autosave code.
- Delete or rewrite tests that assert the old remount, refetch, or per-block save
  behavior.
- Update docs that describe notes save behavior without this focus-stability
  contract.

## Final State

Notes have one editor session model.

The editor mounts from an initial server snapshot for a specific resource key.
After mount, ProseMirror transactions own the focused document, selection, focus,
and undo history. Parent component rerenders, server echoes, save-status changes,
highlight summary changes, and equivalent note body payloads do not recreate the
`EditorView`.

Every document change updates the local note session immediately and schedules a
background save. The save session is scoped by resource:

```text
page:<page-id>
block:<block-id>
highlight:<highlight-id>:<note-block-id-or-draft-id>
```

Each scope has at most one in-flight write. While a write is in flight, later
edits replace the queued doc for that scope. When the in-flight write resolves,
the session applies the response only if it acknowledges the current local
sequence. If the user typed more since the request started, the response updates
revision metadata but never replaces the live editor doc.

Highlight-linked note saves update or create note blocks and then patch only the
affected highlight row's `linked_note_blocks` summary from the returned
normalized note block. The highlight list is not refetched for note body saves.
PDF highlight note saves do the same local note-summary patch and do not refresh
PDF highlight geometry.

Page note saves use one backend-owned document save endpoint. The backend applies
the page diff in one service operation, validates revisions, updates search
projection and page metadata once, commits once, and returns the normalized page
snapshot plus revision metadata. A conflict leaves the local draft dirty and
visible; it does not reload the editor.

## Target Behavior

### Typing A Page Note

1. The page loads a server snapshot.
2. The editor mounts once for `page:<page-id>`.
3. The user types continuously.
4. The editor remains focused.
5. Autosave waits for the configured idle debounce.
6. Continuous typing is bounded by the configured max-wait flush.
7. A save request persists the latest doc snapshot for the page.
8. Returned server data updates clean/revision state when current.
9. The editor doc, focus, selection, and undo stack are not replaced by the save
   response.
10. No extra `GET /api/notes/pages/:pageId` is issued after save.

### Typing A Focused Note Pane

1. `/notes/:blockId` resolves the note block resource.
2. The focused editor mounts once for `block:<block-id>`.
3. Autosave persists the focused block tree under its original parent.
4. Route-level rerenders and save-status changes do not remount the editor.
5. A conflict on the focused block leaves the local draft dirty and visible.

### Typing A Daily Note

1. The daily route loads or creates the daily page.
2. The daily response primes the notes session for its page.
3. The page editor does not fetch the same page again unless the session has no
   usable snapshot.
4. Autosave follows the same page save behavior as `/pages/:pageId`.

### Typing A Highlight-Linked Note

1. Opening the rail creates a stable draft note identity for every editable
   highlight note slot.
2. The editor key is stable before and after first persistence.
3. The user types in the highlight note editor.
4. Autosave persists after the configured debounce.
5. Create uses the stable client-generated note block id.
6. Update uses the persisted note block id.
7. The returned normalized `NoteBlock` patches the affected highlight's
   `linked_note_blocks` locally.
8. The highlight list is not refetched because note body changed.
9. The row remains visible.
10. The editor remains focused and further typing appends to the same live doc.

### PDF Highlight-Linked Note

1. Typing a PDF highlight note follows the same highlight-linked note behavior.
2. Note body save does not bump the PDF highlight refresh token.
3. The PDF document, current page, zoom, scroll state, and highlight geometry are
   not reloaded because note text changed.
4. Geometry/color/bounds mutations keep their existing PDF refresh behavior.

### Save While Save Is In Flight

1. The first save starts for the current local sequence.
2. The user continues typing.
3. The session records the latest doc as the queued doc.
4. The first response cannot mark the session clean if a newer local sequence
   exists.
5. The queued save starts after the first write settles.
6. Only the latest queued doc is sent.
7. The final acknowledged sequence marks the session clean.

### Empty Highlight Note

1. An empty unsaved highlight note slot is not persisted.
2. Emptying a persisted highlight note deletes that note block.
3. Delete patches the affected highlight's local `linked_note_blocks`.
4. Delete does not refetch highlights or refresh PDF geometry.
5. If a delete conflicts with a newer local edit, the local edit wins and the
   delete response is treated as stale.

### Conflict

1. A save request includes base revision metadata.
2. The backend rejects stale base revisions with a typed note conflict.
3. The frontend keeps the local draft dirty.
4. The editor stays mounted and focused if it was focused.
5. The save status shows conflict.
6. The user can choose a final conflict action implemented by this cutover:
   reload latest and discard local draft, or overwrite with local draft.
7. No conflict path silently overwrites remote content.

### Lifecycle Flush

1. Blur flushes pending edits for the blurred editor scope.
2. Unmount flushes pending edits for the unmounted scope.
3. `pagehide` flushes all dirty scopes.
4. `visibilitychange` to hidden flushes all dirty scopes.
5. Flush uses the same save queue and stale-response rules as debounce saves.

## Product Rules

- Autosave is background sync, not content rehydration.
- The focused editor is never remounted because save succeeded.
- Server echoes do not replace active local edits.
- Local user input is the most recent truth until a save acknowledges that exact
  local sequence.
- One resource scope has one save queue.
- A save response can update metadata without replacing the live editor doc.
- A note body change does not require a highlight list refetch.
- A note body change does not require PDF highlight geometry refresh.
- A first save must not change React identity for the editor being typed in.
- Conflicts are explicit and recoverable.
- No path silently drops local unsaved edits.
- No path updates unchanged note blocks just because a page save ran.

## Repo Rule Alignment

- Follow the Browser -> Next.js BFF -> FastAPI -> Postgres layer boundary. BFF
  routes remain transport proxies; notes business logic belongs in FastAPI
  services.
- Keep one primary notes autosave capability. Do not expose interchangeable
  component-local save APIs after the shared session lands.
- Keep timing parameters as named constants in one notes module.
- Do not add polling for save reconciliation.
- Use typed API errors for note conflicts and save failures.
- Preserve sequential equivalence under concurrent saves. If concurrent execution
  can produce an impossible ordering, it is a bug.
- Use backend transactions for the atomic page document save.
- Keep tests behavior-focused: focus stays, text remains, requests are bounded,
  conflicts preserve local drafts.
- Do not add speculative options, flags, or alternate save modes.

## Architecture

### Ownership

`ProseMirrorOutlineEditor` owns editor mechanics:

- creating and destroying `EditorView`
- applying transactions
- preserving focus and selection
- preserving undo history
- object-ref autocomplete UI
- exposing editor lifecycle events

It receives an `initialDoc` and a `resourceKey`. It only recreates the editor
when `resourceKey` changes. It does not recreate the editor when parent props
carry an equivalent or newer server echo for the same resource.

`useNoteEditorSession` owns note persistence state:

- local sequence
- acknowledged sequence
- dirty/clean/conflict status
- debounce timer
- max-wait timer
- pending doc
- in-flight request
- queued latest doc
- base revision metadata
- lifecycle flush

`PagePaneBody` owns route composition for page and focused note routes. It does
not own autosave internals after cutover.

`HighlightNoteEditor` owns the highlight note editing shell and stable draft
identity. It does not own a private autosave queue after cutover.

`MediaPaneBody` owns media/highlight state and patches highlight summaries from
note mutation results. It does not refetch highlight lists for note body saves.

`AnchoredHighlightsRail` owns row rendering and layout measurement. It uses
stable editor keys and throttles note-layout measurement invalidation without
participating in persistence.

FastAPI notes services own atomic note persistence, revision validation,
conflict responses, and projection updates.

### Editor Interface

Replace the controlled doc prop with the final editor interface:

```ts
interface ProseMirrorOutlineEditorProps {
  resourceKey: string;
  initialDoc: ProseMirrorNode;
  editable?: boolean;
  ariaLabel?: string;
  createBlockId?: () => string;
  singleBlock?: boolean;
  searchObjects?: (query: string) => Promise<HydratedObjectRef[]>;
  onDocChange?: (doc: ProseMirrorNode) => void;
  onFocusChange?: (focused: boolean) => void;
  onBlurFlush?: (doc: ProseMirrorNode) => void;
  onOpenBlock?: (blockId: string, openInNewPane: boolean) => void;
  onOpenObject?: (objectType: string, objectId: string, openInNewPane: boolean) => void;
}
```

The editor may expose an imperative ref only for explicit operations that are not
expressible as props, such as reading the current doc during lifecycle flush. Do
not expose a general-purpose `setDoc` fallback.

### Autosave Session

Add one shared frontend module:

```text
apps/web/src/lib/notes/useNoteEditorSession.ts
```

The hook owns the save queue and exposes:

```ts
interface NoteEditorSession {
  status: "clean" | "dirty" | "saving" | "saved" | "failed" | "conflict";
  scheduleSave(doc: ProseMirrorNode): void;
  flush(): void;
  reset(): void;
}
```

Timing constants live in one notes module:

```ts
const NOTE_AUTOSAVE_IDLE_DELAY_MS = 1500;
const NOTE_AUTOSAVE_MAX_WAIT_MS = 5000;
const NOTE_LAYOUT_MEASURE_DELAY_MS = 100;
```

If final implementation chooses different values, change them only in the
constant definitions and keep their names. Do not inline these numbers in
components.

### Page Document Save Endpoint

Add one backend endpoint:

```text
PATCH /notes/pages/{page_id}/document
```

Add one Next proxy route:

```text
PATCH /api/notes/pages/[pageId]/document
```

The request includes:

- `client_mutation_id`
- `base_page_revision`
- scope metadata for page or focused block save
- `blocks`, containing only changed existing blocks with `base_revision` and
  newly created blocks with client-generated ids and `base_revision: null`
- `deleted_blocks`, containing root deleted block ids with `base_revision`
- order and parent changes

The response returns the normalized page or focused block snapshot, updated
revision metadata, and the applied client mutation id.

The service applies the document diff in one transaction and updates page
metadata/search projection once.

### Highlight Note Save

Keep note block create, update, and delete endpoints for single highlight-linked
notes. The frontend uses the returned normalized note block to patch local
highlight state.

`createNoteBlock`, `updateNoteBlock`, and `deleteNoteBlock` remain note block
capabilities. They are not legacy paths because highlight notes are one-block
resources and do not need the page document endpoint.

### Revision Model

Add integer revisions:

- `pages.revision`
- `note_blocks.revision`

Revisions increment on successful mutations to that resource. Timestamps remain
display metadata and are not the concurrency contract.

Conflict detection uses revisions, not client clocks.

### Local Draft Journal

Use a small browser-local draft journal after the main cutover code path is in
place:

- key by note save scope
- include base page/block revisions and local document metadata
- write on local change
- clear after current sequence is acknowledged
- recover on mount by autosaving with the draft's original base revisions, so a
  server-side change becomes a normal typed conflict instead of a silent
  overwrite

This journal is not an offline-first mode. It is crash recovery for unsynced
local edits.

## Key Decisions

1. The editor is uncontrolled after mount.
2. A save response does not replace focused editor content.
3. Highlight note saves patch local highlight summaries.
4. PDF note body saves do not refresh PDF highlight geometry.
5. Page note saves become atomic backend operations.
6. Revisions are integer write contracts.
7. Debounce is a traffic-shaping tool, not the correctness mechanism.
8. Queues, sequence checks, and revisions are the correctness mechanism.
9. The cutover does not adopt CRDTs.
10. The cutover does not add a general frontend query cache.

## Files

### Frontend Notes

- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
- `apps/web/src/components/notes/HighlightNoteEditor.tsx`
- `apps/web/src/components/notes/HighlightNoteEditor.test.tsx`
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.test.tsx`
- `apps/web/src/lib/notes/api.ts`
- `apps/web/src/lib/notes/useNoteEditorSession.ts`
- `apps/web/src/lib/notes/prosemirror/schema.ts`
- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`
- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/notes/[blockId]/NotePaneBody.tsx`
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx`

### Frontend Reader And Highlights

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlights.ts`
- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsRail.test.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/__tests__/components/PdfReader.test.tsx`

### Next BFF

- `apps/web/src/app/api/notes/pages/[pageId]/document/route.ts`
- `apps/web/src/app/api/notes/blocks/route.ts`
- `apps/web/src/app/api/notes/blocks/[blockId]/route.ts`

### Backend

- `python/nexus/api/routes/notes.py`
- `python/nexus/services/notes.py`
- `python/nexus/schemas/notes.py`
- `python/nexus/errors.py`
- `python/nexus/db/models.py`
- `migrations/alembic/versions/*_notes_revisions_document_save.py`
- `python/tests/test_notes.py`

### E2E

- `e2e/tests/notes.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`
- optional shared request-count helper under `e2e/tests/`

## Implementation Plan

1. Add failing browser tests for focused highlight note autosave preserving focus
   across parent server echoes.
2. Add failing rail tests proving linked-note save does not remount the note
   editor.
3. Add failing page-note tests for save queue collapse and no post-save page
   refetch.
4. Cut over `ProseMirrorOutlineEditor` to `resourceKey` plus `initialDoc`.
5. Add `useNoteEditorSession` and move duplicated autosave logic into it.
6. Cut over `HighlightNoteEditor` to stable draft ids and shared session.
7. Patch `MediaPaneBody` to update highlight note summaries locally from returned
   note blocks.
8. Remove PDF note-save refresh-token behavior.
9. Cut over `AnchoredHighlightsRail` to stable editor keys and throttled note
   layout invalidation.
10. Add note revisions in the database, Pydantic schemas, and TypeScript types.
11. Add the page document save endpoint and service operation.
12. Cut over `PagePaneBody` from per-block save loops to the document endpoint.
13. Add conflict handling UI and behavior tests.
14. Add lifecycle flush and local draft journal.
15. Add E2E coverage for non-PDF highlight note autosave and PDF highlight note
   autosave.
16. Delete legacy autosave code and tests that assert old request shapes.

## Acceptance Criteria

### Focus And Reload

- Typing in a highlight-linked note through two autosave cycles keeps focus in the
  same editor.
- The typed text after the second cycle appends to the existing live doc.
- First save of a new highlight-linked note does not remount the editor.
- PDF highlight note autosave does not reload the PDF file, page, zoom, or
  highlight geometry.
- Page note autosave does not refetch the page after save.

### Request Shape

- A burst of typing in one editor produces one save after idle debounce.
- Continuous typing produces bounded saves no more frequently than max-wait.
- A save in flight plus more typing produces one queued latest save.
- Highlight note body save does not call `GET /api/fragments/:id/highlights`.
- PDF note body save does not call the PDF highlight refresh path.
- Page note save calls the document endpoint, not per-block update/move/delete
  loops.

### Correctness

- Stale save responses cannot mark newer local edits clean.
- Conflicts return typed errors and preserve the dirty local draft.
- Independent saves in different scopes do not block each other.
- Repeated create with the same client note block id is idempotent or rejected
  with a typed conflict, never duplicated.
- Empty persisted highlight notes delete exactly one note block and patch local
  highlight state.

### Tests

- Browser component tests cover editor focus preservation, parent echo rerenders,
  stable first-save identity, queue collapse, and stale response handling.
- Backend integration tests cover document save success, revision conflict,
  idempotency, create/update/delete/move in one page document save, and
  independent mergeable edits.
- E2E tests cover non-PDF highlight note autosave and PDF highlight note autosave
  without reload or focus loss.

## Verification

Focused checks:

```bash
cd apps/web
bunx vitest run --project browser \
  src/components/notes/HighlightNoteEditor.test.tsx \
  src/components/notes/ProseMirrorOutlineEditor.test.tsx \
  src/components/reader/AnchoredHighlightsRail.test.tsx \
  'src/app/(authenticated)/pages/[pageId]/PagePaneBody.test.tsx'
```

Backend notes checks:

```bash
make test-back-integration PYTEST_ARGS=python/tests/test_notes.py
```

E2E checks:

```bash
PLAYWRIGHT_ARGS="notes.spec.ts pdf-reader.spec.ts" make test-e2e
```

Final gate:

```bash
make verify
```

## External References

- ProseMirror guide: https://prosemirror.net/docs/guide/
- Tiptap persistence: https://tiptap.dev/docs/editor/core-concepts/persistence
- Tiptap performance guidance: https://tiptap.dev/docs/guides/performance
- Yjs ProseMirror binding: https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror
- Local-first software: https://www.inkandswitch.com/essay/local-first/
