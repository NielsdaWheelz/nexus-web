# User Graph Tags Hard Cutover

Status: SPECIFICATION / IMPLEMENTATION PLAN
Date: 2026-06-17
Type: hard cutover
Compatibility posture: none

This document specifies the hard removal of user graph tags from Nexus.

Hard cutover means:

- no `tags` table;
- no `tag:<uuid>` resource scheme;
- no tag object type;
- no tag resolver, hydrator, autocomplete, search, capability, chat-subject, or
  graph-edge behavior;
- no legacy reads;
- no compatibility branches;
- no hidden fallbacks;
- no replacement taxonomy unless a separate future spec introduces one with a
  real owner.

The target product behavior is simple: `#sota` in a note is plain note text.
It may be matched by ordinary note full-text search because it is text, but it
does not create a resource, edge, chip, chat subject, scope, filter, or graph
node.

## 1. SME Framing

A subject matter expert should approach this as an ontology and capability
contract correction, not as a local cleanup of an unused table.

The central question is:

> Does "tag" represent a durable, user-owned domain object with product
> behaviors that justify identity, permissions, graph edges, search semantics,
> chat context, UI affordances, lifecycle rules, and migrations?

For this codebase, the answer is no.

The existing user graph tag surface is a generic taxonomy primitive. It is not
owned by a current product workflow and overlaps with stronger domain concepts:

- pages and note blocks own authored knowledge;
- media, highlights, evidence spans, content chunks, and fragments own source
  material;
- contributors own people/author identity;
- library and library-intelligence revisions own corpus-level and generated
  synthesis concepts;
- resource edges own relationships between concrete resources;
- search scopes own retrieval selection;
- chat subjects own context assembly.

User graph tags do not add a coherent capability at any one layer. They leak
across all of them.

The SME move is to remove the concept at the closed vocabularies first, then
delete all downstream branches that existed only because the vocabulary admitted
`tag`. The safe unit of work is the capability boundary, not the table.

## 2. Rules And Precedents

This cutover follows the repo rules:

- `docs/rules/cleanliness.md`: one owner per concern; remove dead, duplicate,
  compatibility, fallback, migration-era, and orphaned code.
- `docs/rules/module-apis.md`: expose each capability in one primary form; do
  not keep interchangeable duplicate APIs.
- `docs/rules/database.md`: database cleanup is explicit; do not hide lifecycle
  behavior behind cascades.

It also follows existing cutover patterns:

- closed resource identity lives in `python/nexus/services/resource_graph/refs.py`
  and mirrors to `apps/web/src/lib/resourceGraph/resourceRef.ts`;
- item-level product semantics live in
  `python/nexus/services/resource_items/capabilities.py`;
- object-reference UI/search behavior lives behind the existing object-ref
  boundary, not tag-specific endpoints;
- migration tests assert actual schema shape;
- negative gates in `python/tests/test_cutover_negative_gates.py` prevent
  completed hard cutovers from silently regressing.

## 3. Current State

Current user graph tag support is spread across persistence, graph identity,
note parsing, object-ref hydration, chat context, and frontend autocomplete.

### 3.1 Persistence

`python/nexus/db/models.py` defines a `Tag` ORM model backed by `tags`:

- `id`;
- `user_id`;
- `name`;
- `slug`;
- `created_at`;
- `updated_at`;
- unique `(user_id, slug)`.

The table was introduced by
`migrations/alembic/versions/0148_notes_pages_resource_graph_order.py`.

The `tag` scheme also appears in CHECK constraints for polymorphic resource
tables and event/context tables, including:

- `resource_edges.source_scheme`;
- `resource_edges.target_scheme`;
- `resource_versions.resource_scheme`;
- `resource_view_states.surface_scheme`;
- `resource_view_states.target_scheme`;
- `chat_run_turn_contexts.requested_subject_scheme`;
- `chat_run_turn_contexts.subject_scheme`.

### 3.2 Resource Identity

Backend:

- `python/nexus/services/resource_graph/refs.py` includes `"tag"` in
  `ResourceScheme` and `RESOURCE_SCHEMES`.

Frontend:

- `apps/web/src/lib/resourceGraph/resourceRef.ts` includes `"tag"` in
  `RESOURCE_SCHEMES`.

This makes `tag:<uuid>` part of the persisted ResourceRef grammar.

### 3.3 Resource Capabilities

`python/nexus/services/resource_items/capabilities.py` gives tags these product
facts:

