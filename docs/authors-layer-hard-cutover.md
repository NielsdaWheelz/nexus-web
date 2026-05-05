# Authors Layer Hard Cutover

## Role

This document is the target-state plan for replacing string bylines,
per-media author rows, podcast author fields, and catalog-only author strings
with one contributor authority layer used by media, podcasts, search, AI tool
retrieval, object links, and workspace panes.

The implementation is a hard cutover. The final state keeps no
`media_authors` product path, no scalar `podcasts.author` product path, no
Project Gutenberg `authors` product path, no string-only author renderer, no
author-name search fallback, no feature flag, and no backward-compatible route
or DTO shape for legacy author strings.

The cutover establishes these durable primitives:

```text
Contributor
  -> ContributorAlias
  -> ContributorExternalId
  -> ContributorCredit
      -> credited content object
      -> role on that object
      -> exact credited name and provenance
  -> ObjectRef(contributor)
      -> /authors/:contributorHandle pane
```

`Contributor` is the person, organization, group, or local unverified identity.
`ContributorCredit` is the byline or creator credit on a specific work-like
object. "Author" is a role and product label, not the identity table name.

## Research Baseline

The target state follows the common pattern used by mature bibliographic,
music, scholarly, and wiki systems:

- Wikidata separates entity-valued author claims from author-name-string
  fallbacks.
- OpenAlex models authors as entities and filters works by author identity.
- Zotero, DataCite, and Schema.org model creators/contributors separately from
  the work itself.
- ORCID, ISNI, VIAF, Wikidata, OpenAlex, and LCNAF are authority identifiers,
  not display names.
- MusicBrainz treats aliases and artist credits as first-class data because
  displayed credit text is not always the canonical identity name.
- Open Library and LibraryThing style systems assume author disambiguation is
  continuous curation, not a one-time import task.

References:

- https://www.wikidata.org/wiki/Property:P50
- https://docs.openalex.org/api-entities/authors
- https://developers.openalex.org/api-reference/works/list-works
- https://www.zotero.org/support/adding_items_to_zotero
- https://support.datacite.org/docs/connecting-to-people
- https://schema.org/CreativeWork
- https://orcid.org/
- https://www.oclc.org/developer/api/oclc-apis/viaf.en.html
- https://musicbrainz.org/doc/Aliases
- https://openlibrary.org/dev/docs/api/authors

## Goals

- Every visible author, host, creator, channel, editor, translator, narrator,
  or producer reference is clickable.
- Every clickable contributor reference opens a workspace pane.
- Author panes list all visible works credited to the contributor, grouped and
  filterable by role, content kind, library scope, and source.
- User search can return authors as first-class results and can filter media,
  podcasts, and content evidence by author/contributor.
- AI app search accepts structured contributor filters and persists them with
  tool-call metadata and retrieval rows.
- Ingest, metadata enrichment, podcast sync, OPML import, file import, URL
  capture, YouTube import, PDF import, EPUB import, and Gutenberg catalog import
  all write contributor credits through the same service.
- Exact credited byline text is preserved even when it differs from the
  canonical contributor display name.
- Authority IDs and aliases are first-class data.
- Automated identity resolution is conservative: exact external IDs may attach
  credits automatically; fuzzy/name-only matches create suggestions, not merges.
- Manual merge and split operations are transactionally safe and auditable.
- Object references, backlinks, message context, notes, command palette,
  search, and panes all use the same contributor identity.
- Tests treat string-only author display, unclickable author text, unstructured
  search filters, and accidental name-based false merges as correctness bugs.

## Non-Goals

- Do not implement a full FRBR/LRM work-expression-manifestation model in this
  cutover.
- Do not build an external authority reconciliation pipeline that mutates local
  identities without review.
- Do not auto-merge contributors from name similarity alone.
- Do not treat author biographies, headshots, birth/death dates, or external
  profile enrichment as required for the first production cutover.
- Do not preserve legacy API response fields such as `authors: string[]` or
  `author: string`.
- Do not keep compatibility adapters that map old author strings into frontend
  links.
- Do not add a separate author search service outside the existing backend
  search layer.
- Do not add database-level cascading deletes. Cleanup is explicit in services.
- Do not expose database UUIDs at end-user boundaries.
- Do not split rollout by media kind, user, feature flag, or old/new search
  path.

