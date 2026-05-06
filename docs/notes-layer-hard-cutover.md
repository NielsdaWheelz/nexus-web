# Notes Layer Hard Cutover

## Role

This document is the target-state plan for replacing page-only markdown notes,
highlight-bound annotations, object-specific context links, ad hoc note access
surfaces, and type-specific note search with one ProseMirror-backed knowledge
workspace and one universal object-link graph.

The implementation is a hard cutover. The final state keeps no annotation
editor, no `Annotation` model, no compatibility route for old annotation ids,
no feature flag, no fallback markdown textarea editor, no old
media/highlight/annotation-only chat context path, and no backward-compatible
renderer for old annotation payloads.

The cutover establishes these durable primitives:

```text
DailyNotePage
  -> Page
      -> NoteBlock
          -> ProseMirror inline/block content
          -> ObjectLink
              -> ObjectRef
          -> ObjectSearchDocument
              -> ObjectSearchEmbedding
```

`NoteBlock` is the smallest editable and linkable note unit. `Page` is a
named container for ordered note blocks. `ObjectLink` is the single durable
relationship model for notes, pages, media, highlights, messages,
conversations, and future object types. `DailyNotePage` is a durable date
identity that resolves to an ordinary page. `ObjectSearchDocument` is the
searchable projection of a page, note block, or other supported ObjectRef.

## Goals

- One Roam-style outliner for editable notes: bullets, nesting, zooming,
  splitting, merging, moving, and keyboard-first editing.
- One fast access model for knowledge work: Today, Notes, Pages, pinned
  objects, recent objects, command palette, and global add all resolve through
  the same ObjectRef and pane runtime.
- One daily-note flow where `Today` and `/daily/:localDate` resolve to an
  ordinary page through durable date identity, not title matching.
- Pure ProseMirror as the editor foundation. Do not use Tiptap, Lexical,
  Draft, Slate, a plain textarea, or ad hoc `contenteditable`.
- Stable block ids for every bullet or editable note unit.
- Page panes and note panes that share the same editor and renderer; only
  their headers, scope, and backlink surfaces differ.
- Universal object references so any note block can reference any supported
  object and any chat can pull any supported object as context.
- One bidirectional link table with independent ordering from each endpoint.
- Embeds and transclusion as ObjectRef presentation over durable object links,
  never copied note content.
- First-class hybrid search for pages and note blocks: exact/title matching,
  PostgreSQL full-text search, vector retrieval, object-type filters, and
  deterministic reranking over the same result contract.
- AI context that is grounded in the same pages, note blocks, object links,
  search documents, and evidence spans the user sees in the product.
- Annotation hard cutover: existing valid annotations become note blocks
  linked to their highlights, then legacy annotation storage and code are
  removed.
- Markdown import, export, vault sync, and LLM context projection generated
  from the structured note model.
- Reader and note readability that follows `docs/reader-research.md` and
  `docs/reader-implementation.md`.
- Responsive editing for large pages and deep outlines.
- Deterministic tests for cursor behavior, block movement, object linking,
  annotation migration, vault projection, search, and chat context hydration.

## Non-Goals

- Do not preserve annotation API compatibility.
- Do not preserve annotation ids as navigable user-facing objects.
- Do not keep `Annotation.body` as a product data path.
- Do not keep `MessageContext` limited to media, highlight, and annotation.
- Do not preserve `ConversationMedia` as a user-authored relationship model.
  A derived read model may exist only if it is rebuilt from universal object
  references.
- Do not make Markdown files the canonical source of truth for notes.
- Do not store raw HTML as note content.
- Do not build a custom editor engine.
- Do not add real-time multiplayer editing, CRDT sync, comments, suggestions,
  or track changes in this cutover.
- Do not add canvas, whiteboard, database views, or Tana-style typed schemas
  beyond minimal object types and link relation types.
- Do not add a plugin system for notes.
- Do not implement mobile-native clients.
- Do not split rollout by user, media type, annotation type, or feature flag.
- Do not create a separate daily-note model with its own editor, body,
  backlinks, search path, chat context path, or export path.
- Do not identify daily notes by page title, slug, route text, or mutable
  labels.
- Do not put every page in the primary navbar. Primary navigation exposes
  durable surfaces and user-pinned objects, not an unbounded page list.
- Do not ship vector-only search, lexical-only search, or a search path that
  bypasses ObjectRef hydration.
- Do not add an external vector database, external note warehouse, or second
  knowledge search service in this cutover.
- Do not copy embedded page or block content into the containing object.
  Embeds are references with render-time projection.
- Do not make AI memory a parallel data model. AI context uses ObjectRefs,
  object links, evidence spans, and search documents.

## Final State

Nexus has one notes domain.

- `/notes` opens the notes home pane.
- `/notes/:blockId` opens a focused note pane for one note block.
- `/pages/:pageId` opens a page pane for a page outline.
- `/daily` opens today's daily note page for the user's local date.
- `/daily/:localDate` opens or creates the daily note page for that local
  date.
- The primary navbar exposes Today, Notes or Pages, Search, Add, and any
  user-pinned knowledge objects through stable navigation items.
- The global Add affordance can create a new page, open today's note, append
  a quick note to today's page, import files or URLs, and import OPML.
- Clicking an internal note/page/object link opens it in the current pane.
- Shift-clicking an internal note/page/object link opens it in a new pane
  through the existing workspace pane runtime.
- Every bullet in a page is a `note_block`.
- Every note block can contain Markdown-equivalent rich text, inline object
  references, links, images, code snippets, and supported embeds through the
  ProseMirror schema.
- Highlights no longer have annotations. A highlight can have linked note
  blocks, and those note blocks appear in backlinks and chat context.
