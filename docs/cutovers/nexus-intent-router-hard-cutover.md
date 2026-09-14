# Nexus Intent Router Hard Cutover

Status: APPROVED SPECIFICATION — REVISED 2026-07-31
Type: hard cutover
Date: 2026-07-31

## Decision

Nexus is one intent router with two platform-native renderers.

- Desktop and mobile share commands, query intent, entries, ranking, history,
  actions, targets, provider lifecycle, replay, and dispatch.
- Desktop remains a compact keyboard-first dialog.
- Mobile remains an opaque full-screen task with touch, IME, safe-area, and
  Back ownership.
- Capability parity is required. Section layout, density, focus, and gestures
  remain platform-owned through one declared projection policy.
- One typed platform-activation seam owns gesture-only requirements. It is not
  a second command, target, or dispatch path.

No open questions. The defaults below are final.

This specification supersedes these conflicting clauses in full:

- `desktop-nexus-switchboard-hard-cutover.md`: the shared five-row zero-state
  cap, exactly four zero-state actions, no Continue, Library-not-zero-state,
  unrelated open panes in typed results, footer Actions, listbox-only rows,
  `SearchWeb`, continuation placement, and separate mobile result ownership;
- `mobile-nexus-switchboard-hard-cutover.md`: Places/Quick dashboard Root,
  its mobile-only Places projection, separate Find page, scope chips,
  `SwitchboardRowModel`, and mobile-only merge;
- `mobile-nexus-full-screen-task-hard-cutover.md`: AC-3 in full, explicit Root
  -> Find, and the Root portion of AC-4. Full-screen geometry, modal lifecycle,
  guarded dismissal, safe-area, visual-viewport, and focus-containment
  contracts remain authoritative; the old no-search/no-software-keyboard Root
  contract does not;
- `daily-pages-quick-capture-hard-cutover.md`: desktop rail Quick Note/Today,
  exactly four desktop zero-state actions, Today-not-a-quick-action, Library
  exclusion, preservation of the old mobile Root inventory, and AC-15;
- `docs/modules/app-navigation.md`: rail Quick Note/Today, exact mobile Places
  inventory, four-action desktop zero state, one-column/no-command-language
  grammar, and the footer-only Actions contract.

Implementation updates the affected module docs in the same change. There is
no feature flag, dual projection, compatibility adapter, fallback ranker, old
identifier alias, or retained superseded test.

Governing standards: `docs/rules/{simplicity,cleanliness,boundaries,frontend,
correctness,control-flow,tagged-unions,keys-and-identities,naming,
function-parameters,operation-types,retries}.md` and
`docs/local-rules/testing-standards.md`.

## Scope / 80/20 Boundary

Build:

- one shared command registry and pure intent compiler;
- one shared `NexusEntry` / `NexusGroup` semantic projection with a declared
  desktop/mobile layout policy;
- explicit blank-query and typed-query section contracts;
- query-seeded Today Note, Page, Chat, and Library workflows;
- typed Browse intent and a Browse-kind chooser;
- visible per-row Actions and shortcut teaching;
- one autofocused mobile search Root using canonical Nexus results;
- one typed mobile activation adapter for gesture-time text handoff;
- one shell-owned player provider enclosing Nexus and workspace consumers;
- Quick Note and Today inside both Nexus blank states, not desktop navigation;
- canonical mobile Places without the old mobile-only result model, matcher,
  merge, scopes, or Root -> Find path.

Reuse:

- `useNexusController`, `NexusTarget`, `NexusAction`, and `dispatchNexusTarget`;
- `activateWorkspaceTarget` and Follow / Fork / Adopt;
- `DESTINATIONS`, Openables, canonical Search, Nexus history, prefetch, and
  provider retry;
- Browse query builders and the existing Browse pane/providers;
- Today Page, daily draft/handoff, Page, Chat, Library, and Add owners;
- `ActionMenu`, keybindings, feedback, focus-return, recovery, pane-cap
  handling, and the player runtime;
- `MobileFullScreenTask` and existing mobile modal lifecycle.

Do not build:

- a backend endpoint, table, column, migration, index, or second history store;
- action recency, cross-device command history, pins, favorites, or ranking
  settings;
- embeddings, semantic command matching, an LLM router, learned ranking, or an
  agentic planner;
- a generic command/plugin framework;
- a second provider blend inside See All Search;
- Browse-All fan-out from an ambiguous query;
- a preview pane, new navigation taxonomy, voice, widgets, OS shortcuts, or
  offline synchronization;
- shared desktop/mobile JSX, geometry, focus mechanics, or gesture code;
- a broad player, Search, Browse, workspace, editor, or design-system rewrite.
  The only player change is moving its existing provider boundary.

