# Notes and Pages Resource Surface Editor Hard Cutover

Status: IMPLEMENTED — 2026-07-26
Type: hard cutover
Date: 2026-07-26

## Decision

Ship one quiet, shared editor for page and note resource surfaces.

- A page intrinsically owns only `title`.
- A note intrinsically owns only `body_pm_json` plus derived `body_text`.
- Both may expose one flat, ordered list of explicit outgoing resource
  placements.
- The scrollable masthead edits the source's intrinsic value.
- The body edits its ordered placements.
- Note placements are editable inline; other resources are compact, activatable
  rows.

No open questions. No feature flag, dual read/write, compatibility route,
payload alias, legacy draft import, fallback editor, or retained outline path.

This document supersedes the recursive-outline and page-specific editor
direction in:

- `docs/cutovers/notes-pages-object-graph-hard-cutover.md`;
- the frontend/API portions of
  `docs/cutovers/resource-native-pages-and-notes-hard-cutover.md`.

The resource-native storage ontology remains authoritative.

Governing standards: `docs/rules/simplicity.md`, `cleanliness.md`, `layers.md`,
`boundaries.md`, `frontend.md`, `database.md`, `concurrency.md`,
`operation-types.md`, `errors.md`, and `testing.md`.

## Scope / 80/20 Boundary

Build:

- one `ResourceSurfaceEditor`;
- one surface query;
- one atomic structural-command API;
- one flat resource-surface body compositor with one ProseMirror editor per
  inline note;
- optimistic local editing, current autosave timing, and local draft recovery;
- keyboard insertion, splitting, activation, removal, and reorder;
- current resource search, activation, attachment, reference, pulse, Companion,
  daily-note, indexing, and pane primitives.

Do not build:

- collaboration, CRDTs, presence, or server push;
- offline synchronization beyond local draft recovery;
- recursive inline nesting or transclusion;
- pointer drag/reorder;
- a formatting toolbar;
- virtualization;
- a second graph, document aggregate, note-placement table, or editor framework.

## Goals

1. Make pages and notes feel immediate, calm, and native at Apple Notes quality.
2. Make the product UI tell the same truth as the resource graph.
3. Make Enter create/split notes in the surface body; make Shift+Enter insert a
   line break inside a note.
4. Give source content, ordered placement, persistence, and rendering one owner
   each.
5. Preserve note identity when a note is reused, moved, or unlinked.
6. Replace multi-request page saves with atomic user-intent mutations.
7. Delete the recursive outline, page-document projection, and destructive
   adjacency replacement paths.
8. Lower total code and state-machine complexity.

## Non-Goals

- No Apple branding or pixel-copying.
- No page body field or note title field.
- No implicit inclusion of backlinks, citations, highlights, chats, or
  note-body references.
- No cross-note merge on Backspace/Delete.
- No delete-resource command in the editor.
- No durable structural command history/undo journal.
- No automatic graph traversal, flattening, or inherited children.
- No broad Vault, artifact, search, Companion, reader, or workspace redesign.
- No speculative resource-surface capability beyond pages and notes.

## Final State and Product Contract

### Mental model

```text
pane chrome: navigation + actions + derived one-line pane label

scrolling resource surface
├── masthead: source intrinsic content
└── body: source -> ordered outgoing resource occurrences
```

`page:<id>` masthead = page title.
`note_block:<id>` masthead = canonical note body.
Body membership = only `origin=user`, `kind=context`, non-null
`source_order_key` edges directly outgoing from that source.

The fixed 60px workspace chrome remains fixed. It mirrors a one-line,
truncated pane label. Canonical title/content lives in the scrollable masthead;
multiline note content never expands fixed pane chrome.

### Flat means one hop

- A page body renders only direct page occurrences.
- A note body renders only direct note occurrences.
- A note occurrence may itself own a surface, opened in its note pane.
- Existing `page -> note -> note` data is not flattened or copied. The first
  note appears on the page; the second appears in the first note's surface.