- Chat context accepts any supported `ObjectRef`.
- Search returns pages and note blocks as first-class hybrid results with
  ObjectRefs, snippets, backlinks, routes, and chat-context actions.
- Pages, note blocks, and embedded objects are indexed through one
  object-search projection. Media evidence remains indexed through the
  evidence layer and appears as `content_chunk` results.
- Vault sync exports and imports pages and note blocks as deterministic
  Markdown projection files with stable block ids.

Legacy annotation code is gone from active application code. Old annotation
rows are handled only by the one-time cutover migration.

## Target Behavior

### Knowledge Navigation

- The navbar exposes knowledge surfaces, not implementation tables.
- `Today` opens the current local daily note.
- `Notes` or `Pages` opens the notes home pane.
- Pinned pages and pinned note blocks appear in the knowledge navigation area
  only when the user explicitly pins them.
- Recent pages and note blocks appear in command palette and notes home. They
  do not become permanent navigation items.
- Opening a page, note block, daily note, search result, backlink, or embedded
  object goes through the pane runtime.
- Internal navigation uses current-pane behavior by default and new-pane
  behavior for Shift-click or explicit open-in-new-pane commands.
- Navbar active state is route-aware for `/notes`, `/pages/*`, `/notes/*`,
  and `/daily/*`.
- Page titles in navigation are hydrated from ObjectRef. The navbar does not
  keep independent page-title state.

### Global Add and Quick Capture

- The global Add affordance is the fastest path to create knowledge objects.
- `New page` creates a blank page, opens it in the current pane, and focuses
  the title or first block.
- `Today` opens or creates the user's current local daily note.
- `Quick note to today` appends one note block to today's page without forcing
  the user through an import flow.
- File, URL, and OPML import remain Add modes, but they do not dominate the
  first interaction.
- Add actions use existing services and pane navigation. They do not create
  frontend-only placeholder pages.
- Failed creates, imports, and appends use the feedback layer and leave no
  partially navigable object.

### Daily Notes

- A daily note is an ordinary page with a durable daily identity row.
- Daily identity is `(user_id, local_date)`.
- `local_date` is the user's intended calendar date, not a server timestamp
  truncated in UTC.
- The user's timezone is used to resolve `/daily` to a `local_date`.
- `/daily/:localDate` accepts only ISO `YYYY-MM-DD` dates.
- Resolving a daily note performs SELECT-before-create inside a retryable
  serializable transaction.
- Creating the same daily note concurrently produces one page and one daily
  identity row.
- The default daily page title is derived from the local date, but the user
  may rename it without breaking `/daily/:localDate`.
- Daily pages appear in normal page lists, backlinks, search, vault export,
  and chat context.
- Daily pages can contain any supported note block, object reference, embed,
  backlink, or highlight-linked note.
- Daily notes are the default quick-capture destination. They are not the only
  organization model.
- Users can move blocks from a daily page to another page without changing
  block ids.
- Users can create a page from a block on a daily page and leave an object
  link or embed behind when requested.

### Page Pane

- A page pane displays the page title and a single continuous editable
  outline.
- The outline is an ordered forest of top-level note blocks.
- Each block renders as a bullet row with nested children.
- The user can click inside text to place the cursor exactly where clicked.
- The user can click the bullet affordance to focus or select the block.
- Shift-clicking the bullet affordance opens the block in a new note pane.
- The page pane preserves scroll position, collapsed state, and current block
  focus while the pane remains mounted.
- Page title edits update internal links through backend-owned object
  references; link identity is id-based, not title-based.

### Note Pane

- A note pane displays one focused block as the root of the editable outline.
- Ancestors appear as a compact breadcrumb in the pane header.
- Descendants appear inline and remain editable.
- Backlinks and linked objects appear below or beside the focused outline
  depending on pane width.
- Editing the focused block in a note pane edits the same canonical block
  shown in its page pane.
- A note pane is not a copy of a block. It is a focused view over the same
  block id.

### Keyboard Editing

The editor owns these shortcuts:

- `Enter`: split the current block at the cursor or create a new sibling
  block after the current block.
- `Shift+Enter`: insert a soft line break inside the current block.
- `Tab`: indent the current block under the previous sibling when valid.
- `Shift+Tab`: outdent the current block when valid.
- `Alt+Up`: move the current block before the previous sibling.
- `Alt+Down`: move the current block after the next sibling.
- `Mod+Shift+Up`: move the selected block range upward when supported by the
  platform convention.
- `Mod+Shift+Down`: move the selected block range downward when supported by
  the platform convention.
- `Backspace` at the start of an empty block: merge into the previous block or
  lift out of the parent according to outliner rules.
- `Delete` at the end of a block: merge with the next editable block when
  valid.
- `Mod+K`: open object-link insertion for the current selection.
- `[[`: open page and note autocomplete.
- `@`: open object autocomplete for pages, note blocks, media, highlights,
  conversations, and messages.

Keyboard commands are implemented as ProseMirror commands and keymaps. They
are not React DOM event hacks.

### Cursor and Selection

- Arrow up and arrow down preserve the user's intended horizontal column when
  moving between visual lines and adjacent blocks.
- Browser-native selection is used where it is correct; ProseMirror selection
  mapping owns cross-block behavior.
- Selection survives inline object references, links, code marks, and soft
  line breaks.
- Pasting nested Markdown lists creates nested note blocks with stable ids.
- Pasting rich text is sanitized into the ProseMirror schema.
- Pasting unsupported HTML stores only supported semantic content.
- Undo and redo work across block splits, merges, indents, outdents, moves,
  inline edits, object-reference inserts, and paste operations.
- Selection bugs are correctness bugs, not polish issues.

### Linking and Backlinks