## Final State

Nexus has one contributor domain.

- `/authors/:contributorHandle` opens a contributor pane.
- `ObjectRef` supports `contributor`.
- Search supports `contributor` as a first-class result type.
- Search filters support contributor handles and normalized contribution roles.
- AI app search accepts contributor filters as structured tool arguments.
- Media, podcast, browse, library, search, command palette, chat, notes,
  context, and citation surfaces render contributor credits through shared
  structured DTOs.
- In-pane author links open in the current pane. Shift-click opens a new pane
  through the existing workspace pane runtime.
- Every credited content object stores ordered `ContributorCredit` rows.
- Every `ContributorCredit` stores the exact credited name, normalized role,
  raw role when present, ordinal, source, confidence, provenance, and linked
  contributor.
- Contributor identities store display names, sort names, aliases, external
  IDs, status, and merge/split audit data.

Legacy author storage is gone from active application code and DTOs. Old rows
are handled only by the one-time cutover migration.

## Target Behavior

### Clickable references

- Author text is never rendered as a raw string.
- Author references render from structured contributor-credit DTOs.
- A reference displays the credited name by default, not necessarily the
  canonical contributor display name.
- A tooltip or secondary label may expose the canonical name when it differs
  from the credited name.
- Contributor links use backend-supplied handles and hrefs.
- No frontend component constructs an author href from a raw name.
- No UI creates invalid nested anchors. In clickable result rows, contributor
  chips are sibling controls or row-level action targets that preserve pane
  navigation semantics.
- Missing or malformed contributor data is a rendering error in development and
  a backend contract failure in tests. It is not silently downgraded to text.

### Contributor pane

- A contributor pane opens at `/authors/:contributorHandle`.
- The pane header shows display name, primary sort name when useful, status,
  known aliases, and trusted external authority links.
- The pane title uses the contributor display name.
- The primary tab lists visible credited works.
- Works are grouped by role and content kind by default.
- Works can be filtered by role, content kind, library, podcast, and text query.
- Each work row shows title, kind, date when known, source/publisher when known,
  credited name, role, and containing library context.
- A contributor with no visible works still opens and states that no visible
  works are available to the current viewer.
- Unverified contributors are visible, clickable identities. They are not
  hidden fallbacks.
- Contributor panes never leak inaccessible media, podcasts, notes, messages,
  or library membership.

### Search

- `/search` accepts structured contributor filters.
- Search result types include `contributor`.
- User-facing labels may say "Authors"; API result type and object type remain
  `contributor`.
- Query text can match contributor display names, aliases, credited names, and
  external IDs.
- Structured contributor filters are handle/id based after backend unsealing.
  They are not implemented as text query rewriting.
- Role filters apply to credit roles, not contributor identities.
- Media and podcast search can match contributor names and aliases.
- Content-chunk search can be filtered by contributors credited on the owning
  media item.
- Search snippets and source metadata include structured contributor credits,
  not `authors: string[]`.
- Search result hrefs are backend-owned and pane-safe.
- Search ranking may use contributor aliases as rank features, but permission
  and scope filters apply before ranking.

### User filter surfaces

- The search pane has a contributor filter control with typeahead.
- The command palette can return contributors directly.
- The command palette can open contributor panes.
- Browse and library panes can filter visible rows by contributor.
- Media, podcast, and author panes expose author chips that can be used as
  filters in the current search surface when that surface supports filters.
- Filter chips display contributor names and roles, and removing a chip updates
  the URL/query state deterministically.
- Search URLs encode contributor handles, not database IDs and not raw names.

### AI app search

- The app-search tool schema accepts structured filters:
  `contributor_handles`, `roles`, `content_kinds`, and existing scope/type
  selectors.
- The retrieval planner can pass contributor context into app search when the
  conversation scope or attached context includes a contributor.
- The model is not asked to encode author filters inside the query string.
- `message_tool_calls` stores the normalized app-search filter payload.
- `message_retrievals` stores result refs and enough contributor filter context
  to replay and audit the retrieval.
- Prompt context for app-search results includes credited contributor labels.
- Citations render contributor credits from persisted structured metadata.
- A contributor-filtered search that returns no results reports the empty
  filtered result. It does not retry without the contributor filter.