- linkable: yes;
- attachable: yes;
- chat subject: label;
- readable: none;
- prompt render: label;
- adjacency target: yes.

That capability row is the strongest sign that tags have become a product
contract, not merely a table. Removing only the table would leave the product
contract inconsistent.

### 3.4 Notes

`python/nexus/services/note_bodies.py` imports
`nexus.services.resource_graph.tags` and scans note body text for `#tag` tokens.
It then creates body-derived `origin="note_body"` resource edges from note
blocks to tag resources.

`python/nexus/services/resource_graph/tags.py` owns:

- `TAG_TEXT_RE`;
- `tag_names_from_text`;
- `ref_for_tag_name`;
- `_get_or_create_tag`.

The frontend note editor also exposes tag insertion:

- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx` has a `#`
  autocomplete trigger;
- the autocomplete filters object refs to `objectTypes: ["tag"]`;
- tag object refs can be inserted as inline chips;
- ProseMirror command parsing admits `tag` object refs.

### 3.5 Object Refs

`python/nexus/services/object_refs.py` hydrates and searches tags.
`apps/web/src/lib/objectRefs.ts` includes `"tag"` in `OBJECT_TYPES`.
`apps/web/src/lib/resources/resourceKind.ts` maps tag resource kind and icon.

### 3.6 Chat

Resource chat subject support treats `tag:<uuid>` as a valid subject. Context
assembly can render tag subjects by label, and chat-run turn context storage can
persist tag subject schemes.

Tag chat support is label-only. It cannot cite or read body content. That makes
it a weak subject, and it is not worth preserving as a special case.

### 3.7 Search

There is no durable explicit tag search scope in the current search owner. The
existing search scopes are `all`, `media`, `library`, and `conversation`.

Some older docs mention future or intended tag search semantics. Those should
be treated as superseded by this cutover.

## 4. Non-Goals

This cutover does not remove every identifier named "tag" in the repository.
It removes user graph tags only.

Out of scope and must remain unless a separate owner-specific spec changes
them:

- Oracle metadata arrays such as `oracle_passage_anchors.tags` and
  `oracle_plates.tags`;
- in-memory Oracle retrieval candidate metadata named `tags`;
- FastAPI/OpenAPI router metadata such as `APIRouter(tags=[...])`;
- HTML tags, ProseMirror document tags, syntax-highlighting CSS tokens such as
  `.hljs-tag`;
- HTTP entity tags / ETag handling;
- Git tags and release tags;
- service-name, log, or deployment tags unrelated to user graph resources;
- any vendor or model metadata called tags.

This cutover also does not introduce a replacement:

- no topics;
- no folders;
- no labels;
- no categories;
- no playlists;
- no subjects taxonomy;
- no tag alias table;
- no `#`-mention system;
- no "soft tags" stored in JSON.

If a future workflow needs an organizing concept, it must earn its own spec,
owner, capability contract, lifecycle, and UI. It must not reuse hidden tag
compatibility.

## 5. Target Behavior

### 5.1 Notes

- Typing `#sota` in a note inserts literal text only.
- Pasting `#sota` into a note stores literal text only.
- Saving a note containing `#sota` does not create a tag row.
- Saving a note containing `#sota` does not create a resource edge.
- The note editor does not open object-ref autocomplete on `#`.
- The note editor does not offer tag object-ref results.
- Existing saved tag object-ref chips are destructively normalized to plain
  text during the cutover.
- `[[tag:<uuid>|#sota]]` is not recognized as a valid object-ref command after
  the cutover.

### 5.2 Resource Graph

- `tag:<uuid>` is not a valid ResourceRef.
- Resource graph APIs reject `tag:<uuid>` with the existing invalid/unsupported
  ResourceRef error path.
- No resource edge can have `source_scheme = 'tag'`.
- No resource edge can have `target_scheme = 'tag'`.
- There is no tag resolver branch.
- There is no tag adjacency target.
- There is no tag provenance, backlink, or connection surface.

### 5.3 Object Refs

- `"tag"` is not an `ObjectType`.
- `/object-refs/search?type=tag` is invalid input.
- `/object-refs/resolve?ref=tag:<uuid>` is invalid input.
- Object-ref hydration has no tag branch.
- Object-ref search has no tag query.

### 5.4 Chat