## Goals

1. Make common work one invocation plus typing or one selection.
2. Remove arrow-key dependence for known commands.
3. Make the palette teach aliases and configured shortcuts in place.
4. Give every result a clear section, type, primary action, and action menu.
5. Make desktop and mobile capability-complete from one semantic owner.
6. Keep exact local results immediate and progressive results identity-stable.
7. Delete duplicate result, command, navigation, and action paths.
8. Lower total concepts and code.

## Non-Goals

- Pixel parity with Spotlight, Raycast, Superhuman, or another product.
- Automatic mutation from typing alone.
- A universal app command bus.
- Four unconditional Create rows for every query.
- Bare-letter or bare-letter-space command modes while text or IME owns input.
- Opaque adaptive section movement.
- Exhaustive commands or filters in the blank state.
- Customizable Places, pins, or favorites.
- Automatic insertion into a non-appendable atomic daily draft.
- Recent actions before the existing history owner supports typed command keys.
- Replacing canonical Search or Browse.

## Final Product Contract

### Entry

- `Nexus.Open` and the existing Nexus controls open the same session.
- The search input is immediately focused on desktop and mobile.
- Placeholder and accessible name remain `Find anything…`.
- Opening may load href history. It launches no Openables, canonical Search,
  Browse, or other provider work until the normalized query reaches the
  existing owner threshold or the user selects an explicit action.
- Closing restores focus unless accepted navigation transfers it.
- Root owns the query on both platforms. Actions and workflows return to Root
  with its query and active identity preserved; there is no separate Find page
  or scope state.
- Root with a nonblank query consumes the first Back/Escape by clearing the
  query and preserving input focus. Back/Escape on blank Root dismisses Nexus.

### Blank query

The semantic inventory is:

| Section | Contract | Cap |
|---|---|---:|
| Open | Open panes in stable workspace order; mark current | 5 |
| Continue | Current resumable player item from the existing player owner | 1 |
| Recent | Accepted internal href history not already in Open | 4 |
| Quick Actions | Quick Note, Today, New Chat, New Page, New Library, Import | 6 |
| Places | Lectern, Libraries, Browse, Podcasts, Chats, Notes | 6 |

Rules:

- Caps are independent. Open panes cannot erase Recent or Quick Actions.
- Omit an empty section. Do not render an empty heading.
- If more than five panes are open, append `Manage tabs…` after the five Open
  entries. It is an uncapped navigation row, not an owned-result cap exemption.
- Continue exists only when the mounted player owner exposes a current
  resumable item. Do not query or persist a second resume source.
- Recent means real Nexus href history. Recently closed panes remain only in
  Manage Tabs/recovery.
- Places use canonical `DESTINATIONS`; delete the mobile-only projection.
- Desktop flow order is Open, Continue, Recent, Quick Actions. Places remain
  searchable and in the desktop rail.
- Mobile flow order is Open, Quick Actions, Continue, Recent, Places. Each
  group is a compact horizontal rail so the keyboard does not turn the blank
  state into a long dashboard.
- The shared composer, not either renderer, applies this closed projection
  policy. Renderers receive ordered groups and layout modes.

### Typed query

- Blank-state sections disappear.
- Open panes remain only when their label, route, or owned aliases match.
- Compose at most eight visible owned results. `See all` owns exhaustive
  retrieval.
- Preserve canonical-owner grouping for deep occurrences.
- Results appear synchronously from local owners, then progressively from
  Openables and canonical Search.
- Provider arrival never changes a surviving active identity or
  user-stabilized prefix.

Rank within Results by:

1. unambiguous explicit intent from the reserved grammar;
2. exact title/name/open object;
3. prefix and token match;
4. current-context relevance;
5. fuzzy title and explicit synonym;
6. metadata/full-text tier.

Within a tier, compare existing normalized score, then joined href frecency,
then deterministic source order and semantic key. Deep entries without a
canonical href receive zero frecency. Frecency never crosses sections or tiers.

Only recognized reserved syntax receives tier 1. Ordinary command keywords do
not outrank an exact object. Therefore `a tale of two cities`, `i robot`, and
`c programming` remain retrieval queries; `ask …`, `import <URL>`, and
`create page …` are explicit intent. Exact existing matches precede generic
Create.

Progressive stability is exact:

- a normalized-query change resets stabilization;
- before explicit movement, retain the surviving active identity while the
  remaining seven slots may rerank;
- Arrow movement, grid-cell movement, or pointer selection stabilizes the
  surviving ordered Results prefix through the active row;
- stable entries reserve slots inside the eight-result cap; there is no cap
  exemption;
- arrivals fill only unreserved slots; if a stable entry becomes invalid or
  disappears, select the nearest surviving index, then the first result;
