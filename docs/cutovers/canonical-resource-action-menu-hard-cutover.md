# Exhaustive Canonical Resource Actions Hard Cutover

**Status:** IMPLEMENTED + VERIFIED · 2026-08-05

**Type:** Coordinated hard cut. No flag, dual path, fallback, alias,
compatibility decoder, or partial migration.

**Supersedes:** Every earlier revision of this document; the resource-action
policy/surface clauses in `universal-resource-actions-hard-cutover.md`,
`library-placement-resource-action-hard-cutover.md`, and narrower surface specs.
Existing domain command ownership remains authoritative.

**Open questions:** None. The requested invariant is precise; these defaults are
final.

## Decision

For one canonical action subject, viewer, authoritative shared facts, and
authoritative client facts, every representation receives one identical,
complete, ordered semantic action plan.

Equality includes IDs, current labels, icons, groups, order, control state,
availability/reason, tone, confirmation, and typed effect. Only trigger and
container geometry may differ. Different per-device offline state may change a
stable action's state; platform, breakpoint, and location never change
structural membership or order.

This covers rows, cards, Search, acquired Browse results, Library/Libraries,
Lectern, Chat/Chats, Podcast/Podcasts, Author/Authors, context/evidence/
connections, players, Nexus/command palette, desktop, mobile, and the resource's
**desktop, primary-mobile, and secondary-mobile pane headers**.

Surface, route, occurrence, list, pane, header, player, DTO richness, callback
presence, and promoted-primary status are forbidden policy inputs.

Philosophy: the menu is a capability inspector, not surface decoration.
Location controls presentation, never policy. Omission means structurally
inapplicable; a constraint stays visible and explains itself.

## Target Behaviour

- Every applicable resource action is reachable from every standing
  representation.
- At minimum: Open, Open in new pane, Share, Chat, Edit, Libraries, Lectern,
  Play/Resume, Subscribe/Unsubscribe, Download, source/transcript operations,
  settings, export, and Delete/Remove wherever applicable.
- Open and Open in new pane remain in an already-open pane's header dropdown and
  after promotion to a primary control.
- Stateful capabilities have one stable ID; current facts select the verb,
  checked state, and reason.
- Blocked/busy actions remain discoverable and inert. Danger is last. Order is
  static, never surface-, usage-, AI-, recency-, or telemetry-ranked.
- Opening an already-mounted menu performs no request. Mutations update all
  mounted representations together.

## Goals

- One owner each for subject identity, applicability, presentation, execution,
  and reconciliation.
- Exhaust every existing user-reachable single-resource command and global
  resource relationship.
- Make surface divergence unrepresentable.
- Make Library and Lectern membership useful everywhere.
- Reuse existing refs, capabilities, snapshots, planner, menu, workspace,
  overlays, Library/Lectern owners, and domain commands.
- Delete duplicate builders, callback policy, local busy stores, neighboring
  resource ellipses, immortal cache state, and dead tests/docs.

## Governing Rules

All of `docs/rules` applies. Especially: [boundaries](../rules/boundaries.md),
[cleanliness](../rules/cleanliness.md), [simplicity](../rules/simplicity.md),
[frontend](../rules/frontend.md), [keys/identities](../rules/keys-and-identities.md),
[control flow](../rules/control-flow.md), [concurrency](../rules/concurrency.md),
[mutation ordering](../rules/mutation-ordering.md), and
[testing](../rules/testing.md).

## Scope and Taxonomy

| Subject | Canonical treatment |
|---|---|
| Resource | Open, edit, share, chat, consume, source/transcript, export, lifecycle |
| Global resource relationship | Libraries, Lectern, subscription, portable queue membership |
| One occurrence/edge | Named control for unlink, reorder, or remove this exact edge |
| Pane/view/session | Named control for sort, filter, theme, zoom, local visibility, volume, queue reorder |
| Selection/batch/account/picker/tool | Existing owning surface |

`Play next` is canonical when its operand is the resource and it works from any
representation; reordering one queue occurrence is not. Transcript provisioning
is canonical; showing the current pane's transcript is a view control. Removing
a Library relationship is always available inside `Libraries…`; a row-only
duplicate is unnecessary.

Every scheme gets an explicit policy branch—never a default "core-only" branch:

`media`, `library`, `evidence_span`, `content_chunk`, `highlight`, `page`,
`note_block`, `fragment`, `conversation`, `message`, `oracle_reading`,
`oracle_passage_anchor`, `artifact`, `artifact_revision`, `external_snapshot`,
`contributor`, `podcast`, `reader_apparatus_item`, `passage_anchor`.

