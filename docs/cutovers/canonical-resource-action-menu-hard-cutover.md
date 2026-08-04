# Canonical Resource Action Menu Hard Cutover

**Status:** APPROVED SPEC · 2026-08-03

**Type:** Coordinated hard cut. No feature flag, compatibility path, fallback,
dual publication, or partial migration.

**Supersedes:** The projection, thin/rich, caller-published resource groups,
context/view mixing, and action-free resource-row portions of
`universal-resource-actions-hard-cutover.md` and narrower surface specs.
Existing command ownership and non-resource menu rules remain authoritative.

**Open questions:** None. The defaults in this document are final.

## Decision

For the same canonical resource, viewer, server facts revision, and client
capability environment, every standing resource dropdown publishes the exact
same semantic actions: ids, copy, icons, grouping, order, tone, current verbs,
availability, confirmation, and effects.

Surface, route, projection, pane/list placement, DTO richness, callback
presence, responsive breakpoint, and promoted-primary status are not policy
inputs.

```text
static scheme capability ─┐
server action snapshot ───┼─> pure resource action planner
client action environment ┤              |
global keyed busy state ──┘              v
                                immutable action plan
                                          |
                         ResourceActionMenu / header / Nexus
                                          |
                              shared action runtime
                                          |
                               owning domain command
```

## Target Behaviour

- The resource dropdown is identical in panes, Nexus, Author, Podcast,
  Library, Browse, search, Lectern, context cards, Connections, Evidence,
  player resource representations, and desktop/mobile presentations.
- `Open` remains in the menu when promoted or already open. It opens or focuses
  the canonical representation; invoking it in that representation is safe.
- Header promotion never removes an action from the dropdown.
- Temporarily blocked or busy actions remain visible and `aria-disabled` with a
  reason. Unsupported or viewer-ineligible actions are omitted everywhere.
- Relationship state machines publish exactly one current verb, such as Add to
  Lectern or Remove from Lectern.
- Menu order is static. Usage, surface, AI, recency, and telemetry never reorder
  it.
- Opening a menu performs no network request. Standing surfaces prefetch their
  snapshots in a deduplicated batch; the trigger is unavailable until the
  canonical snapshot exists.
- A mutation updates busy state in every simultaneous representation, awaits
  canonical snapshot reconciliation, then clears busy state.

## Goals

- One owner for resource-action membership, presentation, execution, and state.
- Make surface-specific divergence unrepresentable.
- Centralize existing user-visible actions; do not invent new effects.
- Preserve domain authorization and mutation ownership.
- Reuse `ActionMenu`, resource identity/activation, resource capabilities,
  existing API clients, and existing domain services.
- Remove private action registries, callback-gated policy, duplicate adapters,
  and dead publication machinery.
- Achieve strict parity without menu-open hydration or N+1 reads.

## Governing Standards

- `cleanliness.md`: one concern, state derivation, and capability owner; delete
  duplication, legacy paths, dead code, and broad public surfaces.
- `simplicity.md`: one primary capability form; no speculative framework.
- `boundaries.md` and `frontend.md`: decode once, preserve rich typed facts,
  derive UI state, and map expected errors at the owning boundary.
- `tagged-unions.md`: couple each state with exactly the fields legal for it.
- `naming.md`: global action IDs are stable dot-delimited PascalCase.
- `testing.md` and `local-rules/testing-standards.md`: red/green tests assert
  observable behavior through public owners and the real stack.

## Scope

Included:

- Every persistent overflow/options affordance whose target is a canonical
  `ResourceRef`.
- Menu, promoted-header, Nexus/action-panel, shortcut, and mobile projections
  of those same semantic resource actions.
- Static capability generation, dynamic action snapshots, client device facts,
  global busy state, execution dispatch, invalidation, and parity proofs.
- Moving context-edge, pane, list, and playback-session commands to their
  truthful owners.

Excluded:

- Account, filter, picker, batch, selection, highlight, PDF-tool, editor,
  citation-chip, and other non-resource menus.
- Plain links and primary row activation.
- Transient generated resources without a direct stable `ResourceRef`.

## Action Taxonomy

The canonical resource menu contains only actions whose target is the resource:

1. **Core:** Open, Share, Chat.
2. **Operations:** source/lifecycle operations, offline state, metadata/authors,
   read/played state, settings, refresh of the resource itself, and canonical
   deletion/removal.
3. **Global relationships:** Libraries, Lectern membership, subscription state.

