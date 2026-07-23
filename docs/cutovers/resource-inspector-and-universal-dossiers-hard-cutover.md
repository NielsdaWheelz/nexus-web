# Resource Inspector And Universal Dossiers Hard Cutover

Status: IMPLEMENTED AND VERIFIED · UNSHIPPED · Rev 3
Type: hard cutover
Date: 2026-07-23
Open questions: none

## Decision

Every canonical resource pane has one user-facing **Companion**, implemented as
one workspace-owned **Resource Inspector** secondary group.

Eligible dossier subjects are exactly:

- `media`
- `conversation`
- `library`
- `podcast`
- `contributor` (the Author pane)
- `page`
- `note_block`

The primary pane presents the resource. The Inspector presents its structure,
relationships, branches, and Dossier. A Dossier is canonical to exactly one
resource and one authenticated audience.

This is a destructive replacement. No old groups, actions, routes, artifact
kinds, jobs, components, drawers, columns, inline dossier/connection surfaces,
aliases, fallbacks, compatibility parsers, or dual paths survive.

## Vocabulary

- **Companion**: the user-facing name and pane-header action.
- **Resource Inspector**: the internal workspace group and composition
  architecture.
- **Dossier**: the single manual, cited, revisioned artifact product.
- **AudienceScope**: the server-derived `User` or `Library` audience that owns
  dossier visibility.
- **Media Intelligence**: the media-canonical current `MediaUnit` projection;
  it is not a Dossier or an audience-keyed artifact.
- **Linked items**: the capability role implemented by the existing Evidence,
  Context, or Connections domain surface. It is not one universal renderer.

## North Star

```text
canonical resource + authenticated AudienceScope
  -> typed resource capability
  -> one Resource Inspector publication
     -> optional Contents
     -> exactly one of Evidence | Context | Connections
     -> optional Forks
     -> Dossier
        -> optional Media Intelligence Abstract
        -> canonical current revision
        -> immutable history
  -> workspace desktop column or workspace mobile sheet
```

## Goals

- One Inspector/action/capability contract and one Dossier
  controller/API/build/history contract across seven subjects.
- Resource-plus-audience identity, one head serialization point, separate
  subject/binding policies, manual cited generation, and immutable history.
- Preserve citation-valid successful history; classify legacy outputs that
  cannot satisfy the new invariant; expose/reuse Media Intelligence; compose
  existing workspace/domain primitives; delete every touched legacy path.

## Non-goals

- No new `ResourceScheme` or artifact product other than `Dossier`.
- No automatic dossier generation, refresh, or scheduled conversation sweep.
- No shareable URL state for Inspector tab, width, or viewed revision.
- No historical readable-source snapshots or replay of old reader content.
- No recursive graph traversal; Page and Note use one current graph hop.
- No graph-schema, reader-document, podcast-ingest, contributor-identity,
  chat-engine, notes-editor, or library-entry redesign.
- No runtime plugin system, server-configurable UI, or second mobile sheet owner.
- No universal backend relationship store or universal linked-items renderer.
- No broader search-product redesign; existing artifact search behavior is
  preserved through the new Dossier owner.

## Supersession

This specification replaces, rather than adapts:

- the artifact/run substrate, kinds, APIs, jobs, sweep, search literals, and
  feature facades in `one-press-artifact-engine-hard-cutover.md`;
- inline Library Dossier behavior in
  `library-intelligence-ai-native-consolidation-hard-cutover.md`;
- the live Library Intelligence artifact naming in
  `library-intelligence-revision-resource-identity-hard-cutover.md`;
- inline Library/Page/Note placement in
  `machine-output-in-place-hard-cutover.md`;
- `reader-tools`, `conversation-context`, Document Map as the generic opener,
  and the old reader/chat surface IDs in the reader-sidecar documents;
- the pane-header exclusion of Library, Conversation, Podcast, Contributor,
  Page, and Note in `pane-header-identity-hard-cutover.md`;
- stale resource-group maps in
  `workspace-pane-publication-contract-hard-cutover.md`.

It retains:

- workspace ownership of desktop/mobile secondary presentation;
- the publication value/equality contract in `panePublications.ts`;
- the inner reader Contents and Evidence features;
- the current Conversation Context and Forks features;
- current-only source readability and citation snapshots;
- `artifact` and `artifact_revision` resource identities.

“Preserved” means product semantics survive. Artifact generation events are
rebuilt and re-keyed from revision runs to build runs.

## Target Behavior

### Resource composition

| Pane | Primary pane | Inspector tabs | Default |
| --- | --- | --- | --- |
| Media | Reader | Contents when available · Evidence · Dossier | Contents, else Evidence |
| Conversation | Transcript/composer | Context · Forks · Dossier | Context |
| Library | Entries | Connections · Dossier | Dossier |
| Podcast | Summary and Episodes inline | Connections · Dossier | Dossier |
| Author | Works inline | Connections · Dossier | Dossier |
| Page | Content/editor | Connections · Dossier | Dossier |
| Note | Content/editor | Connections · Dossier | Dossier |

Conversation Forks is always present; a one-path conversation renders its
legitimate empty/single-branch state. `/conversations/new` has no Inspector
until the conversation exists.

Media Evidence and Dossier are always published. Evidence renders a typed
`Processing | IngestFailed | Empty | Ready` projection when reader content is
not readable; it is never gated away with Contents. Dossier is always published
for every eligible subject and is the terminal fallback in every default order.

Podcast Episodes and Author Works remain ordinary inline primary-pane content.
No feature owns a fixed secondary column, drawer, or mobile overlay.

### Companion action

- Every eligible pane publishes exactly one directly visible Companion action
  through the same trailing pane-header action slot.
- Companion uses the shared `panel-right-open` icon. The surface registry uses
  `list-tree` for Contents, `link-2` for Evidence and Context, `git-branch` for
  Forks, and adds `network` for Connections and `file-text` for Dossier.
- The icon, position, tooltip, accessible name, active state, and behavior are
  identical on desktop and mobile.
- On mobile it is immediately left of Options. Lower-priority route actions move
  into Options when needed; Companion never does.
- One shared disclosure-action helper toggles the pane-local Inspector and
  produces the repository `ActionControlState`; `aria-controls` appears only in
  its expanded disclosure variant.
- Close/Escape captures the opener, collapses, then focuses it. A disconnected
  opener falls back to `findPaneChromeFocusTarget`; the opener map is not
  cleared first.
- Escape closes only while focus is inside the desktop Inspector. Action-toggle
  close leaves focus on the already-focused action. MobileSheet retains its
  existing return-focus ownership.
- Header geometry is verified at 390 CSS pixels; identity truncates before the
  Companion or Options controls collide.

