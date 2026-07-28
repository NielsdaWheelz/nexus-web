# X Quote-Post Resource Reference Hard Cutover

Status: IMPLEMENTED AND LOCALLY VERIFIED · RELEASE DATA GATE PENDING — 2026-07-27

## Questions

None. Product decisions are closed for this cutover.

## Decision

An X quote post is a separate saved media resource. The surrounding post contains
one compact reference to that resource, never an inline copy of its body.

Use the existing source-authored embed path:

- `document_embeds` owns each quote occurrence and its fragment locator;
- `resource_edges(origin='document_embed', kind='context')` owns the unique
  parent-media → quoted-media relationship;
- the quoted `media` owns its body, index, highlights, notes, citations, and
  lifecycle;
- the workspace owns internal-link activation.

Do not model the relationship as a user-authored Link or generated Citation.
Those origins have different authorship, snapshot, ordering, and cleanup
contracts. No new table, resource scheme, media kind, graph origin, or endpoint
is introduced.

Both existing records are required: the graph edge is the deduplicated
relationship; `document_embeds` preserves each ordered fragment occurrence and
can represent an unavailable target. It is not a second graph.

## Target behavior

| Source state | Parent rendering | Child/resource behavior |
| --- | --- | --- |
| Direct quote resolves | `Quoted X post by @user — Open in Nexus` | Save/reuse one `x` / `post:<id>` media and link to `/media/<id>` |
| Direct quote is unavailable | `Quoted X post unavailable — Open on X` | No child; persist a failed occurrence with the canonical X URL |
| Quoted child itself quotes a post | `Quotes another X post — Open on X` in the child | External link only; do not fetch, save, or persist an occurrence for the deeper post |

The visible label is the complete parent representation. Do not show the quoted
body, author card, preview, media, or nested blockquote.

Plain internal click/Enter uses workspace `Follow`; Shift-click uses `Fork`.
External links remain browser-owned.

## Goals

- Give every successfully fetched direct quote its own durable, readable media.
- Make quote ownership unambiguous: quoted text is selectable and highlightable
  only in the quoted media.
- Keep a visible reference when a direct or deeper quote is not ingested.
- Remove duplicate quote text from parent indexing and evidence.
- Reuse the document-embed, resource-graph, source-ingest, reader, highlight,
  and workspace owners.
- Make refresh, reuse, deletion, concurrency, and partial provider results
  deterministic.

## Governing constraints

This contract is subordinate to
[`boundaries`](../rules/boundaries.md),
[`cleanliness`](../rules/cleanliness.md),
[`simplicity`](../rules/simplicity.md),
[`database`](../rules/database.md),
[`frontend`](../rules/frontend.md), and
[`testing`](../rules/testing.md), plus the
[`highlight`](../modules/highlight.md) and
[`workspace`](../modules/workspace.md) owner contracts.

Final-state invariants:

- one owner and one write path per fact;
- one quote-ingest hop, with no recursion;
- no silent quote omission;
- no quoted body in parent canonical text;
- no ready X-post media without source-attempt provenance;
- no occurrence-derived graph edge without a materialized child;
- current artifact replacement is atomic and concurrency-safe.

## Scope

In scope:

- official-X author-thread ingest and refresh;
- direct quote references in every thread fragment;
- synchronous child publication from the already-fetched X snapshot;
- current-only occurrence persistence and graph synchronization;
- compact reader rendering and pane-native navigation;
- source-attempt provenance for every saved X post;
- focused data repair, tests, and documentation.

Non-goals:

- recursive quote ingestion;
- nested/transcluded readers or cross-media selections;
- quote previews, cards, expansion controls, or arbitrary X widgets;
- changing direct X URLs from author-thread capture to single-post capture;
- historical occurrence versions;
- generated Citation or user Link creation;
- changes to generic web-article embed behavior beyond adapting it to the
  consolidated artifact command;
- deleting quoted child media when a parent is refreshed or deleted.

## Final architecture

```text
official X snapshot
  ├─ thread posts ──> parent fragments + compact quote placeholders
  └─ direct quotes ─> shared X-post snapshot publisher
                         └─ media + source attempt + fragment + index

all parent occurrences
  └─ document-embed artifact replace (one atomic current artifact)
       ├─ document_embeds: occurrence, fragment, order, status, target
       ├─ document_embed_artifact_states: aggregate status
       └─ resource_edges(document_embed/context): unique resolved targets

fragment API ──> compact typed link ──> workspace Follow / Shift-Fork
```

The parent and child are independent archival resources after publication. A
parent refresh replaces only the parent's current occurrences and edges. A
quoted child remains until explicitly deleted.

## Capability contract

### X provider

- Fetch the requested author thread and its direct quote IDs only.
- Batch-fetch missing direct quotes once. Do not recurse.
- Return every direct reference as either:
  - resolved provider snapshot, or
  - typed `post_unavailable` with the canonical `https://x.com/i/status/<id>`
    URL.