- at a canonical-owner boundary, admit its parent/group identity and only the
  highest-ranked children that fit; never soft-cap past eight or orphan a child;
- Query Actions are outside this merge and never consume the eight slots.

For every nonblank, non-URL query, render `Do with query` in this order:

1. `Ask Nexus about “{query}”`;
2. `Add “{query}” to Today`;
3. `Browse for “{query}”…`;
4. `Create “{query}”…`;
5. `See all results for “{query}”`.

Desktop renders Query Actions after Results. Mobile renders the same group as
a compact horizontal rail pinned below the search field and before Results.
This is declared section layout, not different command semantics.

A bare URL remains the exact `Import URL` result. Import never starts on
selection; it opens Add prefilled.

### Intent grammar

The compiler is lexical, deterministic, pure, and side-effect free. It
normalizes once for matching while preserving the trimmed user draft for
display and target seeds.

Recognize:

- `new|create` + `note|page|chat|library` + optional draft;
- `ask` + nonempty draft;
- `browse|find` + `article|podcast|video|book` + optional query;
- bare `add|import`, or `add|import` + one canonical URL;
- exact slash aliases `/n `, `/p `, `/c `, `/l `, `/i `, `/a `, and `/b `.

The slash and trailing space are part of each alias. Configured keybindings are
the non-text shortcut path. Typing never mutates state; selection is required.
Slash aliases preserve their remainder as the target argument. `/i ` compiles
only with an empty remainder or canonical URL; other remainders remain search.

Unknown or incomplete command text remains an ordinary search query.

Bare Import/Add opens the existing Add surface without a seed. Import/Add with
a canonical URL seeds the URL field. Any other argument remains ordinary
search; the compiler never discards a user argument.

### Create behavior

- Explicit intent produces one direct seeded command result.
- A plain noun query produces one generic `Create…` result.
- Selecting generic Create opens `ChooseCreate` with Today Note, Page, Chat,
  and Library in that order. This is not an entry Actions page.
- Right Arrow may open this page on desktop; Enter/tap is the required path.
- Exact existing matches remain ahead of generic Create.

Seed ownership:

| Choice | Seed | Final behavior |
|---|---|---|
| Today Note | note body draft | Open Today and focus the provisional daily note; save remains editor-owned |
| Page | title draft | Create through the current replay-safe Page workflow |
| Chat | initial draft | Open the canonical new-conversation route |
| Library | name draft | Open the current Library form prefilled; explicit submit remains required |

Blank quick actions preserve current behavior: a Page uses `Untitled`, Chat
opens with an empty draft, Library opens its empty form, and Quick Note opens an
empty provisional note.

`Quick Note` is the blank-seed form. `Add “query” to Today` is the query-seeded
form. Both use the existing daily draft and handoff owner. If an unsaved daily
draft exists, append the new plain text through that owner; never overwrite it
or create a parallel draft store.

The existing note schema admits one top-level body. If the unsaved draft's body
is atomic and cannot accept inline append, project Add to Today as
`Unavailable` with the reason `Open Today to finish the current embedded
draft`. Keep the query and Nexus open, announce the reason, and dispatch
nothing. Do not silently drop the seed. Multi-note atomic-safe insertion is
outside this cutover.

### Browse behavior

- Generic `Browse for…` opens `ChooseBrowse` with Articles, Podcasts, Videos,
  and Books. It is not an entry Actions page.
- Explicit kind intent bypasses the chooser.
- Each choice builds a canonical `BrowseQuery` and opens the existing Browse
  pane with `WebArticle`, `Podcast`, `Video`, or `Epub`.
- No ambiguous query uses `kind=All`.
- Generic Web Search may remain a secondary Browse action; it is not a root
  continuation.

### Media behavior

- Blank state exposes at most one Continue row.
- Move the existing `GlobalPlayerProvider` shell boundary outward so one
  provider encloses Nexus, AppNav, workspace, and player surfaces. Continue
  consumes `usePlayerSession()` from that provider; it does not infer or bridge
  a second resume source.
- A normal media search result keeps Open as primary. Play/Resume, Queue, Add to
  Lectern, restart, mark state, and other applicable operations live in that
  result's Actions.
- Do not show media actions that the current subject cannot perform.
- Type label, icon, and metadata distinguish commands, media, episodes, videos,
  resources, destinations, and open tabs.

## Interaction and Visual Rules

### Shared

- One sticky search field and one vertical result scroller. Declared compact
  rails may scroll horizontally.
- Quiet text headings; no card wall, rainbow taxonomy, or permanent scope-chip
  row.
- Use existing color, type, spacing, radius, motion, and focus tokens.
- Reserve a stable trailing accessory column so async metadata does not move
  controls.
