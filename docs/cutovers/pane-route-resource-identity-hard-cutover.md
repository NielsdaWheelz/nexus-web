# Pane Route Resource Identity Hard Cutover

Status: IMPLEMENTED
Author: Codex
Type: hard cutover
Date: 2026-06-19

## North Star

Every pane that presents a concrete resource exposes the same canonical resource
identity the graph, chat, citations, search, context refs, and resource-item
services use.

The product language is:

> This pane is showing this resource.

The architecture is:

```text
Product URL or pane route
  -> typed product locator
  -> resource_items locator resolver
  -> canonical ResourceRef
  -> ResourceItemOut
  -> pane runtime resource surface
  -> graph, chat, context refs, citations, connections, and resource actions
```

The URL may be a human route such as `/authors/{handle}` or a date route such as
`/daily/2026-06-19`. The durable resource identity is still
`contributor:<uuid>` or `page:<uuid>`.

## Type

Hard cutover. No legacy code, no fallback resource identity, no compatibility
lanes, no route-specific resource shims, no frontend-only alias-to-ref
construction, no `author:<handle>` pseudo-ref, no `daily_note:<date>` pseudo-ref,
no "try UUID else URL key" resource semantics, and no old path kept as a second
owner.

If two modules answer "what resource is this pane showing?", one of them stops
answering it. If a route can represent a resource, it must go through the same
locator-to-`ResourceItemOut` contract as every other route. If a pane does not
represent a resource, it must say so explicitly and must not use URL fallback as
resource identity.

## Precedents And Repo Rules

- `docs/architecture.md` makes `ResourceRef` the persisted resource identity
  vocabulary across edges, citations, attached context refs, chat subjects, and
  agent-tool arguments.
- `docs/cutovers/resource-graph-product-spine-hard-cutover.md` makes
  `resource_edges` the single durable connection spine.
- `docs/cutovers/resource-capability-registry-hard-cutover.md` makes
  `resource_items.capabilities` the owner of link, attach, route, read, cite,
  search, prompt, and expansion policy.
- `docs/cutovers/resource-chat-subject-hard-cutover.md` says author product
  surfaces map to `contributor:<id>` and forbids an `author` scheme.
- `docs/cutovers/resource-native-pages-and-notes-hard-cutover.md` says daily
  notes are ordinary resource-native pages and note blocks, not a separate
  resource identity family.
- `docs/cutovers/authors-directory-and-contributor-ownership-hard-cutover.md`
  establishes contributors as the person/author owner.
- `docs/rules/keys-and-identities.md` says handles are outward opaque aliases
  that resolve server-side to typed targets before authority and scope checks.
- `docs/rules/cleanliness.md` requires one owner per concern, deletion of
  compatibility lanes, and collapse of dangerous duplication.
- `docs/rules/layers.md` keeps BFF and API routes thin; services own behavior.
- `docs/rules/correctness.md` requires typed boundary parsing and illegal states
  made unrepresentable.
- `docs/local-rules/testing_standards.md` requires behavior tests at public
  owner boundaries.

## SME Thesis

A subject matter expert would not patch `/authors/:handle` and `/daily/:date`
one pane at a time. They would name the missing concept:

> A pane route can be a locator for a resource before it is itself a canonical
> resource ref.

The existing system already has the right primitives:

- strict backend `ResourceRef` grammar in `resource_graph.refs`;
- frontend `ResourceRef` parser mirror in `apps/web/src/lib/resourceGraph`;
- resource-item surface projection in `resource_items.surfaces`;
- resource-item route activation in `resource_items.routing`;
- contributor handle resolution and merge following in `services/contributors`;
- daily-note resolution to an ordinary page in `services/notes`;
- generic resource chat components that require a `ResourceRef`;
- graph connection and citation systems that require canonical refs.

The professional move is to add one semantic product-locator contract and make
the pane shell consume it. That finishes the owner boundary without weakening the
resource graph.

The wrong moves are:

- adding `author`, `author_handle`, `daily`, or `daily_note` to
  `ResourceScheme`;
- exposing raw contributor UUIDs only so the frontend can build
  `contributor:${id}`;
- letting `DailyNotePaneBody` build `page:${page.id}` and publish it as pane
  identity;
- making `resolvePaneRouteModel` async or letting it call APIs;
- accepting arbitrary frontend href strings as backend resource identity input;
- treating handles or local dates as authorization-bearing ids;
- preserving URL fallback as a resource identity after the cutover;
- using object refs as the route resolver for graph resources;
- putting graph/chat/context affordances behind per-pane conditional code;
- adding local allowlists for which pane routes can chat, attach, connect, or
  cite.

## Vocabulary

### `ResourceRef`

The canonical durable resource identity: `<scheme>:<uuid>`.

Examples:

- `contributor:11111111-1111-4111-8111-111111111111`
- `page:22222222-2222-4222-8222-222222222222`
- `note_block:33333333-3333-4333-8333-333333333333`

Only `resource_graph.refs` and the frontend resource-ref mirror parse or format
this shape.

### Product Locator

A typed product-level locator that can resolve to a `ResourceRef`.

Examples:

- `resource_ref(media:<uuid>)`
- `contributor_handle(ursula-k-le-guin)`
- `daily_note_today(America/Los_Angeles)`
- `daily_note_date(2026-06-19, America/Los_Angeles)`

A locator is not durable graph identity. It is an ingress shape.

### Pane Route

The syntactic, URL-derived pane model. It owns route id, route params, static
title, body mode, width policy, and secondary groups. It does not own semantic
resource identity.

### Pane Route Key

The stable route-instance key derived from normalized href and route id. It
guards remounts, stale title/layout publications, pending secondary-pane
requests, and route-local editor draft state.

### Pane Resource Surface

The resolved resource shown by a pane. It is represented by `ResourceItemOut`,
including `ref`, `activation`, `route`, `capabilities`, `missing`, label,
summary, and version lanes.

### Pane Resource Key

The canonical resource-surface key, derived only from the resolved
`ResourceItemOut.ref`.

It is not available for non-resource panes. It is not the same thing as the pane
route key.

## Current Head Facts

### Already Correct

- `python/nexus/services/resource_graph/refs.py` owns the closed UUID-only
  resource identity grammar.