### Inspector interaction

- Inspector state—open/closed, active tab, width, and viewed revision—is
  workspace-local.
- Desktop uses `SecondaryPaneShell`; mobile uses only
  `MobileSecondaryPaneHost`.
- Tabs have visible labels plus icons, roving focus, Arrow/Home/End behavior,
  and valid tab/tabpanel ID references.
- Historical revision navigation is not written to the route URL.
- Reopening Dossier selects the canonical current revision.
- The one `resource-inspector` group owns one width policy:
  `default=360px`, `min=280px`, `max=720px`.

### Dossier surface

The shared surface owns:

- Never generated with the primary Generate action;
- Loading and reconnecting;
- Generating first revision;
- suspended generation that requires repair or explicit cancellation;
- current and stale revisions;
- regenerating while the current revision remains readable;
- viewing a historical revision;
- failed and cancelled attempts, with or without a current revision;
- Generate, Regenerate, Cancel, Retry, and Make current;
- content, citations, provenance, instruction, model, coverage, freshness,
  revision position, and build indicators.

The controller uses explicit local-state unions:

```text
head =
  | Idle
  | Loading
  | Failed { error }
  | Ready {
      current_revision: Presence<DossierRevision>
      freshness: Presence<Current | Stale>
      active_build: Presence<DossierBuild {
        execution: Queued | Running | Recovering | Suspended
      }>
      latest_unsuccessful_build: Presence<Failed | Cancelled>
      history: DossierRevisionSummary[]
    }

revision_selection = Current | Historical { revision_ref }
historical_revision = Idle | Loading | Ready { revision } | Failed { error }
stream = Disconnected | Connecting | Live | Reconnecting | Suspended | Terminal
```

One exhaustive view-model helper derives the valid visual states. It does not
encode absence as booleans or flatten API `Presence` values.

Freshness describes only the current revision. Make current clears historical
selection. Tab switches retain selection; closing and reopening the Inspector
resets it to Current. `useResourceInspector` owns that reset by observing the
workspace Inspector visibility transition from hidden to visible. Dossier body
mount/unmount effects must not reset selection because tab switches produce the
same body remount.

Generation is manual:

- Generate/Regenerate sends one new `Idempotency-Key`.
- A transport retry reuses that same key.
- Regeneration preserves the current readable revision.
- Opening or reloading mid-build reconnects to the durable build stream.
- Failure or cancellation never removes the current revision.
- Retry creates a new build; it never reuses a terminal build.
- Suspended shows “Generation stopped; needs attention” plus Cancel. Generate,
  Regenerate, and Retry remain unavailable until operator replay completes or
  Cancel terminalizes the build.
- Only successful output with at least one valid citation creates a revision.
- History arrows are view-only.
- While viewing a non-current revision, the history row says which revision is
  viewed and exposes **Make current** beside the revision position.

### Citation activation

- Evidence-span citations open the Media pane at the current reader locator.
- Message citations open the Conversation pane, select the branch containing
  the message, and scroll to it.
- Page, Note, Media, Podcast, Library, and Contributor citations open their
  canonical pane through resource activation.
- Context-resource citations reuse the existing resource activation owner.
- A current-only target removed by reingestion keeps its citation snapshot but
  exposes a failed-closed, non-jumping state. It never guesses a locator.

### Media Abstract

Media Dossier alone renders:

```text
Abstract
  compact current Media Intelligence summary
  grounded-claim/evidence affordance

Dossier
  standard revisioned Dossier surface
```

The Abstract is compact, read-only, current-only, and visually subordinate. It
has typed Building, Ready, Stale, Failed, and NotAvailable projections, but no
Generate control or history.

`MediaUnit` remains:

- one current summary head per Media;
- grounded claims targeting exact evidence spans;
- freshness keyed by the media-content fingerprint;
- reusable retrieval/projection substrate, not revision history.

The Media Dossier binding consumes the exact displayed projection and records
its fingerprint in the input manifest. Aggregate bindings consume each unique
visible Media projection once. No Dossier path invokes a second interpretation
for the same `(media_id, content_fingerprint)` pair.

## Capability Contract

`RESOURCE_ITEM_CAPABILITIES` remains the backend authority. Add one field:

```text
ResourceInspectorSurfaceRole =
  Contents | LinkedItems | Forks | Dossier

ResourceInspectorPolicy =
  | None
  | Resource {
      linked_items: MediaEvidence | ConversationContext | ResourceConnections
      forks: None | ConversationForks
      default_surface_order: NonEmpty<ResourceInspectorSurfaceRole>
    }
```

Rules:

- `Resource` implies Dossier.
- Contents derives from the already-owned `inspectable` capability; no
  `contents_provider` field is added.
- The Media Abstract is owned by the Media Dossier binding; no
  `dossier_preface` field or registry is added.
- The static TypeScript capability projection is renamed from the misleading
  `resourceCapabilities.generated.ts` to `resourceCapabilities.ts` and remains
  a committed, parity-tested mirror.
- Manifest validation defects on missing Dossier eligibility, an incompatible
  linked-items/forks policy, an invalid default order, or route/capability
  disagreement.
- Dossier guarantees at least one runtime surface, so no speculative
  “no available surface” branch exists.

Canonical workspace identities:

- group: `resource-inspector`
- surfaces: `resource-contents`, `resource-evidence`, `resource-context`,
  `resource-connections`, `resource-forks`, `resource-dossier`

Concrete linked-items IDs keep global labels/icons honest. The shared contract
is the group, tab slot, ordering, and chrome—not the domain row renderer.

Role resolution is exact:

```text
Contents    -> resource-contents when runtime Contents exists
LinkedItems -> resource-evidence | resource-context | resource-connections
Forks       -> resource-forks
Dossier     -> resource-dossier
```

`default_surface_order` is a fallback preference, not tab display order. It is
exact:

| Subject | `default_surface_order` |
| --- | --- |
| Media | `[Contents, LinkedItems, Dossier]` |
| Conversation | `[LinkedItems, Forks, Dossier]` |
| Library, Podcast, Contributor, Page, Note | `[Dossier]` |

Every order contains unique supported roles and ends in always-published
Dossier. `useResourceInspector` selects the first concrete surface currently
published. Media LinkedItems resolves to always-published Evidence, so
non-readable Media opens a meaningful Evidence state rather than a blank
Inspector.

## Frontend Architecture

`useResourceInspector` is the sole resource-pane composition boundary. It:

- reads the typed capability;
- accepts only the route-owned domain bodies required by that capability;
- creates one subject-keyed `DossierControllerStore`;
- publishes one memoized `PaneSecondaryPublication`;
- returns one shared Companion action;
- restores a still-valid workspace tab or selects the first published default;
- reconciles an unsupported active surface to that default synchronously during
  render whenever the subject locator or capability changes. A post-commit
  effect may persist the resolved selection but must not expose a closed or
  stale-surface frame.

Streaming must not republish pane bodies. The Dossier publication body is stable
for the subject locator; it subscribes to the external controller store through
fine-grained state selectors. Stream tokens mutate the store, not the
publication. This preserves the body-identity equality contract and avoids
rerendering the route-owned primary pane per token.

The mounted primary pane owns the store through a subject-keyed owner component
with lazy `useState`/`useRef` creation and effect cleanup. A disposable store is
never created by `useMemo`, disposed during render, or kept in a module-global
cache. Subject change and primary-pane unmount dispose exactly the prior store.
An inactive or closed Dossier may disconnect its client stream; the durable
build continues. Remount refetches the head and resumes any active build before
rendering settled state.

Only Dossier state is retained by this controller across tab switches.
`SecondarySurfacePanels` continues to unmount inactive route-owned Contents,
Evidence, Context, Connections, and Forks bodies; this cutover makes no contrary
whole-body retention claim. Any Page/Note Connections draft that can lose user
input is owned above the panel by its route/controller and survives a tab
switch; transient scan/render state may reset. No tab switch silently discards
typed input.

`MobilePaneChrome` accepts direct actions. `PaneShell` no longer folds the
Companion action into Options, and `NavTopBar` renders it once in the agreed
trailing position.

`ConnectionsSurface` remains the graph controller and becomes the body for
`resource-connections`. Media Evidence and Conversation Context remain their
own controllers and renderers.

One exhaustive `dossierErrorMessage` helper maps every expected Dossier error
near the screen boundary. Progress, success, and cancellation announce through
one polite status region. Terminal failure renders a visible alert/notice and
Retry without moving focus. Focus may move only for an immediate synchronous
validation error attached to the invoked control.

## Backend Architecture

### Identity and authority

A Dossier head is unique by:

```text
(subject_scheme, subject_id, audience_scheme, audience_id)
```

`AudienceScope` is a closed owned value:

```text
AudienceScope =
  | User { user_id }
  | Library { library_id }
```

The server derives it:

| Subject | AudienceScope |
| --- | --- |
| Library | `Library(subject_id)` |
| Conversation | `User(conversation.owner_user_id)` |
| Page | `User(page.owner_user_id)` |
| Note block | `User(note.owner_user_id)` |
| Media | `User(requesting_user_id)` |
| Podcast | `User(requesting_user_id)` |
| Contributor | `User(requesting_user_id)` |

Audience is never supplied by the client. Requester/billing identity, collection
viewer, audience identity, and citation-edge owner are separate typed facts.

`DossierSubjectLocator` is:

```text
DossierSubjectLocator =
  | Resource {
      ref: ResourceRef<
        Media | Conversation | Library | Podcast | Page | NoteBlock
      >
    }
  | Contributor { handle: ContributorHandle }
```

The Resource variant cannot carry `contributor`; Contributor handles resolve and
authorize server-side without exposing a private Contributor id.

### Owners

`DossierDefinition` is one value, not a one-entry registry. It owns:

- generated-output and citation contracts;
- generic build/revision lifecycle;
- shared read/history/event schemas.

`SubjectPolicyRegistry`, keyed by subject scheme, owns:

- locator resolution and 404-masked read/generate authorization;
- AudienceScope, collection viewer, requester/billing attribution, and
  citation-edge ownership;
- audience-visible source intersection;
- subject/audience deletion integration;
- canonical resource activation.

`DossierBindingRegistry`, keyed by subject scheme, owns:

- input collection and bounded reduction;
- prompt, operation/profile, reasoning, token/cost budget, and reduction plan;
- input-manifest, freshness, and coverage projection;
- generated schema and citation materialization;
- typed empty-input behavior.

Exactly seven bindings exist. The engine, routes, stream, jobs, resolver, and
history contain no subject-specific branch.

One job kind, `dossier_build`, dispatches through the binding registry.
Binding-owned operation policy is exact:

| Binding | LLM operation | Profile | Reasoning |
| --- | --- | --- | --- |
| Media | `dossier_media` | `balanced` | medium |
| Conversation | `dossier_conversation` | `balanced` | medium |
| Library | `dossier_library` | `balanced` | high |
| Podcast | `dossier_podcast` | `balanced` | high |
| Contributor | `dossier_contributor` | `balanced` | high |
| Page | `dossier_page` | `fast` | low |
| Note | `dossier_note` | `fast` | low |

Each binding also owns its concrete input/output/token/cost limits. The hard cut
updates `BackgroundLlmOperation`, `OPERATION_PROFILES`, job registry, worker
allowlists, configuration, and ledger checks as one closed union.

All seven Dossier operations use the same managed provider-transition posture.
A stable build/structural-path request fingerprint and provider reconciliation
metadata are mandatory. Unless a provider adapter explicitly declares and tests
idempotent dispatch or authoritative reconciliation, dispatch is treated as
non-idempotent: an `Uncertain` transition suspends for operator reconciliation
and never redispatches automatically. Profile choice does not alter this rule.

### Subject inputs

| Subject | Audience-scoped input |
| --- | --- |
| Media | Current MediaUnit and its exact evidence spans |
| Conversation | Every complete message on every branch, deduplicated shared prefixes, branch topology, and attached Context |
| Library | Direct entries; Podcast entries expand to Episodes; all Media intersect audience-visible Media |
| Podcast | Every audience-visible Episode and its current MediaUnit |
| Contributor | Canonical Contributor Works: all credited roles, audience-filtered, deduplicated by Media |
| Page | Ordered contained Note blocks plus current one-hop Connections |
| Note block | Exact current body/evidence plus current one-hop Connections |

Required new owners include an all-branch Conversation collector,
`resolve_contributor_media_ids`, and audience-visible Library/Podcast expansion.
These are new binding work, not thin reuse.

Page/Note collection uses `ConnectionFilters` with explicit allowed schemes and
excludes `artifact` and `artifact_revision` sources/targets. The graph write
policy is not treated as a read filter.

Before promotion, the binding produces a normalized validation witness outside
the head-lock transaction by re-resolving every manifest input and citation for
the AudienceScope. The terminal mutation then locks the head and cheaply
rechecks the authoritative database visibility/membership versions, topology
and content fingerprints, and citation-target existence represented by that
witness. No provider/network call or unbounded graph traversal runs inside the
transaction. When an owner lacks a version fence, its authoritative rows are
read inside the SERIALIZABLE mutation rather than weakening the recheck. Any
visibility, membership, fingerprint, or topology mismatch writes
`InputsChanged`; the paid output remains only in operational provenance and is
never published as a revision.