- Save success is silent. Source failure is section-local and retryable through
  the existing owner.
- Reduced motion changes decoration only.

### Desktop

- Use a combobox with a grid popup, not buttons nested in listbox options.
- DOM focus stays on the input while the popup is active;
  `aria-activedescendant` identifies the active primary or Actions gridcell.
- Each row with secondary actions has a real trailing
  `Actions for {label}` button for pointer use. It has `tabIndex=-1`; its parent
  Actions gridcell is reachable through virtual grid focus and announced by
  assistive technology.
- Up/Down move rows; Left/Right move between the primary and Actions cells;
  Enter invokes the active cell; Shift+Enter Forks only from a primary cell;
  Escape clears then closes; IME owns composition keys.
- `Nexus.Open` pressed again opens Actions for the active entry.
- The trailing affordance displays the actual configured `Nexus.Open` shortcut
  (`⌘K` or `Ctrl K` by default), never a hard-coded key label.
- Tab exits the grid composite through normal dialog focus order. It never
  means Create and does not visit every row button.
- Row Actions use the existing `ActionMenu` behavior and descriptors; do not
  maintain `DesktopNexusActionsPage` or a second menu implementation.
- Pointer Actions first select that exact row, then open its snapshotted action
  set; they never act on a stale keyboard selection.
- Opening or closing `ActionMenu` returns virtual focus to the originating
  Actions cell. Primary operations never require Right Arrow or a shortcut;
  secondary actions have both grid-cell and configured-shortcut access.

### Mobile

- Keep `MobileFullScreenTask`, one opaque canvas, one content scroller, and the
  current modal/Back/visual-viewport lifecycle.
- A direct Nexus-control tap performs a gesture-owned `flushSync` open. Root's
  search ref is focused from the resulting layout-effect flush before the
  discrete event returns. Post-paint `useInitialFocus` is not Root's iOS
  keyboard authority.
- Programmatic opens still focus Root but do not promise an iOS software
  keyboard without a user gesture.
- Rows retain 48 px minimum targets and the existing sibling action-menu
  button. No action depends on hover, long press, or a hardware keyboard.
- Blank groups use the declared compact-rail order above. Query Actions remain
  pinned below the search input; Results own the content scroller below them.
- Remove Root -> Find, Places grid, Quick grid, scope chips, and bottom Find
  button. Keep canonical Places as one compact group.
- Advanced filtering lives in See All Search, not Nexus Root.
- Hardware keyboards honor the desktop command vocabulary.
- Mobile Back/Escape clears a nonblank Root query first. Nested pages return to
  the exact Root query/active identity; Back on blank Root dismisses.
- Manage Tabs is a distinct direct-or-recovery page inside the same task. It
  reuses row/action primitives and does not restore the old dashboard.

### Platform activation

- `NexusAction.activation` declares `Standard` or `DailyTextHandoff` behavior.
  It is authored with the action; renderers never branch on command ids.
- Desktop routes both kinds through the standard activation owner.
- Mobile pointer activation routes `DailyTextHandoff` through
  `MobileNexusActivationAdapter`. Its first side effect focuses the mounted
  handoff input; it then calls the shared target materializer and dispatch.
- The adapter may buffer/transfer daily editor input and consume the prepared
  replay identity. It never creates an alternate target or mutation path.
- Presentational renderers and result projection never mint replay identity.
  The shared target materializer is the sole minting entrypoint whether called
  by standard dispatch or the sanctioned adapter.

## Capability Contract

`NexusEntry` remains the sole result contract. Section and presentation facts
are typed; no renderer infers them from labels or keys.

```ts
type NexusSurface = "Desktop" | "Mobile";

type NexusSectionId =
  | "Open"
  | "Continue"
  | "Recent"
  | "QuickActions"
  | "Places"
  | "Results"
  | "QueryActions";

interface NexusGroup {
  readonly id: NexusSectionId;
  readonly label: string;
  readonly layout: "Flow" | "CompactRail" | "PinnedBelowInput";
  readonly entries: readonly NexusEntry[];
}

interface NexusProjection {
  readonly surface: NexusSurface;
  readonly groups: readonly NexusGroup[];
  readonly activeKey: NexusEntryKey | null;
}

type NexusActionAvailability =
  | { readonly kind: "Available"; readonly target: NexusTarget }
  | { readonly kind: "Unavailable"; readonly reason: string };

interface NexusAction {
  readonly id: string;
  readonly label: string;
  readonly activation:
    | { readonly kind: "Standard" }
    | { readonly kind: "DailyTextHandoff" };
  readonly availability: NexusActionAvailability;
}

interface NexusCommand {
  readonly id: NexusCommandId;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  readonly category: "Create" | "Acquire";
  readonly activation: NexusAction["activation"];
  readonly shortcut:
    | { readonly kind: "None" }
    | { readonly kind: "Keybinding"; readonly actionId: NexusCommandId };
  target(input: { readonly argument: string }): NexusTarget;
}
```

