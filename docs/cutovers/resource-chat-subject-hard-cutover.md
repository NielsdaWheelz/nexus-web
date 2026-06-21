# Resource Chat Subject Hard Cutover

Status: BUILT - 2026-06-16
Author: Codex
Type: hard cutover
Date: 2026-06-16

Built 2026-06-16 (`f9acaa3c`): every supported `ResourceRef` is a chat subject
through one capability / subject-resolution / turn-context / prompt pipeline; the
legacy document-chat owner and the `reader_context` field are gone. See
`docs/modules/chat.md`.

## North Star

Nexus can start, list, continue, search, cite, open, and inspect a conversation
about any supported `ResourceRef`.

The product language is "chat about this resource", but the architecture is more
precise:

```text
ResourceRef
  -> resource item capability policy
  -> chat subject resolution
  -> durable run turn context
  -> conversation context edge
  -> prompt <subject> and <resources>
  -> read/search/citation/tool admission
```

`media:<id>` is one resource subject, not the special chat case. Notes,
highlights, messages, Oracle readings, Library Intelligence revisions,
libraries, and contributors enter the same pipeline with scheme-specific
capability decisions. User graph tags are not chat subjects; they were removed
by `docs/cutovers/user-graph-tags-hard-cutover.md`.

## Type

Hard cutover. No legacy document-chat path, no `reader_context` compatibility
field, no old request aliases, no pane-local POST variants, no duplicate route
resolver, no fallback from one resource identity to another, no graph traversal
without an explicit search-scope policy.

This is not a new chat product beside document chat. It deletes document-chat as
the owner and replaces it with a resource-subject contract.

## Precedents And Repo Rules

- `docs/cutovers/resource-graph-product-spine-hard-cutover.md` establishes
  `resource_edges` as the durable connection spine, including conversation
  context refs.
- `docs/cutovers/resource-native-pages-and-notes-hard-cutover.md` establishes
  `resource_items.capabilities` as the owner of readable, citable, attachable,
  prompt-renderable, searchable item behavior.
- `docs/cutovers/library-intelligence-revision-resource-identity-hard-cutover.md`
  establishes the mutable-head vs immutable-revision rule for generated work.
- `docs/modules/chat.md` keeps chat engine, view, and adapters separate, and
  makes `buildChatRunBody` the single frontend `/chat-runs` body assembler.
- `docs/modules/reader-implementation.md` and
  `docs/modules/reader-design-rationale.md` make reader quote-to-chat
  highlight-first and keep `reader_selection` bind-only.
- `docs/rules/cleanliness.md` requires one owner per concern, no compatibility
  lanes, and deletion of finished-era names.
- `docs/rules/cleanliness.md` requires one primary API per capability.
- `docs/rules/layers.md` keeps BFF and FastAPI routes thin; services own
  business behavior.
- `docs/rules/correctness.md` requires typed boundary parsing and illegal states
  made unrepresentable.
- `docs/local-rules/testing_standards.md` requires behavior tests at public owner
  boundaries, not implementation-shape tests.

## SME Thesis

A subject matter expert would treat "chat about this document" as a local symptom
of a missing owner-level subject contract.

The existing system already has the hard primitives:

- closed `ResourceRef` grammar;
- resource item capability policy;
- conversation context refs as graph edges;
- prompt assembly ledgers;
- `read_resource` admission through context;
- search-scope allowlists;
- graph-owned citations;
- Library Intelligence revision identity;
- Oracle reading identity;
- generic frontend `ResourceChatTab`.

The professional move is not to add note chat, author chat, Oracle chat, and
taxonomy-chat endpoints. The move is to make "chat subject" a typed first-class contract
over `ResourceRef`, then collapse every surface to that contract.

The wrong moves are:

- keeping `reader_context` as the document-chat compatibility lane;
- adding `document_id`, `note_id`, or `author_id` fields to
  `/chat-runs`;
- making every pane POST `/conversations` differently;
- using object refs as the resource-chat source of truth;
- treating linkable as readable, readable as searchable, or searchable as
  citable;
- letting `contributor` imply open graph traversal;
- using `message_retrievals` as subject storage;
- using `library_intelligence_artifact:<id>` when the user means an exact
  generated output.

## Current Head Facts

### Already Correct

- `python/nexus/services/resource_graph/refs.py` owns the backend
  `ResourceRef` grammar and includes `media`, `library`, `highlight`,
  `page`, `note_block`, `conversation`, `message`, `oracle_reading`,
  `library_intelligence_artifact`, `library_intelligence_revision`,
  `contributor`, and `podcast`.
- `apps/web/src/lib/resourceGraph/resourceRef.ts` mirrors that grammar on the
  frontend. No code outside it should split refs.
- `python/nexus/services/resource_items/capabilities.py` already owns a closed
  `ResourceItemCapability` for every scheme:
  `linkable`, `attachable`, `readable`, `citable_result_type`,
  `app_search_scope`, `conversation_search_scope`,
  `citation_output_source`, `prompt_render`, `expandable`,
  `adjacency_source`, and `adjacency_target`.
- `python/nexus/services/resource_graph/context.py` already attaches arbitrary
  visible, attachable resource refs to a conversation by graph edge.
- `POST /conversations` already accepts `initial_context_refs` and inserts them
  atomically in request order.
- `GET /conversations?has_context_ref=<resource_ref>` already lists
  conversations with any edge to a target ref.
- `apps/web/src/components/chat/ResourceChatTab.tsx` already lists chats for any
  `resourceUri`.
- `LibraryPaneBody` already starts Library Intelligence chat with
  `[library_intelligence_revision:<id>, library:<id>]`.
- `OracleReadingPaneBody` already starts Oracle chat with
  `oracle_reading:<id>`.

### Still Wrong Or Partial

- `ChatRunCreateRequest` has `reader_context` and `reader_selection`, but no
  generic `chat_subject`.
- `reader_context` is a document/library hint that duplicates the resource graph
  context model.
- `reader_context` and `reader_selection` are carried in the queue payload, not
  durable run state. Retries re-enqueue only `run_id`, so request-only anchors
  can disappear.
- `context_assembler` renders generic `<resources>` but not a dedicated primary
  `<subject>` block.
- `DocChatTab` hardcodes `media:<id>` and document copy.
- `ReaderChatDetail` requires `mediaId`, always creates `reader_context`, and is
  not a generic resource chat detail.