`danger` is an orthogonal consequence class. Danger actions form the final
group. The planner owns relative order and separators.

These commands are not resource actions and leave the resource menu:

- **Context edge:** remove from conversation context, unlink this edge, dismiss
  this synapse.
- **Pane/view/list:** refresh the current query, reorder, companion navigation,
  transcript/notes visibility, theme, and local expansion.
- **Playback session:** Play next and current queue/session controls.

They use separately labelled controls or menus. Mobile must not merge them back
into the resource dropdown.

## Ownership and Structure

| Concern | Sole owner |
|---|---|
| Static per-scheme possibility | `services/resource_items/capabilities.py` |
| Generated browser static projection | Generated `resourceCapabilities.ts` |
| Viewer/resource eligibility and relationship state | `services/resource_items/action_snapshots.py` |
| Device-local facts | Existing offline/connectivity/platform owners |
| Busy state, execution, reconciliation | Authenticated app resource-action runtime |
| IDs, copy, icons, tone, confirmation, order | `RESOURCE_ACTION_CATALOG` |
| Membership and semantic plan | Pure `resolveResourceActionPlan` |
| Accessible dropdown | `ResourceActionMenu` over `ActionMenu` |
| Authorization and effects | Existing owning domain command/service |

The snapshot service is a read aggregator. It calls public read APIs from domain
owners and performs no cross-domain mutation. Commands continue to reauthorize
inside their owning transaction; snapshots are never mutation authority.

## Capability Contract

Applicability has four distinct layers:

1. **Statically unsupported:** absent for the scheme.
2. **Viewer-ineligible:** absent from the server snapshot.
3. **Eligible but blocked:** present with one structured blocked reason.
4. **Eligible and available:** present and invokable.

The server returns a closed union of semantic facts, not UI descriptors:

```ts
type ServerActionAvailabilityOut =
  | { kind: "Available" }
  | {
      kind: "Blocked";
      reason:
        | "Locked"
        | "Processing"
        | "TemporarilyUnavailable";
    };

interface EligibleCapabilityOut {
  readonly availability: ServerActionAvailabilityOut;
}

type ResourceActionCapabilityOut =
  | (EligibleCapabilityOut & { kind: "Open" | "Share" | "Chat" })
  | (EligibleCapabilityOut & { kind: "OpenSource"; href: string })
  | (EligibleCapabilityOut & {
      kind:
        | "RetryProcessing"
        | "RefreshSource"
        | "RetryMetadata"
        | "EditAuthors"
        | "ResetProgress"
        | "LibrarySettings"
        | "DeleteLibrary"
        | "PodcastSettings"
        | "RefreshPodcast"
        | "DeleteConversation"
        | "RemoveMedia"
        | "LibraryPlacement";
    })
  | (EligibleCapabilityOut & {
      kind: "Consumption";
      state: "Unread" | "InProgress" | "Finished";
    })
  | (EligibleCapabilityOut & {
      kind: "EpisodeConsumption";
      state: "Unplayed" | "Played";
    })
  | (EligibleCapabilityOut & {
      kind: "PodcastSubscription";
      state: "Subscribed" | "Unsubscribed";
    })
  | (EligibleCapabilityOut & {
      kind: "LecternMembership";
      state: "Absent" | "Present";
      lecternItemId?: string;
    });
```

The implementation inventory must add any extant canonical resource operation
missing from this union before migration. No generic action name, arbitrary
payload, handler URL, or untyped metadata bag is allowed.

`PodcastSubscription.Unsubscribed` projects a Subscribe action that reuses the
existing acquisition flow; `Subscribed` projects Unsubscribe. This adds no new
acquisition semantics.

Device-local offline actions are composed from one client-wide contract:

```ts
interface ResourceActionEnvironment {
  readonly platform: "Web" | "Android";
  readonly connectivity: "Online" | "Offline";
  readonly offlineMediaByRef: ReadonlyMap<CanonicalResourceRef, LocalAvailability>;
}
```

Every surface reads the same environment instance. Device facts never arrive
through presenter callbacks. The planner derives offline Download, Cancel,
Retry, and Remove actions plus client-only `RequiresOnline`, `DeviceUnsupported`,
and `Busy` blocked reasons from this environment and the app runtime. They are
forbidden from the server snapshot.

## API Design

Add one authenticated batch endpoint:

```http
POST /resource-items/action-snapshots/resolve
```