Rules:

- Rename `NexusQuickAction` / `QUICK_ACTION_REGISTRY` to the final command
  vocabulary. Delete the old type, registry symbol, projections, and aliases.
- Preserve the existing `Nexus.Quick.*` string values: they remain correct,
  stable quick-command and keybinding identities, not compatibility aliases.
- The registry is the sole static-command label, slash alias, category, icon,
  activation, shortcut, and target-factory owner. `intent.ts` is the sole owner
  of reserved parameterized verbs and `/a ` / `/b `; no token is duplicated.
- `NexusEntry` continues to own key, factual presentation, primary/secondary
  actions, rank, and canonical parent identity.
- `composeNexusProjection(surface, …)` owns section membership, order, caps,
  and layout enum. Renderers do not regroup, hide, or rerank entries.
- Commands produce typed targets. Presentational components never infer
  behavior from strings, command ids, URLs, or icons. The named platform
  adapter may exhaustively switch on `NexusAction.activation` only.
- Every target and page union is exhaustively matched.
- Every registered command is reachable through both projections.

The initial registry is closed:

| Id | Label | Aliases/keywords | Target seed |
|---|---|---|---|
| `Nexus.Quick.Note` | Quick Note | `note`, `new note`, `create note`, `jot`, `capture`, `/n ` | Today AppendNote body |
| `Nexus.Quick.Page` | New Page | `page`, `new page`, `create page`, `document`, `/p ` | Page title |
| `Nexus.Quick.Chat` | New Chat | `chat`, `new chat`, `start chat`, `conversation`, `/c ` | Chat draft |
| `Nexus.Quick.Library` | New Library | `library`, `new library`, `create library`, `collection`, `/l ` | Library name |
| `Nexus.Quick.Import` | Import | `add`, `import`, `url`, `file`, `opml`, `/i ` | Add seed |

Today remains the `today` destination from `DESTINATION_REGISTRY`. Ask,
Browse-kind, generic Create, and See All are query actions composed by
`results.ts`; they do not create a second static registry.

Final target additions/changes:

```ts
type DailyPageLocator =
  | { readonly kind: "Today" }
  | { readonly kind: "LocalDate"; readonly value: string };

type NexusTarget =
  | ExistingTargets
  | { kind: "OpenDailyPage"; date: DailyPageLocator;
      entry: { kind: "View" } |
        { kind: "AppendNote"; initialText: string } }
  | { kind: "CreatePage"; titleDraft: string }
  | { kind: "CreateLibrary"; nameDraft: string }
  | { kind: "NewConversation"; initialDraft: string }
  | { kind: "ChooseCreate"; initialDraft: string }
  | { kind: "ChooseBrowse"; query: string }
  | { kind: "Browse"; query: string;
      browseKind: "WebArticle" | "Podcast" | "Video" | "Epub" }
  | { kind: "ResumeCurrentPlayback" };

type NexusReturnPoint = {
  readonly kind: "Root";
  readonly query: string;
  readonly activeKey: NexusEntryKey | null;
};

type RetainedActivationSource =
  | "Result"
  | "Place"
  | "QuickAction"
  | "Page"
  | "Chat"
  | "Library"
  | "Import";

interface RetainedActivation {
  readonly target: RetainedNexusTarget;
  readonly activation: NexusTargetActivation;
  readonly source: RetainedActivationSource;
  readonly completion: Presence<CommittedWorkflow>;
  readonly returnTo: NexusReturnPoint;
}

type ManageTabsOrigin =
  | { readonly kind: "Direct" }
  | { readonly kind: "Recovery"; readonly retained: RetainedActivation };

type NexusPage =
  | { readonly kind: "Root" }
  | { readonly kind: "EntryActions"; readonly entry: NexusEntry }
  | { readonly kind: "ChooseCreate"; readonly initialDraft: string }
  | { readonly kind: "ChooseBrowse"; readonly query: string }
  | { readonly kind: "ManageTabs"; readonly origin: ManageTabsOrigin }
  | ExistingWorkflowPages;
```

`initialText`, `titleDraft`, `nameDraft`, and `initialDraft` are always present;
the empty string is valid draft input, not semantic absence. Selection mints
replay identity once before the first mutation and preserves it through retry.

`materializeNexusTarget` is the only replay-identity factory. It converts an
AppendNote seed exactly once into a prepared daily activation carrying the
existing `OpenDailyPageTarget`, `initialText`, `noteId`, and
`clientMutationId`. Standard activation materializes then dispatches. The
mobile handoff focuses first, calls the same materializer, buffers against the
prepared identity, then invokes the same dispatch. No path rematerializes a
prepared activation.