- Library, podcast, and Oracle panes duplicate "create conversation with
  initial refs and open it" logic.
- `Conversation.handleOpenResource` maps context refs through
  `resourceKind -> objectRefs`, with a manual `library` special case. This
  omits openable `oracle_reading` and makes object refs a route resolver for a
  graph concept.
- `resource_items.surfaces.resource_item_out` already projects `route`, but only
  for a subset of schemes.
- `read_resource`, `context_assembler`, `app_search`, `resource_graph.context`,
  `resource_graph.edges`, and frontend resource helpers still contain or consume
  separate fragments of item behavior that must be driven by the capability
  owner.
- `docs/architecture.md` documents the `ResourceRef` vocabulary.

## Goals

G1. Make `ResourceRef` the only public identity for "chat about X".

G2. Add a typed `chat_subject` contract to `/chat-runs`.

G3. Delete `reader_context` from schemas, frontend request builders, queue
payloads, prompt assembly, tests, and docs.

G4. Keep `reader_selection` as a bind-only quote anchor, but persist enough
durable identity for retry and trust inspection.

G5. Render a dedicated primary `<subject>` prompt block before generic
`<resources>`.

G6. Keep conversation context refs as graph edges. Subject attachment creates or
reuses ordinary context edges; it does not introduce a second context store.

G7. Make resource item capability policy the single owner for whether a scheme
can be a chat subject, context ref, search scope, readable body, prompt body,
citable resource, citation output source, or openable route.

G8. Centralize frontend "start chat about resource" behavior in one adapter.

G9. Replace document-specific `DocChatTab` and media-only `ReaderChatDetail`
ownership with generic resource chat components plus a thin reader quote adapter.

G10. Make Library Intelligence chat revision-first everywhere. Artifact heads
are accepted only as explicit latest aliases and resolve to the consumed
revision before prompt assembly.

G11. Make Oracle reading chat first-class by giving `oracle_reading` the same
subject, route, prompt, read-resource, and trust-trail treatment as other
readable generated outputs.

G12. Map "author" product surfaces to `contributor:<id>`. Do not add an
`author` scheme.

G13. Make `contributor:<id>` useful only through explicit capability and
search-scope policy. No implicit traversal through arbitrary edges.

G14. Make context-ref opening route through resource item hydration, not object
refs plus special cases.

G15. Add acceptance tests that fail when a new `ResourceScheme` has no explicit
chat-subject decision.

## Non-Goals

N1. No graph database.

N2. No new persisted graph, link, or conversation-context table. The only new
durable storage allowed by this spec is run-owned turn context for
answer-determining subject and quote identity.

N3. No per-resource chat endpoints.

N4. No backwards-compatible `reader_context` request field.

N5. No document-chat wrapper kept as a production concept.

N6. No open-ended graph traversal for contributor, page, note, highlight,
or message chat.

N7. No `author:<id>` scheme.

N8. No fallback from `library_intelligence_revision` to artifact head.

N9. No fallback from `library_intelligence_artifact` to historical revisions.

N10. No fake `message_retrievals` rows for chat subjects.

N11. No frontend-only capability matrix.

N12. No object-ref route resolver for conversation context refs.

N13. No migration bridge that accepts old request payloads.

N14. No compatibility tests that preserve old document-only behavior.

N15. No attempt to make every scheme readable, searchable, or citable.

## Scope

In scope:

- backend schemas for chat-run subject input;
- durable run turn context for subject and quote identity;
- conversation context attachment from subject resolution;
- prompt assembly subject rendering;
- resource item capability extensions and tests;
- `read_resource` and `app_search` composition with the capability owner;
- frontend request-body builder and composer API;
- generic resource chat tab/detail/start adapter;
- media, note block, highlight, message, Oracle reading, Library Intelligence,
  library and contributor entrypoints;
- context-ref opening through resource item routes;
- docs and negative gates.

Out of scope:

- multi-user sharing changes;
- graph visualization;
- relation ontology UI;
- CRDT or collaborative editing;
- Library Intelligence revision DAGs;
- source-version replay;
- changing library membership ownership;
- changing citation edge storage;
- changing message retrieval telemetry beyond keeping it out of subject storage.

## Final Behavior

### Generic Resource Chat

Every chat-capable surface can call one frontend owner with:

```ts
startResourceChat({
  subjectRef: "note_block:<uuid>",
  extraContextRefs?: ["media:<uuid>"],
  readerSelection?: ...
})
```

The adapter:

1. parses the ref with `resourceGraph/resourceRef.ts`;
2. resolves the subject through the resource-item subject API when it needs
   label, route, or default companions;
3. opens or creates the conversation through the shared chat engine;
4. passes the canonical `chat_subject` to `buildChatRunBody`;
5. never assembles a resource-specific request shape.

Existing conversation listing uses:

```text
GET /conversations?has_context_ref=<subject-or-companion-resource-ref>
```

Blank chats are still created lazily on first send unless a surface explicitly
wants to materialize an empty conversation. If a blank conversation is created,
it uses `initial_context_refs`; that remains a generic context-ref API, not a
subject substitute.

### Chat Run Creation

`POST /chat-runs` accepts a primary subject:

```json
{
  "conversation_id": "...",
  "content": "...",
  "model_id": "...",
  "reasoning": "default",
  "key_mode": "auto",
  "branch_anchor": { "kind": "none" },
  "chat_subject": {
    "resource_ref": "note_block:00000000-0000-4000-8000-000000000001"
  },
  "reader_selection": null
}
```

Rules:

- `chat_subject` is optional for ordinary continuation chat.
- When present, it is parsed at the FastAPI boundary into a canonical
  `ResourceRef`.
- The subject resource must be visible and chat-subject-capable.
- The service resolves the consumed subject before idempotency hashing.
- The consumed subject and any durable quote identity are persisted with the
  run before enqueue.
- The subject resource is attached to conversation context in the same
  transaction.
- Default companion refs are attached in deterministic order after the subject.
- The queue payload carries only `run_id`.
- Retry and dead-letter finalization load durable run context from the database,
  not request-only payload fields.

### Prompt Rendering

Prompt assembly renders a primary subject block before the generic resource
list:

```xml
<subject uri="note_block:..." label="..." summary="..." fetch_hint="...">
  <body>...</body>
</subject>
```