- Connections, backlinks, citations, and inferred relations remain in
  Companion unless the user explicitly inserts their resource as an ordered
  occurrence.

### Identity and placement

- A note is one globally reusable resource.
- An ordered edge is one placement occurrence.
- Editing a note changes it everywhere it appears.
- Moving an occurrence preserves its edge identity.
- Removing an occurrence deletes only that edge, never the target resource.
- A target may appear once per source and may appear under any number of other
  sources.
- Deleting a page or note remains an explicit resource action outside this
  editor.

### Keyboard contract

| Context | Enter | Shift+Enter |
|---|---|---|
| Page masthead | focus first body note; create it when empty | no action |
| Note masthead | insert a line break in the note | insert a line break |
| Body note row | split at caret; insert new note immediately after | insert a line break |
| Empty body insertion row | create and focus a blank note | no action |
| Non-note resource row | activate with existing `ResourceActivation` | no action |
| Open autocomplete/listbox | accept active option | editor does not intercept |
| IME composition | composition owns the key | composition owns the key |
| Code/embed/control focus | focused control owns the key | focused control owns the key |

Additional rules:

- `Alt+ArrowUp/Down` moves the current occurrence.
- `Tab`/`Shift+Tab` never create hierarchy; they retain normal focus/code
  behavior.
- Backspace on an empty note occurrence unlinks it and focuses the previous
  editable row. Backspace/Delete never merge two note resources.
- Undo/redo covers note text. Failed structural commands retain their optimistic
  draft and expose retry/reload/copy; durable structural history/undo would
  require a server-owned inverse journal and is outside this prototype cutover.
- Structural handlers run only inside the surface editor; no document-level
  Enter interception.

### Visual and motion contract

- One pane scroll container; no nested editor scroller.
- Content measure: at most `76ch`.
- Inline padding: `clamp(var(--space-4), 4vw, var(--space-8))`.
- Page title: existing `--text-xl`/`--weight-bold`.
- Note content and note rows: existing `--text-md`/`--leading-normal`.
- No permanent card border around note rows.
- Handles and row actions appear on hover, focus-within, or touch selection.
- Existing canvas, ink, spacing, radius, easing, and focus tokens are the only
  visual primitives.
- Input paints synchronously. Network work never blocks a keystroke.
- Insert/move/remove transitions use 120-180ms `--ease-glide`; reduced-motion
  removes them.
- Save success is silent. Recovery, conflict, and failure are compact and
  pane-local.
- Controls retain visible focus, semantic labels, keyboard reachability, and
  44px touch targets.

## Capability and Data Contract

No new table, column, index, or migration is expected.

| Concern | Canonical owner |
|---|---|
| Page intrinsic title | `pages.title` |
| Note intrinsic content | `note_blocks.body_pm_json`, derived `body_text` |
| Ordered occurrence | `resource_edges` |
| Per-lane concurrency | `resource_versions` |
| Request replay | `resource_mutations` |
| Occurrence view state | `resource_view_states`, preserved but not editor-owned |
| Admission | resource capability registry |
| Activation | `ResourceActivation` |

Rules:

- Source must have `adjacency_source=true`; today that is page or note.
- Target must have `adjacency_target=true`.
- `note_block` is the only inline-editable target scheme.
- All other admitted targets render from `ResourceItemOut` and activate through
  its existing activation descriptor.
- `source_order_key` is storage-private. Array order is the API order.
- The UI never derives membership from scheme, backlinks, search, citations, or
  Companion results.
- Surface reads use `resolve_refs` plus one bulk note-body load; no per-row
  hydration loop.

## Read Schema

`GET /resource-items/{resource_ref}/surface` is the sole surface query.
The canonical wire shape is snake_case only:

```text
ResourceSurfaceContent =
  | { kind: "page_title", title }
  | { kind: "note_body", body_pm_json, body_text }
  | { kind: "resource_summary" }

ResourceSurfaceNode = {
  item: ResourceItemOut,
  content: ResourceSurfaceContent
}

ResourceSurfaceOccurrence = {
  occurrence_id,
  target: ResourceSurfaceNode
}

ResourceSurface = {
  source: ResourceSurfaceNode,
  ordered_items: ResourceSurfaceOccurrence[]
}
```

`resource_summary` is target-only. A surface source that projects any other
content kind is a defect because source admission already restricts the set.
Versions remain on `ResourceItemOut.version_by_lane`; bodies do not duplicate a
version field.

The notes page DTO becomes page/daily-note metadata only. It does not embed
`surface`, recursive `blocks`, parent ids, order keys, children, or collapsed
state.

## Mutation API

Keep intrinsic and relational capabilities separate:

- `PATCH /resource-items/{page_ref}/title`;
- `PATCH /resource-items/{note_ref}/body`;
- `POST /resource-items/{source_ref}/surface/commands`.

Delete `PUT /resource-items/{source_ref}/adjacency`.

Every surface command request has:

```text
{
  client_mutation_id,
  base_versions: [{ ref, lane, version }],
  command
}

SurfacePosition =
  | { kind: "start" }
  | { kind: "after", occurrence_id }

command =
  | {
      type: "insert_note",
      note_id,
      position,
      body_pm_json
    }
  | {
      type: "split_note",
      occurrence_id,
      note_id,
      left_body_pm_json,
      right_body_pm_json
    }
  | {
      type: "insert_resource",
      target_ref,
      position
    }
  | {
      type: "move_occurrence",
      occurrence_id,
      position
    }
  | {
      type: "remove_occurrence",
      occurrence_id
    }
```

The response is `{ client_mutation_id, surface }`.

Command rules:

- The client creates stable `note_id` and `client_mutation_id` values once and
  reuses them on transport retry.
- `split_note` atomically updates the canonical left note, creates the right
  note, inserts its occurrence, bumps both body/outgoing lanes, syncs note-body
  references, and queues indexing.
- Splitting a reused note changes its left body everywhere; the new right note
  is placed only in the current surface.
- Insert rejects self-placement, invisible targets, incapable targets, and a
  target already present under the source.
- Move/remove address an occurrence owned by the requested source.
- Reorder updates keys in place; it never delete/recreates surviving edges or
  their view state.
- The graph owner may temporarily normalize keys inside the transaction, then
  stores dense canonical keys. Clients never send keys.

## Correctness and Persistence

- Each command is one replayable, serializable-equivalent database mutation.
- Validate every supplied base version before any write.
- Bump each changed lane exactly once.
- Identical replay returns the recorded response; the same mutation id with
  different bytes is an invalid request.
- A stale lane returns typed `E_RESOURCE_CONFLICT` with the latest surface.
- Unknown/malformed commands and impossible occurrence/source combinations fail
  closed; no best-effort partial result.
- Note indexing is queued durably from the same database boundary. Index
  execution remains asynchronous.
- Structural commands are optimistic and serialized per source in the browser.
- Text autosave reuses the current 1500ms idle / 5000ms max-wait policy and
  flushes on blur, visibility change, pane close, and route change.
- A conflict stops the queue, retains the local draft, and offers reload/copy;
  there is no silent merge or last-write-wins path.
- Draft recovery uses one new resource-surface storage key and current schema.
  Old outline drafts are neither read nor migrated.

## Frontend Architecture

```text
PagePaneBody / NotePaneBody              thin route adapters
  -> ResourceSurfaceEditor               masthead + body composition
      -> NoteBodyEditor                  one canonical note body
      -> ResourceSurfaceBodyEditor       flat keyed occurrence list
      -> useResourceSurfaceSession       optimistic queue/autosave/recovery
      -> resourceSurface API client      query + commands + intrinsic saves
```