- `chat_subject.resource_ref = "tag:<uuid>"` is rejected.
- Chat turn-context rows cannot store `requested_subject_scheme = 'tag'`.
- Chat turn-context rows cannot store `subject_scheme = 'tag'`.
- Existing tag-only chat turn-context rows are removed.
- Existing chat messages remain.
- A chat run that previously had only a tag subject becomes an ordinary chat
  run without that subject metadata.

### 5.5 Search

- There is no tag search scope.
- `#sota` can still match note content only because it is text.
- Search does not join `tags`.
- Search does not hydrate tag results.

### 5.6 Frontend

- `"tag"` is absent from frontend resource schemes.
- `"tag"` is absent from frontend object types.
- `resourceObjectTypeForScheme("tag")` is impossible at the type level.
- There is no tag icon mapping.
- There is no tag-specific autocomplete trigger or filter.
- Existing generic object-ref UI remains for the real object types.

## 6. Final Architecture

### 6.1 Resource Identity

Resource identity is a closed vocabulary. The final vocabulary excludes `tag`.

Backend owner:

- `python/nexus/services/resource_graph/refs.py`

Frontend mirror:

- `apps/web/src/lib/resourceGraph/resourceRef.ts`

Contract:

- no caller splits or special-cases `tag:<uuid>`;
- no caller accepts arbitrary schemes;
- unsupported schemes fail at parse/validation boundaries;
- typed unions make `tag` unrepresentable.

### 6.2 Capability Contract

`python/nexus/services/resource_items/capabilities.py` remains the single owner
of resource-item product semantics.

Final contract:

| Contract | Final tag state |
| --- | --- |
| `RESOURCE_SCHEMES` | absent |
| `RESOURCE_ITEM_CAPABILITIES` | no tag key |
| `LINKABLE_RESOURCE_SCHEMES` | absent |
| `ATTACHABLE_RESOURCE_SCHEMES` | absent |
| `CHAT_SUBJECT_RESOURCE_SCHEMES` | absent |
| `READABLE_RESOURCE_SCHEMES` | absent |
| `APP_SEARCH_SCOPE_SCHEMES` | absent |
| `CONVERSATION_SEARCH_SCOPE_SCHEMES` | absent |
| `CITABLE_RESOURCE_RESULT_TYPES` | absent |
| `CITATION_OUTPUT_SOURCE_SCHEMES` | absent |
| adjacency source/target | absent |
| prompt rendering | absent |

There is no "disabled tag capability" row. A disabled row is still a product
concept and would keep the vocabulary alive.

### 6.3 Database

Final database state:

- `tags` table does not exist;
- `resource_edges` CHECK constraints exclude `tag`;
- `resource_versions` CHECK constraints exclude `tag`;
- `resource_view_states` CHECK constraints exclude `tag`;
- `chat_run_turn_contexts` CHECK constraints exclude `tag`;
- no rows in polymorphic resource tables use `tag`;
- no stored object-ref JSON payload contains tag object refs after the cutover
  data normalization pass.

No database-level cascade is introduced. Cleanup is explicit and ordered.

### 6.4 Notes

Notes own authored text and explicit object refs. They do not own a taxonomy.

Final contract:

- note body synchronization still derives edges for real object refs and embeds;
- note body synchronization does not scan natural text for hashtags;
- `#` has no note-domain semantics;
- note text remains note text.

### 6.5 Object Refs

Object refs remain the cross-resource mention and autocomplete system for real
objects. Tag removal must not fork object-ref behavior.

Final contract:

- keep the generic object-ref resolve/search APIs;
- remove `tag` from the accepted type vocabulary;
- keep current validation behavior for unknown object types;
- delete the tag-specific search/hydration branch;
- do not add a tag endpoint;
- do not add a "missing tag" placeholder object.

### 6.6 Chat Context

Chat context is built from allowed chat subject schemes and resource capability
policy. Tags disappear because they disappear from the closed capability set.

Final contract:

- subject validation is derived from `CHAT_SUBJECT_RESOURCE_SCHEMES`;
- context assembly has no tag-specific renderer;
- prompt assembly never receives a tag resource;
- previous tag-only context rows are removed as stale metadata;
- chat messages and runs are not deleted merely because a stale tag subject was
  removed.

### 6.7 Search

Search scopes remain explicitly owned by the search service. There is no tag
scope.

Final contract:

- no tag joins;
- no tag filter;
- no tag result type;
- no tag citable result;
- no tag context-expansion path.

### 6.8 Oracle Corpus Metadata

Oracle corpus metadata tags are not user graph tags.