### Ingest and enrichment

- All ingest paths call one contributor-credit service.
- A byline is parsed into ordered credits before storage.
- Ingest preserves the exact credited name even when normalized matching finds a
  canonical contributor.
- External IDs from providers attach credits only through
  `contributor_external_ids`.
- Name-only provider data creates or reuses only a locally safe unverified
  contributor according to resolver rules.
- Metadata enrichment can propose contributor updates, aliases, roles, or
  external IDs, but cannot overwrite credited names without provenance.
- Metadata enrichment does not append raw `MediaAuthor` rows or scalar author
  strings.
- Reingest replaces the source-owned credits for that source and object through
  explicit delete/insert/update logic in a transaction.
- User-curated aliases, merges, and external IDs survive reingest.

### Identity resolution

- Exact authority IDs are strong identity evidence.
- Existing manually confirmed aliases may resolve a new credit to a contributor.
- Fuzzy names, same normalized names, same title pages, and LLM guesses produce
  merge suggestions only.
- Resolver decisions are deterministic and logged with source/provenance.
- Merge suggestions are not visible as backlinks and do not affect search
  filters until accepted.
- A merge moves credits, aliases, external IDs, object links, message context
  items, and saved references to the survivor inside one transaction.
- A split moves selected credits and aliases to a new contributor inside one
  transaction.
- Conflicting external IDs block automatic merge.
- Tombstoned contributors are not returned in normal search.
- No handle redirect compatibility is required after merge. Stored object refs
  are updated to the survivor.

### Object references and notes

- `ObjectRef` supports `contributor`.
- Object-link autocomplete can find contributors by display name, alias,
  credited name, and external ID.
- Notes can link to contributors inline.
- Contributor panes show backlinks from notes and other supported object links.
- Message context can include a contributor.
- Chat context hydration for a contributor includes identity metadata and a
  bounded, permission-filtered list of visible credited works.
- Object-link identity is contributor id internally and contributor handle at
  end-user boundaries.

### Podcasts

- Podcast show author text is replaced by contributor credits on the podcast.
- Podcast episode authors remain credits on the episode media item.
- Podcast provider data can create show-level and episode-level credits.
- Podcast discovery, subscribe, OPML import/export, subscription sync, detail,
  library rows, and search use structured contributor DTOs.
- OPML export writes provider-compatible author text from structured credits.
  It does not reintroduce scalar product storage.
- Podcast app-search prompt context includes show and episode contributor
  credits where relevant.

### Gutenberg and external catalogs

- Gutenberg catalog author strings are parsed into catalog contributor credits.
- Browse results expose structured contributor credits.
- Importing a Gutenberg item into media carries catalog contributor credits into
  media contributor credits with source provenance.
- Catalog search can match contributor display names, aliases, and credited
  names.
- Catalog contributor credits are not allowed to become authoritative external
  IDs unless the catalog source supplies a trusted authority identifier.

### Deletion

- Deleting a media item explicitly deletes or tombstones its contributor credits
  before deleting the media row.
- Deleting a podcast explicitly deletes or tombstones show-level contributor
  credits before deleting the podcast row.
- Deleting a contributor is allowed only when it has no credits, object links,
  message context items, or persisted references.
- Contributors with historical references are tombstoned, not hard-deleted.
- Cleanup code asserts affected row counts after mutations.

## Architecture

### Naming

The internal domain name is `Contributor`. Product copy can use "Authors" on
search filters and panes because author is the dominant user-facing role.

Rules:

- Use `contributor` for object types, tables, service names, and schemas.
- Use `contributorHandle` for outward opaque identity.
- Use `contributorId` only inside backend services and database code.
- Use `role="author"` for author credits.
- Do not create an `authors` table.

### Data model

#### `contributors`

Canonical local identity records.

Required fields:

- `id uuid primary key`
- `handle text not null unique`
- `display_name text not null`
- `sort_name text null`
- `kind text not null`
- `status text not null`
- `disambiguation text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `merged_into_contributor_id uuid null references contributors(id)`
- `merged_at timestamptz null`

Allowed `kind` values:

- `person`
- `organization`
- `group`
- `unknown`

Allowed `status` values:

- `unverified`
- `verified`
- `tombstoned`
- `merged`

Rules:

- `handle` is the only outward opaque identity.
- `display_name` is presentation, not matching authority.
- `sort_name` is optional and never used as identity.
- `merged` contributors are hidden from normal reads.

#### `contributor_aliases`

Names associated with a contributor.

Required fields:

- `id uuid primary key`
- `contributor_id uuid not null references contributors(id)`
- `alias text not null`
- `normalized_alias text not null`
- `sort_name text null`
- `alias_kind text not null`
- `locale text null`
- `script text null`
- `source text not null`
- `confidence numeric null`
- `is_primary boolean not null default false`
- `created_at timestamptz not null default now()`

Allowed `alias_kind` values:

- `display`
- `credited`
- `legal`
- `pseudonym`
- `transliteration`
- `search`

Rules:

- Alias uniqueness is per contributor, not global.
- A globally duplicated alias is allowed.
- Alias matching may find candidates; it must not merge contributors by itself.

#### `contributor_external_ids`

Trusted and provider-owned authority identifiers.

Required fields:

- `id uuid primary key`
- `contributor_id uuid not null references contributors(id)`
- `authority text not null`
- `external_key text not null`
- `external_url text null`
- `source text not null`
- `created_at timestamptz not null default now()`

Supported authorities at cutover:

- `orcid`
- `isni`
- `viaf`
- `wikidata`
- `openalex`
- `lcnaf`
- `podcast_index`
- `rss`
- `youtube`
- `gutenberg`

Rules:

- `(authority, external_key)` is unique.
- External IDs are identity evidence, not display labels.
- Provider-local IDs are scoped to their provider authority.

#### `contributor_credits`

Ordered credits on work-like objects.

Required fields:

- `id uuid primary key`
- `contributor_id uuid not null references contributors(id)`
- `media_id uuid null references media(id)`
- `podcast_id uuid null references podcasts(id)`
- `project_gutenberg_catalog_ebook_id bigint null references
  project_gutenberg_catalog(ebook_id)`
- `credited_name text not null`
- `normalized_credited_name text not null`
- `role text not null`
- `raw_role text null`
- `ordinal integer not null`
- `source text not null`
- `source_ref jsonb not null`
- `resolution_status text not null`
- `confidence numeric null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Rules:

- Exactly one target foreign key is non-null.
- Role belongs to the credit, not the contributor.
- `credited_name` preserves source byline text.
- `source_ref` uses typed JSONB for provider/source provenance.
- Reingest replaces only source-owned credits for the target object.

Allowed `role` values at cutover:

- `author`
- `editor`
- `translator`
- `host`
- `guest`
- `narrator`
- `creator`
- `producer`
- `publisher`
- `channel`
- `organization`
- `unknown`

Allowed `resolution_status` values:

- `external_id`
- `manual`
- `confirmed_alias`
- `unverified`

#### `contributor_identity_events`

Audit records for identity curation.

Required fields:

- `id uuid primary key`
- `event_type text not null`
- `actor_user_id uuid null references users(id)`
- `source_contributor_id uuid null references contributors(id)`
- `target_contributor_id uuid null references contributors(id)`
- `payload jsonb not null`
- `created_at timestamptz not null default now()`

Allowed `event_type` values:

- `create`
- `alias_add`
- `alias_remove`
- `external_id_add`
- `external_id_remove`
- `merge`
- `split`
- `tombstone`

### Removed tables and fields

These are removed from active schema and code:

- `media_authors`
- `podcasts.author`
- `project_gutenberg_catalog.authors`

If a destructive migration needs temporary staging tables, they exist only
inside that migration and are not mapped by SQLAlchemy models or used by runtime
code.

### Backend services

#### `python/nexus/services/contributors.py`

Owns contributor reads, pane hydration, work listing, autocomplete, curation,
merge, split, tombstone, and deletion guards.

Required service functions:

- `get_contributor_by_handle`
- `list_contributor_works`
- `search_contributors`
- `hydrate_contributor_object_ref`
- `merge_contributors`
- `split_contributor`
- `tombstone_contributor`

#### `python/nexus/services/contributor_credits.py`

Owns credit parsing, validation, source replacement, and output DTO assembly.

Required service functions:

- `normalize_contributor_name`
- `normalize_contributor_role`
- `resolve_or_create_contributor_for_credit`
- `replace_media_contributor_credits`
- `replace_podcast_contributor_credits`
- `replace_gutenberg_contributor_credits`
- `load_contributor_credits_for_media`
- `load_contributor_credits_for_podcasts`
- `build_contributor_credit_out`

#### `python/nexus/services/contributor_resolution.py`

Owns identity matching and merge suggestions.

Required service functions:

- `find_contributor_by_external_id`
- `find_confirmed_alias_candidates`
- `create_unverified_contributor`
- `record_merge_suggestion`
- `explain_resolution_decision`

#### Existing services to extend

- `python/nexus/services/search.py`
- `python/nexus/services/browse.py`
- `python/nexus/services/media.py`
- `python/nexus/services/media_deletion.py`
- `python/nexus/services/metadata_enrichment.py`
- `python/nexus/services/object_refs.py`
- `python/nexus/services/object_links.py`
- `python/nexus/services/message_context_items.py`
- `python/nexus/services/context_lookup.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/retrieval_planner.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/gutenberg.py`
- `python/nexus/services/podcasts/catalog.py`
- `python/nexus/services/podcasts/provider.py`
- `python/nexus/services/podcasts/subscriptions.py`
- `python/nexus/services/podcasts/sync.py`

### API

New FastAPI routes:

- `GET /contributors`
- `GET /contributors/{contributor_handle}`
- `GET /contributors/{contributor_handle}/works`
- `POST /contributors/{contributor_handle}/aliases`
- `DELETE /contributors/{contributor_handle}/aliases/{alias_id}`
- `POST /contributors/{contributor_handle}/external-ids`
- `DELETE /contributors/{contributor_handle}/external-ids/{external_id_id}`
- `POST /contributors/merge`
- `POST /contributors/{contributor_handle}/split`

Existing routes to change:

- `GET /search`
- `GET /browse`
- media detail/list routes
- library detail/list routes
- podcast discovery/ensure/subscribe/detail/list routes
- object-ref/object-link routes
- message-context routes
- chat routes that persist and render app-search metadata

Rules:

- Routes validate input and call services.
- Routes do not contain contributor resolution business logic.
- Next.js BFF routes only proxy requests and attach auth.
- Client code calls `/api/*`, not FastAPI directly.

### Schemas

New backend schema module:

- `python/nexus/schemas/contributors.py`

Core DTOs:

- `ContributorOut`
- `ContributorAliasOut`
- `ContributorExternalIdOut`
- `ContributorCreditOut`
- `ContributorWorkOut`
- `ContributorSearchResultOut`
- `ContributorMergeRequest`
- `ContributorSplitRequest`
- `ContributorFilterIn`

Existing schema changes:

- `MediaOut` uses `contributors: list[ContributorCreditOut]`.
- Podcast DTOs use `contributors: list[ContributorCreditOut]`.
- Library item DTOs use structured contributor credits.
- Browse DTOs use structured contributor credits.
- Search source metadata uses structured contributor credits.
- App-search persisted/citation DTOs include contributor filters.
- `ObjectRef` includes `contributor`.

Removed DTO fields:

- `MediaAuthorOut`
- `MediaOut.authors`
- search `source.authors`
- podcast `author`
- library podcast `author`
- browse podcast `author`
- browse episode `podcast_author`
- Gutenberg `authors`

### Frontend

New files:

- `apps/web/src/app/(authenticated)/authors/[handle]/page.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/page.module.css`
- `apps/web/src/components/contributors/ContributorChip.tsx`
- `apps/web/src/components/contributors/ContributorCreditList.tsx`
- `apps/web/src/components/contributors/ContributorFilter.tsx`
- `apps/web/src/lib/contributors/api.ts`
- `apps/web/src/lib/contributors/types.ts`
- `apps/web/src/lib/contributors/formatting.ts`

Existing frontend files to change:

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/lib/objectRefs.ts`
- `apps/web/src/lib/objectLinks.ts`
- `apps/web/src/lib/search/resultRowAdapter.ts`
- `apps/web/src/components/search/SearchResultRow.tsx`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/ui/ContextRow.tsx`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaFormatting.ts`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcastSubscriptions.ts`
- chat citation and tool-call rendering components
- note object-link/autocomplete components

Frontend files to delete or replace:

- author-string-specific formatting helpers that return only text
- tests that assert scalar `author` or `authors: string[]`

### Pane route

Pane registry adds:

```text
route id: author
path: /authors/:handle
resourceRef: contributor:<handle>
component: AuthorPaneBody
```

Rules:

- Normal click opens in the current pane.
- Shift-click opens in a new pane.
- Author pane links are internal app links.
- Author panes can be restored from workspace state.

## Rules

### Identity rules

- Contributor identity is never inferred from display name alone.
- Credits always point to one contributor row.
- Unverified contributors are explicit identities, not fallbacks.
- Authority IDs are stored separately from aliases.
- Alias text is not unique globally.
- Merge and split operations write audit events.
- Object refs use contributor identity, not credited names.

### Credit rules

- Credited name is source data and is preserved.
- Role is normalized into a controlled vocabulary.
- Raw provider role is retained when present.
- Credit order is stable and source-owned.
- Reingest may replace source-owned credits but must not erase user-curated
  identity data.
- No runtime code writes `media_authors` or scalar author fields.

### Search rules

- Contributor filters are structured.
- Contributor search is one result type in the main search service.
- User search and AI app search share filter semantics.
- Search never broadens a contributor-filtered query by dropping the filter.
- Search output never returns author strings as the only author data.
- Permission and scope checks happen before returning contributor works.

### Frontend rules

- Every visible contributor reference uses `ContributorChip` or an equivalent
  structured renderer.
- Contributor links use backend hrefs or handles, never raw names.
- No nested anchor markup.
- Search, command palette, browse, library, media, podcast, chat, and notes
  surfaces must all render clickable contributor references.
- UI text says "Author" where the role is author and "Contributor" where the
  role set is broader.

### Hard-cutover rules

- No feature flag.
- No compatibility DTOs.
- No old search params accepted for author strings.
- No legacy author fields in generated TypeScript types.
- No SQLAlchemy model for `media_authors`.
- No runtime access to `podcasts.author`.
- No runtime access to `project_gutenberg_catalog.authors`.
- No frontend fallback that renders a raw author string if contributors are
  missing.

## Key Decisions

- Use `contributors`, not `authors`, internally because author is a role on a
  credit. This keeps hosts, editors, translators, narrators, producers,
  organizations, and channels in one authority model.
- Keep `/authors/:handle` as the user-facing route because users expect author
  panes for bylines and creator references.
- Preserve credited names separately from canonical display names. This avoids
  destroying source bylines and supports pseudonyms, transliterations, and
  organization credits.
- Prefer conservative identity resolution over aggressive deduplication. False
  duplicate author panes are fixable; false merged identities corrupt search,
  citations, and user trust.
- Represent unverified contributors explicitly. This makes every reference
  clickable without pretending that name-only data is authoritative.
- Put contributor filtering in the main search service and app-search tool
  contract. Do not create a parallel author search path.
- Add contributor to `ObjectRef`. Notes, backlinks, chat context, and panes
  should not invent separate contributor reference shapes.
- Use explicit cleanup and row-count assertions for deletion. Do not add
  database cascades.
- Treat legacy author data as migration input only. After cutover, legacy author
  fields are removed, not tolerated.

## Implementation Plan

### Phase 1: Schema cutover

- Add contributor tables and constraints.
- Add `contributor` to object-link and message-context type constraints.
- Migrate existing author data from `media_authors`, `podcasts.author`, and
  Project Gutenberg author strings into contributor credits.
- Create unverified contributors for migrated name-only credits unless a strong
  external ID or confirmed alias exists.
- Drop legacy author tables/columns from active schema.
- Update SQLAlchemy models.

### Phase 2: Backend domain

- Add contributor schemas and services.
- Add contributor route handlers.
- Update media, podcast, Gutenberg, browse, library, object-ref, object-link,
  context, and deletion services.
- Replace every author-string response with structured contributor-credit DTOs.
- Add merge/split/tombstone service operations.

### Phase 3: Ingest and enrichment

- Route URL capture, web article ingest, EPUB ingest, PDF ingest, YouTube ingest,
  podcast sync, OPML import, Gutenberg import, and metadata enrichment through
  contributor-credit services.
- Remove direct inserts into old author storage.
- Add deterministic resolver logging and tests.

### Phase 4: Search and AI app search