The surface body is not another ProseMirror document and is never serialized as
one. It is a React-owned ordered list keyed by stable target identity. Each
inline note row mounts exactly one `NoteBodyEditor`; each non-note row renders
one existing `ResourceItem` activation. This keeps globally reused note bodies
independent, avoids nested editor/NodeView state, and leaves the graph as the
sole owner of occurrence order.

Shared note-body node specs/plugins own paragraphs, hard breaks, code, embeds,
images, marks, paste, attachments, `@`, `[[`, and Mod-K. The surface compositor
does not copy them. `ResourceSurfaceEditor` owns only occurrence composition
and structural commands.

`PagePaneBody` retains daily-date routing, Dawn Write, pane actions, and pending
note focus. `NotePaneBody` retains citation pulse and pane actions. Both delegate
all common loading, save, recovery, masthead, body, and error behavior.

## Intra-System Composition

- **Add item:** reuse `useResourceTargetSearch(purpose="link")`; show direct
  resource results with `adjacency_target=true`; exclude source and present
  targets. Passage materialization is out of scope.
- **Open item:** reuse `ResourceActivation`; no route reconstruction.
- **Inline references/attachments:** retain current note-body plugins and
  `origin=note_body` edges. They do not become surface occurrences.
- **Companion:** retains backlinks, connections, citations, and inferred
  relations. It is not duplicated below the editor.
- **Daily notes/Dawn Write:** remain a page-specific prefix around the shared
  surface.
- **Quick Capture/Amanuensis:** call the same insert-note capability; they do not
  rebuild a full adjacency list.
- **Indexing/search/citations:** body changes retain current note indexing and
  stable note refs.
- **Vault/artifacts:** may retain internal graph traversal/reconciliation for
  their owned export, import, or rendering behavior. They are not an
  interactive page-document API or editor fallback.

## File Plan

| Action | Files |
|---|---|
| Extend read/command schemas | `python/nexus/schemas/resource_items.py` |
| Own surface query/commands | `python/nexus/services/resource_items/surfaces.py` |
| Batch heterogeneous activation | `python/nexus/services/resource_items/routing.py` |
| Preserve occurrences during reconciliation | `python/nexus/services/resource_graph/adjacency.py` |
| Thin HTTP dispatch; delete adjacency route | `python/nexus/api/routes/resource_items.py` |
| Remove recursive page payload | `python/nexus/schemas/notes.py`, `python/nexus/services/notes.py` |
| Compose quick capture/tool insertion | `python/nexus/services/notes.py` |
| Replace BFF route | delete `apps/web/src/app/api/resource-items/[resourceRef]/adjacency/route.ts`; add `.../surface/commands/route.ts` |
| Own frontend DTO/API/session | `apps/web/src/lib/resources/resourceItems.ts`, new `apps/web/src/lib/resourceSurface/{api,useResourceSurfaceSession}.ts` |
| Own shared UI | new `apps/web/src/components/resource-surface/ResourceSurfaceEditor.tsx`, `ResourceSurfaceBodyEditor.tsx`, and their `.module.css` files |
| Extract reusable body editor | `apps/web/src/components/notes/NoteBodyEditor.tsx`, `apps/web/src/lib/notes/prosemirror/*` |
| Thin pane adapters | `PagePaneBody.tsx`, `NotePaneBody.tsx`, `notes.module.css` |
| Replace behavior tests | `python/tests/test_resource_item_surfaces.py`, shared editor component tests, pane tests, `e2e/tests/notes.spec.ts` |
| Lock deletion | `python/tests/test_cutover_negative_gates.py` |
| Close docs | `docs/architecture.md`, this document's status |

### Required deletion

- `ProseMirrorOutlineEditor*`;
- `outlineSchema`, `outline_doc`, `outline_block`, nesting, indent/outdent, and
  cross-block merge commands;