For Media aggregates, `MediaIntelligence.ensure_current_many`:

- accepts a deduplicated, already audience-filtered Media set;
- invokes one MediaIntelligence durable operation per
  `(media_id, current_content_fingerprint)`;
- runs with a binding-owned concurrency and budget limit, never an unbounded or
  sequential N-call loop;
- returns projections in deterministic subject order;
- returns a typed no-source failure before Dossier generation when no usable
  projection exists;
- records omitted/failed projections in binding-specific coverage.

A usable projection is audience-readable, `Ready`, current for the Media content
fingerprint, and supplies at least one audience-resolvable citation candidate.
A ready but claimless MediaUnit is not usable for Dossier generation.

### Citation contract

- Citation presence is mandatory: zero materialized citations fails the build.
- Generated citation indices are validated only against candidates offered by
  the binding.
- Every materialized target is re-resolved for the AudienceScope before
  success.
- Aggregate bindings cannot cite only their subject container. Page body claims
  cite the contained `note_block` or its owned evidence; Connections cite their
  exact target.
- A Note is an atomic body resource: it cites its owned evidence span when one
  exists, otherwise the exact Note body with an immutable citation snapshot.
  An empty Note with no connection returns `NoSourceMaterial`.
- Narrowness beyond that rule is guaranteed by candidate construction, not
  claimed as a universal ingress validator.
- Citation edges remain owned by `resource_graph`; revisions store no duplicate
  citation JSON.

Failure classification follows one precedence:

1. No usable citation candidate after collection and before provider dispatch:
   `NoSourceMaterial`.
2. A required Media Intelligence dependency reaches a modeled terminal failure
   while otherwise usable sources exist: `DependencyProjectionFailed`.
3. Subject/audience visibility, membership, topology, content, or a cited target
   changes between collection and terminal recheck: `InputsChanged`.
4. Inputs remain unchanged but generated markers, indices, targets, or
   materialized citations violate the offered contract:
   `CitationValidationFailed`.

The same event cannot select two codes. In particular, a previously valid cited
target becoming audience-invisible is `InputsChanged`, not
`CitationValidationFailed`.

### Media Intelligence owner

`media_summaries` and `media_claims` remain one media-canonical current
projection with `UNIQUE(media_id)`.

`MediaIntelligence` becomes the sole semantic owner:

- internal `get_current(media_id)`;
- no-LLM `current_content_fingerprint(media_id)`, including for not-ready Media;
- authorized single-media read for UI/agents;
- idempotent `ensure_current(media_id, requester)` by content fingerprint;
- bounded `ensure_current_many` for real aggregate bindings;
- batch projection reads for search/retrieval consumers.

Audience gates readability before resolving Media ids; it does not select or
key a different summary. Routes, agents, search, Synapse, citation enrichment,
and Dossier bindings stop reading the tables directly.

The MediaIntelligence durable operation serializes on
`(media_id, content_fingerprint)`, owns its replay/result state, and classifies
modeled projection failures separately from defects. Publication uses one
head-row fingerprint-gated update:
`UPDATE media_summaries ... WHERE media_id = :media_id AND
content_fingerprint = :captured_fingerprint`; zero affected rows means
reingestion/deletion won and the stale result cannot publish. Aggregate Dossier
work invokes Media Intelligence as an inline child durable operation or
reschedules the parent; it never enqueues child jobs and blocks the only worker
waiting for them.

## Data Contract

### `artifacts`

- stable head and nullable `current_revision_id`;
- `subject_scheme`, `subject_id`, `audience_scheme`, `audience_id`;
- unique resource-plus-audience identity;
- no domain-value database checks, polymorphic subject FK, or cascade.

### `artifact_builds`

- one generation attempt: artifact FK, requester, instruction,
  idempotency key, creation time;
- private UUID identity exposed only as a sealed, non-authorizing
  `ArtifactBuildHandle`;
- LLM/provider ledger attribution owner;
- active state derives from the absence of a revision, failure, or
  cancellation child;
- idempotency uniqueness moves here.

The sealed handle is required new boundary infrastructure: one owner defines
its validated wire type plus `seal_artifact_build`/`unseal_artifact_build`.
It is not authority. The legacy schema projection named `ArtifactBuildOut` is
deleted; new read contracts use `DossierBuildSummary` and
`DossierBuildExecution` so the domain build entity is not confused with the old
revision-status wrapper.

### Terminal children

- `artifact_revisions`: successful immutable content, unique non-null build FK,
  creator, typed input manifest, citation owner, provenance, and creation time;
- `artifact_build_failures`: modeled failure code/detail/support facts and time;
- `artifact_build_cancellations`: actor and time.

Every child has a unique build FK. Cross-child mutual exclusion is enforced by
the artifact-head mutation, not a database business constraint. Observing
multiple terminal children or multiple revisions for one build is a defect.

`citation_owner_user_id` is stable revision provenance:

- new User-audience revision: that user;
- new Library-audience revision: the Library owner selected by SubjectPolicy;
- migrated revision: the historical `artifacts.user_id`, exactly matching its
  existing citation edges.

Requester, revision creator, and cancellation actor are nullable attribution
FKs. Explicit User teardown nulls them on surviving shared-Library history and
the UI renders “Deleted user.” `citation_owner_user_id` is non-null because it
is graph ownership, not display attribution. Before deleting such a user,
surviving Library history rehomes its citation edges and revision owner to the
Library’s current owner. A Library owner must transfer or delete the Library
before that User becomes unobservable.

### `artifact_build_events`

- build-keyed replacement for `artifact_revision_events`;
- strict payloads with `extra='forbid'`;
- event types `Started`, `Progress`, `Delta`, `Succeeded`, `Failed`,
  `Cancelled`;
- `Succeeded` identifies its revision; other terminal payloads carry only their
  owned facts;
- each append is one replayable mutation whose committed sequence/result is
  memoized at its managed structural path;
- sequence allocation and insert occur together while holding the artifact-head
  lock, preventing both writer collisions and crash-replay duplicates;
- notification trigger and listener use one `artifact_build_events` channel.

Payloads are exact:

| Event | Payload |
| --- | --- |
| `Started` | build handle, artifact ref, subject locator |
| `Progress` | owned progress phase and user-facing message |
| `Delta` | appended text |
| `Succeeded` | artifact revision ref |
| `Failed` | `DossierBuildFailureCode`, detail/support `Presence` |
| `Cancelled` | cancellation actor and time |

`run_kit` replaces its ArtifactRevision arm with ArtifactBuild. It derives build
terminal state from terminal children; it never reads a nonexistent build
status column.