`DailyPageLocator.LocalDate.value` is validated at its boundary. Do not use the
degenerate `"Today" | string` union.

Direct Manage Tabs needs no retained activation. Recovery Manage Tabs preserves
the exact retained target, activation, completion, and `NexusReturnPoint` for
retry or cancel. Its page is rendered by a dedicated shared Manage Tabs owner,
never by deleted Root.

Final continuation ids are `Ask`, `AddToToday`, `Browse`, `Create`, and
`SeeAll`. Delete `SearchWeb`.

## API and Persistence

- No HTTP API or database schema changes.
- `/api/me/nexus-history`, Openables, canonical Search, Browse, notes, pages,
  libraries, chats, and Add retain their current wire contracts.
- Remove the mobile guard that suppresses Nexus history loading. Both
  projections consume the same href history response.
- Do not record commands in the href-only history API.
- Browse targets use `browseHref(BrowseQuery)`; Nexus does not hand-build query
  strings.
- Seeded Today Note extends the existing pane-entry activation and daily draft
  ingress. It does not create a second note endpoint or commit a server mutation
  on selection.
- An atomic, non-appendable local daily draft makes Add to Today unavailable;
  selection cannot degrade into an unseeded Today open.
- Existing workflow owners retain error classification, feedback, replay, and
  activation disposition.
- Move `GlobalPlayerProvider` in `AuthenticatedShell.tsx` to enclose `<Nexus />`
  and the existing layout. Keep exactly one provider instance and change no
  player wire, persistence, or session contract.

## Intra-System Composition

```text
Nexus.Open / mobile control
  -> one useNexusController session
  -> command registry + pure intent compiler
  -> local entries + Openables + canonical Search + href history + player state
  -> one stable composeNexusProjection(surface) result
  -> desktop grid renderer | mobile full-screen renderer
  -> NexusAction
  -> standard activation | typed mobile gesture adapter
  -> one materializeNexusTarget entrypoint
  -> one dispatchNexusTarget path
  -> existing workspace, Today, Page, Chat, Library, Add, Browse, player owners
```

Ownership rules:

- `lib/nexus/commands.ts` owns command facts and target construction.
- `lib/nexus/intent.ts` owns lexical intent recognition only.
- `lib/nexus/ranking.ts` owns text tiers, normalized score validation, and the
  total entry comparator.
- `lib/nexus/results.ts` owns entry projection, section composition, caps,
  dedupe, href-frecency joins, and sectioned progressive stability; it calls
  the ranking owner and does not redefine comparison.
- `useNexusController` owns one session, provider lifecycle, page/workflow
  state, selection, and dispatch orchestration. Move pure logic out; do not add
  another controller.
- `MobileNexusActivationAdapter` is the sole platform exception: it owns
  gesture-time focus and daily text transfer, not command or target meaning.
- Desktop and mobile components consume `NexusProjection` and emit user
  intents. They contain no ranking, command, target, provider, or workflow
  policy.
- `lib/nexus/performance.ts` owns desktop and mobile Nexus measures. Migrate all
  consumers and delete the parallel Switchboard performance module.
- Domain owners continue to own mutations and navigation.

## Hard-Cut File Plan

Create:

- `apps/web/src/lib/nexus/commands.ts`;
- `apps/web/src/lib/nexus/intent.ts`;
- `apps/web/src/components/nexus/{ManageTabsPage,ChooseCreatePage,
  ChooseBrowsePage}.tsx`;
- `apps/web/src/components/switchboard/{SwitchboardSearch,
  MobileNexusActivationAdapter}.tsx`.

Modify:

- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx` and its shell
  provider-ownership test;
- `apps/web/src/lib/nexus/{model,results,ranking,actions,dispatch,events,
  performance}.ts` and focused tests;
- `apps/web/src/lib/nexus/architectureInvariants.test.ts`;
- `apps/web/src/components/nexus/Nexus.tsx`;
- `apps/web/src/components/nexus/useNexusController.ts`;
- `apps/web/src/components/nexus/desktop/{DesktopNexus,
  DesktopNexusInput,DesktopNexusResults,DesktopNexusRow}.tsx`,
  `desktop/types.ts`, and styles;
- `apps/web/src/components/switchboard/{SwitchboardTask,SwitchboardRow,
  SwitchboardActions,MobileQuickNoteHandoff,NexusButton,CreateLibraryPanel,
  SwitchboardRecovery}.tsx` and styles;
- `apps/web/src/components/ui/MobileFullScreenTask.tsx` and focus tests where
  required to prove gesture-flush ownership without changing generic modal
  semantics;
- `apps/web/src/components/appnav/{AppNav,NavRail}.tsx` and tests;
- `apps/web/src/lib/notes/openDailyPage.ts`;
- `apps/web/src/lib/workspace/targetActivation.ts` and the workspace delivery
  owner;
- `apps/web/src/lib/resourceSurface/{dailySurfacePersistence,
  useResourceSurfaceSession}.ts`;
- performance consumers `apps/web/src/components/workspace/PaneShell.tsx`,
  `apps/web/src/lib/panes/paneRenderRegistry.tsx`, and
  `apps/web/src/lib/resources/openableResources.ts`;
- affected Nexus, workspace, daily-page, and real-browser tests;
- any committed Nexus/Switchboard screenshot baselines owned by those tests;
- `docs/modules/{app-navigation,overlays,panes-tabs,workspace}.md` and the
  five superseded owners enumerated above.

Delete after consumers move:

- `apps/web/src/lib/nexus/quickActions.ts` and its old tests;
- `apps/web/src/lib/switchboard/{model,merge,findScopes,places}.ts` and the
  existing merge/findScopes/places tests;
- `apps/web/src/lib/switchboard/performance.ts` after every consumer moves to
  `lib/nexus/performance.ts`;
- `apps/web/src/lib/switchboard/paneStatusLabel.ts` and its test if canonical
  `NexusEntry` metadata leaves no consumer;
- `apps/web/src/components/switchboard/{SwitchboardRoot,
  SwitchboardFind}.tsx`, `useSwitchboardController.ts`, and superseded tests;
- `apps/web/src/components/nexus/desktop/DesktopNexusActionsPage.tsx` and its
  entry-actions page contract;
- desktop rail Quick Note/Today props, handlers, markup, styles, and tests;
- `NexusPage.Find`, `NexusFindScope`, scope setters, mobile-only provider
  state, `OpenContext` typed-query fallback, `SearchWeb`, and dead adapters;
- any duplicate action-menu keyboard logic replaced by `ActionMenu` behavior.

Before deletion, use reference search to preserve unrelated pane status,
Manage Tabs, recovery, performance, and mobile lifecycle behavior. Do not retain
an adapter solely to keep old tests green.

## Delivery Order

One hard-cut branch; no partial production state.

1. Update normative docs and lock independent behavior fixtures.
2. Move the existing player provider boundary and prove one runtime owner.
3. Add command, intent, target-materialization, return-point, and projection
   contracts with pure ranking/group/stability tests.
4. Compose projections from existing providers, history, and player state.
5. Cut desktop to the sectioned grid and sole `ActionMenu` action surface.
6. Cut mobile Root to `SwitchboardSearch`, gesture-owned autofocus, compact
   canonical groups, and the typed handoff adapter.
7. Add seeded Create/Browse/Today workflows, direct/recovery Manage Tabs, and
   remove rail Quick Note/Today.
8. Consolidate performance ownership; delete superseded result, Find, action,
   navigation, name, style, and test paths.
9. Run focused proof, static checks, real Chromium, thin real-stack journeys,
   and required physical-device smoke.

Do not merge a slice that leaves both result engines or both navigation/action
owners reachable.

## Acceptance Criteria

### Product

- Desktop opens with input focus. A direct mobile Nexus-control tap opens Root,
  focuses search, and requests the software keyboard in the same event flush.
- Desktop blank state renders Open, optional Continue, Recent, and Quick
  Actions. Mobile renders Open, Quick Actions, optional Continue, Recent, and
  canonical Places. Caps are independent.
- Quick Note and Today appear in both Nexus blank states and nowhere in the
  desktop rail.
- Mobile retains one-tap Lectern, Libraries, Browse, Podcasts, Chats, and Notes
  without restoring the old Places dashboard/projection.
- Typing removes blank-state sections; nonmatching tabs are absent.
- Reserved verbs and slash aliases put explicit intent first without executing
  during typing. Bare-letter phrases remain search.
- Ordinary exact existing matches beat command keywords and generic Create.
- `a tale of two cities`, `i robot`, and `c programming` do not compile to Ask,
  Import, or Chat.
- Generic Create exposes exactly Today Note, Page, Chat, and Library.
- Query seeds reach the correct owned draft/title/name field.
- Import never discards text: canonical URLs seed Add; other arguments remain
  search.
- Add to Today appends only through the daily owner. A non-appendable atomic
  draft produces an announced unavailable action, keeps the query, and performs
  no navigation or mutation.
- Browse kind intent routes to the existing typed Browse surface; ambiguous
  Browse never fans out `All`.
- Desktop places Ask, Add to Today, Browse, Create, and See All after at most
  eight owned results. Mobile keeps the same actions pinned below search.
- A bare URL remains exact Import and does not ingest on selection.
- Continue resumes the current session from the sole player provider; media
  result actions expose only operations valid for their owned subject.
- Direct Manage Tabs works without retained activation. Recovery Manage Tabs
  preserves and retries/cancels the exact retained activation.

### Interaction and accessibility

- Desktop rows use valid combobox/grid semantics with no button inside an ARIA
  option.
- Every desktop row with secondary actions has a pointer Actions control;
  the configured `Nexus.Open` shortcut opens the same `ActionMenu` for the
  active row.
- `aria-activedescendant` reaches primary and Actions cells; Up/Down moves
  rows, Left/Right moves cells, Enter invokes the active cell, and Tab exits the
  composite.
- Enter, Shift+Enter, Escape, pointer, IME, selection stability, menu focus
  return, and dialog focus return preserve their contracts.
- Mobile retains full-screen geometry, one scroll owner, 48 px targets,
  safe-area behavior, software-keyboard visibility, focus containment, and
  guarded Back/Escape.
- Mobile Root with text consumes Back/Escape by clearing its query; the next
  Back/Escape dismisses. Nested workflows restore query and active identity.
- No primary operation depends on hover, long press, Tab, Right Arrow, or a
  memorized shortcut. Secondary desktop actions have both grid-cell and
  configured-shortcut access.
- Provider arrivals preserve a surviving active identity and explicit stable
  prefix inside, never beyond, the eight-result cap.

### Architecture and deletion

- One command registry, one intent compiler, one entry/group composer, one
  target materializer, one provider lifecycle, and one dispatch path remain.
- Both renderers consume `NexusProjection`; neither owns membership, semantic
  ranking, command lists, or targets.
- Exactly one typed mobile activation adapter exists. It switches only on
  activation kind and cannot mint identity or dispatch alternate targets.
- `SwitchboardRowModel`, `mergeSwitchboardRows`, mobile Find scopes, Places
  projection, Root -> Find, `OpenContext` typed fallback, `SearchWeb`, and
  `DesktopNexusActionsPage` are absent.
- Canonical destination entries, not `lib/switchboard/places.ts`, own mobile
  Places.
- One `GlobalPlayerProvider` encloses Nexus and existing workspace/player
  consumers; no bridge, snapshot, or second resume source exists.
- `lib/nexus/performance.ts` owns all Nexus metrics and no consumer imports
  `lib/switchboard/performance.ts`.
- Daily locators use the tagged `DailyPageLocator`; `"Today" | string` is
  absent from the changed contract.
- No superseded registry symbol, type, result model, merge, scope, component,
  CSS, test, or compatibility alias remains.
- No backend endpoint, migration, action-history store, LLM path, or new search
  subsystem is added.
- `useNexusController` is smaller and contains orchestration, not duplicated
  pure projection logic.
- Module docs describe the final state and older cutovers carry explicit
  supersession notices.

### Proof

- Pure intent fixtures cover every verb, synonym, slash alias, incomplete
  command, canonical/noncanonical URL, the three named collisions, and generic
  fallback.
- Pure group/rank fixtures independently assert section order, caps, dedupe,
  exact-before-keyword/generic-Create, matching-tabs-only, score-before-
  frecency, href-only frecency, fixed query actions, and surface layout.
- Progressive fixtures prove the active/stable-prefix reservation never exceeds
  eight entries and deterministic fallback occurs only when a key disappears.
- Architecture fixtures prove provider ancestry, one materializer/dispatch,
  direct/recovery Manage Tabs, performance imports, and legacy-file deletion.
- New critical behavior demonstrates red/sensitivity against a representative
  wrong rank, dropped seed, cap eviction, duplicate identity, or duplicate
  dispatch.
- Real Chromium component proof covers desktop grid/action semantics and mobile
  flush focus, Back, compact/pinned layout, unavailable Today append, action
  menus, and progressive results.
- Thin real-stack journeys cover Page/Library replay, Today Note persistence,
  Browse routing, Continue/player wiring, Search, and Openables without
  repeating kernel cases.
- Android hardware Back/WebView keyboard and physical iOS focus/keyboard smoke
  are release gates and are reported separately from Chromium proof.
- Static checks, build, focused tests, and `git diff --check` pass. Unrun CI,
  device, deploy, and production gates are never reported as passed.

## Completion Invariant

The cutover is complete only when one typed Nexus capability can be discovered,
ranked, acted on, retried, and tested through either platform projection without
any Switchboard-specific semantic translation.

If desktop and mobile can disagree about whether a command exists, what it
means, how it ranks, or which target it dispatches, the cutover is incomplete.