```json
{
  "refs": ["media:00000000-0000-0000-0000-000000000000"]
}
```

Rules:

- `refs` contains 1–100 unique canonical refs. Invalid refs or duplicates are
  `E_INVALID_REQUEST`.
- Response order equals request order. A missing resource returns a strict
  missing snapshot with no capabilities; it is not silently dropped.
- Authorization is derived only from the authenticated viewer.
- Resolution is set-based and bounded. No per-ref service loop may issue
  database queries.
- `factsRevision` is the SHA-256 of the canonical serialized snapshot fields
  other than itself. It is opaque, deterministic, not persisted, and changes
  whenever the emitted server capability plan can change.

```ts
interface ResourceActionSnapshotOut {
  readonly ref: CanonicalResourceRef;
  readonly activation: ResourceActivationOut;
  readonly missing: boolean;
  readonly factsRevision: string;
  readonly capabilities: readonly ResourceActionCapabilityOut[];
}

interface ResourceActionSnapshotResolveResponse {
  readonly snapshots: readonly ResourceActionSnapshotOut[];
}
```

Labels, icons, order, separators, confirmation copy, mutation URLs, executors,
and busy state are forbidden from this API.

## Frontend Composition

`resolveResourceActionPlan(snapshot, environment, busyIds)` is total and pure.
It validates duplicate capability kinds, maps every union variant exhaustively
to the catalog, emits exactly one verb for each state machine, and returns:

```ts
interface ResourceActionPlan {
  readonly core: readonly SemanticResourceAction[];
  readonly operations: readonly SemanticResourceAction[];
  readonly relationships: readonly SemanticResourceAction[];
}
```

The composer defects on duplicate action IDs, strips caller separators,
preserves catalog order, emits core → operations → relationships, and moves all
danger actions to one final group.

The app runtime owns:

- Deduplicated batch registration/prefetch and snapshot cache.
- Global keyed busy state by `(resourceRef, actionId)`.
- Exhaustive action dispatch to existing typed clients.
- Confirmation, expected-error feedback, auth handling, and defect propagation.
- Success invalidation of the resource and every affected relationship ref.
- Awaited snapshot refresh before busy state clears.

`ResourceActionMenu` accepts a validated target and only navigation, focus, and
feedback ports. It accepts no actions, groups, capability flags, callbacks,
projection, or surface identifier.

Nexus entries retain resource identity and primary activation, not a private
resource-action array. Nexus desktop/mobile and pane/list consumers invoke the
same planner, runtime, projector, and `ResourceActionMenu`.

## Rules

- One action fact, policy, state machine, and executor has one owner.
- Static capability is not viewer authorization. Snapshot eligibility is not
  command authorization.
- Surface code cannot add, omit, sort, rename, disable, or replace a resource
  action.
- Callback presence cannot determine applicability.
- Blocked reason codes map to frontend copy in one exhaustive owner.
- Busy actions remain keyboard discoverable and cannot execute.
- Stable action IDs remain dot-delimited PascalCase.
- Trusted identity or snapshot contradictions defect; no downgrade or fallback.
- Use existing resource transport/cache and domain clients. Do not introduce a
  parallel fetching, error, notification, or mutation framework.
- Tests assert observable menus and outcomes through public owners, not wiring.

## Hard-Cut Final State

- `ResourceActionProjection`, caller-published resource groups, rich-option
  callback capabilities, and surface-local resource busy stores do not exist.
- `CollectionRow`, `PaneShell`, Nexus, Browse, players, and specialist surfaces
  render the canonical component or a catalog projection of the same plan.
- `ActionMenu` remains the only dropdown primitive.
- Context/view/session actions have separate typed publication contracts.
- No standing canonical resource representation is action-free.
- No lower-kebab, player-local, Nexus-local, or duplicated semantic resource
  action ID remains.
- Backend static capabilities and the committed generated browser projection
  are freshness-checked by the repository verification command.

## Files

Add:

- `python/nexus/schemas/resource_action_snapshots.py`
- `python/nexus/services/resource_items/action_snapshots.py`
- `apps/web/src/lib/actions/resourceActionSnapshot.ts`
- `apps/web/src/lib/actions/resourceActionRuntime.tsx`
- `apps/web/src/components/resources/ResourceActionMenu.tsx`
- Focused pure/service/component tests and
  `apps/web/e2e/journeys/resource-action-parity.journey.spec.ts`

Update:

- `python/nexus/api/routes/resource_items.py`
- `python/nexus/services/resource_items/capabilities.py`
- Capability generation/check ownership and generated
  `apps/web/src/lib/resources/resourceCapabilities.ts`
- `apps/web/src/lib/actions/{resourceActions,resourceActionExecution}.ts`
- `CollectionRow`, `PaneShell`, SurfaceHeader/mobile pane chrome, Nexus desktop
  and mobile, Author, Podcast, Library, Browse/preview/search, Lectern, context
  refs, Connections, Evidence, and resource-bearing player surfaces.
- `testdata/proofs.json` and the living workspace/library/podcast/overlay docs.
- Existing cutovers only to mark the exact superseded clauses.

Delete after migration:

- `buildResourceNexusActions` and duplicate `NexusAction → ActionDescriptor`
  resource adapters.
- `ResourceActionProjection` and `Representation`/`CurrentPane` menu branches.
- `ResourceMenuGroups`, `emptyResourceMenuGroups`, and resource
  `ActionPublication` caller groups; retain an explicitly non-resource menu
  publication if still needed.
- Surface-local resource option builders/callback contracts, ad hoc `queue-add`,
  duplicated player Open/Open source actions, and dead tests/docs/imports.

Do not add barrels, re-exports, compatibility modules, aliases, or migrations.

## Implementation Order

1. Freeze the complete inventory and write failing parity, API, planner,
   accessibility, mutation, performance, and residue proofs.
2. Add generated static-capability freshness checking.
3. Add the closed snapshot schema, set-based service, endpoint, and decoder.
4. Add the planner, app runtime, cache/prefetch, and canonical component.
5. Separate context/view/session controls.
6. Migrate every standing resource surface in one coordinated cutover.
7. Delete all superseded paths and update living/superseded docs.
8. Run focused static, unit, service, component, real-stack E2E, generation, and
   residue gates. No transitional state lands.

## Acceptance Criteria

- **AC1 — Exact parity.** The same parity key produces an identical dropdown on
  every included surface and breakpoint.
- **AC2 — Surface independence.** Planner and snapshot inputs contain no
  surface, route, projection, DTO-richness, or callback-presence fact.
- **AC3 — Closed contracts.** Snapshot, environment, plan, and dispatch are
  exhaustive typed unions with no arbitrary metadata or generic command path.
- **AC4 — Correct taxonomy.** Context-edge, pane/list/view, and playback-session
  commands are absent from the resource menu and remain available through their
  own owners.
- **AC5 — Stable presentation.** Catalog alone owns IDs, copy, icon, tone,
  confirmation, reason copy, and deterministic order; danger is last.
- **AC6 — Promotion parity.** Open and every promoted action remain in the
  dropdown and share behavior with their promoted projection.
- **AC7 — Global state.** Busy, blocked, relationship, offline, and post-mutation
  state agree across simultaneous representations.
- **AC8 — Authoritative effects.** Every mutation reauthorizes and executes in
  its existing domain owner; stale snapshots grant no authority.
- **AC9 — Bounded reads.** Snapshot resolution is batched/set-based; opening a
  menu causes zero requests and collections cause no N+1 queries.
- **AC10 — Accessibility.** Existing `ActionMenu` keyboard, focus, portal,
  dismissal, ARIA, and unavailable-reason behavior is preserved.
- **AC11 — Generated parity.** Backend static capabilities and the committed
  browser projection cannot drift without a verification failure.
- **AC12 — Real-stack proof.** One seeded resource is compared and representative
  commands are invoked across Nexus, row, pane, Browse, and specialist surfaces
  on desktop/mobile.
- **AC13 — Strict residue.** Automated gates reject local resource action IDs,
  option arrays, projection branches, duplicate adapters, `queue-add`, and old
  publication/callback types.
- **AC14 — Hard cut.** No feature flag, fallback, compatibility alias, dual path,
  dead code, or stale normative documentation survives.

## Non-Goals

- No database-backed action registry, server-defined UI menu, generalized
  command bus, plugin system, or arbitrary automation framework.
- No rewrite of domain commands, persistence, authorization, durable jobs, or
  relationship ownership.
- No database migration.
- No personalization, adaptive ranking, AI reordering, submenu system, global
  undo, analytics UI, or visual redesign.
- No universalization of non-resource dropdowns.
- No full DTO hydration, per-row request, or request-on-menu-open fallback.
- No legacy behavior retained for narrower surface specs.