Persisted build events remain the domain event union above. The stream transport
may additionally emit a typed, unsequenced `ExecutionAdvisory` carrying
`Queued | Running | Recovering | Suspended`, derived from queue/coordination
state. It is not an `artifact_build_failure`, does not advance the persisted
event cursor, and cannot make a second Generate legal.

## Build Lifecycle And Concurrency

The artifact head row is the sole database-domain serialization point.

First-head creation is one replayable SERIALIZABLE mutation: select the
resource-plus-audience key, explicitly insert on absence, retry a
serialization/unique conflict, then lock the winning head. Create-build, every
event append, success, modeled failure, cancellation, Make current, and cleanup
lock that head. Build-row locks may narrow local reads but are never a second
authority.

Database serialization and coordination linearization are distinct. The
durable-operation conflict key is exactly the individual `artifact_build_id`
(one generation attempt), never the artifact-head key. The build is also the
replay identity. Cancelling build A therefore permits build B immediately even
if A's coordination lease remains contained; every late A step fails the
terminal/head/lease recheck.

Rules:

1. Same artifact and same idempotency key returns the original build.
2. A different key while a build is active returns
   `DossierGenerationInProgress`.
3. First committed terminal child wins.
4. Repeating the winning terminal mutation is an idempotent no-op.
5. An internal later competing terminal mutation returns the existing outcome;
   it is not a defect.
6. Persisted conflicting terminal children are a defect.
7. Success first selects all terminal children under the head lock. If one
   exists it returns that outcome. Otherwise it applies the cheap validation
   witness recheck, inserts revision and citations, appends `Succeeded`, and
   repoints current atomically.
8. Cancel and modeled failure have the same select-existing-child symmetry
   under the head lock; absent an existing outcome, each atomically inserts its
   child and event.
9. Make current locks the same head, authorizes the revision, recomputes
   freshness, and repoints the head without mutating the revision.
10. Cleanup wins by deleting/invalidating the locked head/build before a late
    worker can promote.

### Durable execution and liveness

`DossierBuildFailureCode` is closed: `NoSourceMaterial`, `InputsChanged`,
`DependencyProjectionFailed`, `EntitlementDenied`, `BudgetExceeded`,
`ContextTooLarge`, `ProviderRefused`, `ProviderIncomplete`,
`SchemaRepairExhausted`, `CitationValidationFailed`, and migration-only
`MigratedFailure`/`MigratedIncomplete`. Only these modeled outcomes become
`artifact_build_failures`. Unexpected exceptions, invariant violations,
persistent infrastructure/provider retry exhaustion, unknown provider
failures, and unreconciled uncertain dispatches are defects. No generic
Internal failure code exists.

`MigratedIncomplete` support has a closed reason:
`LegacyBuilding | LegacyZeroCitation`. The reason is support provenance, not a
second failure-code namespace.

The generic build job:

- receives and retains `JobExecutionContext`;
- verifies exact job, attempt, unexpired lease, visible subject/audience, and
  active build before every provider dispatch, checkpoint, event, and terminal
  mutation;
- uses only central retry policies;
- treats a successfully recorded Failed/Cancelled build as a successful queue
  execution;
- lets unexpected exceptions escape to queue retry/dead-letter handling.

The root durable operation uses the build as its stable replay identity.
Reduction traverses stable ordered node descriptors with managed iteration, so
the coordination runtime derives structural replay paths; domain code does not
author explicit step keys. Coordination replay state—not a duplicate Dossier
table—owns each provider step’s replay-stable generation identity, request
fingerprint, provider idempotency/reconciliation key, dispatch phase, and
normalized terminal result.

- `Prepared` may dispatch.
- `Completed` reuses its memoized outcome.
- `Uncertain` reconciles through a provider guarantee or an explicit operator
  transition that attaches a reconciled terminal outcome or proves
  `NotDispatched`.
- Without provider idempotency/reconciliation, `Uncertain` never
  auto-redispatches; it defects for operator reconciliation.

The operation commits `Prepared`, commits `Uncertain` immediately before the
network dispatch, and commits `Completed` with the normalized outcome after the
response. No network call occurs inside a database transaction.

The LLM ledger is billing/provenance, not replay memoization.

Lease expiry below the attempt budget yields `Recovering` and reclaims the same
job/build. Lease expiry alone is not `Suspended`. Retry exhaustion/dead-letter
coordination state yields the loud `Suspended` advisory and leaves the active
build as a suspended prefix; it does not synthesize Failed or unlock a second
Generate. The dead-letter hook is absent or diagnostic-only and the dead job is
never pruned. Requeue is valid after repairing code, data, or a dependency; an
`Uncertain` call first requires the operator transition above. User Cancel is
the explicit abandon/compensation that terminalizes the suspended build and
permits a later new Generate.

This avoids both permanent un-cancellable ownership and silent defect
softening, while never automatically repeating an uncertain billed call.

## Generic API

Subject route parameters decode once into `DossierSubjectLocator`. Audience
always comes from authentication.

```text
GET  /artifacts/dossiers/{subject_scheme}/{subject_handle}
POST /artifacts/dossiers/{subject_scheme}/{subject_handle}/builds
     Idempotency-Key: <required>
     { instruction: Presence<string> }

GET  /artifacts/{artifact_ref}/revisions
GET  /artifact-revisions/{artifact_revision_ref}
POST /artifact-revisions/{artifact_revision_ref}/make-current
POST /artifact-builds/{artifact_build_handle}/cancel

GET  /stream/artifact-builds/{artifact_build_handle}/events
GET  /media/{media_handle}/intelligence
```

`artifact` and `artifact_revision` retain their existing refs. A build is
attempt/coordination identity, not a ResourceRef. `ArtifactBuildHandle` is a
validated sealed outward value with one owning seal/unseal helper; it identifies
but never authorizes. Authenticated subject policy and the existing stream token
authorize cancel/read/stream access. The UUID remains internal and no build
`ResourceScheme` is added.

The head read returns:

- current revision;
- current freshness;
- active build with its queue/coordination-derived execution advisory;
- latest unsuccessful build;
- typed binding coverage and revision count;
- Media Abstract only for Media;
- no historical revision body.

Revision list/read owns history. Build stream resume uses the existing
last-event sequence contract against the new strict persisted build-event
schema; unsequenced execution advisories are fresh coordination projections and
are not replayed as domain events.

Expected API errors are a closed union including invalid subject locator,
not-found/unauthorized masking, generation in progress, invalid instruction,
revision not found, revision not owned by head, and build not active.
Asynchronously discovered `NoSourceMaterial` is a terminal failed build/event,
not a synchronous Generate error. Public Cancel returns the existing result
only when cancellation already won; a succeeded/failed build returns
`BuildNotActive`. Transport handlers validate/proxy only.