- `apps/web/src/lib/resourceGraph/resourceRef.ts` mirrors that grammar.
- `python/nexus/services/resource_items/capabilities.py` declares capability
  policy for `page`, `note_block`, `contributor`, and the other schemes.
- `python/nexus/services/resource_items/surfaces.py` projects a canonical
  `ResourceRef` into `ResourceItemOut`.
- `python/nexus/services/resource_items/routing.py` maps canonical refs back to
  activation routes, including `contributor:<uuid>` to `/authors/{handle}`.
- `python/nexus/services/contributors.py` resolves contributor handles and
  follows merge chains.
- `python/nexus/services/notes.py` resolves or creates daily notes as ordinary
  `Page` rows.
- `apps/web/src/components/chat/ResourceChatTab.tsx` can list chats for any
  `resourceUri`.
- `apps/web/src/components/chat/ResourceChatDetail.tsx` can start chat with a
  generic `chat_subject.resource_ref`.
- `apps/web/src/lib/resources/activation.ts` already treats backend activation
  hrefs as the route authority.
- `apps/web/src/lib/resourceGraph/contractParity.test.ts` already protects graph
  vocabulary parity.
- `python/tests/test_cutover_negative_gates.py` already guards route-building
  ownership for canonical `ResourceRef` routes.

### Still Wrong Or Partial

- `apps/web/src/lib/panes/paneRouteModel.ts` exposes `resourceRef` only when a
  URL param is a canonical UUID.
- `/authors/:handle` is a product resource surface, but its route definition
  returns `resourceRef: null`.
- `/daily` and `/daily/:localDate` are page-backed resource surfaces, but their
  route definitions return `resourceRef: null`.
- `apps/web/src/lib/panes/paneRouteTable.test.tsx` has a test named as if author
  routes resolve contributor refs while the assertion still expects `null`.
- `apps/web/src/lib/panes/paneIdentity.ts` mixes route-instance identity and
  resource-surface identity into one `resourceKey`.
- `WorkspaceHost` uses that one key for remounts, stale publication guards,
  title publications, layout publications, fixed chrome, secondary panes, and
  pending secondary-surface targeting.
- `paneServerLoaders.ts` prefetches author panes by `author:<handle>`, which is a
  fetch-cache alias, not canonical graph identity.
- `AuthorPaneBody` receives a handle and fetches contributor data, but
  contributor output does not expose a `ResourceItemOut` surface for the
  resolved canonical contributor.
- `DailyNotePaneBody` fetches a daily page and delegates to `PagePaneBody`, but
  the shell-level pane runtime never learns that the pane resource is `page:<id>`.
- `DailyNotePaneBody` has no direct pane-body test covering current-date
  fallback, invalid date, cache key, open-yesterday behavior, or page delegation.
- Some tests manually pass invalid resource refs such as `resourceRef={handle}`
  to author pane harnesses.
- There is no public backend API that accepts product locators and returns
  canonical `ResourceItemOut` records.
- There is no explicit contract deciding whether contributor `ResourceRef`
  hydration is global or viewer-visible. Contributor detail/search and handle
  routes use visibility predicates; graph resolution must align.

## Duplicate Or Repetitive Patterns To Collapse

D1. Direct route param -> `ResourceRef` construction in `paneRouteModel.ts`
duplicates the frontend resource-ref parser and bypasses backend resource-item
surface policy.

D2. `resourceKey` currently acts as route key, resource key, publication guard,
remount key, pending-secondary key, and title key. Those are different concerns.

D3. Author handle resolution exists in contributor services, search filters, and
author pane data loading, but not in a reusable resource locator contract.

D4. Daily date resolution exists in notes services and daily pane data loading,
but not in a reusable resource locator contract.

D5. Backend `ResourceRef -> route` has one owner in `resource_items.routing`,
while frontend route aliases still infer resource semantics locally.

D6. `ResourceChatTab`, `ResourceChatDetail`, `ConnectionsSurface`, citations,
and context refs already consume canonical refs. Panes without shell-level refs
force each product body to rediscover or omit those affordances.

D7. Server loaders seed panes by feature cache keys such as `author:<handle>`,
while workspace identity uses `resourceKey` and resource items use
`ResourceItemOut.ref`.

D8. Tests duplicate route-resource expectations at route table, pane identity,
workspace host, and body harness layers without one owner-level semantic test for
"this route resolves to this resource item".

The cutover collapses these patterns into one route-locator owner and one pane
resource-surface runtime contract.

## Goals

G1. Make `ResourceItemOut` the pane-shell resource surface payload.

G2. Make every resource-backed pane route resolve to a canonical resource item:

- `/media/{uuid}` -> `media:<uuid>`;
- `/libraries/{uuid}` -> `library:<uuid>`;
- `/conversations/{uuid}` -> `conversation:<uuid>`;
- `/podcasts/{uuid}` -> `podcast:<uuid>`;
- `/pages/{uuid}` -> `page:<uuid>`;
- `/notes/{uuid}` -> `note_block:<uuid>`;
- `/authors/{handle}` -> `contributor:<uuid>`;
- `/daily` -> `page:<uuid>` for the current local date in the active timezone;
- `/daily/{localDate}` -> `page:<uuid>` for that local date in the active
  timezone.

G3. Keep directories and tools explicitly non-resource:

- `/libraries`;
- `/conversations`;
- `/conversations/new`;
- `/browse`;
- `/podcasts`;
- `/search`;
- `/authors`;
- `/notes`;
- `/settings/*`;
- unsupported routes.

G4. Delete pane-route `resourceRef` as the semantic owner. Replace it with a
typed pane resource locator or no locator.

G5. Split route-instance identity from resource-surface identity.

G6. Keep `resolvePaneRouteModel` pure, synchronous, and URL-only.

G7. Add one backend locator resolver that maps product locators to
`ResourceItemOut`.

G8. Keep route activation authority in `resource_items.routing`.

G9. Keep capabilities in `resource_items.capabilities`; panes consume
capabilities from `ResourceItemOut`.

G10. Make author handles aliases to canonical contributors. Merged handles
resolve to the survivor contributor.

G11. Make daily dates aliases to canonical pages. Daily resolution is
idempotent and timezone-explicit.