They are keyword metadata used by the Oracle corpus and retrieval pipeline.
They are not `ResourceRef`s, not object refs, not chat subjects, not user-owned
rows in `tags`, and not graph nodes.

Final contract:

- Oracle metadata arrays may keep the name `tags`;
- no Oracle metadata tag may be promoted into a user graph `tag` resource;
- negative gates must allow Oracle metadata tags while banning user graph tags.

## 7. API Design

No new APIs are added.

### 7.1 ResourceRef APIs

Any API that accepts a ResourceRef rejects `tag:<uuid>` because the scheme is
unsupported.

Expected examples:

- resource graph edge creation with `source_ref = tag:<uuid>`: 400;
- resource graph edge creation with `target_ref = tag:<uuid>`: 400;
- resource graph resolve for `tag:<uuid>`: 400;
- chat run creation with `chat_subject.resource_ref = tag:<uuid>`: 400.

The exact error envelope should follow the existing ResourceRef parse failure
contract. Do not add a tag-specific error type.

### 7.2 Object Ref APIs

The object-ref type vocabulary excludes `tag`.

Expected examples:

- `/object-refs/search?q=sot&type=tag`: invalid request;
- `/object-refs/resolve?ref=tag:<uuid>`: invalid request.

Do not silently ignore `type=tag`. Silent ignore would make stale callers look
successful and would preserve compatibility by accident.

### 7.3 Notes APIs

No notes API accepts or returns tag resources.

Expected behavior:

- note save with text `#sota`: success, plain text;
- note save with valid non-tag object refs: unchanged;
- note save with tag object-ref JSON after cutover: reject if it reaches the
  boundary after migration, because that is invalid current input.

### 7.4 Chat APIs

Chat subject input is validated against current resource capability policy.
`tag:<uuid>` is invalid.

No chat endpoint exposes a tag label, tag subject badge, tag route, or tag
context block.

## 8. Data Cutover Plan

This is a destructive one-way cutover. The implementation must run as one
ordered migration plus matching code removal in the same deploy unit.

Because this is a one-user prototype, the correct production posture is to
normalize or delete stale tag data deterministically, then remove the storage
and vocabulary. It is not to keep compatibility code for old rows.

### 8.1 Preflight Audit

Before writing the migration, measure the current blast radius:

```sql
select count(*) from tags;

select source_scheme, target_scheme, count(*)
from resource_edges
where source_scheme = 'tag' or target_scheme = 'tag'
group by source_scheme, target_scheme;

select resource_scheme, count(*)
from resource_versions
where resource_scheme = 'tag'
group by resource_scheme;

select surface_scheme, target_scheme, count(*)
from resource_view_states
where surface_scheme = 'tag' or target_scheme = 'tag'
group by surface_scheme, target_scheme;

select requested_subject_scheme, subject_scheme, count(*)
from chat_run_turn_contexts
where requested_subject_scheme = 'tag' or subject_scheme = 'tag'
group by requested_subject_scheme, subject_scheme;
```

Also inspect persisted note ProseMirror JSON for tag object refs:

```sql
select id
from note_blocks
where body_pm_json::text like '%"objectType":"tag"%'
   or body_pm_json::text like '%"object_type":"tag"%'
   or body_pm_json::text like '%tag:%';
```

The implementation should print or log these counts in the migration test
fixtures, not in runtime production code.

### 8.2 Migration Ordering

The next Alembic migration after the current head should do the storage cutover.
At the time this spec was written, the newest version file was
`0162_library_intelligence_dossier_metadata.py`; implementation must still
confirm current heads before naming the new revision.

Required order:

1. Normalize persisted note JSON tag chips to text.
2. Remove graph edges touching tag endpoints.
3. Remove or scrub chat turn-context rows containing tag subject schemes.
4. Remove tag resource-version rows.
5. Remove tag resource-view-state rows.
6. Drop constraints that still admit `tag`.
7. Recreate those constraints without `tag`.
8. Drop indexes/constraints owned by `tags`.
9. Drop `tags`.
10. Assert absence with migration tests.

### 8.3 Note JSON Normalization

Existing tag object-ref chips must not survive as dead object refs.

Before dropping `tags`, build a tag id to text map from the `tags` table:

- preferred text: `#` + `tags.name` if `name` does not already start with `#`;
- otherwise `tags.name`;
- fallback for malformed/missing rows inside the migration: preserve the visible
  chip label if present in the ProseMirror node;
