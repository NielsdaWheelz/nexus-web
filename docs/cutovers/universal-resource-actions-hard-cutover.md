# Universal Resource Actions — Hard Cutover

**Status:** IMPLEMENTED AND LOCALLY VERIFIED · Rev 3 · 2026-07-24

**Type:** Hard cutover. One action grammar; no compatibility paths.

**Open questions:** None.

## Decision

For identical action target, viewer, capability facts, relationship facts, and
projection, every standing action surface produces identical semantic action
descriptors: id, copy, icon, order, tone, availability, and behavior.

Thin and rich surfaces are comparable only for facts they both possess. Thin
surfaces expose the universal resource core. Rich surfaces additionally expose
operations proven by their domain state.

```text
decoded target + facts + typed executors
                 |
                 v
        pure action policy/catalog
                 |
                 v
 core | operations | relationships | view
                 |
                 v
       enforcing menu composer
                 |
                 v
 ActionMenu | ActionBar | pane chrome | Launcher
```

This is an action-policy and publication-contract cutover, not a dropdown
redesign. Reuse `ActionDescriptor`, `ActionMenu`, `ActionBar`,
`ResourceActivation`, `ResourceItem`, collection rows, pane chrome, and the
resource capability registry.

## Goals

- One frontend owner for resource action identity, copy, icon, order, tone, and
  projection.
- Open, Share, and resource Chat behave identically wherever applicable.
- Rich pane/row pairs expose the same operations for the same facts.
- Resource menus publish semantic groups before flattening.
- Capability and executor contracts make inapplicable actions unrepresentable.
- Thin targets carry explicit identity and activation; no `href` identity
  inference.
- Delete every touched duplicate, callback-gated, and legacy action path.

## Non-goals

- No database, permission, domain-operation, or backend route change.
- No server-defined menu, backend action registry, generalized command bus,
  plugin system, personalization, ranking, submenu, or global undo.
- No full DTO fetch on menu open, N+1 action hydration, or rich-action promise
  on thin surfaces.
- No dropdown visual redesign or broad custom-content/Tab-model rewrite.
- No primary-control redesign. Existing primary activation and modifier-key
  behavior remain.
- No non-resource account, filter, batch, PDF, picker, or selection-menu
  migration.

Narrow response-schema and decoder changes are in scope only to provide an
explicit action target. Persistence and domain behavior remain unchanged.

## Scope

A **standing action surface** is a persistent representation with a stable
action target and an overflow/action affordance.

Included:

- pane Options on desktop and mobile;
- resource-bearing `CollectionRow`, `ItemCard`, and context-reference menus;
- resource Launcher actions;
- explicitly eligible Connections and Evidence object rows;
- resource-bearing search, note, contributor-work, and Lectern rows.

Excluded:

- inline citation chips, source markers, and transient generated citations;
- plain links and primary activation controls;
- picker, listbox, and search-suggestion options;
- highlight-selection and other transient popovers;
- account, filter, batch, and PDF-tool menus;
- non-resource targets beyond Open.

## Governing Rules

- [`cleanliness.md`](../rules/cleanliness.md): one owner; delete duplication,
  fallbacks, and compatibility paths.
- [`simplicity.md`](../rules/simplicity.md): one primary form; no speculative
  framework.
- [`boundaries.md`](../rules/boundaries.md) and
  [`frontend.md`](../rules/frontend.md): validate and preserve domain facts at
  boundaries.
- [`tagged-unions.md`](../rules/tagged-unions.md): couple applicability and
  execution with discriminated variants.
- [`naming.md`](../rules/naming.md): global action ids use dot-delimited
  PascalCase.
- [`testing.md`](../rules/testing.md): test behavior at owning boundaries.

## Action Taxonomy

The groups are disjoint:

1. **Resource core:** Open, Share, Chat.
2. **Resource operation:** Open source, retry/refresh, read/played state,
   settings, and mutation/removal of the canonical resource.
3. **Relationship:** Add/Remove from Lectern, remove from context, unlink,
   dismiss, and unsubscribe.
4. **View:** transcript, show/hide notes, playback, theme, reorder, and
   related-content navigation.