- Add contributor result type.
- Add contributor and role filters to `/search`.
- Add contributor filters to browse/library queries where applicable.
- Update app-search tool schema, planner, persistence, prompt rendering, and
  citations.
- Remove all author-string search fallbacks.

### Phase 5: Frontend panes and filters

- Add author pane route and pane body.
- Add contributor chip/list/filter shared components.
- Update media, podcast, browse, library, search, command palette, chat, notes,
  and context surfaces to render structured contributor references.
- Update URL/query-state handling for contributor filters.
- Remove author-string formatting helpers.

### Phase 6: Cleanup and verification

- Delete legacy models, schemas, DTO fields, helpers, tests, and dead SQL.
- Run backend, frontend, and E2E test gates.
- Run targeted zero-result checks for legacy identifiers and string-only author
  paths.
- Document the final contributor rules in `docs/rules/` if this cutover becomes
  a standing repo convention.

## Files

### New backend files

- `python/nexus/schemas/contributors.py`
- `python/nexus/api/routes/contributors.py`
- `python/nexus/services/contributors.py`
- `python/nexus/services/contributor_credits.py`
- `python/nexus/services/contributor_resolution.py`
- `python/tests/test_contributors.py`
- `python/tests/test_contributor_search.py`
- `python/tests/test_contributor_app_search.py`
- `python/tests/test_contributor_ingest.py`

### Backend files to modify

- `python/nexus/db/models.py`
- `python/nexus/api/main.py`
- `python/nexus/api/routes/search.py`
- `python/nexus/api/routes/browse.py`
- `python/nexus/api/routes/libraries.py`
- `python/nexus/api/routes/media.py`
- `python/nexus/api/routes/podcasts.py`
- `python/nexus/schemas/media.py`
- `python/nexus/schemas/search.py`
- `python/nexus/schemas/library.py`
- `python/nexus/schemas/podcast.py`
- `python/nexus/schemas/notes.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/services/search.py`
- `python/nexus/services/browse.py`
- `python/nexus/services/media.py`
- `python/nexus/services/media_deletion.py`
- `python/nexus/services/metadata_enrichment.py`
- `python/nexus/services/object_refs.py`
- `python/nexus/services/object_links.py`
- `python/nexus/services/message_context_items.py`
- `python/nexus/services/context_lookup.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/retrieval_planner.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/gutenberg.py`
- `python/nexus/services/podcasts/catalog.py`
- `python/nexus/services/podcasts/provider.py`
- `python/nexus/services/podcasts/subscriptions.py`
- `python/nexus/services/podcasts/sync.py`
- `python/nexus/tasks/ingest_web_article.py`
- `python/nexus/tasks/ingest_epub.py`
- `python/nexus/tasks/ingest_pdf.py`
- `python/nexus/tasks/ingest_youtube_video.py`
- existing tests for media, podcasts, browse, search, app search, object refs,
  object links, conversations, and ingestion

### Backend files to delete or stop using

- `MediaAuthor` SQLAlchemy model
- `MediaAuthorOut`
- direct SQL that inserts, deletes, or selects from `media_authors`
- scalar podcast author DTO fields
- scalar Gutenberg author DTO fields

### New frontend files

- `apps/web/src/app/(authenticated)/authors/[handle]/page.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/page.module.css`
- `apps/web/src/components/contributors/ContributorChip.tsx`
- `apps/web/src/components/contributors/ContributorCreditList.tsx`
- `apps/web/src/components/contributors/ContributorFilter.tsx`
- `apps/web/src/lib/contributors/api.ts`
- `apps/web/src/lib/contributors/types.ts`
- `apps/web/src/lib/contributors/formatting.ts`

### Frontend files to modify

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/lib/objectRefs.ts`
- `apps/web/src/lib/objectLinks.ts`
- `apps/web/src/lib/search/resultRowAdapter.ts`
- `apps/web/src/components/search/SearchResultRow.tsx`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/ui/ContextRow.tsx`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaFormatting.ts`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcastSubscriptions.ts`
- frontend tests for command palette, search adapter, library pane, media pane,
  browse pane, podcast panes, object refs, and chat citations

### Frontend files to delete or replace

- helpers that only format `authors: string[]`
- components/tests that require scalar `author`
- fixtures that omit structured contributor credits for bylined content