- Unknown provider failures remain defects after the provider retry/classification
  boundary; they are not rendered as unavailable posts.

### X-post publication

One X-post snapshot publisher owns creation and reuse of
`provider='x', provider_id='post:<post_id>'` media.

On success it must establish:

- one globally reusable media identity;
- a succeeded `media_source_attempts(source_type='x_post')` provenance row for
  the publication;
- ready fragment, blocks, apparatus, and indexable content;
- canonical X source URL and provider identity;
- accepting viewer's default library plus the parent's selected libraries;
- idempotent reuse under the existing provider-identity lock.

Publishing from a thread snapshot must not call X again. Direct X-post ingest and
quote-child ingest must converge through this publisher rather than maintain two
media/fragment write paths.

### Quote occurrence artifact

Hard-cut `replace_document_embed_artifact` to one batch command for the complete
current parent artifact. Its target is an explicit discriminated outcome:

- `accept_source(canonical_url)` for the existing generic-web materialization
  flow;
- `materialized(media_id)` for a child already published by its provider owner;
- `terminal(status='unsupported' | 'failed', error)` when no child exists.

Do not use nullable target IDs or parallel option maps to reconstruct this
decision. Each X quote occurrence input carries:

- `fragment_id`;
- parent-global `ordinal` and stable `occurrence_key`;
- provider `x`, kind `post`, source shape `provider_json`;
- canonical X URL and post provider reference;
- exact compact `placeholder_text`;
- canonical offsets in that fragment;
- one explicit target outcome:
  - `materialized(media_id)`; or
  - `terminal(status='failed', error_code='E_X_POST_UNAVAILABLE', message)`.

The command atomically:

1. removes the parent's old occurrence rows, aggregate state, and
   `document_embed` edges;
2. inserts all occurrences across all fragments;
3. writes one aggregate state;
4. replaces graph edges with the distinct materialized target set.

The generic web-article caller must adapt to this batch contract in the same
cutover. Delete the old single-`fragment_id` interface; do not add a second X-only
artifact writer or call replacement once per fragment.

Multiple occurrences of the same quote remain multiple ordered
`document_embeds` rows and one graph edge.

### Reader and canonical text

The stored placeholder and rendered compact link must emit exactly the same
canonical text. The renderer may change attributes and styling, but must not add
visible provider, state, title, description, or action text.

Use the existing `source_shape='provider_json'` discriminant to select the
compact X-quote presentation. Preserve `source_shape` in the decoded frontend
model; no wire field is added.

This exact-text invariant is required because highlight offsets are computed
against persisted fragment canonical text. A reader-side canonical exclusion or
nested cursor model is out of scope.

### Highlight, search, and evidence ownership

- Parent canonical text and search chunks contain only the compact reference.
- Quoted body text exists and is indexed only on the child media.
- A selection inside the child creates a child-media highlight.
- Parent highlights cannot span or target child text.
- Notes and chat citations about quoted text target the child resource.
- The parent-child graph relation remains available to Document Map and other
  graph consumers without manufacturing a Citation.

### Reuse, visibility, and deletion

- Reconcile child library assignment on every parent publish or canonical-parent
  reuse, not only first creation.
- Library assignment is additive. Removing a quote from a refreshed parent does
  not unsave the child.
- Viewer removal of a shared parent or child removes only that viewer's graph
  projection; it never mutates the global source-authored occurrence.
- Physical parent deletion removes its occurrences and edges, not children.
- Physical child deletion detaches the target globally. For a viewer who cannot
  read a still-shared child, the parent occurrence degrades to its external X
  action without changing other viewers' internal relation.
- A later parent refresh may materialize and relink that quote again.

## Data design

No DDL or new API schema is required.

| Existing store | Final responsibility |
| --- | --- |
| `media` | Parent author-thread and independent quoted X-post resources |
| `media_source_attempts` | Durable provenance for parent and every child |
| `fragments` / blocks / content index | Body and highlight coordinate space of their owning media |
| `document_embeds` | Current source-authored quote occurrences and locators |
| `document_embed_artifact_states` | Parent occurrence aggregate |
| `resource_edges` | Distinct resolved parent → child context relations |
| `library_entries` | Viewer visibility for parent and saved children |

Add one deploy-time data repair for existing
`provider='x', provider_id LIKE 'post:%'` media without a source attempt. Record
the already-completed X-post publication as a succeeded `x_post` attempt using
the stored provider identity and canonical source URL. After repair, missing
provenance is a defect; do not retain an adoption or compatibility branch.

## API design

No new route.

- Existing media/fragment reads return `document_embeds`.
- Existing embed DTO fields provide occurrence, locator, status, canonical URL,
  target href, and display action.
- Existing `/media/<id>` routes open the child.
- Existing resource-graph and Document Map reads expose the
  `document_embed/context` relationship.
- Existing highlight routes remain media-scoped.