`danger` is an orthogonal tone/order property, not a group. Tone and
confirmation derive from actual impact and reversibility. Podcast unsubscribe
retains its existing confirmation and danger treatment because it may remove
managed-library entries.

## Target Contract

The decoded frontend contract is:

```ts
export interface ResourceActionSubject {
  kind: "Resource";
  ref: CanonicalResourceRef;
  activation: ResourceActivation;
  missing: boolean;
}

export interface ExternalActionTarget {
  kind: "External";
  href: string;
}

export type StandingActionTarget =
  | ResourceActionSubject
  | ExternalActionTarget;
```

`External` means outside the canonical Nexus resource graph; its `href` may be
an internal bridge route. It receives Open only.

Rules:

1. A boundary validates `ref`, validates/constructs `activation`, and emits the
   union. Renderers never parse identity from `href`.
2. `ResourceActionSubject.ref` must equal `activation.resourceRef`.
3. Invalid same-system resource facts defect. They do not downgrade to
   `External`.
4. Missing resources expose no core actions.
5. An unrouteable resource omits Open and Share. Chat follows its explicit
   resource capability.
6. Static scheme capabilities determine possible Share/Chat applicability;
   they do not authorize rich mutations.

Boundary changes:

| Surface | Final source of target facts |
|---|---|
| Existing `ResourceItem`/context/connection rows | Project existing ref, activation, and missing facts |
| Contributor Work | Response emits a discriminated target from real media/podcast ids; Gutenberg emits `External`; never infer from `href` |
| Contributor detail | Response emits the canonical contributor target; the detail decoder validates it before pane publication |
| Notes/pages | Notes decoder emits `Resource` from the typed page id and owned page activation |
| Lectern | Strict decoder emits `Resource` from `MediaId` and canonical `AppHref`; consumption activation remains separate |
| Search | Strict decoder validates the response target and carries it unchanged through the view model |
| Resonance | Strict slate decoder constructs the target from its validated canonical ref and owned `AppHref` |
| Evidence | Only decoded object/source variants already carrying ref and `ResourceActivation` are eligible |

## Publication Contract

Flat resource action arrays are removed from row and pane boundaries.

```ts
export interface ResourceMenuGroups {
  core: readonly ActionDescriptor[];
  operations: readonly ActionDescriptor[];
  relationships: readonly ActionDescriptor[];
  view: readonly ActionDescriptor[];
}

export type ActionPublication =
  | {
      kind: "ResourceMenu";
      target: StandingActionTarget;
      groups: ResourceMenuGroups;
    }
  | { kind: "FlatMenu"; actions: readonly ActionDescriptor[] };
```

- `CollectionRowView` and pane chrome publications carry
  `ActionPublication`.
- Resource-bearing presenters publish groups. Non-resource menus publish the
  explicit flat variant.
- `CollectionRow`, `PaneShell`, and other final resource renderers call
  `composeResourceMenu` exactly once.
- `CollectionRow` projects its renderer-owned reorder and related-content
  state into `view`, merges that with the published groups, and invokes the
  composer once. It does not prepend a separate flat list or invent domain
  policy.
- `PaneShell` resolves current-pane Share and Chat into core; it does not splice
  a flat list. Open remains representation-only.

## Catalog And Projections

The cross-surface catalog owns stable metadata. Required ids include:

```text
ResourceAction.Open
ResourceAction.Share
ResourceAction.Chat
ExternalAction.Open
ResourceOperation.OpenSource
RelationshipAction.Lectern.Add
RelationshipAction.Lectern.Remove
RelationshipAction.Context.Remove
RelationshipAction.Connection.Unlink
RelationshipAction.Connection.Dismiss
```

Every migrated id follows the same global naming grammar. No lower-kebab alias
survives.

Core order is Open → Share → Chat. Each per-kind builder owns deterministic
relative order inside its other groups; callers never sort descriptors.

The catalog produces one semantic resource action and typed projections:

- menu projection → `ActionDescriptor`;
- pane/action-bar projection → icon-bearing `PaneHeaderAction`;
- Launcher projection → `LauncherAction`.

Share metadata has one owner. Menu and header projections may differ in shape,
but never in semantic id, copy, icon token, tone, or behavior.