## Acceptance Criteria

### Schema and migration

- Contributor tables exist with UUID primary keys, handles, timestamps, and
  explicit foreign keys.
- `contributor_credits` enforces exactly one credited target object.
- External IDs are unique by authority and external key.
- `media_authors` is absent from SQLAlchemy models and runtime queries.
- `podcasts.author` is absent from SQLAlchemy models, schemas, and runtime
  queries.
- `project_gutenberg_catalog.authors` is absent from runtime product
  code.
- Existing legacy author data is migrated into contributors and credits.
- Migration does not create database-level cascades.

### Backend

- `GET /contributors` returns contributor autocomplete/search results.
- `GET /contributors/{handle}` returns pane hydration data.
- `GET /contributors/{handle}/works` returns permission-filtered works.
- Media, podcast, library, browse, and search APIs return structured
  contributor credits.
- ObjectRef hydration works for `contributor`.
- Contributor merge and split operations update credits, aliases, external IDs,
  object links, message context items, and audit events transactionally.
- Deletion services explicitly remove or block contributor-related rows.
- No backend tests or API snapshots assert legacy author-string fields.

### Search and AI

- User search can return contributor results.
- User search can filter media, podcasts, and content chunks by contributor.
- Browse/library filtering by contributor works where those surfaces expose
  search/filter controls.
- Command palette can find and open contributors.
- App search accepts contributor filters as structured arguments.
- App search persists normalized filters.
- App search citations render contributor metadata from structured result data.
- A contributor-filtered no-result app search does not retry without filters.

### Frontend

- Every visible contributor reference in media, library, browse, podcast,
  search, command palette, chat, notes, and context surfaces is clickable.
- Normal click opens the contributor in the current pane.
- Shift-click opens the contributor in a new pane.
- Author panes render visible works and support role/kind filtering.
- Contributor chips do not create nested anchors.
- Search URLs use contributor handles for filters.
- No frontend type accepts scalar `author` or `authors: string[]` for product
  bylines.

### Ingest

- Web article, EPUB, PDF, YouTube, podcast sync, OPML import, and Gutenberg
  import all write contributor credits through contributor-credit services.
- Reingest replaces source-owned credits without deleting curated identity data.
- Metadata enrichment stores proposed or resolved contributor data through the
  contributor domain.
- Resolver tests cover external-ID match, confirmed-alias match, unverified
  contributor creation, merge suggestion, and conflict blocking.

### Tests

- Backend integration tests cover contributor APIs, search filters, app-search
  persistence, permissions, migration behavior, and deletion behavior.
- Frontend tests cover contributor chips, search filters, author pane routing,
  command palette results, and pane-aware click behavior.
- E2E tests cover clicking an author from a media pane, filtering search by that
  author, opening the author in a new pane via Shift-click, and seeing the same
  author filter applied in a search result workflow.
- Zero-result checks confirm no runtime references to `media_authors`,
  `MediaAuthor`, scalar `podcasts.author`, scalar Gutenberg `authors`, or
  `authors: string[]` product DTOs remain.

### Hard cutover

- No feature flag exists.
- No compatibility route exists.
- No old author search params are accepted.
- No string-only author rendering remains.
- No fallback broadens filtered search by dropping contributor filters.
- No old DTO shape is accepted by frontend product code.

## Test Plan

- Run existing tests before starting implementation to expose pre-existing
  failures.
- Add failing acceptance tests first for schema, API, search, app search, and
  panes.
- Use backend integration tests for database/API behavior.
- Use Vitest/component tests for contributor chips and filter behavior.
- Use Playwright E2E for pane navigation and visible user workflows.
- Add targeted `rg` zero-result checks for removed legacy paths.

## Cutover Sequence

1. Land schema migration and SQLAlchemy model changes.
2. Land contributor schemas, services, and routes.
3. Cut ingest/enrichment/podcast/Gutenberg writers to contributor credits.
4. Cut read DTOs for media, podcast, library, browse, and search.
5. Cut ObjectRef, object links, message context, and notes to include
   `contributor`.
6. Cut user search, browse/library filters, command palette, and app search.
7. Land author pane and contributor chip/filter frontend.
8. Delete legacy author paths and update tests.
9. Run full verification and zero-result checks.