G12. Route every resource chat, context-ref list, connection surface, citation
activation, and secondary resource surface from pane runtime's resolved
`ResourceItemOut.ref`.

G13. Make missing, unauthorized, invalid, and unsupported states typed and
visible at the resolver boundary.

G14. Add negative gates that prevent future handle/date pseudo-refs and local
pane-route resource identity reconstruction.

G15. Update docs so product routes, resource locators, resource refs, and pane
keys are separate terms.

## Non-Goals

N1. No new resource schemes for author or daily notes.

N2. No graph database.

N3. No new connection, backlink, citation, or context-ref table.

N4. No generic backend parser for arbitrary frontend hrefs.

N5. No attempt to make every pane a resource pane.

N6. No attempt to make contributor readable, citable, or graph-traversable beyond
its explicit capability policy.

N7. No attempt to make `/daily` the canonical activation route for a `page`.
`/daily` remains a product locator route; canonical page activation remains
resource-item route policy.

N8. No backward-compatible `resourceKey` meaning where URL fallback also counts
as resource identity.

N9. No body-local publication hook that bypasses the shell resolver.

N10. No frontend construction of `contributor:<uuid>` from a contributor payload.

N11. No frontend construction of `page:<uuid>` from a daily page payload for pane
identity.

N12. No fallback to old pane behavior when locator resolution fails.

N13. No compatibility tests that pin author/daily `resourceRef: null`.

N14. No broad workspace rewrite unrelated to route identity, resource surfaces,
or stale publication keys.

N15. No persistence migration unless the implementation chooses to rename stored
workspace keys. The target can be reached with runtime key separation.

## Scope

In scope:

- backend product locator schema;
- backend locator resolver service;
- resource-item API route and BFF proxy for locator resolution;
- contributor-handle-to-resource resolution;
- daily-date-to-page resource resolution;
- contributor visibility contract alignment for resource-item hydration;
- frontend pane route locator model;
- frontend pane route key and resource key split;
- pane runtime `ResourceItemOut` exposure;
- workspace host resource surface hydration;
- server loader seeding through the same locator contract;
- author pane and daily pane resource surface behavior;
- resource chat, connections, context refs, and secondary panes consuming the
  resolved pane resource;
- tests and negative gates;
- docs updates.

Out of scope:

- changing contributor merge product behavior except as required for canonical
  resource resolution;
- redesigning the notes editor;
- redesigning workspace layout persistence;
- changing search ranking;
- changing citation storage;
- adding new resource capabilities unrelated to route identity;
- adding multi-user sharing semantics.

## Target Behavior

T1. Opening `/authors/ursula-k-le-guin` resolves a product locator
`contributor_handle("ursula-k-le-guin")`.

T2. The backend follows contributor merge chains and visibility rules, then
returns a `ResourceItemOut` for `contributor:<canonical_id>`.

T3. The author pane runtime exposes that resource item before author-specific
graph, chat, context, connections, or resource actions render.

T4. The author pane body may still fetch author detail data by handle, but it
does not define the pane's resource identity.

T5. A merged-away author handle either canonicalizes the route to the survivor
activation href or renders the existing "formerly" product state while the pane
resource item is still the survivor contributor. It never creates an
`author:<handle>` identity.

T6. Opening `/daily/2026-06-19` resolves a product locator
`daily_note_date("2026-06-19", active_time_zone)`.

T7. Opening `/daily` resolves `daily_note_today(active_time_zone)`, where
"today" is evaluated by the backend or a shared render-environment owner using
the explicit timezone.

T8. Daily locator resolution is idempotent. Repeated resolution for the same
user, local date, and timezone returns the same `page:<uuid>`.

T9. Daily locator resolution may create the backing page because daily-note
opening is already a creating product operation. The mutation is explicit in the
locator resolver contract and is not hidden behind a generic read.

T10. The daily pane runtime exposes `ResourceItemOut(ref="page:<uuid>")`.

T11. The daily pane body delegates to the page editor with the resolved page id,
but graph/chat/context/citation resource identity comes from the shell resource
item, not from body-local string building.

T12. Direct UUID resource routes use the same resource-surface pipeline as alias
routes. They can create a `resource_ref` locator without server-side alias
lookup, but the pane runtime still receives `ResourceItemOut`.

T13. Non-resource routes have no pane resource item and no pane resource key.
Their route key remains valid for remounts, titles, fixed chrome, layout, and
secondary UI that is not resource-specific.

T14. Resource secondary surfaces open only when `ResourceItemOut.capabilities`
allows the required behavior.

T15. `ResourceChatTab` and `ResourceChatDetail` are mounted from resolved pane
resource items, not from route params.

T16. `ConnectionsSurface` is mounted from resolved pane resource items, not from
feature-local handle/date/id parsing.

T17. `activateResource` continues to trust backend activation hrefs. The
frontend does not reconstruct activation routes from refs.

T18. If locator resolution fails, the pane renders a typed failure state:
invalid locator, missing target, unauthorized target, unsupported locator, or
server error. It does not silently become a non-resource pane.

T19. Tests fail if a resource-backed pane route lacks a locator decision.

T20. Tests fail if a route locator returns a ref whose scheme is not explicitly
supported by resource-item capabilities.

## Final Architecture

### Backend Owner

The backend owner is `python/nexus/services/resource_items/`.

Recommended new module:

```text
python/nexus/services/resource_items/locators.py
```

The public service contract is semantic:

```python
def resolve_resource_locator(
    db: Session,
    *,
    viewer_id: UUID,
    locator: ResourceLocator,
) -> ResourceLocatorResolution:
    ...

def resolve_resource_locators(
    db: Session,
    *,
    viewer_id: UUID,
    locators: Sequence[ResourceLocator],
) -> list[ResourceLocatorResolution]:
    ...
```

The locator resolver may call domain owners, but callers do not call those
owners directly for pane resource identity.

```text
resource_items.locators
  -> resource_graph.refs for canonical ref parsing/formatting
  -> contributors service for contributor handle resolution
  -> notes service for daily note page resolution
  -> resource_items.surfaces.resource_item_out for final projection
```