- if no visible label exists, use an empty string and remove the chip.

Then recursively rewrite note body ProseMirror JSON:

- inline `object_ref` with `objectType = "tag"` becomes a text node;
- inline `object_ref` with `object_type = "tag"` becomes a text node;
- any encoded `ref = "tag:<uuid>"` object-ref node becomes a text node;
- tag embeds, if any exist, become a plain paragraph containing the label text;
- non-tag object refs are untouched.

This is data normalization, not backward compatibility. After it runs, the
current application has no tag object-ref reader.

Implementation detail:

- prefer a deterministic migration helper with unit coverage over ad hoc SQL
  string replacement;
- the helper must operate on parsed JSON structures, not raw string search;
- the migration test should cover nested content arrays and both camelCase and
  snake_case historical attribute spellings if both are observed in stored data.

### 8.4 Edge Cleanup

Delete all `resource_edges` rows where:

- `source_scheme = 'tag'`; or
- `target_scheme = 'tag'`.

Do not repoint them. A tag edge has no canonical replacement endpoint.

After deletion, tighten CHECK constraints so `tag` cannot reappear.

### 8.5 Chat Context Cleanup

For `chat_run_turn_contexts`:

- if a row is anchored only by a tag subject, delete the row;
- if a row also has a valid non-tag anchor, null out the tag subject fields and
  keep the row;
- clear `subject_context_edge_id` when it points to a deleted tag edge;
- keep chat runs and chat messages.

The final invariant is:

- no requested subject scheme is `tag`;
- no resolved subject scheme is `tag`;
- no subject context edge points to a missing tag edge.

### 8.6 Resource Versions And View State

Delete rows whose polymorphic resource identity is tag-owned:

- `resource_versions.resource_scheme = 'tag'`;
- `resource_view_states.surface_scheme = 'tag'`;
- `resource_view_states.target_scheme = 'tag'`.

Do not keep tombstones. There is no resource to version or view.

### 8.7 Downgrade

This cutover is not compatibility work. The migration should not preserve old
data for downgrade.

If the project requires Alembic downgrade functions syntactically, the downgrade
may recreate schema only for local migration mechanics, but it must not be
treated as a product-supported rollback path. No application code should be kept
to read downgraded tag data.

## 9. Implementation Scope

### 9.1 Backend Files

Remove or update:

- `python/nexus/db/models.py`
  - delete `Tag`;
  - remove `tag` from all resource scheme CHECK definitions;
  - ensure model constraints match migration head.
- `python/nexus/services/resource_graph/refs.py`
  - remove `tag` from `ResourceScheme`;
  - remove `tag` from `RESOURCE_SCHEMES`.
- `python/nexus/services/resource_graph/tags.py`
  - delete the file.
- `python/nexus/services/note_bodies.py`
  - remove hashtag scanning;
  - remove tag imports;
  - keep object-ref/embedded-resource edge synchronization.
- `python/nexus/services/resource_graph/resolve.py`
  - remove tag dispatch;
  - remove `_load_tag`;
  - remove tag label rendering.
- `python/nexus/services/object_refs.py`
  - remove `Tag` import;
  - remove tag hydration;
  - remove tag search branch;
  - keep validation for unknown object types.
- `python/nexus/services/resource_items/capabilities.py`
  - remove tag capability row;
  - verify derived tuples exclude tag.
- `python/nexus/services/chat_runs.py`
  - ensure subject validation derives from current capability policy and rejects
    tag through the generic invalid ResourceRef path.
- `python/nexus/services/context_assembler.py`
  - remove any tag-specific prompt rendering branch if present;
  - keep generic label rendering only for schemes still in capability policy.
- schemas that define object type or resource-ref unions
  - remove tag from accepted values.

### 9.2 Frontend Files

Remove or update:

- `apps/web/src/lib/resourceGraph/resourceRef.ts`
  - remove `"tag"` from `RESOURCE_SCHEMES`.
- `apps/web/src/lib/objectRefs.ts`
  - remove `"tag"` from `OBJECT_TYPES`.
- `apps/web/src/lib/resources/resourceKind.ts`
  - remove tag icon import if no longer used;
  - remove tag kind mapping;
  - remove tag object-type mapping.
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.tsx`
  - remove `#` autocomplete trigger;
  - remove tag-only object-ref search filter;
  - keep `@`/generic object-ref behavior for real object types.