Then it renders conversation context refs:

```xml
<resources>
  <resource uri="note_block:..." ...>...</resource>
  <resource uri="library:..." ...></resource>
</resources>
```

Rules:

- `<subject>` tells the model what the user's "this" refers to.
- `<resources>` lists attached context available to the conversation.
- The subject is also a context ref unless capability explicitly forbids
  attachment, in which case it cannot be a chat subject.
- `reader_selection` remains a separate `<reader_selection>` block. It is a
  quote anchor for the current turn, not a subject, not a branch anchor, not a
  context ref, and not a citation.
- A citable attached subject gets a citation number only through the existing
  `get_search_result -> citation_from_search_result` path. No numbered prompt
  citation can be minted without a backing retrieval/citation row.

### Resource-Specific Behavior

`media:<id>`

- Chat subject: yes.
- Context ref: yes.
- Readable: media readable state decides.
- Search scope: yes.
- Prompt: label plus `read_resource`/search hints; inline full media body does
  not enter the prompt.
- Replaces "chat about this document".

`library:<id>`

- Chat subject: yes, as scope.
- Context ref: yes.
- Readable: no direct body; `read_resource` returns scope-not-readable.
- Search scope: yes.
- Prompt: label and scope hint.
- Used as a companion for Library Intelligence and library-scoped chat.

`note_block:<id>`

- Chat subject: yes.
- Context ref: yes.
- Readable: body.
- Search scope: conversation note scope.
- Citable: yes when `get_search_result` can materialize it.
- Prompt: inline body.
- Default companion refs: none unless a launching surface explicitly adds a page
  or media ref.

`page:<id>`

- Chat subject: yes.
- Context ref: yes.
- Readable: body/title according to the resource-native page contract.
- Search scope: conversation note/page scope.
- Citable: yes only through the resource item citation path.
- Prompt: inline body or label per capability.

`highlight:<id>`

- Chat subject: yes.
- Context ref: yes.
- Readable: quote with prefix/suffix and linked note context.
- Search scope: conversation note/highlight scope.
- Citable: yes only when the highlight can materialize a search result.
- Prompt: quote.
- Reader quote-to-chat uses highlight as the subject and may add `media:<id>` as
  an explicit surface companion.

`message:<id>`

- Chat subject: yes.
- Context ref: yes.
- Readable: message text only.
- Search scope: no by default.
- Citable: yes only if the message result type materializes through the same
  search result path; otherwise it is prompt context without a citation number.
- Prompt: inline message body.
- Trust trail, tool calls, retrieval rows, and hidden reasoning are not included
  by default. "Chat about this message" is not "dump this message's trust
  trail" and not "branch from this message".

`conversation:<id>`

- Chat subject: allowed only if capability marks it chat-capable.
- Readable: conversation summary/history policy, not raw full transcript by
  default.
- Search scope: no by default.
- This cutover does not need a first user-facing conversation-subject surface.

`oracle_reading:<id>`

- Chat subject: yes.
- Context ref: yes.
- Readable: generated reading body.
- Citation output source: yes.
- Citable target: no by default; citations inside the reading remain edges
  sourced from the Oracle reading.
- Prompt: inline body under budget or clear `read_resource` fetch hint.
- Route: openable through resource item route resolution.

`oracle_passage_anchor:<id>`

- Chat subject: no.
- Context ref: no.
- Readable: no.
- It remains a citation/concordance target. Do not invent
  `oracle_reading_passage` unless phase-specific marginalia becomes a resource.

`library_intelligence_revision:<id>`

- Chat subject: yes.
- Context ref: yes.
- Readable: exact generated revision body.
- Citation output source: yes.
- Citable target: no by default; citations inside the generated output remain
  revision-sourced edges.
- Prompt: inline body or fetch hint per budget.
- Default companion refs: `library:<id>` when the revision belongs to a library
  and retrieval scope is useful.

`library_intelligence_artifact:<id>`

- Chat subject: explicit latest alias only.
- Default UI behavior: resolve to the current
  `library_intelligence_revision:<id>` and use that revision as the consumed
  subject.
- Durable exact chat must never store only the artifact head.
- Artifact ref may still be attached when product language truly means
  latest/head.

`contributor:<id>`

- Product alias: author.
- Chat subject: yes.
- Context ref: yes.
- Readable: label/profile summary only unless contributor profile body becomes
  an explicit resource item body.
- Search scope: explicit contributor-scope SQL only. No graph traversal.
- Prompt: label and summary.
- Route: author/contributor route through resource item hydration.

`podcast:<id>`

- Chat subject: label/context only until podcast-level search scope is
  explicitly specified.
- This cutover may keep podcast out of the first visible resource-chat rollout.

`evidence_span:<id>`, `content_chunk:<id>`, `fragment:<id>`

- Chat subject: yes if surfaced by citations/search UI.
- Readable: body.
- Citable: yes when materialized through search result owners.
- Search scope: no.
- Prompt: inline body.

`external_snapshot:<id>`

- Chat subject: no.
- Context ref: no.
- Readable: no.
- It remains web/citation snapshot evidence, not a first-class user chat
  subject.

## Capability Contract

`ResourceRef` identity stays in `resource_graph.refs`.

`resource_items.capabilities` owns all item behavior. This cutover extends that
owner, not by adding a parallel chat matrix, but by making chat-subject behavior
part of the same item policy.

Target capability shape:

```python
@dataclass(frozen=True, slots=True)
class ResourceItemCapability:
    linkable: bool
    attachable: bool
    chat_subject: Literal["none", "label", "scope", "readable", "quote", "generated_output"]
    readable: Literal["none", "scope", "body", "media"]
    citable_result_type: str | None
    app_search_scope: bool
    conversation_search_scope: bool
    citation_output_source: bool
    prompt_render: Literal["none", "label", "inline_body", "quote"]
    expandable: bool
    adjacency_source: bool
    adjacency_target: bool
```

Rules:

- `chat_subject == "none"` means the scheme cannot be sent as
  `chat_subject.resource_ref`.
- `chat_subject != "none"` requires `attachable=True`.
- `chat_subject == "scope"` requires `readable="scope"` or an explicit search
  scope.
- `chat_subject == "readable"` requires `readable in ("body", "media")`.
- `chat_subject == "quote"` requires `prompt_render="quote"`.
- `chat_subject == "generated_output"` is for generated output resources whose
  own citations are output-sourced edges, not user-citable body facts.