`resource_items.routing` remains the owner for `ResourceRef -> activation href`.
`resource_items.locators` is the owner for `product locator -> ResourceRef`.

### Backend Schemas

Add to `python/nexus/schemas/resource_items.py` or a sibling imported from it:

```python
class ResourceRefLocatorIn(BaseModel):
    kind: Literal["resource_ref"]
    ref: str

class ContributorHandleLocatorIn(BaseModel):
    kind: Literal["contributor_handle"]
    handle: str

class DailyNoteTodayLocatorIn(BaseModel):
    kind: Literal["daily_note_today"]
    time_zone: str

class DailyNoteDateLocatorIn(BaseModel):
    kind: Literal["daily_note_date"]
    local_date: date
    time_zone: str

ResourceLocatorIn = Annotated[
    ResourceRefLocatorIn
    | ContributorHandleLocatorIn
    | DailyNoteTodayLocatorIn
    | DailyNoteDateLocatorIn,
    Field(discriminator="kind"),
]

class ResourceLocatorResolveRequest(BaseModel):
    locators: list[ResourceLocatorIn]

class ResourceLocatorResolutionOut(BaseModel):
    locator: ResourceLocatorIn
    resource_item: ResourceItemOut
    canonical_href: str | None

class ResourceLocatorResolveResponse(BaseModel):
    resolutions: list[ResourceLocatorResolutionOut]
```

The exact class names can change, but the contract must stay discriminated,
typed, and closed.

### Backend API

Add one thin route under `python/nexus/api/routes/resource_items.py`:

```text
POST /resource-items/locators/resolve
```

Behavior:

- requires an authenticated viewer;
- accepts a bounded list of typed locators;
- validates locator shape at the boundary;
- calls `resource_items.locators.resolve_resource_locators`;
- returns `ResourceItemOut` for each locator;
- preserves input order;
- returns typed errors for invalid, missing, unauthorized, and unsupported
  locators;
- does not accept raw hrefs;
- does not accept `author:*`, `daily:*`, or `daily_note:*` refs;
- does not return raw table ids except through `ResourceItemOut.id`, which is
  already part of the resource-item read model.

Recommended route path if batching is not desired:

```text
POST /resource-items/locator/resolve
```

The batch route is preferred because workspace restore and server prefetch can
resolve visible pane resources in one call.

### BFF API

Add one proxy route:

```text
apps/web/src/app/api/resource-items/locators/resolve/route.ts
```

It is a thin authenticated proxy. It does not parse product semantics. It
forwards the body to the backend route and returns the backend response.

Update `apps/web/src/app/api/proxy-routes.test.ts` intentionally.

### Frontend Locator Model

Add a frontend resource locator owner:

```text
apps/web/src/lib/panes/paneResourceLocator.ts
```

It owns:

- TypeScript discriminated union matching backend locator input;
- route model to locator mapping;
- locator key derivation for request de-dupe only;
- date and timezone normalization helpers;
- no graph/chat/capability behavior.

The pane route model can expose:

```ts
resourceLocator?: (params: RouteParams) => PaneResourceLocator | null;
```

or it can expose only enough static metadata for `paneResourceLocator.ts` to map
`ResolvedPaneRouteModel` to a locator. The second option is stricter because it
keeps semantic resource identity out of the syntactic route table.

Hard-cutover target:

- delete `PaneRouteModelDefinition.resourceRef`;
- delete `ResolvedPaneRouteModel.resourceRef`;
- delete `canonicalResourceRef` from `paneRouteModel.ts`;
- build all resource locators in `paneResourceLocator.ts`.

### Frontend API Client

Add or extend an API client under one owner:

```text
apps/web/src/lib/resources/resourceItems.ts
```

or, if existing local patterns require it:

```text
apps/web/src/lib/api/resource.ts
```

The public client should expose:

```ts
resolveResourceLocators(
  locators: readonly PaneResourceLocator[],
): Promise<ResourceLocatorResolution[]>
```

The client returns normalized `ResourceItem` objects using the same normalizer as
`apps/web/src/lib/notes/api.ts` uses for resource-item endpoints. Do not create a
second `ResourceItemOut` normalizer.

### Pane Runtime

Extend `PaneRuntimeContextValue` to separate route and resource concerns:

```ts
interface PaneRuntimeContextValue {
  paneId: string;
  href: string;
  pathname: string;
  routeId: PaneRouteId | "unsupported";

  routeKey: string;
  resourceItem: ResourceItem | null;
  resourceRef: string | null;
  resourceKey: string | null;
  resourceStatus: "none" | "pending" | "ready" | "missing" | "unauthorized" | "invalid" | "error";

  pathParams: Record<string, string>;
  searchParams: URLSearchParams;
  ...
}
```

`resourceRef` is derived from `resourceItem.ref`. It is never derived from route
params in the runtime provider.

`resourceKey` is derived from `resourceItem.ref`. It is never the normalized href.

`routeKey` replaces the old stale-publication use of `resourceKey`.

### Workspace Host

`WorkspaceHost` owns pane-shell resource hydration:

```text
pane href
  -> resolvePaneRouteModel
  -> routeKey
  -> paneResourceLocator(route, render environment)
  -> resolveResourceLocators
  -> ResourceItem
  -> PaneRuntimeProvider
```

The host must:

- resolve resource locators for visible resource-backed panes;
- batch locator resolution where practical;
- seed resource locator results during server bootstrap when possible;
- keep route rendering possible while resource status is pending;
- block resource-only affordances until resource status is ready;
- show typed resource resolution failures without silently falling back;
- use `routeKey` for stale title/layout/fixed-chrome guards;
- use resolved `resourceKey` for resource-targeted secondary surfaces and
  resource-level de-dupe.

### Route Key And Resource Key

Replace the current single `resourceKey` with explicit keys:

```ts
interface PaneRouteIdentity {
  href: string;
  routeId: ResolvedPaneRouteModel["id"];
  routeKey: string;
  resourceLocator: PaneResourceLocator | null;
}
```

Resource resolution later provides:

```ts
interface PaneResourceIdentity {
  resourceItem: ResourceItem;
  resourceRef: string;
  resourceKey: `resource:${string}`;
}
```

Rules:

- `routeKey` is always present.
- `resourceKey` exists only after successful resource resolution.
- non-resource panes never get a resource key.
- route-key changes may remount the pane body.
- resource-key changes may update resource affordances but must not remount the
  pane body by accident.
- if a route transition changes to a different canonical resource, the workspace
  handles it as an explicit resource transition, not as stale publication drift.

### Server Bootstrap And Prefetch

`apps/web/src/lib/panes/paneServerLoaders.ts` should stop inventing feature-local
resource identity for route aliases.

Target behavior:

- server bootstrap computes route keys for restored panes;
- server bootstrap resolves resource locators that are safe on the server;
- author handle locators are safe on the server;
- explicit daily date locators are safe only with an explicit timezone;
- `/daily` is safe on the server only if the request has a product-owned timezone
  source;
- if timezone is browser-only, `/daily` resource resolution happens on the client
  before resource affordances render;
- no server prefetch path creates a handle/date pseudo-resource key.

### Contributor Contract

Add a contributor-owned function for canonical resource resolution:

```python
def resolve_contributor_resource_ref_by_handle(
    db: Session,
    *,
    viewer_id: UUID,
    handle: str,
) -> ResourceRef:
    ...
```

or:

```python
def resolve_contributor_resource_item_by_handle(...) -> ResourceItemOut:
    ...
```

The first shape is cleaner if `resource_items.locators` remains the final
projection owner.

Rules:

- follows merge chains;
- enforces the same visibility predicate as contributor detail/search;
- returns the survivor contributor id;
- does not expose raw UUIDs for frontend string construction;
- does not accept arbitrary external ids;
- distinguishes not found, unauthorized, invalid handle, and merge-cycle defect.

`ContributorOut` may include:

```python
surface: ResourceItemOut
```

only if it is projected through `resource_items.surfaces`. It must not add a raw
`id` field for clients to assemble refs.

### Daily Note Contract

Add a notes-owned function for canonical page resolution:

```python
def resolve_daily_note_page_ref(
    db: Session,
    *,
    viewer_id: UUID,
    local_date: date,
    time_zone: str,
) -> ResourceRef:
    ...
```

or:

```python
def ensure_daily_note_page_resource(...)
```

The name must reveal that daily route opening can create the backing page.

Rules:

- validates `local_date`;
- validates `time_zone` as an IANA timezone;
- uses the existing daily-note uniqueness invariant;
- is idempotent;
- returns `page:<uuid>`;
- delegates page surface projection to `resource_items.surfaces`;
- does not create a `daily_note` resource scheme.

`DailyNotePageOut` may expose `page.surface` or a top-level `surface`, but the
surface must be a `ResourceItemOut` from the resource-item owner.

### Capability Contract

Pane resource surfaces consume the existing capability model:

- `linkable`;
- `attachable`;
- `chat_subject`;
- `readable`;
- `inspectable`;
- `citable_result_type`;
- `citation_output_source`;
- `app_search_scope`;
- `conversation_search_scope`;
- `prompt_render`;
- `expansion_policy`;
- `adjacency_source`;
- `adjacency_target`.

Rules:

- capability policy is per canonical resource scheme, not per route alias;
- `/authors/{handle}` inherits `contributor` capabilities;
- `/daily/{date}` inherits `page` capabilities;
- `contributor` may be linkable, attachable, and a label chat subject without
  becoming readable or citable;
- `page` may be readable, attachable, editable, and adjacency-aware through the
  page/note capability contract;
- route aliases cannot override capabilities;
- frontend surfaces may hide actions based on capability output, but may not
  reclassify a scheme locally.

### Error Contract

Use typed resolver errors:

```text
invalid_locator
unsupported_locator
invalid_handle
not_found
unauthorized
invalid_local_date
invalid_time_zone
resolution_conflict
server_error
```

Rules:

- invalid input is a 422 boundary error;
- missing visible resource is a typed resource resolution result when the pane
  can still render an empty/missing state;
- unauthorized is never converted to missing inside the API route unless the
  existing product privacy policy already requires indistinguishability;
- merge cycles and daily uniqueness conflicts are defects;
- the frontend does not catch all errors and continue as a non-resource pane.

## API Design

### Request

```json
{
  "locators": [
    {
      "kind": "contributor_handle",
      "handle": "ursula-k-le-guin"
    },
    {
      "kind": "daily_note_date",
      "local_date": "2026-06-19",
      "time_zone": "America/Los_Angeles"
    },
    {
      "kind": "resource_ref",
      "ref": "media:11111111-1111-4111-8111-111111111111"
    }
  ]
}
```

### Response

```json
{
  "resolutions": [
    {
      "locator": {
        "kind": "contributor_handle",
        "handle": "ursula-k-le-guin"
      },
      "canonical_href": "/authors/ursula-k-le-guin",
      "resource_item": {
        "ref": "contributor:11111111-1111-4111-8111-111111111111",
        "scheme": "contributor",
        "id": "11111111-1111-4111-8111-111111111111",
        "label": "Ursula K. Le Guin",
        "summary": null,
        "route": "/authors/ursula-k-le-guin",
        "activation": {
          "resource_ref": "contributor:11111111-1111-4111-8111-111111111111",
          "kind": "route",
          "href": "/authors/ursula-k-le-guin",
          "unresolved_reason": null
        },
        "missing": false,
        "capabilities": {
          "linkable": true,
          "attachable": true,
          "chat_subject": "label",
          "readable": false,
          "inspectable": false
        }
      }
    }
  ]
}
```

The example is illustrative. The exact JSON field names must match the existing
`ResourceItemOut` schema.

### Locator Keys

Locator keys are client request/cache keys only:

```text
resource_ref:media:<uuid>
contributor_handle:ursula-k-le-guin
daily_note_today:America/Los_Angeles
daily_note_date:2026-06-19:America/Los_Angeles
```

They are not graph identity. They must not be stored as `resource_edges`
endpoints, chat subjects, citation targets, or context refs.

## Composition With Other Systems

### Resource Graph

All graph calls receive canonical refs from `ResourceItemOut.ref`.

Author route aliases become graph endpoints only after resolving to
`contributor:<uuid>`.

Daily route aliases become graph endpoints only after resolving to `page:<uuid>`
or `note_block:<uuid>` through page/note interactions.