## Policy And Execution

Policy remains pure. It receives validated facts, projection, busy ids, and
typed command ports and returns descriptors.

Thin shared execution adapters own only:

- **Open:** delegate to `activateResource` with surface navigation ports;
- **Share:** delegate to the existing share controller and focus-return port;
- **Resource Chat:** call `startResourceContextChat(ref)`, then open the created
  conversation through the surface navigation port.

Surface controllers supply navigation, focus return, and feedback boundaries.
They do not redefine action semantics. No command bus is introduced.

Launcher gains distinct resource targets:

```ts
type LauncherActionTarget =
  | { kind: "ResourceOpen"; subject: ResourceActionSubject }
  | { kind: "ResourceShare"; subject: ResourceActionSubject }
  | { kind: "ResourceChat"; ref: CanonicalResourceRef }
  | { kind: "Ask"; text: string }
  | /* existing targets */;
```

The three resource variants use the shared core execution adapters. Generic
`Ask` remains for non-resource targets. Existing pane/history `href` targets
remain non-resource when their source does not carry a canonical subject; the
Launcher never infers one.

## Rich Capability Contract

Applicability and execution are one discriminated domain value. Example:

```ts
type LecternMembershipAction =
  | { kind: "Unavailable" }
  | { kind: "Add"; execute: () => Promise<void> }
  | {
      kind: "Remove";
      itemId: LecternItemId;
      execute: () => Promise<void>;
    };
```

Per-kind builders receive named capabilities of this form plus a keyed
in-flight set. They do not receive separate optional callbacks.

| Builder | Named capabilities |
|---|---|
| `mediaResourceOptions` | retry processing, refresh source, retry metadata, edit authors, Lectern membership, read state, remove media |
| `libraryResourceOptions` | settings, delete library |
| `podcastResourceOptions` | settings, refresh sync, subscription state |
| `episodeResourceOptions` | media operations including edit authors, plus played state |
| `conversationResourceOptions` | delete conversation |

Rules:

- `Unavailable` contains no executor and produces no descriptor.
- Each applicable variant contains the executor and facts needed by that
  action.
- Relationship state machines project exactly one applicable verb.
- Keyed in-flight state controls disabled/busy presentation only.
- Executors retain rapid re-entry guards.
- Expected failures reach the owning feedback surface; authentication follows
  the canonical auth path; unexpected failures propagate; nothing is silently
  swallowed.

Episode transcript, show/hide notes, and Play next leave
`episodeResourceOptions` and publish in `view`.

## Composer Contract

`composeResourceMenu`:

1. defects on duplicate ids across all groups;
2. discards caller-supplied separators;
3. preserves relative order within each group;
4. orders core → operations → relationships → view;
5. stable-partitions every danger action into one final group;
6. inserts exactly one separator between non-empty groups;
7. does not mutate its inputs.

Flat non-resource publications retain caller-owned separators.

## Surface Final State

| Surface | Final composition and retained behavior |
|---|---|
| Resource pane | current-pane core without Open + rich operations + relationships + pane view |
| Rich collection row | representation core + same rich operations/relationships for the same facts |
| Search/note/resource contributor row | representation core |
| External contributor work | Open only |
| Conversation context ref | representation core + Remove from conversation context |
| Lectern row | representation core + Remove from Lectern + reorder/playback view; existing consumption activation remains primary |
| Launcher resource | resource core via typed Launcher projections; resource Chat carries resource context, not a draft rename |
| Highlight | existing highlight builder; shared Share projection only |

Mandatory rich parity pairs:

- media pane ↔ library media row;
- library pane ↔ libraries row;
- podcast detail ↔ followed-podcast row ↔ podcast-in-library row;
- episode row ↔ opened podcast-episode media pane;
- conversation pane ↔ conversation row.

### Connections

- Retain row primary activation and Shift-click/new-pane behavior.
- Every non-missing resource target receives core.
- User-origin connection receives
  `RelationshipAction.Connection.Unlink`.
- Synapse receives `RelationshipAction.Connection.Dismiss`.
- Other origins receive core only.
- Remove bespoke unlink/dismiss icon buttons only after the overflow owns the
  same behavior, busy state, and feedback.