Cover web article, EPUB, PDF, video, and podcast-episode Media. Do not fabricate
a `ResourceRef` for a non-resource singleton such as the Lectern container; its
collection commands keep a truthful owner, while every contained resource gets
the canonical resource plan.

Before implementation, freeze a reviewed command ledger: owner, truthful
subject, schemes/states, stable action ID or non-resource classification,
current-verb rule, authority/readiness, confirmation, and reconciliation scope.
It is a test oracle, not a second production registry. `Unclassified` blocks
completion.

## Subject Contract

Occurrence activation and action identity are separate:

```ts
interface ResourceActionSubject {
  readonly ref: CanonicalResourceRef;
}

interface ResourceBearingOccurrence {
  readonly activation: ResourceActivation; // row click / deep link
  readonly actionSubject: ResourceActionSubject; // dropdown identity
}
```

- The subject contains only its meaningful key. The snapshot owns canonical
  activation and missing state, so callers cannot vary Open behavior.
- A passage result may activate the passage while its menu targets the article.
  A card representing a Highlight targets the Highlight. Publishers decide;
  clients never infer from href/type or blindly prefer an owner.
- Search and other occurrence APIs publish `actionSubjectRef`. Browse
  `InNexus` publishes it. `Preview`/`ExternalOnly` get no fabricated canonical
  menu before acquisition.
- Presenters, Nexus, players, context cards, and pane publications carry only
  `actionSubject`, never resource actions, flags, activation overrides, or
  callbacks.
- Same-system subject/snapshot contradictions defect; no External/Open-only
  fallback exists.

## Architecture and Ownership

```text
static scheme policy + batched domain facts
                       |
                       v
subject ref ─> snapshot endpoint ─> retained cache
                                      |
                         shared client facts
                                      |
                                      v
                           pure planner + catalog
                                      |
                               immutable plan
                                      |
                    dropdown / pane header / Nexus / mobile
                                      |
                                typed runtime
                                      |
                            owning domain command
```

| Concern | Sole owner |
|---|---|
| Ref grammar/static possibility | `resource_graph/refs.py`, `resource_items/capabilities.py` |
| Viewer eligibility/shared state | Set-based domain reads composed by `resource_items/action_snapshots.py` |
| IDs/copy/icons/groups/order/tone/confirmation | `RESOURCE_ACTION_CATALOG` |
| Membership/current verb/final availability | Pure `resolveResourceActionPlan` |
| Prefetch/busy/dispatch/reconciliation | Authenticated resource-action runtime |
| Responsive UI | `ResourceActionMenu` over existing UI primitives |
| Authorization/effects | Existing owning domain command/service |

The snapshot service is read-only and calls public domain reads. Snapshots never
authorize mutations; commands reauthorize and linearize in their owner. Typed
effect adapters stay near existing clients. Root dispatch exhaustively matches a
closed intent union—no handler URL, command bus, plugin registry, remote config,
or metadata bag.

## Capability and API Contract

Retain and atomically hard-break the existing authenticated batch endpoint as
needed:

```http
POST /resource-items/action-snapshots/resolve
```

```ts
interface ResourceActionSnapshotOut {
  readonly ref: CanonicalResourceRef;
  readonly activation: ResourceActivationOut;
  readonly missing: boolean;
  readonly factsRevision: string;
  readonly capabilities: readonly ResourceActionCapabilityOut[];
}

type ServerAvailabilityOut =
  | { readonly kind: "Available" }
  | {
      readonly kind: "Blocked";
      readonly reason:
        | "PermissionDenied"
        | "Locked"
        | "Processing"
        | "TemporarilyUnavailable";
    };
```

`ResourceActionCapabilityOut` is a closed discriminated union. Simple variants
carry `{kind, availability}`. Stateful variants—Consumption, Subscription,
Lectern, Libraries, Queue, Transcript, Offline—carry only legal typed facts.
No generic name, payload, handler, or UI descriptor is allowed.

Contract rules:

- Request 1–100 unique canonical refs; return exactly one ordered snapshot per
  ref. Missing is explicit with no capabilities.
- Resolution is set-based/bounded; query count cannot scale per ref.
- Every scheme is exhaustively resolved. Any still-consumed generated browser
  projection is freshness-checked; delete an action-only mirror with no other
  consumer.
- Structurally inapplicable actions are absent. Applicable but forbidden or
  temporarily unavailable actions are blocked.
- Shared client facts add closed reasons `Loading`, `CapacityReached`,
  `RequiresOnline`, `UnsupportedOnDevice`, and `Busy`; platform cannot remove an
  applicable action.
- `factsRevision` changes with emitted shared facts. Unknown/contradictory owned
  variants defect in the strict decoder.
- The API forbids labels, icons, order, separators, confirmation copy, executor
  URLs/closures, and client busy state.