- `citable_result_type` means "may be numbered if materialization succeeds",
  not "always cite".
- `app_search_scope=True` is allowed only when `services/search/scope.py` owns
  explicit SQL for that scheme.
- `conversation_search_scope=True` is allowed only when
  `resource_graph.context` and search scope tests say exactly what it admits.
- The test suite must assert that every `ResourceScheme` has an explicit
  `chat_subject` decision.

## Subject Resolution Contract

Add a resource item service:

```text
python/nexus/services/resource_items/chat_subjects.py
```

Public operations:

```python
resolve_chat_subject(
    db: Session,
    *,
    viewer_id: UUID,
    requested_ref: ResourceRef,
    extra_context_refs: Sequence[ResourceRef] = (),
) -> ResolvedChatSubject
```

`ResolvedChatSubject`:

```python
@dataclass(frozen=True, slots=True)
class ResolvedChatSubject:
    requested_ref: ResourceRef
    subject_ref: ResourceRef
    subject_item: ResourceItemOut
    context_refs: tuple[ResourceRef, ...]
    companion_refs: tuple[ResourceRef, ...]
    prompt_mode: Literal["label", "scope", "inline_body", "quote", "generated_output"]
```

Rules:

- `requested_ref` is what the caller sent.
- `subject_ref` is the exact resource the run consumes.
- For most schemes, `requested_ref == subject_ref`.
- For `library_intelligence_artifact`, `subject_ref` is the current
  `library_intelligence_revision` unless the caller explicitly asks for latest
  alias semantics.
- `context_refs` is deterministic and de-duplicated. The subject ref is first.
- `companion_refs` are resource-owned defaults such as `library:<id>` for an LI
  revision.
- Extra context refs are validated for visibility and attachability, then
  appended after defaults.
- This service may call resource-specific owners to derive companions, but the
  capability decision remains in `resource_items.capabilities`.
- Missing or forbidden resources return normal API errors. They never silently
  downgrade to labels or parent resources.

Optional API for frontend previews:

```text
POST /resource-items/chat-subject/resolve
{
  "resource_ref": "library_intelligence_artifact:<id>",
  "extra_context_refs": ["library:<id>"]
}
```

Response:

```json
{
  "requestedRef": "library_intelligence_artifact:<id>",
  "subjectRef": "library_intelligence_revision:<id>",
  "contextRefs": ["library_intelligence_revision:<id>", "library:<id>"],
  "subject": { "...": "ResourceItemOut" }
}
```

The route is a convenience view over the service. `/chat-runs` must still call
the service; it cannot trust a frontend preview response.

## API Design

### Backend Schemas

`python/nexus/schemas/conversation.py`

Add:

```python
class ChatSubjectRequest(BaseModel):
    resource_ref: str
```

Change:

```python
class ChatRunCreateRequest(BaseModel):
    conversation_id: UUID
    parent_message_id: UUID | None = None
    branch_anchor: BranchAnchorRequest = Field(default_factory=NoBranchAnchorRequest)
    content: str
    model_id: UUID
    reasoning: ReasoningMode
    key_mode: LLMKeyMode
    chat_subject: ChatSubjectRequest | None = None
    reader_selection: ReaderSelectionRequest | None = None
```

Delete:

```python
reader_context: ReaderContextHint | None
```

Delete `ReaderContextHint` unless another non-chat contract still owns it. If a
branch-anchor `reader_context` variant exists only for this old model, delete it
too. Branch anchors after this cutover are:

- `none`;
- `assistant_message`;
- `assistant_selection`.

### Frontend Types

`apps/web/src/lib/api/sse/requests.ts`

Add:

```ts
export interface ChatSubjectInput {
  resource_ref: string;
}
```

Change `ChatRunCreateRequest`:

```ts
chat_subject?: ChatSubjectInput | null;
reader_selection?: ReaderSelectionInput | null;
```

Delete:

```ts
reader_context: ReaderContextHintInput | null;
```

### Request Body Assembly

`apps/web/src/lib/conversations/chatRunBody.ts`

`buildChatRunBody` remains the only frontend `/chat-runs` body assembler. It
accepts:

```ts
chatSubject: ChatSubjectInput | null;
readerSelection?: ReaderSelectionInput | null;
```

It does not accept `readerContext`.

### Conversation Creation

`POST /conversations` keeps:

```json
{ "initial_context_refs": ["resource:<uuid>"] }
```

This API means "create a conversation with context refs". It does not mean
"create a durable primary subject". The primary subject is per-run and belongs
to `/chat-runs`.

### Context Ref Mutation

`POST /conversations/{id}/context-refs` remains the explicit user attach API.
It continues to attach one visible, attachable resource ref as `origin='user'`.

Subject-derived default companions are attached inside `create_chat_run` with a
service-owned origin decision:

- primary subject: `origin='user'`;
- default companions derived by product policy: `origin='system'`;
- citation graduation remains `origin='citation'`.

The same target ref still has one bare context edge per conversation because
`resource_graph.context.add_context_ref_without_commit` is idempotent across
user/citation/system origins for the same target.

## Durable Run Context

Queue payloads must not be the durable source of answer-determining request
context.

Add one durable one-to-one row:

```text
chat_run_turn_contexts
```

Columns:

- `chat_run_id uuid primary key references chat_runs(id)`;
- `requested_subject_scheme text null`;
- `requested_subject_id uuid null`;
- `subject_scheme text null`;
- `subject_id uuid null`;
- `subject_context_edge_id uuid null`;
- `reader_selection_media_id uuid null`;
- `reader_selection_highlight_id uuid null`;
- `created_at timestamptz not null default now()`.

Constraints:

- requested subject scheme/id are both null or both non-null;
- consumed subject scheme/id are both null or both non-null;
- reader selection media/highlight are both null or both non-null;
- at least one of consumed subject or reader selection is present;
- subject schemes are in the closed `ResourceScheme` set;
- requested subject schemes are in the closed `ResourceScheme` set.

Rules:

- Generic chat without subject or reader selection has no row.
- A resource chat run has a row with requested and consumed subject refs.
- A quote-to-chat run has the subject row plus reader selection identity.
- The row stores durable identity only. It does not store prompt text, display
  snapshots, trust trails, or retrieval telemetry.