- Every persisted relationship uses `object_links`.
- Inline `[[Page]]`, `[[Page#Block]]`, `@object`, pasted internal URLs, and
  programmatic context attachments all resolve to typed `ObjectRef` values.
- Link labels are presentation. Link identity is `object_type` plus
  `object_id`.
- Backlinks are queried from `object_links`, not text search.
- Unlinked mention search may exist later, but it is not a durable backlink.
- Object links are bidirectional in retrieval, but each endpoint owns its own
  ordering and display metadata.
- Deleting one endpoint does not delete the other endpoint's object. It
  deletes or tombstones only the link rows that reference the deleted object.

### Embeds and Transclusion

- Embeds are rendered ObjectRefs with relation `embeds`.
- Embedding a page, note block, media item, content chunk, highlight,
  conversation, or message does not copy that object's canonical content.
- Embedded note blocks render a read-only projection by default.
- Explicit edit-in-place for embedded blocks may exist only when the UI makes
  canonical editing unambiguous and preserves the original block id.
- Embedded pages render a bounded preview by default and can expand into a
  focused page pane.
- Embedded content carries source affordances: open, open in new pane, copy
  link, add to chat context, and show backlinks.
- Embed projection is hydration-time behavior. Stored ProseMirror JSON holds
  an `object_ref` or embed node with ObjectRef attributes, not copied child
  blocks.
- Search indexes the containing note block's own text plus object-reference
  labels. It does not inline the full text of embedded objects into the
  container's search document.
- Backlinks include embeds. They can be filtered by relation type.

### Chat Context

- Chat accepts pages, note blocks, media, highlights, conversations,
  messages, and future supported object types as context.
- Context picker and drag/drop insertion use the same ObjectRef resolver.
- Message context ordering is stored in a context occurrence table and may
  write `object_links` with relation `used_as_context`.
- Prompt construction hydrates context through the ObjectRef service.
- Prompt context for note blocks uses deterministic Markdown projection plus
  object-reference labels and ids.
- Prompt context for pages includes the selected page scope and enough outline
  structure to preserve hierarchy.
- There is no media-only or annotation-only chat path.

### Highlights and Former Annotations

- Highlights remain source anchors and reader selections.
- A highlight can be linked to any number of note blocks.
- Creating a note from a highlight creates a note block and an
  `object_links` row with relation `note_about`.
- Former annotation text is migrated into note blocks linked to the original
  highlight.
- After migration, `Annotation` is dropped from active schema, services,
  schemas, frontend helpers, tests, and UI.
- Highlight side panels show linked note blocks and linked objects. They do
  not show an annotation textarea.
- If a migrated annotation cannot be tied to a valid owned highlight, the
  migration fails. It does not keep a compatibility table.

### Markdown, Vault, and Export

- ProseMirror JSON plus normalized block rows are canonical.
- Markdown is a deterministic projection used for export, vault sync, import,
  search snippets, and LLM context.
- Markdown projection preserves stable block ids in a documented syntax.
- Markdown import parses into note blocks and object references through the
  same resolver used by the editor.
- Vault sync writes pages and linked highlight notes from the notes layer.
- Vault sync does not read or write `Annotation.body`.
- Unsupported Markdown syntax is either losslessly preserved in supported
  ProseMirror nodes or rejected with explicit feedback. It is not silently
  converted to raw HTML.

### Search

- Pages and note blocks are searchable first-class objects.
- `note_blocks.body_text` is generated from ProseMirror content and kept in
  sync with edits.
- Search results include an ObjectRef, route, title, snippet, pane title,
  result type, score details for debugging, and chat-context payload.
- Search does not inspect old annotations.
- Search highlighting maps back to note block text positions when possible.
- Search indexing treats object-reference labels as indexed text while
  preserving the target ObjectRef.
- Search uses a hybrid retrieval contract: exact title or alias matches,
  lexical PostgreSQL full-text matches, vector candidates, graph-aware boosts,
  and deterministic reranking.
- Page results search title, description, aliases, daily identity, and a
  derived page-outline projection.
- Note block results search block text, object-reference labels, page title,
  ancestor labels, and daily identity when the block is on a daily page.
- Vector retrieval uses note blocks as the primary embedding granularity.
  Page-level embeddings are derived aggregates for page discovery and are not
  the canonical editable unit.
- Search filters accept `page`, `note_block`, `content_chunk`, `media`,
  `highlight`, `conversation`, `message`, `podcast`, and `contributor` only
  when those ObjectRef types are supported by hydration.
- Search scopes are applied before ranking.
- Search never falls back from a scoped search to unscoped search.
- Search result rows for pages and note blocks support open, open in new pane,
  copy link, attach to chat, and show backlinks.
- The frontend preserves backend `context_ref` for page and note block
  results.
- Browser search and agent/app search use the same result contract. Agent
  tools do not default scoped searches to media-only results.

### Readability and Layout

- Note reading surfaces follow the reader docs: comfortable line length,
  stable line height, high contrast, mobile-safe layout, and continuous
  single-column reading for prose-heavy content.
- Editing controls do not cause layout shifts while typing.
- Bullets, drag handles, collapse toggles, and inline link affordances have
  stable dimensions.
- Long pages virtualize non-focused block subtrees without breaking selection,
  find-in-page within mounted content, or pane scroll restoration.
- Code blocks use the shared Markdown/code rendering style where applicable.

### Deletion

- Deleting a page deletes its note blocks only through explicit service
  cleanup.
- Deleting a note block deletes or tombstones descendant blocks according to
  the selected product action.
- Deleting any object deletes or tombstones `object_links` rows that point to
  it before deleting the object.
- Deleting a highlight deletes links from that highlight to note blocks, but
  does not delete the note blocks unless the user explicitly chooses that
  cleanup action.
- Media deletion removes links involving the media, its highlights, and any
  media-scoped anchors before deleting media records.