No graph table accepts handle/date endpoints.

### Chat

`ResourceChatTab` lists chats by `resourceItem.ref`.

`ResourceChatDetail` sends:

```json
{
  "chat_subject": {
    "resource_ref": "contributor:<uuid>"
  },
  "initial_context_refs": ["contributor:<uuid>"]
}
```

or:

```json
{
  "chat_subject": {
    "resource_ref": "page:<uuid>"
  },
  "initial_context_refs": ["page:<uuid>"]
}
```

The chat system never sees `author:<handle>` or `daily_note:<date>`.

### Connections

`ConnectionsSurface` receives canonical refs and capability-derived affordances.
It does not parse pane routes.

### Citations

Generated citations continue to target canonical refs. Daily pages cite as
`page` or `note_block` depending on the cited resource. Contributors follow
their explicit citable capability; no route alias changes that.

### Search

Search result activation continues through `ResourceItemOut.activation`.

Search filters can still accept author handles as search inputs, but search
canonicalizes handles through its existing contributor-resolution path and emits
canonical `resource_ref` values.

### Object Refs

Object refs remain editor/reference UI syntax. They do not become pane route
resource identity and do not resolve graph resources for the workspace shell.

### Launcher

Launcher entries that open resource-backed routes can attach a locator or rely
on route-to-locator mapping. They must not pass pseudo-refs.

### Workspace Restore

Restored panes keep their route hrefs. On restore, visible panes resolve resource
locators and regain resource surfaces. Restored old URL fallback keys are not
treated as resource identity after the cutover.

### Server Rendering And Timezone

Author handles can resolve during server bootstrap.

Explicit dated daily routes can resolve during server bootstrap only when an
explicit timezone is available.

`/daily` must not guess timezone. If the only trusted timezone is browser-local,
the client resolves it and resource affordances remain pending until that
resolution completes. If a profile timezone exists, the server can resolve
`/daily` with that profile timezone.

## File Plan

### Backend

Create:

- `python/nexus/services/resource_items/locators.py`
- `python/tests/test_resource_item_locators.py`

Update:

- `python/nexus/schemas/resource_items.py`
- `python/nexus/api/routes/resource_items.py`
- `python/nexus/services/contributors.py`
- `python/nexus/services/notes.py`
- `python/nexus/services/resource_graph/resolve.py`
- `python/tests/test_resource_item_surfaces.py`
- `python/tests/test_resource_item_capabilities.py`
- `python/tests/test_resource_graph_refs.py`
- `python/tests/test_cutover_negative_gates.py`

Do not add:

- a new top-level route-alias package;
- route locator logic in `api/routes`;
- contributor UUID exposure for frontend string building;
- `author` or `daily_note` schemes.

### Frontend

Create:

- `apps/web/src/lib/panes/paneResourceLocator.ts`
- `apps/web/src/lib/panes/paneResourceLocator.test.ts`
- `apps/web/src/lib/resources/resourceLocators.ts`
- `apps/web/src/app/api/resource-items/locators/resolve/route.ts`
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.test.tsx`

Update:

- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/lib/panes/paneRouteModel.test.ts`
- `apps/web/src/lib/panes/paneRouteTable.test.tsx`
- `apps/web/src/lib/panes/paneIdentity.ts`
- `apps/web/src/lib/panes/paneIdentity.test.ts`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRuntime.test.tsx`
- `apps/web/src/lib/panes/paneServerLoaders.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/workspace/store.test.tsx`
- `apps/web/src/lib/workspace/bootstrap.server.ts`
- `apps/web/src/lib/workspace/workspaceRestore.test.ts`
- `apps/web/src/lib/api/resource.ts`
- `apps/web/src/lib/notes/api.ts`
- `apps/web/src/lib/notes/api.test.ts`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx`
- `apps/web/src/components/chat/Conversation.tsx`
- `apps/web/src/components/chat/ResourceChatTab.tsx`
- `apps/web/src/components/connections/ConnectionsSurface.tsx`
- `apps/web/src/app/api/proxy-routes.test.ts`

Possibly update:

- `apps/web/src/lib/resources/resourceCapabilities.generated.ts`
- `apps/web/src/lib/resourceGraph/contractParity.test.ts`
- `e2e/tests/authors.spec.ts`
- `e2e/tests/share.spec.ts`

### Docs

Update:

- `docs/architecture.md`
- `docs/modules/chat.md`
- `docs/cutovers/resource-chat-subject-hard-cutover.md`
- `docs/cutovers/resource-capability-registry-hard-cutover.md`
- `docs/cutovers/resource-native-pages-and-notes-hard-cutover.md`
- `docs/cutovers/resource-discovery-link-citation-spine-hard-cutover.md`

Delete or revise stale statements that imply pane route parsing is the resource
identity owner.

## Key Decisions

KD1. `ResourceRef` remains UUID-only and closed.

KD2. `author` is product language; `contributor` is resource identity.

KD3. `daily` is product language; `page` and `note_block` are resource identity.

KD4. Product locators are typed API inputs, not graph ids.

KD5. Backend locator resolution accepts product locator shapes, not raw hrefs.

KD6. `ResourceItemOut` is the final pane resource surface payload.

KD7. Route activation remains backend-owned in `resource_items.routing`.

KD8. Pane route resolution remains pure, synchronous, isomorphic, and URL-only.

KD9. The pane shell, not individual pane bodies, publishes resource surfaces.

KD10. Pane route keys and pane resource keys are separate concepts.

KD11. Daily note resolution is explicitly idempotent and may create the backing
page.

KD12. Timezone is explicit for daily locators.

KD13. Contributor handle resolution follows merge chains and visibility rules.

KD14. Contributor resource hydration must align with contributor visibility
semantics.

KD15. Body payloads may include `surface: ResourceItemOut` only if projected by
the resource-item owner.

KD16. No frontend code formats `scheme:${id}` except the resource-ref utility and
tests specifically exercising it.

KD17. No resource affordance renders from route params when a resource item is
required.

## Implementation Plan

### Phase 1 - Backend Locator Owner