### Evidence

- Top-level `Link` and `Synapse` rows with `item.object` receive core; user
  Links receive Unlink and Synapses receive Dismiss.
- Association-object rows receive core; user associations receive Unlink.
- Source-target rows receive core only when the decoder exposes a valid
  `ResourceActionSubject`; otherwise their existing primary source activation
  remains without a resource menu.
- Preserve primary object/source activation and modifier-key new-pane behavior.
- `Highlight`, `GeneratedCitation`, inline source markers, and rows without a
  direct stable subject are excluded.
- Remove bespoke unlink/dismiss buttons only for variants migrated to the menu.

## Busy-State Accessibility

Authorize one narrow `ActionMenu` correction:

- busy descriptors remain in roving keyboard navigation;
- render unavailable state with `aria-disabled`, not native `disabled`;
- suppress click, Enter, and Space activation while unavailable;
- add `disabledReason` to the applicable descriptor variants and require it
  when the busy label does not explain the state;
- keep existing menu focus, dismissal, and custom-render behavior otherwise.

## API And Data

- Contributor Work adds one response field:

  ```ts
  actionTarget:
    | {
        kind: "Resource";
        ref: string;
        activation: ResourceActivationOut;
        missing: boolean;
      }
    | { kind: "External"; href: string };
  ```

- Contributor detail adds the same `actionTarget` field constrained to the
  `Resource` arm.
- Contributor queries carry actual target ids through projection; the response
  constructs canonical refs/activations from those ids.
- Notes and Lectern construct targets at their owned strict decoders from typed
  identity already present on the wire.
- Existing rich DTOs, permissions, mutations, persistence, and routes remain
  unchanged.
- No lazy action endpoint, fallback hydration, or inferred identity.

## Hard-Cut Removal

Delete, do not wrap or alias:

- flat resource action publications at collection and pane boundaries;
- optional callback gating and fake/no-op rich executors;
- duplicate Share/Open/Chat metadata and behavior;
- Launcher’s resource `Ask` path;
- inline Conversation context Open/Remove arrays;
- relationship-only Lectern replacement menus;
- eligible empty action arrays on thin resource presenters;
- bespoke Connections/Evidence icon actions replaced by the menu;
- builder-owned separators;
- episode view actions inside `episodeResourceOptions`;
- old lower-kebab resource action ids and preserving tests;
- every superseded adapter, overload, alias, fallback, and dead import.

No feature flag, compatibility signature, dual publication, or legacy branch
survives.

## Files

Primary policy and primitives:

- `apps/web/src/lib/actions/resourceActions.ts`
- `apps/web/src/lib/actions/resourceActions.test.ts`
- `apps/web/src/lib/resources/resourceActionExecution.ts`
- `apps/web/src/lib/ui/actionDescriptor.ts`
- `apps/web/src/components/ui/ActionMenu.tsx`
- `apps/web/src/__tests__/components/ActionMenu.test.tsx`

Grouped publications:

- `apps/web/src/lib/collections/types.ts`
- `apps/web/src/components/collections/CollectionRow.tsx`
- `apps/web/src/lib/panes/panePublications.ts`
- `apps/web/src/components/workspace/PanePrimaryChrome.tsx`
- `apps/web/src/components/workspace/usePanePublication.ts`
- `apps/web/src/components/workspace/PaneShell.tsx`

Targets and Launcher:

- `apps/web/src/lib/contributors/types.ts`
- `apps/web/src/lib/contributors/detail.ts`
- `apps/web/src/lib/collections/presenters/presentContributorWork.ts`
- `python/nexus/services/contributor_credits.py`
- `python/nexus/services/contributors.py`
- `python/nexus/schemas/contributors.py`
- `apps/web/src/lib/notes/normalize.ts`
- `apps/web/src/lib/lectern/contract.ts`
- `apps/web/src/lib/resonance/{contract,presentSlateItem}.ts`
- `apps/web/src/lib/search/{normalizeSearchResult,searchViewModel}.ts`
- `apps/web/src/lib/launcher/{model,actions,dispatch}.ts`
- `apps/web/src/lib/resources/resourceContextChat.ts`

Surface adapters:

- rich pane bodies and collection presenters for media, libraries, podcasts,
  episodes, and conversations;
- `apps/web/src/components/chat/ConversationContextRefsSurface.tsx`;
- `apps/web/src/components/items/ItemCard.tsx`;
- `apps/web/src/components/connections/ConnectionsSurface.tsx`;
- `apps/web/src/components/reader/document-map/EvidenceItemRow.tsx`;
- search, Notes, Lectern, pages, and contributor pane owners.

Update final ownership rules in:

- `docs/cutovers/canonical-collection-row-hard-cutover.md`
- `docs/modules/workspace.md`

Do not add a barrel, re-export, compatibility module, or generalized action
framework.

## Implementation Order

1. Add catalog, composer, projection, and accessibility behavior tests.
2. Add the target union and narrow Contributor Work/decoder contracts.
3. Hard-cut collection and pane publications to grouped/flat variants.
4. Implement shared core policy, projections, and execution adapters.
5. Hard-cut rich builders to discriminated capabilities.
6. Migrate rich pairs, then thin surfaces, Launcher, Connections, and Evidence.
7. Delete every superseded path and run focused verification/residue gates.

No transitional state lands.

## Acceptance Criteria

- **AC1 — Closed inventory.** Every included standing surface is migrated;
  every excluded surface is named above.
- **AC2 — Comparable parity.** Identical target, viewer, capabilities,
  relationships, and projection produce identical semantic descriptors.
- **AC3 — Explicit targets.** Every migrated thin resource has canonical ref,
  activation, and missing facts at its decoder. External targets expose Open
  only. No `href` identity inference exists.
- **AC4 — Grouped publication.** Resource-bearing rows and panes publish four
  semantic groups and invoke the composer once. Non-resource menus use the
  explicit flat variant.
- **AC5 — True resource Chat.** Launcher and menu Chat call
  `startResourceContextChat` with the canonical ref and open the resulting
  conversation. Generic Ask remains non-resource-only.
- **AC6 — Rich legality.** Applicability variants require their executor;
  unavailable variants contain none. Callback presence never decides
  visibility.
- **AC7 — Shared execution.** Open, Share, and resource Chat use shared thin
  adapters; surface controllers provide only navigation, focus, and feedback
  ports.
- **AC8 — Typed projections.** Share and other promoted actions use one catalog
  with valid menu, header/action-bar, and Launcher projections.
- **AC9 — Connections/Evidence.** Only enumerated stable-subject variants
  migrate; primary and modifier-key behavior remains; migrated relationship
  actions occur once.
- **AC10 — Accessible busy state.** Busy actions remain keyboard discoverable,
  expose their unavailable state/reason, and cannot execute.
- **AC11 — Enforcing composition.** Duplicate ids defect; separators, group
  order, danger-last order, stability, and immutability satisfy the composer
  contract.
- **AC12 — Consequence-based tone.** Tone and confirmation reflect actual
  impact; podcast unsubscribe retains its consequential treatment.
- **AC13 — Global ids.** All migrated ids are dot-delimited PascalCase and
  stable across projections.
- **AC14 — Hard cut.** No old ids, flat resource publications, optional rich
  callbacks, fake executors, inline duplicates, compatibility paths, or dead
  code remain.
- **AC15 — 80/20 boundary.** The diff contains no persistence change,
  server-driven menu, command bus, lazy hydration, plugin system, global undo,
  or broad dropdown redesign.

## Verification

- Unit: target decoding, core policy, every rich capability state, all
  projections, and every composer invariant.
- Presenter/publication: real adapters assert semantic groups and global ids.
- Component/browser: pane ↔ row rich pairs, desktop/mobile pane parity,
  Launcher resource Chat, Connections/Evidence variants, Lectern composition,
  and keyboard-visible busy state.
- Backend: focused Contributor Work response/query tests.
- Static: focused frontend format, lint, and type-check.
- Residue: old ids/copy, flat resource publications, optional builder
  callbacks, inline Open/Share/Chat, replaced icon actions, and compatibility
  symbols.

Tests assert user-visible copy, order, availability, and outcomes through public
owners. They do not duplicate implementation constants or test wiring.