- Prompt assembly snapshots the rendered blocks in `chat_prompt_assemblies`;
  that remains the prompt ledger.
- Retry loads this row and re-renders the same answer-determining anchors.

## Chat Run Service Flow

`python/nexus/services/chat_runs.py:create_chat_run`

Target sequence:

1. Normalize idempotency key.
2. Parse and resolve `chat_subject` through `resource_items.chat_subjects`.
3. Validate model/key/rate/branch/reader-selection inputs.
4. Compute idempotency hash including:
   - conversation id;
   - parent id;
   - branch anchor;
   - content;
   - model id;
   - reasoning;
   - key mode;
   - consumed subject ref;
   - requested subject ref when different;
   - reader selection durable identity.
5. Lock idempotency key.
6. Prepare messages.
7. Attach subject and context refs through
   `resource_graph.context.add_context_ref_without_commit`.
8. Insert `chat_runs`.
9. Insert `chat_run_turn_contexts` when needed.
10. Append run meta event including subject refs.
11. Enqueue job with `{"run_id": "<id>"}` only.
12. Commit.

`python/nexus/tasks/chat_run.py`

Target behavior:

- accepts `run_id` only;
- loads durable turn context from the database;
- does not parse reader/context request payloads.

`python/nexus/jobs/registry.py`

Target behavior:

- chat job dispatcher passes `run_id` only;
- no `reader_context` or `reader_selection` job payload parsing remains.

## Prompt Assembly

`python/nexus/services/context_assembler.py`

Add:

```python
_build_subject_block(db, run, turn_context) -> PromptBlock | None
```

Rules:

- Subject block renders before reader selection and generic resources.
- Rendering uses the same resolved-resource presentation path as context refs.
- `prompt_render` comes from `RESOURCE_ITEM_CAPABILITIES`.
- `library_intelligence_artifact` requested refs render consumed revision
  metadata, not moving-head ambiguity.
- Missing consumed subject during run execution is a hard error unless the
  resource was deleted after run completion and the prompt assembly already
  exists.
- Subject block source refs include:
  - requested resource ref;
  - consumed subject ref;
  - context edge id if attached;
  - resolved revision ref if any.
- `chat_prompt_assemblies.included_context_refs` records subject refs with
  `role="subject"` and generic resources with `role="context_ref"`.

Change `_build_resources_block`:

- Keep listing conversation context refs.
- Avoid rendering the subject twice with full body when the subject block already
  carries it. The context list may still include a compact label row.
- Use capability `prompt_render` instead of local scheme checks.
- Use `CITABLE_RESOURCE_RESULT_TYPES` from capabilities for numbered attached
  citations.

Delete `_build_reader_context_block`.

Keep `_build_reader_selection_block`, but load selection identity from durable
run context when invoked by the worker.

## Search Scope Composition

Search remains default-deny.

`app_search` accepts a scope only when:

1. the requested scope ref is a conversation context ref for the conversation;
2. `RESOURCE_ITEM_CAPABILITIES[scheme].app_search_scope` is true;
3. `services/search/scope.py` has explicit SQL for that scheme.

Target scope schemes:

- `media`: existing exact media scope.
- `library`: existing library membership scope.
- `contributor`: explicit contributor-credit scope.

No other scheme becomes an `app_search` scope by being attached to a
conversation.

Conversation note/page/highlight search scope remains separately controlled by
`conversation_search_scope`. It is not the same as explicit `app_search`
scopes.

## Citation Composition

Resource chat does not change citation ownership.

- Assistant citations are `resource_edges` sourced from `message:<id>`.
- Oracle citations are `resource_edges` sourced from `oracle_reading:<id>`.
- Library Intelligence citations are `resource_edges` sourced from
  `library_intelligence_revision:<id>`.
- `message_retrievals` remains chat telemetry.
- Attached citable context resources get `[N]` only when
  `get_search_result -> citation_from_search_result` succeeds.
- Generated outputs such as Oracle readings and LI revisions are readable
  subjects but not source-evidence citation targets by default.

## Frontend Architecture

### New Owner

Add one frontend owner:

```text
apps/web/src/lib/resources/resourceChat.ts
```

Responsibilities:

- parse and format subject refs;
- call the resource-item chat-subject resolver when needed;
- create a conversation with subject/context refs;
- build the initial pending context refs for `useConversation`;
- open the conversation route or pane;
- expose stable helpers for pane surfaces.

It must not own:

- resource scheme vocabulary;
- item capability policy;
- prompt rules;
- search rules;
- citation rules.

Those stay backend-owned and are projected through API responses.

### Components

Keep:

- `ResourceChatTab`, but make its copy and empty-state labels resource-driven.
- `ContextRefChatList`, with no document-specific text.
- `ChatComposer`, but replace `readerContext` prop with `chatSubject`.

Add or rename:

- `ResourceChatDetail`: generic inline chat detail for a `ResourceRef`.
- `ReaderQuoteChatDetail`: thin adapter around `ResourceChatDetail` that adds
  `readerSelection` and quote chips.

Delete:

- `DocChatTab`;
- document-specific `ReaderChatDetail` ownership;
- media-only draft keys such as `reader-doc:<mediaId>:new` as public concepts;
- hardcoded labels like "Chat about this document" outside media-specific
  display copy.

### Surface Wiring

Media:

- media action menu uses `startResourceChat({subjectRef: media:<id>})`;
- reader secondary chat uses `ResourceChatTab` for `media:<id>`;
- quote-to-chat uses `highlight:<id>` subject plus optional `media:<id>`
  context ref and durable `reader_selection`.

Library:

- media rows use `startResourceChat({subjectRef: media:<id>})`;
- library chat uses `startResourceChat({subjectRef: library:<id>})`;
- LI chat uses the selected `library_intelligence_revision:<id>` subject and
  `library:<id>` companion.

Oracle:

- reading page uses `startResourceChat({subjectRef: oracle_reading:<id>})`.

Notes/pages:

- page and note surfaces expose resource chat actions using `page:<id>` and
  `note_block:<id>`.

Messages:

- message action menus expose "Chat about this message" using `message:<id>`.
- This action is separate from retry, fork, assistant selection, and trust
  trail actions.

Authors/contributors:

- author panes derive `contributor:<id>` from loaded contributor data and use
  that ref. They do not build an `author:<handle>` ref.

Podcasts:

- podcast surfaces wait for explicit product copy unless podcast-level subject
  behavior is enabled in the capability matrix.

## Opening Resources

Conversation context chips and resource chat surfaces open resources through
`ResourceItemOut.route`, not `ObjectRef`.

Backend:

- expand `resource_items.surfaces._route_for_ref` or replace it with a public
  route owner that covers every openable `ResourceScheme`;
- add routes for `oracle_reading`, `library_intelligence_artifact`,
  `library_intelligence_revision`, and `contributor` where product routes exist;
- return `route=None` when a resource is not openable.

Frontend:

- replace `Conversation.handleOpenResource` object-ref mapping with
  `/resource-items/{resource_ref}` or batched `/resource-items/resolve`;
- remove the manual `library` special case;
- stop using `resourceObjectTypeForScheme` as a route decision for context refs.

`objectRefs` remains the owner for note editor object refs, pins, and object
search if those features still need it. It is not the route owner for chat
context refs.

## Library Intelligence Composition

Default chat from Library Intelligence must send a revision subject.

Rules:

- `LibraryIntelligencePane` exposes `revision_ref` for the selected/current
  revision.
- `startResourceChat` receives `library_intelligence_revision:<id>`.
- `resource_items.chat_subjects` derives `library:<id>` as a companion.
- If a caller sends `library_intelligence_artifact:<id>`, the backend resolves
  the current revision and persists both requested artifact and consumed
  revision in durable turn context.
- Prompt/trust trail display both when they differ:
  "requested latest artifact; consumed revision ...".
- No citation source uses `library_intelligence_artifact` for exact output.

## Oracle Composition

Oracle reading chat uses `oracle_reading:<id>` as a first-class generated-output
subject.

Rules:

- `resolve.py` presents enough body/fetch hint for `oracle_reading`.
- `resource_items.surfaces` returns a route for the reading.
- Prompt subject rendering includes question, motto/argument, and
  interpretation under budget, or a precise `read_resource` hint.
- Oracle corpus passages remain citation targets and concordance identities.
  They are not chat subjects.
- Oracle folio/citation logic is not copied into chat.

## Reader Composition

Reader quote-to-chat remains highlight-first.

Rules:

- creating or reusing `highlight:<id>` stays the durable quote identity;
- `reader_selection` carries only the bind-only turn quote identity and visible
  text hints;
- the chat subject is `highlight:<id>` for quote-driven first sends;
- `media:<id>` can be an explicit companion when the reader surface wants media
  search scope;
- `reader_context` is deleted;
- branch anchors remain assistant-message/assistant-selection only.

## Message Composition

"Chat about this message" is not the same as branch or retry.

Rules:

- subject is `message:<id>`;
- prompt body is message text only;
- trust trail is available through the existing inspector, not automatically
  placed in model context;
- pending/incomplete messages are not readable subjects;
- a message from an unreadable conversation is not visible;
- if a message is citable, it must materialize through the same citable result
  path as every other attached citable resource.

## Contributor Composition

Contributors are where a sloppy design would accidentally create open graph
retrieval. This cutover must not do that.

`contributor:<id>`:

- derives from contributor rows, not author handles;
- can be a label/profile subject;
- can become an app-search scope only through explicit contributor-credit SQL;
- search scope result set must be tested against media with and without that
  contributor.

Contributor resource subjects:

- no recursive traversal;
- no "all connected things" query;
- no search behavior if the scheme does not have `app_search_scope=True`;
- no citable target by default.

## Files To Change

### Docs

- `docs/cutovers/resource-chat-subject-hard-cutover.md` - this spec.
- `docs/modules/chat.md` - replace document/reader-context send contract with
  resource subject contract.
- `docs/modules/reader-implementation.md` - update quote-to-chat wording:
  highlight subject plus `reader_selection`, no `reader_context`.
- `docs/modules/reader-design-rationale.md` - same.
- `docs/architecture.md` - document `chat_subject` as a ResourceRef consumer.
- `docs/cutovers/library-intelligence-revision-resource-identity-hard-cutover.md`
  - cross-link the subject behavior.

### Backend Schemas And Models

- `python/nexus/schemas/conversation.py`
  - add `ChatSubjectRequest`;
  - remove `ReaderContextHint`;
  - remove `reader_context` from `ChatRunCreateRequest`;
  - remove reader-context branch anchor if only legacy.
- `python/nexus/schemas/resource_items.py`
  - expose chat-subject capability and chat-subject resolver response.
- `python/nexus/db/models.py`
  - add `ChatRunTurnContext`;
  - add constraints/indexes;
  - update schema checks if resource scheme lists need parity.
- Alembic migration
  - add `chat_run_turn_contexts`;
  - no data backfill for old request payloads;
  - no compatibility trigger or view.

### Backend Services

- `python/nexus/services/resource_items/capabilities.py`
  - add `chat_subject`;
  - set every scheme explicitly;
  - expose `CHAT_SUBJECT_RESOURCE_SCHEMES`.
- `python/nexus/services/resource_items/chat_subjects.py`
  - new subject resolver.
- `python/nexus/services/resource_items/surfaces.py`
  - route coverage for openable resource refs;
  - project chat capability.
- `python/nexus/services/resource_graph/context.py`
  - keep context mutation owner;
  - use capability attachability;
  - support system-derived companion context refs through existing origin.
- `python/nexus/services/chat_run_validation.py`
  - validate subject visibility/capability through the new service;
  - validate reader selection against durable highlight context.
- `python/nexus/services/chat_run_idempotency.py`
  - hash consumed subject and reader-selection identity.
- `python/nexus/services/chat_runs.py`
  - resolve/persist subject;
  - attach subject and companions;
  - enqueue run_id-only job.
- `python/nexus/tasks/chat_run.py`
  - load durable turn context.
- `python/nexus/jobs/registry.py`
  - remove reader payload parsing.
- `python/nexus/services/context_assembler.py`
  - add subject block;
  - delete reader context block;
  - load reader selection from durable context;
  - use capability prompt/citation policy.
- `python/nexus/services/chat_prompt.py`
  - update system prompt language from document context to resource subject.
- `python/nexus/services/message_trust_trails.py`
  - show requested subject, consumed subject, subject context edge, companions,
    and reader selection identity.
- `python/nexus/services/agent_tools/read_resource.py`
  - keep readable/scope policy capability-driven;
  - ensure generated output subjects present correct tool guidance.