1. Add typed locator schemas.
2. Add `resource_items.locators`.
3. Add contributor handle resolver that returns canonical `ResourceRef`.
4. Add daily note resolver that returns canonical `ResourceRef`.
5. Add batch locator API.
6. Add BFF proxy route.
7. Add Python tests for direct refs, author handles, merged handles, daily date,
   daily today, invalid locators, missing resources, unauthorized resources, and
   unsupported pseudo-refs.

Exit criteria:

- every locator returns a `ResourceItemOut`;
- author handles resolve to `contributor`;
- daily locators resolve to `page`;
- no `author` or `daily_note` scheme appears in parser tests or capability rows.

### Phase 2 - Frontend Locator Contract

1. Add `paneResourceLocator.ts`.
2. Replace route-model `resourceRef` callbacks with locator decisions.
3. Delete `canonicalResourceRef` from pane route model.
4. Update route table and route model tests.
5. Add tests proving author and daily routes produce locators, not refs.

Exit criteria:

- pane route resolution is still pure and synchronous;
- resource-backed routes all have explicit locator decisions;
- non-resource routes explicitly have no locator.

### Phase 3 - Pane Identity Split

1. Replace `resourceKey` in `paneIdentity.ts` with `routeKey`.
2. Introduce resolved `resourceKey` from `ResourceItemOut.ref`.
3. Update workspace store operations to use route keys for remount/publication
   guards.
4. Update resource-targeted secondary surface tracking to use resolved resource
   keys.
5. Update tests for same-route, same-resource, and changed-resource behavior.

Exit criteria:

- URL fallback no longer counts as resource identity;
- route-key changes control route remounts;
- resource-key changes control resource affordances and resource targeting.

### Phase 4 - Pane Runtime Resource Hydration

1. Resolve resource locators in `WorkspaceHost`.
2. Batch visible pane locator resolution where practical.
3. Pass `resourceItem`, `resourceRef`, `resourceKey`, and `resourceStatus` through
   `PaneRuntimeProvider`.
4. Add typed pending and failure states.
5. Update `usePaneRuntime` consumers.

Exit criteria:

- author and daily pane runtimes expose canonical refs;
- resource affordances wait for ready status;
- failures are explicit and do not degrade to non-resource panes.

### Phase 5 - Author And Daily Cutover

1. Update author pane tests so harnesses no longer pass handle strings as
   resource refs.
2. Add contributor surface projection where useful.
3. Update daily pane to use shell-provided page resource identity.
4. Add direct daily pane tests.
5. Ensure merged author handles resolve to the survivor contributor resource.

Exit criteria:

- `/authors/{handle}` has `contributor:<uuid>` at pane runtime;
- `/daily` and `/daily/{date}` have `page:<uuid>` at pane runtime;
- existing product UI remains route-compatible without old resource semantics.

### Phase 6 - Resource Affordance Composition

1. Mount chat/context/connection surfaces from pane runtime resource item.
2. Ensure capability checks come from `ResourceItemOut.capabilities`.
3. Remove pane-local checks for whether author/daily can show resource features.
4. Ensure `activateResource` remains the only resource activation path.

Exit criteria:

- generic resource chat works for contributor and page-backed daily panes when
  capabilities allow it;
- connections work from canonical refs;
- route aliases never reach graph/chat/citation APIs.

### Phase 7 - Cleanup And Gates

1. Delete old `resourceRef` route model fields and tests expecting `null` for
   resource-backed alias routes.
2. Add negative gates for pseudo-ref schemes.
3. Add negative gates for frontend resource-ref string interpolation outside the
   resource-ref utility.
4. Add negative gates for route-alias resolver duplication outside
   `resource_items.locators`.
5. Update docs and architecture.
6. Run targeted frontend, backend, and e2e checks.

Exit criteria:

- no legacy fields or compatibility branches remain;
- no duplicate locator resolvers remain;
- test suite enforces the final owner contract.

## Acceptance Criteria

AC1. `POST /resource-items/locators/resolve` returns `ResourceItemOut` for a
valid `resource_ref` locator.

AC2. The same endpoint returns `ResourceItemOut(ref="contributor:<uuid>")` for a
valid contributor handle.

AC3. Merged contributor handles resolve to the survivor contributor resource.

AC4. Invalid contributor handles fail with a typed boundary error or typed
not-found result.

AC5. Contributor locator resolution uses the same visibility semantics as
contributor detail/search.

AC6. The endpoint returns `ResourceItemOut(ref="page:<uuid>")` for
`daily_note_date`.

AC7. `daily_note_date` resolution is idempotent for the same user, date, and
timezone.

AC8. `daily_note_today` uses an explicit timezone and does not guess.

AC9. Invalid dates and invalid timezones fail with typed errors.

AC10. `author:*`, `daily:*`, and `daily_note:*` are rejected everywhere as
resource refs.

AC11. `paneRouteModel.ts` no longer exposes semantic `resourceRef` fields.

AC12. Every resource-backed route has an explicit locator decision.

AC13. Every non-resource route has an explicit no-locator decision.

AC14. `resolvePaneRouteIdentity` returns a route key, not a resource fallback
key.

AC15. Pane runtime exposes `resourceItem`, `resourceRef`, `resourceKey`, and
`resourceStatus`.

AC16. `/authors/{handle}` renders with pane runtime `resourceRef` equal to
`contributor:<uuid>`.

AC17. `/daily/{date}` renders with pane runtime `resourceRef` equal to
`page:<uuid>`.

AC18. `/daily` renders with pane runtime `resourceRef` equal to the current
local daily page after timezone resolution.

AC19. Author pane tests do not pass handle strings as `resourceRef`.

AC20. Daily pane has direct tests for current date fallback, explicit date,
invalid date, page delegation, and resource status.

AC21. `ResourceChatTab` on author and daily surfaces receives canonical refs.

AC22. `ConnectionsSurface` on author and daily surfaces receives canonical refs.

AC23. Graph APIs never receive handle/date pseudo-refs from pane surfaces.

AC24. Resource activation continues to use backend `activation.href`.

AC25. Server bootstrap no longer seeds resource identity with `author:<handle>`
or URL fallback keys.

AC26. Workspace title/layout/fixed-chrome stale guards use route keys.

AC27. Resource secondary-surface targeting uses resolved resource keys.