- No deleted object remains retrievable as chat context, search result,
  backlink, or pane route.

## Structure

The knowledge workspace is a single layered system.

```text
Navbar / Add / Command Palette / Search
  -> Workspace pane runtime
      -> Notes, daily, page, note, search, and reader panes
          -> Next BFF transport routes
              -> FastAPI routes
                  -> Notes, ObjectRef, ObjectLink, ObjectSearch services
                      -> Pages, NoteBlocks, DailyNotePages, ObjectLinks,
                         MessageContextItems, ObjectSearchDocuments,
                         ObjectSearchEmbeddings
```

Layer rules:

- UI surfaces do not create private note state. They call API operations and
  open pane routes.
- Pane routes are product routes. They are not database-browser routes.
- BFF routes are transport-only.
- Backend services own daily identity, object hydration, link writes, search
  indexing, embedding writes, quick capture, and deletion cleanup.
- Search documents and embeddings are derived artifacts. They are rebuilt
  from canonical objects.
- ObjectRef is the boundary between product surfaces. Pages, note blocks,
  embeds, backlinks, search results, pins, and chat context all carry
  ObjectRefs.
- Evidence text remains owned by the evidence layer. Notes can link to and
  search alongside evidence; they do not fork evidence storage.

## Architecture

### ObjectRef

`ObjectRef` is the shared typed object identity used by notes, backlinks,
chat context, search, panes, and vault projection.

Required shape:

```ts
type ObjectType =
  | "page"
  | "note_block"
  | "media"
  | "content_chunk"
  | "highlight"
  | "podcast"
  | "contributor"
  | "conversation"
  | "message";

interface ObjectRef {
  objectType: ObjectType;
  objectId: string;
}
```

Rules:

- Object types are an explicit enum.
- Unknown object types are rejected at API boundaries.
- ObjectRef hydration is centralized in one backend service.
- Ownership and permission checks happen inside the ObjectRef service.
- UI labels, routes, snippets, and icons are derived from hydrated ObjectRef
  records, not from call-site string concatenation.

### Data Model

#### `pages`

The existing `pages` table becomes the page container for outlines.

Required fields:

- `id`
- `user_id`
- `title`
- `description`
- `created_at`
- `updated_at`
- `deleted_at`

Rules:

- Page titles are mutable labels.
- Page identity is `id`.
- Page body text does not live on the page row after cutover.
- Any existing `pages.body` value is migrated into note blocks and then
  removed from active use.

#### `daily_note_pages`

The durable mapping from a user-local calendar date to an ordinary page.

Required fields:

- `id`
- `user_id`
- `local_date`
- `timezone`
- `page_id`
- `created_at`
- `updated_at`
- `deleted_at`

Rules:

- `(user_id, local_date)` is a real local alternate key.
- `page_id` points to a normal page owned by the same user.
- The daily identity row owns date lookup. The page title does not.
- The timezone is recorded for audit and display. It does not replace
  `local_date` as identity.
- Daily note resolution runs in a serializable transaction using
  SELECT-before-create.
- Deleting a daily page explicitly deletes or tombstones the daily identity
  row before deleting the page.
- Restoring deleted daily notes is outside this cutover.

#### `user_pinned_objects`

The user-owned navigation list for pinned knowledge objects.

Required fields:

- `id`
- `user_id`
- `object_type`
- `object_id`
- `surface_key`
- `order_key`
- `created_at`
- `updated_at`
- `deleted_at`

Rules:

- Pinned objects use ObjectRef validation and hydration.
- `surface_key` names the product surface, such as `navbar` or `notes_home`.
- Only explicitly pinned objects appear as durable navigation entries.
- Recents are derived behavior and do not write to this table.
- Deleting a pinned object explicitly removes or tombstones its pin.
- The navbar hydrates labels and routes through ObjectRef.

#### `note_blocks`

The canonical editable note unit.

Required fields:

- `id`
- `user_id`
- `page_id`
- `parent_block_id`
- `order_key`
- `block_kind`: `bullet`, `heading`, `todo`, `quote`, `code`, `image`,
  `embed`
- `body_pm_json`
- `body_markdown`
- `body_text`
- `properties_json`
- `collapsed`
- `created_at`
- `updated_at`
- `deleted_at`

Rules:

- `body_pm_json` is validated against the notes ProseMirror schema.
- `body_markdown` and `body_text` are generated fields in product logic, even
  if physically stored for search and export performance.
- `parent_block_id` must belong to the same `page_id`.
- Sibling order is represented with reorder-friendly `order_key` values.
- Moving a block changes only parent and order fields plus affected ordering
  metadata. It does not rewrite descendant ids.
- Empty blocks are valid while editing.
- Persisted note blocks must always have stable ids before they are rendered
  as editable rows.

#### `object_links`

The universal bidirectional relationship table.

Required fields:

- `id`
- `user_id`
- `relation_type`
- `a_type`
- `a_id`
- `b_type`
- `b_id`
- `a_order_key`
- `b_order_key`
- `a_locator_json`
- `b_locator_json`
- `a_label_snapshot`
- `b_label_snapshot`
- `metadata_json`
- `created_at`
- `updated_at`
- `deleted_at`

Rules:

- `a_order_key` controls the ordering of `b` when viewing links from `a`.
- `b_order_key` controls the ordering of `a` when viewing links from `b`.
- Reordering links from one endpoint never changes ordering from the other
  endpoint.
- `relation_type` is explicit. Initial values are `references`,
  `embeds`, `note_about`, `used_as_context`, `derived_from`, and `related`.
- Locators are endpoint-specific JSON payloads for inline positions,
  selection anchors, or embed placement.
- Polymorphic endpoints do not have database foreign keys to every target
  table. Services must do explicit existence, ownership, permission, and
  cleanup checks.