## Migration

One destructive maintenance cut performs a per-row transformation; there is no
runtime migration branch. It first stops/drains artifact API mutations and old
workers, removes legacy dossier/distillate/sweep jobs through the queue owner,
runs a read-only preflight census, the migration, and assertions, then deploys
only the new API and `dossier_build` worker. The census reports legacy revisions
by kind/status/citation count and specifically enumerates every `ready`
zero-citation revision; its counts must equal the transformation report.

### Head audience derivation

| Legacy kind | New AudienceScope |
| --- | --- |
| `library_dossier` | `Library(artifacts.subject_id)` |
| `conversation_distillate` | `User(conversations.owner_user_id)` |

The migration never renames `artifacts.user_id` into audience identity.
It backfills dependent requester/citation ownership first, rewrites both legacy
kinds into the table’s single Dossier meaning, drops `kind`, installs the
resource-plus-audience unique key, then drops `artifacts.user_id`.

Conversation Dossiers intentionally become owner-User audience artifacts.
Legacy shared readers lose distillate visibility; this is the approved
resource-plus-audience policy, not a migration omission.

### Revision-to-build mapping

Create a deterministic migration map from every legacy revision to one new
build. Every legacy status receives a parent build:

| Legacy revision | New rows |
| --- | --- |
| `ready` with at least one citation edge | build + preserved successful revision |
| `ready` with zero citation edges | build + `MigratedIncomplete` failure with `support.reason=LegacyZeroCitation`; no revision |
| `failed` | build + normalized `MigratedFailure` child |
| `building` | build + `MigratedIncomplete` failure with `support.reason=LegacyBuilding` |

Only citation-valid successful revisions keep their id, content,
creation/completion provenance, current-head pointer, citation source ref, and
citation edges. A zero-citation legacy success cannot satisfy the new revision
invariant: it does not become revision history, its current pointer is cleared,
and its mapped build records failure support containing the legacy revision id,
legacy status/completion time, and content SHA-256—not the legacy body. The
maintenance backup remains the audit source. No citation is fabricated and no
runtime grandfathering path exists. Other incomplete rows likewise do not
become revision history or fabricate cancellation.

Timestamp mapping is deterministic: build `created_at` keeps the legacy
revision start; successful/failed terminal time uses legacy `completed_at`;
legacy `promoted_at` is retained as immutable initial-promotion provenance.
`MigratedIncomplete` uses migration time as its failure time; any historical
completion time remains typed support provenance.

Move:

- `custom_instruction`, `idempotency_key`, and requester attribution from
  revision/head to build; historical `artifacts.user_id` is the requester;
- error facts to failure;
- successful content, creator, and generated provenance to revision; historical
  `artifacts.user_id` is the creator;
- the idempotency unique index to `(artifact_id, idempotency_key)` on builds.

A missing historical idempotency key becomes the deterministic migration-only
key `migrated:<legacy_revision_id>`; no nullable or compatibility form remains.

Backfill every preserved revision’s `citation_owner_user_id` from its historical
`artifacts.user_id`.

### Dependent data

- Re-key every revision event to its mapped build and translate each payload to
  the strict build-event union. Every mapped terminal child ends with exactly
  one matching terminal event; append `Failed` at the next sequence for a
  migrated failed/incomplete/zero-citation row when legacy history lacks it.
  For a zero-citation legacy success, replace its legacy ready/done terminal
  meaning with `Failed(MigratedIncomplete, LegacyZeroCitation)`; never emit
  `Succeeded`.
- Drop `notify_library_intelligence_revision_event()` explicitly. Rebuild the
  notification trigger/function/channel under the build-event owner; migration
  0174’s inherited library channel is not propagated.
- Reattribute every `llm_calls(owner_kind='artifact_revision')` row to
  `owner_kind='artifact_build'` and its mapped build id. Rewrite
  `library_dossier` to `dossier_library` and `conversation_distillate` to
  `dossier_conversation` in `llm_operation`.
- Transform `covered_targets` with exact per-kind adapters:
  - Library rows `{kind: media, id, fingerprint, coverage}` become
    `LibraryInputManifestV1.media[]` entries
    `{media_ref, content_fingerprint, disposition}`; `coverage=included` maps to
    `Included`, every other value maps to its typed omitted reason.
  - Conversation rows `{kind: conversation, id, active_leaf_message_id,
    message_count}` become `ConversationInputManifestV1` with the conversation
    ref, empty all-branch message/Context sets, absent topology fingerprint, and
    `completeness=Incomplete(MigratedCoverageGap)`. The old leaf/count are kept
    only in migration support provenance.
  Library and Conversation shapes are never treated as interchangeable.
- Preserve Library freshness only when its migrated manifest still compares
  equal. A migrated Conversation revision is deterministically Stale because
  the new binding requires every branch and Context, not the old active path.
- Preserve resource graph/source refs and current pointers only for preserved
  citation-valid revisions; zero-citation current pointers are cleared.
- Assert head, child, terminal-event, current-pointer, citation, and ledger
  counts before old columns/tables/jobs are removed.

Migration defects on an ambiguous head collision, missing subject/audience,
unmappable event/ledger row, citation-owner mismatch, a zero-citation row not
mapped exactly once to `MigratedIncomplete` with
`support.reason=LegacyZeroCitation`, a preserved successful revision with no
citation edge, a remaining current pointer to a non-successful revision, or any
classification/row-count mismatch.

### FK-safe cleanup order

After the subject/audience owner makes the primary resource unobservable and
memoizes its Dossier keys, cleanup locks each head and:

1. asks queue/coordination owners to revoke pending/running/dead jobs and replay
   state for its builds;
2. clears `current_revision_id`;
3. invokes resource-graph cleanup for every artifact/revision ref, preserving
   or deleting incident edges according to the graph’s citation-snapshot rules;
4. deletes build events;
5. deletes revisions, failure children, and cancellation children;
6. deletes builds;
7. deletes heads.

The LLM ledger remains under its independent audit/retention owner after a build
is deleted. No cascade or direct queue/coordination-table mutation is added. A
stale worker must fail its lease/head/build recheck and cannot promote after
cleanup. Dossier cleanup joins existing teardown/visibility-loss lanes; it adds
no Contributor, Podcast, or other subject-delete UI/API.

## Freshness, Coverage, And Reingestion

Each binding owns one typed input manifest and comparison function. Freshness
performs no LLM call.

Coverage is binding-specific, not one generic percentage:

- Media: offered evidence claims and omitted evidence;
- Conversation: included branches/messages/Context;
- Library: included/omitted Media with reason;
- Podcast: included/omitted Episodes with reason;
- Contributor: included/omitted Works with reason;
- Page: included blocks/connections;
- Note: included body/connections.

Reingestion changes the Media content fingerprint and makes affected Dossiers
Stale. Ordinal citation edges and snapshots intentionally outlive deleted
evidence spans; historical Dossiers remain readable and target activation fails
closed. Preserving historical reader locators is out of scope.

## Search And Cross-System Composition

Search, Dawn Write, agents, Synapse, and citation enrichment stop interpreting
legacy artifact kinds or reading Media Intelligence tables directly.

- Library-audience Library Dossiers retain their current app/reference
  metadata exposure.
- Conversation Dossiers retain conversation-scoped generated-claim search.
- Media, Podcast, Contributor, Page, and Note Dossiers are not search results in
  this cutover.
- Every Dossier query constrains subject scheme and authorizes the derived
  AudienceScope.
- Search results activate the subject pane and open its Dossier tab through a
  workspace command, never `?distillate=1`.
- Resource activation for an `artifact` opens the subject’s current Dossier.
  Activation for an `artifact_revision` opens that exact historical revision
  through workspace-local `{ surface: Dossier, revision }` state.
- Media projection consumers use the MediaIntelligence single/batch interfaces.
- Inspector disclosure publishes only Companion. `ActionDescriptor` remains the
  shared general action model; Distill and Document Map disclosure descriptors
  are removed.

```text
Generate
  -> resolve typed subject + AudienceScope
  -> lock/get head and create one idempotent build
  -> enqueue one generic durable build job
  -> collect audience-visible binding inputs
  -> ensure `(media_id, fingerprint)` Media Intelligence dependencies
  -> reduce through binding-owned plan
  -> validate schema + nonempty materialized citations
  -> lock head and recheck build/lease/subject/audience/all manifest inputs
  -> atomically create revision + citations + Succeeded + current pointer
```

## Hard-Cut Inventory

### Delete

- `documentMapAction.tsx` and old disclosure-action tests.
- the misleading `resourceCapabilities.generated.ts` filename after its static
  mirror moves to `resourceCapabilities.ts`;
- `reader-tools`, `conversation-context`, and all old surface/group IDs and
  stored-state translators.
- Chat Context/Forks toolbar toggles and inline `ConversationDistillate*`.
- Distill action descriptors, `?distillate=1`, sweep, routes, jobs, profiles,
  schemas, fixtures, and vocabulary.
- Legacy reducers
  `services/artifacts/reducers/{__init__,library_dossier,conversation_distillate}.py`;
  the seven new bindings are not placed behind this reducer registry.
- Inline `LibraryBrief*`, Library Dossier hooks/types/query state, and
  feature-specific APIs.
- Inline Page/Note `ConnectionsSurface` mounts.
- Podcast Episodes secondary column, mobile drawer, overlay state/hooks/CSS,
  and their tests.
- `library_dossier_generate`, `conversation_distill`, `JOB_KIND_FOR_KIND`, and
  subject/kind branches in engine, worker, routing, resolver, stream, deletion,
  allowlists, and profiles.
- Legacy feature facades in `artifacts/dossier.py` and
  `artifacts/distillate.py`; recompose shared authorization/history currently
  housed in `artifacts/revisions.py`.
- Legacy BFF proxy trees
  `apps/web/src/app/api/libraries/[id]/intelligence/**`,
  `apps/web/src/app/api/conversations/[id]/{distill,distillate}/**`, and their
  tests; only generic Dossier BFF routes replace them.
- `POST /media/{id}/summarize` and feature callers that bypass
  MediaIntelligence; delete `MediaSummarizeOut`, its route contracts, and its
  route/service tests in favor of the Media Intelligence read/ensure contracts.
- Legacy `ArtifactBuildOut`; new schemas use `DossierBuildSummary` and
  `DossierBuildExecution`.
- `DISTILL_ENABLED`, `CONVERSATION_DISTILL_SCHEDULE_SECONDS`, their
  `config.py` fields/validation/docs, and legacy job literals in
  `deploy/env/env-prod-worker.example`, `deploy/hetzner/sync-env.sh`, and
  deployment documentation.
- Every assertion in `python/tests/test_cutover_negative_gates.py` or
  `apps/web/src/lib/ui/machineHandCutover.guards.test.ts` that opens, requires,
  allowlists, line-counts, or imports a deleted file. Rewrite each affected gate
  around the new owner; do not patch only the two originally named assertions.

### Adapt through the new owners

- artifact/distillate search retrievers, `projection.py`, and
  `searchViewModel.ts`;
- `dawn_write.py`;
- direct `media_summaries`/`media_claims` readers in search, agents, Synapse,
  citations, application search, and artifact reducers;
- the evidence-span/Synapse residue gates;
- `run_kit` ArtifactRevision stream support and strict frontend event decoder;
- `resource_items.capabilities`, inspect-resource policy, and parity tests;
- pane publications/store/schema, secondary shells/tabs, pane headers, and
  mobile top bar, including the single `resource-inspector` width policy and
  the complete icon/label registry;
- Document Map Contents/Evidence, Conversation Context/Forks, and
  `ConnectionsSurface`;
- citation graph and current-only activation.

### Residue gates

Runtime source/tests must contain none of:

- `library_dossier`, `conversation_distillate`, Distill actions/sweep/deep link;
- old artifact event table/channel/decoder or feature job kinds;
- `reader-tools`, `conversation-context`, Document Map disclosure action;
- `LibraryBrief`, `ConversationDistillate`, Podcast drawer/column owners;
- direct Media Intelligence table reads outside its storage owner, models, and
  migration;
- a runtime `artifacts.kind` discriminator or artifact-definition registry;
- subject branching in the generic engine;
- old feature routes or compatibility payloads.
- any source-reading gate that names a deleted legacy file;
- old deploy allowlists, distill feature flags, or environment examples.

Immutable historical migrations, including 0174, are excluded from runtime
residue gates. The new destructive migration and this specification are the
only new legacy-literal allowlist; migration history is never rewritten.

## Primary Files