- `resourceSurfacePersistence.ts`;
- `SaveResourceSurfaceInput`, `saveResourceSurface`, and its multi-request loop;
- `ResourceSurfaceMutationRequest`, `replace_surface`, and the `/adjacency`
  API/BFF route;
- frontend `parentBlockId`, `children`, `collapsed`, and `orderKey` note-surface
  fields;
- `NotePageOut.blocks`, `NotePageOut.surface`, `_surface_note_out`;
- dead `apply_note_surface`, `find_surface_note`, `delete_block_subtree`, and
  their now-unreferenced helpers;
- touched surface-only snake/camel dual decoders and aliases;
- old mocks/tests/screenshots that assert recursive outline or replacement-save
  behavior.

`ProseMirrorOutlineEditor` is also used by Create and highlight-note flows.
Those callers move to `NoteBodyEditor`; the old file is not retained as a
wrapper.

## Delivery Order

1. Write failing service/API and real-browser behavior tests from the acceptance
   criteria.
2. Land the batched read projection, in-place adjacency reconciliation, and
   command service.
3. Cut HTTP/BFF/client contracts to the new query and command API.
4. Extract `NoteBodyEditor`; build the flat shared surface editor/session.
5. Replace both pane bodies and migrate Create/highlight callers.
6. Move Quick Capture/Amanuensis to the shared insertion capability.
7. Delete every old route, type, helper, command, test, style, and draft path.
8. Add negative gates, update architecture, run focused verification, then mark
   this document implemented.

No phase may merge with both old and new production paths alive.

## Acceptance Criteria

- **AC1:** Page pane shows one editable title masthead and no page body field.
- **AC2:** Note pane shows one editable canonical-content masthead and no title
  field.
- **AC3:** Both bodies render exactly their direct ordered outgoing occurrences,
  including heterogeneous resource types.
- **AC4:** Body-note Enter splits atomically; Shift+Enter adds a line break;
  page-title Enter focuses/creates the first note.
- **AC5:** Autocomplete, IME, code/embed, and focused controls win key precedence;
  non-note Enter activates.
- **AC6:** Insert, split, move, unlink, text undo/redo, reload, and retry
  preserve visible order and content.
- **AC7:** Move preserves occurrence id and associated view state.
- **AC8:** Unlink never deletes the target; editing a reused note updates every
  occurrence after reload.
- **AC9:** Each structural gesture emits one request and commits atomically;
  replay is idempotent and stale versions return `E_RESOURCE_CONFLICT`.
- **AC10:** Typing is local-first, success is silent, lifecycle flush works, and
  failed/conflicting drafts remain recoverable.
- **AC11:** Surface load is batched; no per-item request or database hydration
  loop.
- **AC12:** Companion, Dawn Write, references, attachments, citation pulse,
  quick capture, Amanuensis, indexing, activation, and pane return still work.
- **AC13:** Desktop, 390px mobile, keyboard-only, touch, screen-reader, reduced
  motion, empty, long-content, failure, and recovery states are usable.
- **AC14:** No interactive nested outline UI, recursive page API payload,
  destructive surface-replace API, legacy route, alias, draft bridge, fallback,
  or dual path remains. Vault/artifact-owned internal graph traversal follows
  the composition boundary above.
- **AC15:** The final implementation deletes more production complexity than it
  adds outside the single shared editor/session and command owner.

## Focused Verification

- Backend integration: surface projection, each command, atomic rollback,
  replay, conflict, stable edge/view state, capability rejection, reuse/unlink.
- Browser component: exact key-precedence matrix, focus, mixed rows,
  autocomplete, recovery, reduced motion, accessibility.
- Pane/E2E: create page, title Enter, type/split/line break, add non-note, move,
  unlink, open note, edit reused note, reload, daily note, Companion.
- Static: frontend typecheck/lint/CSS-token gate and cutover negative gates.
- Visual: existing page/note screenshot viewports, including 390px mobile.

Use focused owner suites first. Do not substitute a broad green suite for the
named behavior contracts.