- `apps/web/src/components/notes/ObjectRefAutocomplete.tsx`
  - remove tag assumptions if any; generic rendering should remain.
- `apps/web/src/lib/notes/prosemirror/commands.ts`
  - remove `tag` from object-ref command grammar.
- `apps/web/src/lib/notes/prosemirror/schema.ts`
  - keep generic object-ref nodes for real object types;
  - no tag special case.

### 9.3 Migrations

Add the next Alembic revision after the current head. The migration must:

- normalize note JSON tag chips to text;
- delete tag graph rows and tag polymorphic state;
- clean chat turn-context rows;
- remove `tag` from all relevant CHECK constraints;
- drop `tags`.

Update migration tests in `python/tests/test_migrations.py` to assert the final
schema, not the historical introduction of tags.

### 9.4 Docs

Update docs that currently describe user graph tags:

- `docs/architecture.md`;
- `docs/cutovers/notes-pages-object-graph-hard-cutover.md`;
- `docs/cutovers/resource-provenance-graph-hard-cutover.md`;
- `docs/cutovers/resource-chat-subject-hard-cutover.md`;
- `docs/cutovers/resource-graph-product-spine-hard-cutover.md`.

The old docs should not keep live tag behavior language. They may keep a short
historical note that user graph tags were removed by this cutover.

Do not edit Oracle docs merely because they mention corpus metadata tags.

## 10. Tests

### 10.1 Backend Tests To Update

Update or remove tag expectations in:

- `python/tests/test_resource_graph_refs.py`;
- `python/tests/test_resource_item_capabilities.py`;
- `python/tests/test_resource_adjacency.py`;
- `python/tests/test_resource_item_surfaces.py`;
- `python/tests/test_resource_graph_resolve.py`;
- `python/tests/test_migrations.py`.

Add positive assertions that:

- `tag` is absent from `RESOURCE_SCHEMES`;
- `parse_resource_ref("tag:<uuid>")` returns unsupported scheme;
- capability keys exactly equal current resource schemes and contain no tag;
- resolver tests do not include a tag branch;
- migration head has no `tags` table;
- migration head CHECK constraints exclude tag;
- migration head contains no tag rows in polymorphic resource tables.

### 10.2 Frontend Tests To Update

Update or remove tag expectations in:

- `apps/web/src/lib/objectRefs.test.ts`;
- `apps/web/src/lib/resources/resourceKind.test.ts`;
- `apps/web/src/lib/resourceGraph/resourceRef.test.ts`;
- `apps/web/src/lib/resourceGraph/contractParity.test.ts`;
- `apps/web/src/components/notes/ProseMirrorOutlineEditor.test.tsx`.

Add positive assertions that:

- `isObjectType("tag")` is false;
- `parseResourceRef("tag:<uuid>")` is null;
- `resourceObjectTypeForScheme` has no tag case;
- typing `#sota` does not open object-ref autocomplete;
- `[[tag:<uuid>|#sota]]` is not converted into an object-ref chip.

### 10.3 Negative Gates

Extend `python/tests/test_cutover_negative_gates.py` with a user graph tags
section.

The gate should scan production code roots and ban only user graph tag support,
with allowlists for legitimate non-user-graph tag concepts.

Ban examples:

- `class Tag(` in `python/nexus`;
- `__tablename__ = "tags"` in `python/nexus`;
- `resource_graph.tags`;
- `TAG_TEXT_RE`;
- `tag_names_from_text`;
- `ref_for_tag_name`;
- `objectTypes: ["tag"]`;
- `"tag"` inside resource scheme registries;
- `"tag"` inside object type registries;
- `scheme == "tag"`;
- `source_scheme = 'tag'` or `target_scheme = 'tag'` in production code.

Allow examples:

- Oracle corpus metadata tags;
- FastAPI/OpenAPI `tags=[...]`;
- HTML tag parsing/rendering;
- ETag;
- syntax-highlighting CSS;
- tests and docs that assert absence.

The gate must be precise. A broad `\btag\b` ban is wrong because many unrelated
technical domains use the word.

### 10.4 Suggested Verification Commands

Backend:

```bash
pytest python/tests/test_resource_graph_refs.py
pytest python/tests/test_resource_item_capabilities.py
pytest python/tests/test_resource_adjacency.py
pytest python/tests/test_resource_item_surfaces.py
pytest python/tests/test_resource_graph_resolve.py
pytest python/tests/test_migrations.py
pytest python/tests/test_cutover_negative_gates.py
```