The planner returns immutable data, never closures:

```ts
interface PlannedResourceAction {
  readonly id: ResourceActionId;
  readonly presentation: ResourceActionPresentation;
  readonly control: ResourceActionControlState;
  readonly availability: ResourceActionAvailability;
  readonly confirmation: ResourceActionConfirmation;
  readonly intent: ResourceActionIntent;
}
```

Group order: Navigate → Consume → Organize → Create/Transform → Share/Export →
Manage → Danger. IDs are dot-delimited PascalCase and name the capability, not
its current verb: e.g. `RelationshipAction.LecternMembership`.

## Library and Lectern Contracts

`Libraries…` is one stable action for every placeable resource. It opens the
existing relationship editor; opening the resource menu never fetches
destinations.

```ts
interface LibraryPlacementOptionOut {
  readonly destination:
    | { readonly kind: "SavedInNexus" }
    | { readonly kind: "Library"; readonly library: LibraryIdentityOut };
  readonly relation:
    | { readonly kind: "Absent" }
    | { readonly kind: "Direct" }
    | {
        readonly kind: "Inherited";
        readonly provenance: readonly LibraryIdentityOut[];
      };
  readonly availability:
    | { readonly kind: "Available" }
    | {
        readonly kind: "Blocked";
        readonly reason:
          | "RequiresAdmin"
          | "RequiresSubscription"
          | "SystemManaged"
          | "Inherited";
      };
}
```

- Media gets a physical Default-backed `Saved in Nexus` toggle plus every
  visible named Library. Direct/inherited/read-only/system state shows
  provenance and reason; remove the query that excludes Default/system.
- The editor supports search and existing Create Library. All/Default-only users
  never see a dead empty chooser.
- Podcast presence in All is subscription, never a fake Default entry; named
  Podcast placement remains explicit.
- Placement removal is distinct from Remove download and Remove from Nexus.
  All writes use `library_entries` public commands.
- One stable LecternMembership action emits Add/Remove for eligible Media.
  Snapshot membership is authoritative; the shared Lectern environment adds
  readiness/capacity/busy only.
- Lectern loading/full/blocked states explain themselves; pre-ready invocation
  cannot defect. Existing add/remove commands remain the effect owner; reorder
  remains occurrence-owned.

## Runtime and UI Rules

- Mounted subjects retain one shared cache entry; unmount releases it. Last
  release evicts after in-flight work settles. Historical navigation cannot grow
  the cache forever.
- First registration batches in the existing scheduling tick; menu open causes
  zero requests. Cache state is Loading/Ready/Error/Reconciling. The trigger is
  always visible: Loading is disabled; Error exposes Retry.
- Per-ref generations prevent stale resolve wins. Busy identity is
  `(subjectRef, stableActionId)` globally.
- Effects return `None`, `Subjects(refs)`, or `AllRetained` reconciliation.
  Nonmutations use `None`; broad effects justify `AllRetained`, bounded to live
  subjects. Overlay mutations use the same typed completion path, not a global
  broadcast.
- Reconciliation is awaited. Failure preserves last good facts but keeps the
  affected action blocked with Retry; no stale inverse verb re-enables.
- `ResourceActionMenu` accepts only `actionSubject` plus trigger presentation.
  It accepts no actions, flags, callbacks, projection, surface ID, or activation.
- Collection rows, Nexus/Switchboard, players, specialist rows, `PaneShell`,
  `SurfaceHeader`, `MobilePaneBar`, and `MobileSecondaryPaneHost` consume the
  same plan. Pane bodies publish only their subject.
- Promotion never removes an entry. Desktop may anchor a panel and mobile use a
  sheet/full-screen panel; semantic content is unchanged. Flat actions use menu
  semantics; searchable content uses dialog/list semantics.
- One resource overflow exists per representation. Separate view/occurrence
  controls are explicitly named. Preserve focus, keyboard/typeahead, checked and
  disabled state, dismissal, scrolling, portals, and 44px mobile targets.

## Files and Hard-Cut Final State

| Area | Update |
|---|---|
| Backend core | `python/nexus/services/resource_graph/refs.py`; `resource_items/{capabilities,action_snapshots}.py`; snapshot schema/route; owning domain reads/commands |
| Subject boundaries | Search/Browse schemas and projections; frontend search/browse/collection/Nexus presenters; context/evidence/connection/player/pane DTOs |
| Client core | `resourceActionTarget.ts`; `lib/actions/resourceAction*`; `resourceActionExecution.ts`; `ResourceActionMenu.tsx`; `ActionMenu*`; `actionDescriptor.ts` |
| Relationship owners | Library placement overlay/editor/chooser, `libraryPlacement.ts`, `library_entries.py`, `LecternProvider.tsx` |
| Surfaces | `CollectionRow`; specialist rows; Nexus/Switchboard; players; `PaneShell`; `SurfaceHeader`; `MobilePaneBar`; `MobileSecondaryPaneHost`; pane publications |
| Proof/docs | Snapshot/planner/cache/component tests; lint/repository policy; `testdata/proofs.json`; living resource/workspace/Library/Lectern/podcast docs |