The reader consumes the typed DTO. It must never parse stored X HTML, infer a
post ID from an href, or construct an absolute Nexus origin.

## Required file changes

Primary owners:

- `python/nexus/services/x_client.py`
- `python/nexus/services/x_types.py`
- `python/nexus/services/x_ingest.py`
- `python/nexus/services/x_provider_lock.py`
- `python/nexus/services/x_rendering.py`
- `python/nexus/services/document_embeds.py`
- `python/nexus/services/media_source_ingest.py`
- `python/nexus/services/web_article_ingest.py`
- `apps/web/src/lib/media/documentEmbeds.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`

Tests/docs:

- `python/tests/test_x_api.py`
- `python/tests/test_from_url.py`
- `python/tests/test_resource_graph_edges.py`
- `apps/web/src/lib/media/documentEmbeds.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/components/workspace/PaneRouteBoundary.test.tsx`
- `docs/cutovers/x-ingest-provider-hard-cutover.md`
- `docs/cutovers/web-article-inline-embeds-hard-cutover.md`

Add one migration only for the attempt-provenance repair. Do not alter tables.

## Hard-cut removals

Delete in the same change:

- `_render_quote_block` full-body transclusion;
- quoted-body link/media rendering in parent fragments;
- `APP_PUBLIC_URL` plumbing from X ingest into stored HTML;
- absolute Nexus URLs persisted in X fragments;
- the duplicate direct-quote media/fragment creation path;
- the single-fragment document-embed replacement interface;
- tests asserting quoted body text exists in parent canonical text;
- comments and fixtures describing an inline quoted body as supported behavior.

No feature flag, dual renderer, old-shape decoder, fallback blockquote, or
background compatibility repair.

## Acceptance criteria

1. A resolved direct quote produces one reusable ready child media and one
   succeeded `x_post` source attempt without a second X request.
2. The parent contains the exact compact reference and no quoted body, quoted
   links, or quoted media.
3. Each direct occurrence has the correct fragment, global order, canonical
   offsets, canonical X URL, and target status.
4. Repeated references produce repeated occurrence rows and one graph edge.
5. Parent search cannot match words that occur only in the quoted body; child
   search can.
6. Highlighting quoted text on the child creates a child-owned highlight.
   Parent selection offsets remain valid after compact-link rendering.
7. Internal quote activation follows workspace `Follow`; Shift-click forks;
   the anchor has a real relative href.
8. An unavailable direct quote remains visible and opens its canonical X URL;
   it creates no child or graph edge.
9. A quote nested inside the saved child remains a visible external X link and
   creates no child, attempt, occurrence, or graph edge.
10. Parent refresh atomically replaces stale occurrences and edges without
    deleting child media.
11. Parent reuse grants the accepting viewer/library access to all resolved
    direct quote children.
12. Direct X-post ingest can reuse a quote-created child, and quote ingest can
    reuse a directly ingested X post, without missing-attempt defects.
13. Parent deletion preserves children; child deletion leaves an external parent
    reference.
14. No parent fragment contains an absolute Nexus origin, `<blockquote>` quote
    transclusion, or legacy quote renderer output.

## Verification

- Backend integration tests cover provider partial results, publication,
  provenance, occurrence/edge replacement, reuse, libraries, deletion, search,
  and highlight ownership through public service/API behavior.
- Browser tests cover exact-text rendering, accessible anchors, and
  Follow/Shift-Fork behavior.
- Run focused backend tests for X ingest, URL ingest, resource graph, and
  highlights; focused browser tests for document embeds, media reader, and pane
  routing; then path-scoped lint, format, typecheck, and `git diff --check`.
- Residue-search every removed symbol and assertion. Zero legacy references is
  a release gate.

### Release data gate

Migration `0197` repairs X-post attempt provenance; it does not rewrite persisted
reader artifacts. Release in this order:

1. apply `0197`, then deploy the cutover code and workers;
2. find every legacy X parent and X-post child with:

   ```sql
   SELECT DISTINCT m.id, m.provider_id
   FROM media AS m
   JOIN fragments AS f ON f.media_id = m.id
   WHERE m.provider = 'x'
     AND (
       m.provider_id LIKE 'author-thread:%'
       OR m.provider_id ~ '^post:[0-9]+$'
     )
     AND f.html_sanitized LIKE '%<blockquote>%'
     AND f.html_sanitized LIKE '%Open quoted post%';
   ```

3. refresh every returned parent and child separately through
   `POST /media/{media_id}/refresh` as its creator;
4. drain `ingest_media_source` and `media_content_reindex_job` work;
5. rerun the query and require zero rows before traffic promotion.

Any unrefreshable row or nonzero final result stops the release. `0197` is
irreversible: repair forward or explicitly delete and re-import with user
approval; never retain, rewrite, or silently serve the legacy artifact.

Implementation is complete only when every acceptance criterion is proven and
the old transclusion path is absent.