- `python/nexus/services/agent_tools/app_search.py`
  - keep scope validation capability-driven;
  - add contributor scopes with explicit search SQL.
- `python/nexus/services/search/scope.py`
  - implement any new explicit contributor scope cells.

### Backend Routes

- `python/nexus/api/routes/chat_runs.py`
  - pass `chat_subject`, no `reader_context`.
- `python/nexus/api/routes/resource_items.py`
  - add optional chat-subject resolver endpoint.
- `python/nexus/api/routes/conversation_context.py`
  - no shape change, but tests must cover subject-derived system companions if
    exposed through API reads.
- Next.js BFF route types regenerate/update as needed.

### Frontend

- `apps/web/src/lib/api/sse/requests.ts`
  - add `ChatSubjectInput`;
  - remove `ReaderContextHintInput`;
  - remove `reader_context`.
- `apps/web/src/lib/conversations/chatRunBody.ts`
  - include `chat_subject`;
  - delete `readerContext`.
- `apps/web/src/components/chat/ChatComposer.tsx`
  - accept `chatSubject`;
  - pass it to `buildChatRunBody`.
- `apps/web/src/components/chat/useConversation.ts`
  - keep `initialContextRefs`;
  - stop silently skipping invalid refs in generic attach paths; typed callers
    should prevent invalid refs, backend should reject request defects.
- `apps/web/src/components/chat/ResourceChatTab.tsx`
  - keep as generic list owner.
- `apps/web/src/components/chat/DocChatTab.tsx`
  - delete or replace with generic resource tab.
- `apps/web/src/components/chat/ReaderChatDetail.tsx`
  - replace with generic resource detail plus reader quote adapter.
- `apps/web/src/components/chat/Conversation.tsx`
  - open context refs through resource item routes, not object refs.
- `apps/web/src/lib/resources/resourceChat.ts`
  - new central frontend start/open helper.
- `apps/web/src/lib/resources/resourceKind.ts`
  - keep icons, stop acting as route resolver.
- `apps/web/src/lib/objectRefs.ts`
  - keep for note editor/pins/search, not chat context opening.
- `apps/web/src/lib/actions/resourceActions.ts`
  - replace document-specific chat option with resource subject action.
- Pane files:
  - `MediaPaneBody.tsx`;
  - `LibraryPaneBody.tsx`;
  - `LibraryIntelligencePane.tsx`;
  - `OracleReadingPaneBody.tsx`;
  - page/note panes;
  - author/contributor panes;
  - message row/action components.

### Tests

Backend:

- `python/tests/test_resource_item_capabilities.py`
- `python/tests/test_resource_chat_subjects.py` new
- `python/tests/test_conversations.py`
- `python/tests/test_resource_graph_routes.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_chat_prompt.py`
- `python/tests/test_reader_selection.py`
- `python/tests/test_read_resource_tool.py`
- `python/tests/test_search_scope_matrix.py`
- `python/tests/test_attached_citations.py`
- `python/tests/test_message_trust_trails.py`
- `python/tests/test_cutover_negative_gates.py`
- migration tests

Frontend:

- `apps/web/src/lib/conversations/chatRunBody.test.ts`
- `apps/web/src/components/chat/ChatComposer.test.tsx`
- `apps/web/src/components/chat/useConversation.test.tsx`
- `apps/web/src/components/chat/ResourceChatTab.test.tsx`
- delete/replace `DocChatTab.test.tsx`
- replace `ReaderChatDetail.test.tsx`
- `apps/web/src/components/chat/Conversation.test.tsx`
- pane-specific tests for media, LI, Oracle, notes, messages, and contributors.

E2E:

- quote-to-chat still works;
- note-block chat first send works;
- LI revision chat pins the revision and attaches library;
- Oracle reading chat opens and answers against the reading;
- message chat action creates a subject run distinct from branch/retry;
- contributor chat retrieves only through explicit scope policy.

## Duplicate Patterns To Delete Or Consolidate

1. Direct pane POSTs to `/api/conversations` with `initial_context_refs`.
   Replace with `startResourceChat`.

2. `DocChatTab` as a media-only wrapper over `ResourceChatTab`.
   Replace with generic resource copy and subject ref props.

3. `ReaderChatDetail` as a media-required chat detail.
   Replace with generic resource chat detail plus a reader quote adapter.

4. `reader_context` in frontend types, backend schemas, queue payloads, prompt
   assembly, tests, and docs.

5. Object-ref route resolution for chat context refs.
   Replace with `ResourceItemOut.route`.

6. Local prompt/citation/read/search scheme lists.
   Drive them from `resource_items.capabilities`.

7. Pane-specific labels for "Chat about this document".
   Derive labels from resource kind/capability, with media-specific copy only
   in media display surfaces.

8. Repeated invalid-ref behavior.
   Parse once at boundaries; pass typed `ResourceRef`/`ChatSubjectInput`
   inward; reject defects instead of silently skipping.

9. LI artifact-head chat special cases.
   Use revision subject resolution.

10. Oracle reading ad hoc chat start.
    Use resource subject helper.

## Key Decisions

D1. `ResourceRef` is the only chat subject identity.

D2. `chat_subject` belongs to `/chat-runs`, because it is answer-determining for
the run.

D3. `initial_context_refs` remains on `/conversations`, but it is not a primary
subject contract.

D4. `reader_context` dies. Media/library context is represented by resource refs
and subject/context capability.

D5. `reader_selection` remains separate from subject. It is a bind-only quote
anchor.

D6. Queue payloads carry `run_id` only. Durable run context lives in the DB.

D7. Subject rendering is explicit. The model gets `<subject>` for "this" and
`<resources>` for attached context.

D8. Capability policy is the owner of chat-subject admission. Routes and panes
do not maintain scheme lists.

D9. Linkability, attachability, readability, searchability, and citability are
separate. One does not imply another.

D10. Search is default-deny and SQL-explicit. Tags and contributors do not imply
graph traversal.

D11. Library Intelligence defaults to immutable revision subjects.

D12. Oracle readings are generated-output subjects; Oracle corpus passages are
not.

D13. Authors are contributors. No `author` scheme.

D14. Context-ref open behavior uses resource item routes. Object refs do not own
resource chat navigation.

D15. Existing messages can be subjects, but message subject does not expose
trust trail or branch semantics.