- Duplicate links are rejected unless their relation type explicitly permits
  multiple occurrences with distinct locators.

#### `message_context_items`

The ordered context occurrence table for chat prompts.

Required fields:

- `id`
- `message_id`
- `user_id`
- `object_type`
- `object_id`
- `ordinal`
- `context_snapshot_json`
- `created_at`

Rules:

- This table records what was attached to a message at send time.
- It uses ObjectRef validation and hydration.
- It may create an `object_links` row with relation `used_as_context`.
- It does not replace `object_links`.
- It is not limited to media, highlights, or annotations.

#### `object_search_documents`

The canonical searchable projection for pages, note blocks, and other
ObjectRefs whose product text is not owned by the evidence layer.

Required fields:

- `id`
- `user_id`
- `object_type`
- `object_id`
- `parent_object_type`
- `parent_object_id`
- `title_text`
- `body_text`
- `search_text`
- `route_path`
- `content_hash`
- `index_version`
- `index_status`
- `search_vector`
- `created_at`
- `updated_at`
- `deleted_at`

Rules:

- Each active searchable ObjectRef has one active search document per index
  version.
- `object_type` and `object_id` point to the canonical object. They do not
  create a copy of that object.
- `parent_object_type` and `parent_object_id` capture page containment for
  note blocks and other scoped objects.
- `title_text`, `body_text`, and `search_text` are derived fields.
- `search_vector` is a generated PostgreSQL full-text vector or an equivalent
  backend-owned lexical index column.
- `content_hash` changes when the searchable projection changes.
- The search service reads object search documents for page and note results.
  It does not run independent ad hoc queries over `pages` and `note_blocks`
  for normal product search.
- Evidence text owned by `content_chunks` remains in the evidence layer. The
  object search index may hold labels and ObjectRef metadata for
  `content_chunk`, but it does not duplicate evidence text.

#### `object_search_embeddings`

The embedding records for object search documents.

Required fields:

- `id`
- `user_id`
- `search_document_id`
- `object_type`
- `object_id`
- `embedding_model`
- `embedding_dimensions`
- `embedding`
- `content_hash`
- `index_version`
- `created_at`
- `updated_at`
- `deleted_at`

Rules:

- Embeddings are derived artifacts. The canonical text remains in pages,
  note blocks, and their search documents.
- Note block embeddings are the primary retrieval unit for notes.
- Page embeddings are derived from page title, description, and bounded
  outline projection.
- Embeddings are rebuilt when `content_hash`, embedding model, dimensions, or
  index version changes.
- Missing embeddings mark the search document as partially indexed. Search
  returns explicit partial-index metadata or excludes the document according
  to the request mode; it never silently switches to a legacy path.
- No external vector database is introduced in this cutover.

#### Removed Tables and Fields

- `annotations` is removed after migration.
- `pages.body` is removed from active application use after page bodies are
  migrated into note blocks.
- `message_contexts` is replaced by `message_context_items`.
- `conversation_media` is removed or converted into a derived read model
  rebuilt from context items and object links.

### ProseMirror Schema

The notes editor owns a dedicated ProseMirror schema.

Required nodes:

- `outline_doc`
- `outline_block`
- `paragraph`
- `text`
- `hard_break`
- `object_ref`
- `object_embed`
- `code_block`
- `image`

Required marks:

- `strong`
- `em`
- `code`
- `link`
- `strikethrough`

Rules:

- `outline_block` carries the stable `note_block.id` as an attribute.
- `object_ref` is an inline atom with `objectType`, `objectId`, and label
  snapshot attributes.
- `object_embed` is a block atom with `objectType`, `objectId`, relation
  metadata, and bounded display settings.
- ProseMirror document JSON is validated before persistence.
- The DOM is a rendering target only. It is never parsed as the durable source
  of truth except during sanitized paste/import.
- All outliner commands are ProseMirror transactions.
- Markdown import/export is implemented as schema-aware serialization, not
  regex replacement.

### Backend Services

New services:

- `python/nexus/services/object_refs.py`: ObjectRef validation, ownership,
  hydration, route metadata, labels, snippets, and deletion checks.
- `python/nexus/services/notes.py`: page and note block CRUD, movement,
  split, merge, tree reads, daily-note resolution, quick capture, and search
  projection maintenance.
- `python/nexus/services/object_links.py`: link create/delete/reorder/query
  and backlink reads.
- `python/nexus/services/note_markdown.py`: Markdown import/export for pages
  and note blocks.
- `python/nexus/services/message_context_items.py`: universal chat context
  occurrence writes and hydration.
- `python/nexus/services/object_search.py`: object search projection,
  indexing state, embedding maintenance, hybrid retrieval, and result
  hydration.

Cutover changes:

- `python/nexus/services/highlights.py` stops owning annotation CRUD.
- `python/nexus/services/contexts.py` is replaced or rewritten around
  ObjectRef.
- `python/nexus/services/conversations.py` hydrates message context through
  ObjectRef.
- `python/nexus/services/vault.py` syncs note blocks and pages, not
  annotations.
- `python/nexus/services/search.py` emits page and note block result types.
- `python/nexus/services/search.py` delegates page and note block retrieval to
  the object search service.
- Agent-facing app search uses the same object search contract and supported
  result type filters as browser search.

### API

New FastAPI routes:

- `GET /notes/pages`
- `POST /notes/pages`
- `GET /notes/daily`
- `GET /notes/daily/{local_date}`
- `POST /notes/daily/{local_date}/quick-capture`
- `GET /notes/pages/{page_id}`
- `PATCH /notes/pages/{page_id}`
- `DELETE /notes/pages/{page_id}`
- `POST /notes/blocks`
- `PATCH /notes/blocks/{block_id}`
- `DELETE /notes/blocks/{block_id}`
- `POST /notes/blocks/{block_id}/split`
- `POST /notes/blocks/{block_id}/merge`
- `POST /notes/blocks/{block_id}/move`
- `GET /object-refs/resolve`
- `POST /object-links`
- `GET /object-links`
- `PATCH /object-links/{link_id}`
- `DELETE /object-links/{link_id}`
- `GET /pinned-objects`
- `POST /pinned-objects`
- `PATCH /pinned-objects/{pin_id}`
- `DELETE /pinned-objects/{pin_id}`
- `POST /message-context-items`

Rules:

- BFF routes remain transport-only.
- Backend services own business logic.
- API request bodies use object parameters.
- Daily-note APIs return normal page payloads plus daily identity metadata.
- Pin APIs accept only supported ObjectRefs and hydrate through ObjectRef
  before returning labels or routes.
- Deprecated annotation endpoints are deleted, not retained.
- Old annotation URLs return the normal route-not-found behavior. They do not
  redirect or render a compatibility pane.

### Frontend

New frontend modules:

- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
- `apps/web/src/components/notes/NoteBlockRow.tsx`
- `apps/web/src/components/notes/NoteBacklinks.tsx`
- `apps/web/src/components/notes/ObjectRefInline.tsx`
- `apps/web/src/components/notes/ObjectEmbed.tsx`
- `apps/web/src/components/notes/ObjectRefAutocomplete.tsx`
- `apps/web/src/components/notes/DailyNoteHeader.tsx`
- `apps/web/src/components/notes/useNoteEditorCommands.ts`
- `apps/web/src/lib/notes/api.ts`
- `apps/web/src/lib/notes/prosemirror/schema.ts`
- `apps/web/src/lib/notes/prosemirror/commands.ts`
- `apps/web/src/lib/notes/prosemirror/markdown.ts`
- `apps/web/src/lib/objectRefs.ts`
- `apps/web/src/lib/objectLinks.ts`

Cutover changes:

- `apps/web/src/lib/panes/paneRouteRegistry.tsx` registers `/notes`,
  `/notes/:blockId`, `/pages/:pageId`, `/daily`, and `/daily/:localDate`.
- `apps/web/src/lib/panes/paneRuntime.tsx` remains the pane integration
  layer.
- `apps/web/src/components/workspace/WorkspaceHost.tsx` keeps current
  internal-link and Shift-click behavior.
- `apps/web/src/components/Navbar.tsx` exposes Today, Notes or Pages, Search,
  Add, and pinned knowledge objects without enumerating every page.
- `apps/web/src/components/AddContentTray.tsx` creates pages, opens or creates
  daily notes, appends quick notes to today, and preserves import modes.