AC28. Tests cover direct UUID routes and alias routes through the same resource
surface contract.

AC29. Negative gates fail if a new resource-backed pane route lacks a locator
decision.

AC30. Negative gates fail if route alias resolution appears outside the locator
owner.

AC31. Negative gates fail if frontend code constructs resource-ref strings
outside the resource-ref utility or approved tests.

AC32. Docs identify route aliases, resource locators, resource refs, route keys,
and resource keys as separate concepts.

## Verification Plan

Backend targeted tests:

```text
python/tests/test_resource_item_locators.py
python/tests/test_resource_item_surfaces.py
python/tests/test_resource_item_capabilities.py
python/tests/test_resource_graph_refs.py
python/tests/test_cutover_negative_gates.py
```

Frontend targeted tests:

```text
apps/web/src/lib/panes/paneResourceLocator.test.ts
apps/web/src/lib/panes/paneRouteModel.test.ts
apps/web/src/lib/panes/paneRouteTable.test.tsx
apps/web/src/lib/panes/paneIdentity.test.ts
apps/web/src/lib/panes/paneRuntime.test.tsx
apps/web/src/components/workspace/WorkspaceHost.test.tsx
apps/web/src/lib/workspace/store.test.tsx
apps/web/src/lib/workspace/workspaceRestore.test.ts
apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.test.tsx
apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.test.tsx
apps/web/src/app/api/proxy-routes.test.ts
```

E2E smoke:

```text
e2e/tests/authors.spec.ts
e2e/tests/share.spec.ts
```

Manual smoke:

1. Open `/authors/{handle}`.
2. Confirm pane runtime has `contributor:<uuid>`.
3. Open resource chat from the author pane.
4. Confirm the chat subject and initial context ref are `contributor:<uuid>`.
5. Open `/daily`.
6. Confirm pane runtime has `page:<uuid>`.
7. Open resource chat or connections from the daily pane.
8. Confirm graph/chat calls use `page:<uuid>`.

## Negative Gates

Add or extend gates so these fail:

- resource schemes named `author`, `author_handle`, `daily`, or `daily_note`;
- frontend code constructing `author:` or `daily_note:` refs;
- route alias resolution outside `resource_items.locators`;
- route activation construction outside `resource_items.routing`;
- `PaneRouteModelDefinition.resourceRef` reintroduced;
- `ResolvedPaneRouteModel.resourceRef` reintroduced;
- `resourceKey` used as both URL fallback and resource identity;
- author pane harnesses passing handles as resource refs;
- daily pane code building `page:${page.id}` for pane runtime identity;
- raw href accepted by backend locator resolver;
- untyped string union instead of discriminated locator union;
- per-pane local lists deciding chat/connect/attach capability.

## Data And Migration

No database migration is required for the core cutover.

Daily note resolution reuses existing page and daily-note page tables.

Contributor handle resolution reuses existing contributor and merge structures.

Workspace persisted state can continue storing hrefs. The cutover changes runtime
interpretation:

- persisted hrefs restore route instances;
- resource surfaces are re-resolved from locators after restore;
- old URL fallback keys are not treated as resource identity.

If persisted workspace metadata contains old `resourceKey` values, the hard
cutover should either:

1. ignore those persisted keys and recompute route/resource keys at restore; or
2. delete the stored field in a single migration.

Do not support both old and new key semantics in production code.

## Security And Correctness

- Handles are not authority.
- Dates are not authority.
- Resource locator resolution must run viewer scope checks.
- Resource locator resolution must not leak the existence of unauthorized private
  resources unless existing product policy allows it.
- `contributor` global identity must have an explicit visibility decision.
- Daily note creation must be idempotent and transaction-safe.
- Timezone input must be validated.
- Batch locator resolution must preserve request order and isolate individual
  failures.
- The frontend must not render resource actions while resource status is pending
  or failed.
- The frontend must not silently retry with a weaker locator type.

## Performance

The resource locator resolver should support batching because workspace restore
can show multiple visible panes.

Direct `resource_ref` locators should use the existing batch resource resolver
or equivalent set-based path.

Contributor handle locators should resolve in a set-oriented query where
possible. A one-user prototype can start with simple per-locator service calls if
the public contract remains batch-shaped.

Daily locators can be per-locator because they may create rows. They must still
be idempotent under repeated calls.

Frontend resource locator results should be cached by locator key for request
dedupe, but resource identity after resolution is always `ResourceItemOut.ref`.

## Open Questions

OQ1. Should the workspace canonicalize `/daily/{date}` to `/pages/{id}` after
resource resolution, or preserve the daily alias in the URL? This spec preserves
the alias route and treats `/pages/{id}` as the canonical resource activation
route.

OQ2. Should author merged-handle routes replace the URL with the survivor
handle? This spec allows URL replacement, but requires the resource item to be
the survivor contributor either way.

OQ3. Should `/daily` use profile timezone when available and browser timezone
otherwise, or should the product require a profile timezone before server
resolution? This spec requires an explicit timezone and forbids guessing.

OQ4. Should resource-key collision after alias resolution close duplicate panes
or keep both route instances? This spec requires the distinction to be explicit.
The safer first hard cutover is to preserve route instances and use resource keys
only for resource affordances, then add deliberate canonical-pane dedupe if the
workspace product wants it.

OQ5. Should `ContributorOut` always include `surface`, or should the pane shell
be the only consumer of contributor resource identity? This spec permits
`surface` only when projected through `resource_items.surfaces`.

## Final State

The final system has one route-to-resource story:

```text
URL route
  -> pane route model
  -> typed pane resource locator or no locator
  -> backend resource locator resolver
  -> canonical ResourceRef
  -> ResourceItemOut
  -> pane runtime resource surface
```

Author panes are first-class `contributor` resource surfaces.

Daily panes are first-class `page` resource surfaces.

Direct UUID panes are first-class resource surfaces through the same pipeline.

Directories, settings, search, browse, and new-chat panes remain non-resource
surfaces by explicit decision.

The graph sees only canonical refs. Chat sees only canonical refs. Citations see
only canonical refs. Context refs see only canonical refs. Resource activation
uses backend activation hrefs. The frontend shell knows the difference between a
route instance and a resource surface.

No legacy fallback remains.