Frontend:

```bash
bun test apps/web/src/lib/objectRefs.test.ts
bun test apps/web/src/lib/resources/resourceKind.test.ts
bun test apps/web/src/lib/resourceGraph/resourceRef.test.ts
bun test apps/web/src/lib/resourceGraph/contractParity.test.ts
bun test apps/web/src/components/notes/ProseMirrorOutlineEditor.test.tsx
```

Static checks:

```bash
rg -n 'resource_graph\.tags|TAG_TEXT_RE|tag_names_from_text|ref_for_tag_name' python/nexus apps/web/src
rg -n '"tag"|'\''tag'\''' python/nexus/services/resource_graph python/nexus/services/resource_items apps/web/src/lib/resourceGraph apps/web/src/lib/objectRefs.ts apps/web/src/lib/resources
git diff --check
```

The second `rg` command is intentionally noisy during implementation. The
negative gate is the durable precision check.

## 11. Acceptance Criteria

### AC-1: Closed ResourceRef Vocabulary

Backend and frontend resource scheme registries exclude `tag`.

Passing evidence:

- backend `RESOURCE_SCHEMES` has no `tag`;
- frontend `RESOURCE_SCHEMES` has no `tag`;
- backend/frontend contract parity tests pass;
- parsing `tag:<uuid>` fails as unsupported/invalid.

### AC-2: No Tag Table

The migration head has no `tags` table and no ORM `Tag` model.

Passing evidence:

- migration tests assert `tags` is absent;
- no `class Tag` exists in production code;
- no production code imports `Tag`.

### AC-3: No Tag Polymorphic Scheme

No database CHECK constraint for resource polymorphism admits `tag`.

Passing evidence:

- `resource_edges` source/target scheme checks exclude tag;
- `resource_versions` resource scheme check excludes tag;
- `resource_view_states` surface/target scheme checks exclude tag;
- `chat_run_turn_contexts` requested/resolved subject scheme checks exclude tag.

### AC-4: No Tag Rows In Polymorphic Stores

The migration removes all stored tag endpoints and tag subject state.

Passing evidence:

- no `resource_edges` row uses tag as source or target;
- no `resource_versions` row uses tag;
- no `resource_view_states` row uses tag;
- no `chat_run_turn_contexts` row uses tag;
- no chat context row points to a deleted tag edge.

### AC-5: No Hashtag Parser

Note save/sync does not parse natural text hashtags.

Passing evidence:

- `resource_graph/tags.py` is deleted;
- `note_bodies.py` has no hashtag extraction;
- saving text containing `#sota` creates no tag row and no tag edge.

### AC-6: No Tag Object Ref

Tag object refs cannot be searched, hydrated, inserted, parsed, or rendered.

Passing evidence:

- backend object-ref type validation rejects tag;
- frontend `OBJECT_TYPES` excludes tag;
- note command parser excludes tag;
- tag object-ref chips from old data are normalized to plain text.

### AC-7: No Tag Autocomplete

The note editor has no `#` autocomplete.

Passing evidence:

- typing `#sota` does not open object-ref autocomplete;
- no frontend code calls object-ref search with `objectTypes: ["tag"]`.

### AC-8: No Tag Chat Subject

Tags cannot be chat subjects.

Passing evidence:

- `CHAT_SUBJECT_RESOURCE_SCHEMES` excludes tag;
- chat subject validation rejects `tag:<uuid>`;
- context assembly has no tag branch;
- old tag-only turn-context rows are removed.

### AC-9: No Tag Search Scope

Search has no tag scope and no tag result type.

Passing evidence:

- search scope union remains current and excludes tag;
- no SQL joins `tags` for app search;
- no result mapper emits tag results.

### AC-10: Docs Match Reality

Current architecture and cutover docs no longer describe user graph tags as
live behavior.

Passing evidence:

- architecture docs remove tag from ResourceRef and graph resource vocabulary;
- older cutover docs mark tag sections superseded by this cutover or remove the
  live behavior language;
- Oracle metadata tag docs, if any, remain clearly distinguished.

### AC-11: Negative Gate Prevents Reintroduction

`python/tests/test_cutover_negative_gates.py` has precise user graph tag gates.

Passing evidence:

- gate fails if `resource_graph.tags` returns;
- gate fails if `Tag` ORM returns;
- gate fails if frontend resource/object registries re-add tag;
- gate does not fail on Oracle corpus metadata tags, OpenAPI route tags, HTML
  tags, ETags, or syntax-highlighting tokens.