- `apps/web/src/components/CommandPalette.tsx` exposes New page, Today's note,
  quick capture, page search, note-block search, pin, and open-in-new-pane
  commands.
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx` receives
  hybrid object search results and preserves page/note context refs.
- `apps/web/src/components/LinkedItemsPane.tsx` is replaced or reduced to a
  generic linked-object/backlink surface. It no longer owns annotation
  editing.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` creates
  linked notes from highlights and sends any ObjectRef to chat.
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlights.ts` removes
  annotation helpers.
- `apps/web/src/components/ui/MarkdownMessage.tsx` is centralized or shared
  with note Markdown projection rendering where appropriate.

## Implementation Plan

### Phase 1: Schema Cutover

- Add `note_blocks`, `daily_note_pages`, `user_pinned_objects`,
  `object_links`, `message_context_items`, `object_search_documents`, and
  `object_search_embeddings`.
- Migrate `pages.body` into `note_blocks`.
- Migrate every valid `annotations` row into a note block linked to its
  highlight with relation `note_about`.
- Replace old message context rows with universal context items.
- Drop annotation table and old context constraints.
- Add explicit cleanup paths for pages, note blocks, object links, context
  items, highlights, media, messages, and conversations.

### Phase 2: Backend Domain

- Implement ObjectRef service.
- Implement notes service.
- Implement daily-note resolution and quick-capture operations inside the
  notes service.
- Implement object links service.
- Implement Markdown projection service.
- Implement object search projection, embedding maintenance, hybrid retrieval,
  and reranking.
- Rewrite chat context hydration around ObjectRef.
- Remove annotation CRUD from highlight services and schemas.
- Add page and note block search indexing through object search documents.

### Phase 3: ProseMirror Editor

- Implement the notes ProseMirror schema.
- Implement outliner commands and keymaps.
- Implement paste/import sanitization.
- Implement object reference autocomplete.
- Implement Markdown serialization.
- Add unit tests for commands, schema validation, and serialization.

### Phase 4: Panes and Reader Integration

- Add notes home, page pane, note pane, and daily note routes.
- Wire click and Shift-click behavior through the pane runtime.
- Add navbar Today and Notes or Pages entries.
- Add pinned knowledge object rendering where navigation space supports it.
- Add global Add actions for new page, today, and quick capture.
- Add command palette actions for page creation, daily notes, quick capture,
  pinning, search, and open-in-new-pane.
- Replace annotation textarea UI with linked note creation and backlink UI.
- Add highlight-to-note creation from reader selection and highlight rows.
- Add ObjectRef send-to-chat behavior for pages, blocks, media, highlights,
  conversations, and messages.

### Phase 5: Embeds, Vault, Search, and Cleanup

- Add object embed rendering and relation-aware backlink filtering.
- Update vault export/import to use pages and note blocks.
- Update search result types, backend search routes, frontend result adapters,
  agent app search, and context-ref preservation.
- Backfill object search documents and embeddings for pages and note blocks.
- Delete legacy annotation frontend helpers and tests.
- Delete old context frontend assumptions.
- Add end-to-end tests for the hard-cutover behavior.
- Run migration, backend, frontend, and E2E suites.

## Files

### New Backend Files

- `python/nexus/services/object_refs.py`
- `python/nexus/services/notes.py`
- `python/nexus/services/object_links.py`
- `python/nexus/services/note_markdown.py`
- `python/nexus/services/message_context_items.py`
- `python/nexus/services/object_search.py`
- `python/nexus/api/routes/notes.py`
- `python/nexus/api/routes/object_links.py`
- `python/nexus/api/routes/object_refs.py`
- `python/nexus/api/routes/pinned_objects.py`
- `python/nexus/schemas/notes.py`
- `python/nexus/schemas/object_refs.py`
- `python/nexus/schemas/object_links.py`
- `python/nexus/schemas/pinned_objects.py`
- `python/nexus/schemas/object_search.py`
- `migrations/alembic/versions/00XX_notes_access_and_object_search.py`
- `python/tests/test_notes.py`
- `python/tests/test_daily_notes.py`
- `python/tests/test_object_refs.py`
- `python/tests/test_object_links.py`
- `python/tests/test_note_markdown.py`
- `python/tests/test_object_search.py`
- `python/tests/test_pinned_objects.py`

### Backend Files To Modify

- `python/nexus/db/models.py`
- `python/nexus/api/routes/vault.py`
- `python/nexus/schemas/vault.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/schemas/search.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/contexts.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/search.py`
- `python/nexus/services/vault.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/media_deletion.py`
- `python/tests/factories.py`
- `python/tests/utils/db.py`

### Backend Files To Delete Or Empty

- Any annotation-only schema, service, route, or test module introduced before
  the cutover.
- Annotation CRUD branches inside highlight services and tests.
- Media/highlight/annotation-only context resolver branches.

### New Frontend Files

- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
- `apps/web/src/components/notes/NoteBlockRow.tsx`
- `apps/web/src/components/notes/NoteBacklinks.tsx`
- `apps/web/src/components/notes/ObjectRefInline.tsx`
- `apps/web/src/components/notes/ObjectEmbed.tsx`
- `apps/web/src/components/notes/ObjectRefAutocomplete.tsx`
- `apps/web/src/components/notes/DailyNoteHeader.tsx`
- `apps/web/src/components/notes/useNoteEditorCommands.ts`
- `apps/web/src/app/(authenticated)/daily/page.tsx`
- `apps/web/src/app/(authenticated)/daily/[localDate]/page.tsx`
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx`
- `apps/web/src/lib/notes/api.ts`
- `apps/web/src/lib/notes/prosemirror/schema.ts`
- `apps/web/src/lib/notes/prosemirror/commands.ts`
- `apps/web/src/lib/notes/prosemirror/markdown.ts`
- `apps/web/src/lib/objectRefs.ts`
- `apps/web/src/lib/objectLinks.ts`
- `apps/web/src/lib/pinnedObjects.ts`
- `apps/web/src/__tests__/notes/prosemirrorCommands.test.ts`
- `apps/web/src/__tests__/notes/noteMarkdown.test.ts`
- `apps/web/src/__tests__/notes/dailyNotes.test.ts`
- `apps/web/src/__tests__/search/objectSearchResults.test.ts`

### Frontend Files To Modify

- `apps/web/package.json`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/Navbar.tsx`
- `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/components/addContentEvents.ts`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/lib/keybindings.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlights.ts`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/lib/search/resultRowAdapter.ts`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/ChatComposer.tsx`

### Frontend Files To Delete Or Replace

- Annotation textarea behavior in `apps/web/src/components/LinkedItemsPane.tsx`.
- Annotation save/delete helpers in media highlight modules.
- Tests that assert annotation textarea behavior.

## Rules

- Hard cutover means no feature flag, no compatibility shim, no legacy route,
  and no fallback editor.
- Active app code must not import or reference `Annotation` after migration.
- Active app code must not read or write `Annotation.body`.
- All note editing writes go through notes service operations.
- All object linking writes go through object links service operations.
- All object hydration goes through ObjectRef.
- All chat context hydration goes through ObjectRef.
- All persisted ProseMirror JSON must validate against the notes schema.
- All Markdown output must be generated from note blocks and ObjectRefs.
- All Markdown input must parse through the notes import pipeline.
- Daily-note lookup goes through `daily_note_pages`. It never derives
  identity from page title or slug.
- The navbar exposes durable surfaces and pinned ObjectRefs. It never renders
  the unbounded global page list as primary navigation.
- Add creates durable backend objects before navigation. It does not create
  frontend-only placeholder pages.
- Embeds are ObjectRefs with relation `embeds`. They never duplicate the
  embedded object's canonical content.
- Page and note search goes through object search documents and ObjectRef
  hydration.
- Hybrid search is the product search contract. Vector-only and lexical-only
  product paths are not accepted as final state.
- Search scopes are enforced before ranking and are never widened silently.
- Agent search and browser search use the same supported object types,
  filters, and context-ref contract.
- Services must do SELECT-before-mutate checks according to
  `docs/rules/database.md`.
- Polymorphic links require explicit permission and cleanup checks.
- Deletion order is explicit in services. Do not rely on accidental cascading
  deletes.
- UI feedback for import, paste, save, link, and migration failures uses the
  feedback layer.
- Editor UI must remain usable with keyboard only.
- Accessibility regressions in keyboard navigation, focus, and screen-reader
  labels block the cutover.
- Performance regressions on large pages block the cutover.

## Key Decisions