Replace `apps/web/e2e/journeys/resource-action-parity.journey.spec.ts` with an
exhaustive ubiquity journey and hand-authored product oracle.

Delete `resourceActionSnapshotInvalidation.ts`, unconditional `reresolveAll()`,
the duplicate catalog-projection hook, resource mutations duplicated in
`useDocumentActions.ts`, `episodeActionBusy.ts`, Highlight/player/podcast local
builders, and any emptied files. Excise all local resource IDs/arrays/flags/busy
stores/adapters, adjacent resource ellipses, action-free `InNexus` branches,
superseded tests/imports/styles/comments/docs, and delegation wrappers.

Final state: one subject contract, snapshot contract, catalog, planner, runtime,
and responsive renderer; all commands remain owned by their domains; no legacy
path, fallback, compatibility code, stale normative clause, or dead residue.

## Implementation and Proof Order

1. Baseline `./scripts/test confidence`; freeze the command ledger and write
   demonstrated-red parity, state, accessibility, performance, and residue
   proofs.
2. Hard-cut DTOs/presenters to `actionSubject`; remove caller activation policy.
3. Complete exhaustive capability/snapshot contracts, strict decoder, generated
   policy proof, catalog, and planner.
4. Complete Library and Lectern semantics; harden cache, stable busy identity,
   typed reconciliation, and effects.
5. Migrate every representation, including all three pane-header hosts; delete
   every superseded path and update docs in the same coordinated cut.
6. Run `./scripts/test changed` per wave, `./scripts/test pr` before merge, and
   `./scripts/test full` before completion. No transitional state lands.

Proof follows `docs/rules/testing.md`: pure planner/cache units; real-database
service/API state transitions and query-count proof; renderer component/a11y
behavior; real-stack cross-surface E2E. The expected menu is hand-authored and
never imports production catalog constants or mocks internal modules.

## Acceptance Criteria

- **AC1 — Exact parity.** One parity key yields one ordered semantic plan
  everywhere; only geometry differs.
- **AC2 — Complete coverage.** All named surfaces, all 19 schemes, five Media
  subtypes, and every command-ledger row are proven; none is unclassified.
- **AC3 — Complete actions.** The target-behaviour actions are present or proven
  structurally inapplicable. Promotion and an already-open pane never filter.
- **AC4 — Pane headers.** Desktop, primary-mobile, and secondary-mobile headers
  expose the complete plan.
- **AC5 — Correct identity.** Search passage and acquired Browse cases act on
  their explicit canonical subject without client guessing.
- **AC6 — Libraries.** Saved-in-Nexus and named-Library add/remove persist from
  representative surfaces; All, inherited/system provenance, authority, and
  Create Library are truthful.
- **AC7 — Lectern.** Add/remove works everywhere; loading/capacity/authority are
  visible blocked states and never pre-ready defects.
- **AC8 — State/resilience.** Simultaneous representations agree through busy,
  confirmation, success, failure, Retry, and reconciliation; stale resolves and
  stale inverse verbs cannot win.
- **AC9 — Authority/performance.** Commands reauthorize in their owner. Prefetch
  is batched/set-based, menu-open reads are zero, reconciliation is declared and
  bounded, and unmounted refs are evicted.
- **AC10 — Platform/accessibility.** Desktop/mobile retain structural parity;
  unsupported actions explain themselves. At 320px/390px, pointer/keyboard
  flows are reachable, scrollable, correctly named, and restore focus.
- **AC11 — Independent proof.** Tests assert public behavior with a product-owned
  oracle, real services at integration/E2E tiers, and no internal mocks.
- **AC12 — Strict residue/hard cut.** Policy gates reject local/surface policy,
  old cache/invalidation paths, duplicate resource menus, acquired rows without
  subjects, stale docs, flags, aliases, compatibility, fallback, and dead code.

## Non-Goals

- No database action registry, server-defined UI menu, generic command bus,
  plugin system, remote action config, automation framework, or execution API.
- No AI/adaptive ordering, personalization, analytics UI, macros, or global undo.
- No unrelated batch/selection/account/picker/editor-tool menu unification,
  broad restyle, persistence/auth/durable-job rewrite, or database migration
  unless the command census proves an existing required relationship needs one.