| Owner | Files |
| --- | --- |
| Workspace | `paneSecondaryModel.ts`, `paneRouteModel.ts`, `panePublications.ts`, secondary shells/tabs/panels, mobile chrome/top bar |
| Capability | `resourceCapabilities.ts`, backend `resource_items/{capabilities,routing}.py`, parity tests |
| Inspector/Dossier UI | `components/{resource-inspector,dossier}/*`, `lib/dossiers/*`, event decoder/generation adapter |
| Pane bodies | Seven eligible routes, `ConnectionsSurface.tsx`, existing Contents/Evidence/Context/Forks owners |
| Artifact backend | `services/artifacts/engine.py`, `services/artifacts/bindings/base.py`, Dossier definition, policy/binding registries, seven bindings, schemas/routes/BFFs |
| Runtime | `media_intelligence.py`, `run_kit.py`, LLM execution/ledger/profiles, jobs registry/queue/worker/tasks, `config.py` |
| Graph/consumers | resource-graph citations/resolve/cleanup; search, Dawn Write, agents, Synapse |
| Deploy/gates | `deploy/hetzner/sync-env.sh`, `deploy/env/env-prod-worker.example`, source-reading negative gates |
| Data/docs | `db/models.py`, one Alembic migration including the old notify-function drop, architecture/modules, superseded/current-only/capability docs |

## Implementation Order

No partial state ships.

1. Write red migration/schema and lifecycle/concurrency tests.
2. Land schema transformation, exact backfill, strict build events, durable
   execution, registries, generic API, history, routing, and cleanup.
3. Implement seven bindings and the MediaIntelligence public/batch owner.
4. Land capability projection, Resource Inspector model/action, stable Dossier
   controller/surface, and Media Abstract.
5. Recompose all seven panes and move Podcast Episodes inline.
6. Adapt search/cross-system consumers; delete every legacy path and rewrite
   residue gates/docs.
7. Run focused static, migration, integration, component, and real-stack E2E
   gates.

## Acceptance Criteria

### Product and composition

- [x] Exactly seven subjects, one `resource-inspector` group, and the six
      declared surface IDs exist; capability mirror/backend parity is exact.
- [x] Every pane exposes one Companion in the same desktop/mobile position,
      survives 390px geometry, satisfies the disclosure/tab ARIA contract, and
      restores focus on every close path; the declared labels/icons and sole
      `360/280/720px` width policy are exact.
- [x] Desktop/mobile consume one publication; `SecondaryPaneShell` is the only
      desktop presenter; no feature-owned drawer/column or token-driven
      publication/primary-pane rerender remains.
- [x] Podcast Episodes and Author Works are inline; Library/Conversation/Page/
      Note have no inline dossier/distillate/connections; Conversation always
      publishes Context, Forks, Dossier.
- [x] Media always publishes typed Evidence and Dossier even when reader content
      is processing, failed, or empty; every default order terminates in Dossier.
- [x] Tab switches preserve historical selection and losable Connections
      drafts; close/reopen alone resets selection. Subject/capability changes
      reconcile stale surfaces during render with no closed-frame flash.

### Dossier and Media Intelligence

- [x] One accessible surface covers never-generated/loading/reconnecting/
      building/suspended/current/stale/historical/regenerating/failed/cancelled
      and all Generate/Regenerate/Cancel/Retry/Make-current/history/citation
      actions.
- [x] Every successful revision has a typed immutable manifest and at least one
      audience-readable citation; aggregate self-citations and recursive
      Page/Note ingestion fail; atomic Note snapshots follow the declared rule.
- [x] Media shows its grounded Abstract; one
      `(media_id, content_fingerprint)` produces at most one interpretation;
      aggregate dependency work is bounded/deduplicated with typed coverage.
- [x] Binding freshness and coverage are deterministic and make no LLM call.
- [x] Failure precedence is deterministic; claimless Media projections are not
      usable; Media fingerprint reads and publish fencing invoke no extra LLM.

### Lifecycle and API

- [x] Concurrent first/later Generate creates one head/active build and replays
      one Idempotency-Key result; every mutation serializes on that head.
- [x] The artifact head is the sole database lock row; `artifact_build_id` is
      the sole durable-operation conflict/replay key, so Cancel permits an
      immediate new build without an old coordination lease blocking it.
- [x] First terminal wins gracefully; persisted conflicts defect; event
      sequence/append replay cannot collide or duplicate.
- [x] Reload resumes; stale lease or changed input cannot promote; completed
      provider steps do not repeat; Uncertain calls never auto-redispatch.
- [x] Dead letters remain operator-repairable/user-cancellable and cannot be
      bypassed by a second Generate; head read and stream expose `Suspended`
      without synthesizing a failure.
- [x] Arrows are view-only; Make current atomically authorizes/repoints and
      recomputes freshness.
- [x] Subject/audience/User teardown follows the specified queue, graph,
      attribution, citation-owner, and FK-safe rules; no late worker recreates
      state.

### Migration and hard cut

- [x] Migration tests cover all legacy statuses, owner/audience divergence,
      zero/one/many citations, current and non-current zero-citation rows,
      events/channel/function, exact per-kind manifests, pointers, idempotency,
      and ledgers.
- [x] Exact audience/citation-owner derivations hold; every legacy revision maps
      to one build; every preserved successful revision has one unique build FK;
      every zero-citation success maps once to
      `MigratedIncomplete` with `support.reason=LegacyZeroCitation` and no
      revision.
- [x] Citation-valid successful history remains navigable; invalid current
      pointers are cleared; the preflight census equals transformation counts;
      `artifacts` has one row meaning and no `kind`; build events notify end to
      end.
- [x] No runtime legacy literal/file/route/API/job/surface/inline placement/
      compatibility path survives.
- [x] Source-reading gates are rewritten wholesale and no deleted reducer,
      facade, BFF, schema, deploy allowlist, environment flag, or file path is
      referenced by runtime source or tests.
- [x] Component, integration, migration/schema, and real-stack E2E tests cover
      the public/ARIA/race/reconnect/citation/history/mobile contracts; current
      architecture/module docs describe only the final system.

## Verification

- Migration/schema: 27 focused migration cases pass; the real-stack journey
  also applies the complete migration chain through `0190` on a clean database.
- Backend: 81 core Dossier owner cases, 20 authorization/read cases, 13
  teardown/concurrency cases, and 197 hard-cut residue gates pass.
- Frontend: TypeScript and changed-file ESLint pass; 66 focused unit and 141
  focused browser cases pass.
- Real stack: the exact Resource Inspector Playwright journey passes in Chromium
  with auth setup, all seven resources, streaming reconnect/cancel, history,
  citation activation, and 390px mobile coverage.

## Final State

There is one resource-workbench grammar:

- primary pane = resource;
- Companion = Resource Inspector;
- projection = current reusable machine interpretation;
- Dossier = manual, cited, resource-plus-audience durable work product;
- artifact head = sole database-domain mutation serialization owner;
- artifact build = one attempt, coordination conflict key, and replay identity;
- subject variation = typed policy and Dossier binding;
- workspace = sole desktop/mobile secondary presentation owner.