### AC-12: No Fallbacks Or Compatibility Paths

There is no code path whose only purpose is to keep old tag payloads working.

Passing evidence:

- no "legacy tag" comments or helpers;
- no missing-tag placeholder rendering;
- no hidden conversion at runtime;
- all data conversion happens in the one-time migration.

## 12. Duplicate Pattern Consolidation

The cutover should remove tag behavior by deleting branches from existing
owners, not by adding a new "tag disabled" layer.

Reuse these existing patterns:

- closed scheme vocabulary in `resource_graph.refs`;
- frontend mirror plus contract parity test;
- capability map in `resource_items.capabilities`;
- generic object-ref validation;
- generic ResourceRef parse failure handling;
- migration-head schema assertions;
- negative gates for completed hard cutovers.

Avoid these anti-patterns:

- a new `DISABLED_SCHEMES = {"tag"}` registry;
- `if scheme == "tag": return None` fallback branches;
- preserving `tag` in unions but marking it inactive;
- keeping `tags` table for possible future use;
- converting tags to a new unowned `label` concept;
- silently ignoring tag inputs;
- broad string replacement in persisted ProseMirror JSON.

## 13. Key Decisions

### D1: Remove, Do Not Disable

`tag` is removed from the vocabulary. It is not retained as an inactive scheme.

### D2: Hashtags Are Text

`#sota` has no product semantics beyond note text.

### D3: Existing Tag Chips Become Text

Persisted tag object-ref chips are normalized to their visible label text during
the migration. Runtime readers do not keep a tag chip compatibility path.

### D4: Existing Tag Edges Are Deleted

Tag graph edges are not repointed. There is no canonical replacement resource.

### D5: Chat Messages Stay, Tag Subject Metadata Goes

Chat messages and runs are user content and remain. Tag subject metadata is
stale graph context and is removed or scrubbed.

### D6: Oracle Metadata Tags Stay

Oracle corpus metadata tags are not user graph tags and are explicitly out of
scope.

### D7: No Replacement Taxonomy

This cutover does not create topics, labels, categories, folders, or subjects.

## 14. Risk Register

| Risk | Mitigation |
| --- | --- |
| Over-deleting Oracle metadata tags | Negative gates must allow Oracle corpus tag fields. |
| Breaking old note bodies with tag chips | One-time parsed JSON normalization before code removal. |
| Leaving stale `tag` in DB constraints | Migration tests inspect final CHECK definitions. |
| Leaving stale `tag` in frontend unions | Contract parity and frontend unit tests. |
| Runtime fallback quietly preserves tags | Negative gates ban tag services, branches, and registries. |
| Broad grep blocks unrelated technical tags | Gate patterns are precise and allowlist known unrelated uses. |
| Chat context references deleted tag edges | Migration clears `subject_context_edge_id` before/while deleting edges. |

## 15. Implementation Sequence

1. Confirm current Alembic heads.
2. Add migration tests describing the final schema and data cleanup.
3. Add or update focused backend tests for ResourceRef, capabilities, resolver,
   adjacency, object refs, chat subject validation, and notes body sync.
4. Add or update focused frontend tests for resource refs, object types,
   resource kind mapping, note editor hashtag behavior, and object-ref command
   parsing.
5. Write the Alembic migration and note JSON normalization helper.
6. Remove backend tag model, service, resolver, object-ref, capability, note
   parser, and chat/context branches.
7. Remove frontend tag scheme/object-type/resource-kind/editor branches.
8. Update current docs and mark older tag language superseded.
9. Add negative gates.
10. Run the targeted verification commands.
11. Run broader app checks only if targeted gates uncover shared-contract drift.

## 16. SME Checklist

Before accepting the cutover, ask:

- Is `tag` unrepresentable in backend and frontend type vocabularies?
- Is there any persistent table, row, CHECK constraint, or JSON chip that can
  still encode a user graph tag?
- Does the note body pipeline still create only edges for real resources?
- Does object-ref search/hydration have exactly one owner and no tag branch?
- Does chat subject validation derive from the capability map and reject tag
  without a special case?
- Are Oracle metadata tags still intact and explicitly outside the cutover?
- Do docs describe the final state rather than the migration story?
- Would reintroducing a tag table, tag scheme, tag object type, or hashtag
  parser fail a test?

If any answer is no, the cutover is incomplete.