- Use pure ProseMirror, not Tiptap.
- Store normalized note blocks as canonical structure.
- Store ProseMirror JSON as canonical block content.
- Treat Markdown as deterministic projection, not canonical storage.
- Treat daily notes as ordinary pages with durable date identity.
- Use `(user_id, local_date)` as the daily-note alternate key.
- Resolve `/daily` from the user's local date and `/daily/:localDate` from an
  explicit ISO date.
- Put Today and Notes or Pages in navbar. Put individual pages in pinned,
  recent, search, and command-palette surfaces.
- Use global Add as the capture surface for new page, today, quick note,
  import file, import URL, and OPML.
- Use one universal `object_links` table for durable graph relationships.
- Represent embeds as object links plus ProseMirror embed nodes.
- Keep message context occurrences separate from durable backlinks while
  sharing ObjectRef hydration.
- Use note block embeddings as the primary semantic retrieval granularity.
- Use page embeddings as derived discovery aggregates.
- Use hybrid object search as the only product search path for pages and
  note blocks.
- Migrate valid annotations into note blocks, then delete annotation storage
  and code.
- Let highlights remain source anchors. Do not turn highlights into notes.
- Use existing pane runtime for current-pane vs new-pane navigation.
- Defer multiplayer, CRDT sync, typed object schemas, canvas, and plugin APIs.

## Acceptance Criteria

### Schema and Migration

- The cutover migration creates `note_blocks`, `object_links`, and
  `message_context_items`.
- The cutover migration creates `daily_note_pages`, `user_pinned_objects`,
  `object_search_documents`, and `object_search_embeddings`.
- Existing page bodies are converted into note blocks.
- Existing valid annotations are converted into note blocks linked to
  highlights.
- The legacy annotation table is dropped or removed from active metadata.
- Migration fails on orphaned or unauthorized annotation data instead of
  preserving a compatibility path.
- No active SQLAlchemy model named `Annotation` remains.
- Daily note identity is independent from page title.
- One user-local date resolves to one active daily page.
- Object search documents and embeddings can be rebuilt idempotently from
  canonical pages and note blocks.

### Backend

- Page and note block CRUD works through notes services and routes.
- Daily note lookup and creation are idempotent under concurrent requests.
- Quick capture appends a note block to today's page without creating
  duplicate daily pages.
- Pinned objects validate through ObjectRef and disappear when their target is
  deleted.
- Block split, merge, indent, outdent, and move operations preserve stable
  block ids and valid ordering.
- Object links can connect every supported ObjectRef pair.
- Backlink queries return links from both directions with independent
  endpoint ordering.
- Chat context accepts every supported ObjectRef.
- Highlight services expose linked notes, not annotations.
- Search returns page and note block result types through hybrid object
  search.
- Search scopes apply before ranking for pages, note blocks, and media
  evidence.
- Page and note block search results include context refs that can be sent to
  chat.
- Vault sync reads and writes note block projections.
- Media, highlight, page, message, and conversation deletion leave no
  retrievable orphaned links or context items.

### Frontend

- `/notes`, `/notes/:blockId`, and `/pages/:pageId` render in panes.
- `/daily` and `/daily/:localDate` render in panes and resolve to normal page
  editing.
- Navbar exposes Today and Notes or Pages, and never enumerates every page by
  default.
- Pinned page or note-block navigation hydrates labels and routes through
  ObjectRef.
- Add creates a new page, opens today's note, appends a quick note to today,
  and preserves file, URL, and OPML import.
- Command palette exposes New page, Today's note, quick capture, page search,
  note-block search, pin, and open-in-new-pane actions.
- Normal click opens internal note/page/object links in the current pane.
- Shift-click opens internal note/page/object links in a new pane.
- Page panes and note panes share the same editor implementation.
- Enter, Shift+Enter, Tab, Shift+Tab, Alt+Up, and Alt+Down match target
  outliner behavior.
- Up/down arrow cursor movement preserves horizontal intent across adjacent
  blocks.
- Inline object references are editable around, clickable, and keyboard
  navigable.
- Embedded objects render as bounded ObjectRef projections with open,
  open-in-new-pane, add-to-chat, and backlinks actions.
- Search result rows for pages and note blocks preserve context refs and can
  be attached to chat.
- Highlight rows can create linked note blocks.
- The annotation textarea no longer exists.
- Chat context picker and send-to-chat support pages, note blocks, media,
  highlights, conversations, and messages.

### Tests

- Backend migration tests cover page body conversion and annotation cutover.
- Backend service tests cover ObjectRef ownership, object links, backlinks,
  note block movement, deletion cleanup, and chat context hydration.
- Backend service tests cover concurrent daily-note creation, quick capture,
  pinned objects, object search indexing, hybrid ranking, and scoped search.
- Frontend unit tests cover ProseMirror commands and Markdown projection.
- Frontend interaction tests cover cursor movement, click placement, link
  opening, Shift-click opening, embeds, Add actions, command-palette actions,
  daily-note routes, pinned navigation, and keyboard shortcuts.
- E2E tests cover creating a highlight note, seeing backlinks, opening a note
  pane, adding the note as chat context, and exporting/importing through the
  vault.
- E2E tests cover opening today's note from navbar, creating a page from Add,
  quick-capturing to today, finding the captured block in search, embedding
  another page, and attaching the page or block to chat.
- `rg "Annotation" python/nexus apps/web/src` returns no active application
  code references except historical migrations or this cutover documentation.

### Hard Cutover

- No feature flag gates the notes layer.
- No legacy annotation route exists.
- No compatibility renderer exists for old annotation ids.
- No fallback textarea editor exists.
- No media/highlight/annotation-only message context path exists.
- No UI copy instructs users to use legacy annotations.
- No title-based daily-note lookup exists.
- No search path returns page or note block results without ObjectRef
  hydration.
- No vector-only or lexical-only product search path is accepted as final
  state.
- No embed implementation copies canonical embedded content into the
  containing note.