## Acceptance Criteria

AC1. `ChatRunCreateRequest` accepts `chat_subject.resource_ref` and rejects
malformed refs with `E_INVALID_REQUEST`.

AC2. `reader_context` is absent from backend schemas, frontend request types,
request-body assembly, queue payloads, prompt assembly, tests, and docs.

AC3. A chat run with `chat_subject=note_block:<id>` creates/reuses a
conversation context edge to that note block and persists durable turn context.

AC4. The idempotency hash changes when the consumed subject ref changes.

AC5. Retrying a failed resource-chat run uses durable turn context, not queue
payload fields.

AC6. Prompt assembly renders one `<subject>` block for a subject run.

AC7. Prompt assembly still renders `<resources>` for conversation context refs.

AC8. The subject is not duplicated as a second full inline body in `<resources>`.

AC9. `reader_selection` renders separately from `<subject>` and remains
quote-bind-only.

AC10. `read_resource` can read a readable subject attached to a conversation.

AC11. `library:<id>` subject returns scope-not-readable through `read_resource`
but is accepted as chat subject and search scope.

AC12. `library_intelligence_artifact:<id>` subject resolves to the current
`library_intelligence_revision:<id>` as consumed subject unless explicit latest
alias behavior is requested.

AC13. LI chat from the pane sends a revision subject and library companion.

AC14. Oracle reading chat uses `oracle_reading:<id>` and renders/fetches the
reading body.

AC15. `oracle_passage_anchor:<id>` is rejected as a chat subject.

AC16. `external_snapshot:<id>` is rejected as a chat subject.

AC17. `message:<id>` chat subject includes message text only and does not include
trust-trail internals.

AC18. Message subject action is separate from retry, fork, branch, and assistant
selection actions.

AC19. Author chat uses `contributor:<id>`, never `author:<handle>`.

AC21. Contributor search scope is explicit SQL and tested.

AC23. `app_search` rejects any explicit scope whose scheme lacks
`app_search_scope=True`.

AC24. `message_retrievals` contains no subject-storage rows.

AC25. Context-ref chips open via `ResourceItemOut.route`; the manual `library`
special case is gone.

AC26. `DocChatTab` is deleted or no longer exported; tests reference generic
resource chat components.

AC27. All pane-local "create conversation with initial refs" implementations
are replaced by the central resource chat helper.

AC28. Every `ResourceScheme` has an explicit `chat_subject` capability decision.

AC29. Frontend/backend resource scheme and capability tests fail if a scheme is
added without chat-subject policy.

AC30. `docs/architecture.md` documents chat subjects as a ResourceRef consumer.

AC31. No production code path accepts `reader_context` as a backwards-compatible
field.

AC32. No fallback alias from document chat to resource chat remains.

## Implementation Sequence

1. Land backend capability decision.
   - Add `chat_subject` to `ResourceItemCapability`.
   - Update `test_resource_item_capabilities.py`.
   - Add negative gates for missing subject policy.

2. Land subject resolver.
   - Add `resource_items.chat_subjects`.
   - Cover note, highlight, message, LI artifact/revision, Oracle reading,
     library, contributor, and rejects.

3. Add durable run turn context.
   - Migration and model.
   - Persistence helpers.
   - Retry loading path.

4. Change `/chat-runs`.
   - Add `ChatSubjectRequest`.
   - Delete `reader_context`.
   - Attach subject/context refs atomically.
   - Hash subject identity.
   - Queue `run_id` only.

5. Change prompt assembly.
   - Add `<subject>`.
   - Remove `<reader_context_hint>`.
   - Use durable reader selection identity.
   - Keep `<reader_selection>` separate.

6. Update tools/search.
   - Keep `read_resource` capability-driven.
   - Add explicit contributor scopes.
   - Add search-scope matrix tests.

7. Add resource item route coverage.
   - Ensure `ResourceItemOut.route` can open supported refs.
   - Add batched route resolution tests.

8. Frontend request contract.
   - Update `requests.ts`, `chatRunBody.ts`, `ChatComposer`.
   - Delete `readerContext` props.

9. Frontend resource chat owner.
   - Add `resourceChat.ts`.
   - Replace direct pane POSTs.
   - Replace `DocChatTab`/media detail with generic resource chat components.

10. Surface rollout.
    - Media.
    - Highlight quote-to-chat.
    - Notes/pages.
    - Library and LI.
    - Oracle.
    - Message actions.
    - Contributor/author.
    - Tag.

11. Open-resource cleanup.
    - Move context-chip routing to resource item route resolution.
    - Remove object-ref route special cases.

12. Docs and negative gates.
    - Update modules and architecture docs.
    - Add grep-based negative gates for `reader_context`, document-chat
      wrappers, and old labels where appropriate.

13. Verification.
    - Targeted backend tests.
    - Targeted frontend tests.
    - E2E quote/resource-chat flows.
    - Full contract parity tests.

## Verification Plan

Backend minimum:

```text
pytest python/tests/test_resource_item_capabilities.py
pytest python/tests/test_resource_chat_subjects.py
pytest python/tests/test_chat_runs.py -k "subject or reader_selection or idempotency"
pytest python/tests/test_chat_prompt.py
pytest python/tests/test_read_resource_tool.py
pytest python/tests/test_search_scope_matrix.py
pytest python/tests/test_attached_citations.py
pytest python/tests/test_cutover_negative_gates.py
```

Frontend minimum:

```text
bun test apps/web/src/lib/conversations/chatRunBody.test.ts
bun test apps/web/src/components/chat/ChatComposer.test.tsx
bun test apps/web/src/components/chat/useConversation.test.tsx
bun test apps/web/src/components/chat/Conversation.test.tsx
bun test apps/web/src/lib/resourceGraph/resourceRef.test.ts
bun test apps/web/src/lib/resources/resourceKind.test.ts
```

E2E minimum:

```text
quote-to-chat
note-block resource chat
library-intelligence revision chat
oracle reading chat
message subject chat
contributor explicit scope retrieval and denial of unscoped resources
```

The final implementation is not complete until:

- no `reader_context` production path remains;
- no direct pane-local conversation-create helper remains for resource chat;
- no citable/resource/search behavior is owned outside capabilities plus the
  specific search/read owners;
- all requested resource classes have explicit subject tests;
- negative gates prevent regression to document-only chat.
