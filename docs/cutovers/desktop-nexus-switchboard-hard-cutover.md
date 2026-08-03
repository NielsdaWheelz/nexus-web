# Desktop Nexus Switchboard Hard Cutover

Status: IMPLEMENTED — repository and real-stack verification complete —
production deployment pending — 2026-07-29
Type: hard cutover

**Superseded Nexus contract (2026-07-31):**
[`nexus-intent-router-hard-cutover.md`](nexus-intent-router-hard-cutover.md)
replaces this document's shared five-row zero-state cap, exactly four actions,
no Continue/Library exclusion, unrelated OpenContext matches, listbox/footer
Actions model, `SearchWeb`, continuation placement, and separate mobile result
ownership. This file is implementation history for all replaced clauses.

**Historical follow-up authority (2026-07-30):**
[`daily-pages-quick-capture-hard-cutover.md`](daily-pages-quick-capture-hard-cutover.md)
replaces “New Note reuses Today Capture” with the pane-native `Quick Note`
entry and deletes Today Capture. The desktop Nexus zero state remains exactly
four actions: Quick Note, New Chat, New Page, and Import.

## Decision

Replace the desktop Launcher with **Nexus**: one keyboard-first workspace
switchboard for Open, Find, Create, and explicit live Web Search.

No open questions. Product defaults in this document are final.

On implementation this document supersedes and deletes
`docs/cutovers/universal-launcher-hard-cutover.md`. There is no feature flag,
dual surface, lane/sigil compatibility, legacy event/API alias, fallback
ranker, or retained `launcher` / `command_palette` runtime naming.

Mobile presentation, result composition, and interaction remain owned by
`components/switchboard/*` and `lib/switchboard/*`. Shared session/workflow
owners are renamed to Nexus. Existing mobile Root, Find, Create, layout,
gesture, ranking, and merge behavior remain unchanged. Cross-viewport
WebSearch URL ingress is additive and reuses the Switchboard row,
Adopt/Fork, and recovery grammar.

**Approved mobile follow-up (2026-07-30):**
[`mobile-nexus-full-screen-task-hard-cutover.md`](mobile-nexus-full-screen-task-hard-cutover.md)
supersedes only this document's
historical `mobile → existing SwitchboardSheet + NexusButton` composition.
After that cut, the mobile branch is `SwitchboardTask + NexusButton`; desktop
Nexus and every shared controller/result contract here remain unchanged.

Governing standards:
`docs/rules/{simplicity,cleanliness,boundaries,layers,frontend,control-flow,keys-and-identities,naming,timing,database,concurrency,operation-types,retries,errors,testing}.md`.

## Scope / 80/20 Boundary

Build:

- one shell-owned Nexus controller and session;
- one new one-column desktop Nexus surface;
- a quiet zero state: open/recent internal targets, New Chat, New Note, New
  Page, and Import;
- type-to-Find across panes, destinations, capabilities, openable resources,
  and canonical owned search;
- one explicit, non-blended live Web Search page using the existing provider;
- `Enter` Follow and `Shift+Enter` Fork through every target-producing workflow;
- one contextual action page with an always-available pointer ingress;
- stable progressive results and prefetch-on-selection;
- the minimum search-score correction required for trustworthy mixed results;
- a hard rename of Launcher/palette runtime, persistence, API, keybinding, and
  active-doc ownership to Nexus.

Reuse:

- `activateWorkspaceTarget` and `Follow | Fork | Adopt`;
- `ResourceActionSubject`, `ResourceActivation`, and canonical resource actions;
- `SearchQuery`, `/api/search`, `SearchResultRowViewModel`, and resource
  openables;
- `/web/search` and `search_web_readonly` for explicit live Web Search;
- `DESTINATIONS`, `QUICK_ACTION_REGISTRY`, Add, Today Capture, Page, Chat,
  Library, Import, and Podcast workflows;
- the mobile Switchboard's existing presentation, owner projection, result
  stability, performance marks, pane-cap recovery, and tests in place;
- the existing overlay, modal-layer, focus-return, prefetch, feedback,
  keybinding, replay-ledger, and API-proxy primitives.

Do not build:

- a new backend retrieval endpoint, index, table, embedding, reranker, or agent;
- generic `resource_edges` / backlink result rows;
- saved searches, pins, demotions, ranking settings, or a learned click model;
- live Web results blended into Find;
- new creation semantics, collaboration, offline sync, voice, or OS integration;
- a preview column or preview loader;
- redesign of existing mobile layout, gesture, navigation, sheet, ranking, or
  merge behavior;
- a second capability registry or a generic command framework.

## Goals

1. Make every common job one invocation plus one selection.
2. Remove exposed modes, lane syntax, and app-taxonomy recall.
3. Make activation disposition uniform and impossible for workflows or recovery
   to discard.
4. Make exact/open/local results immediate and remote results progressive but
   identity-stable.
5. Keep domain policy in existing owners; Nexus only projects, ranks, and
   dispatches typed capabilities.
6. Lower total code, concepts, and public surface.

## Target Behavior

### Entry and persisted invocation

- The user-configurable `Nexus.Open` binding opens Nexus with the input focused;
  its default is `Meta+k`, interpreted as Cmd on Apple platforms and Ctrl
  elsewhere.
- The Settings row is named `Open Nexus`. The rail Nexus control invokes the
  same owner.
- The hard cut replaces persisted `open-launcher` with `Nexus.Open` and
  `nexus.keybindings.v1` with unversioned `nexus.keybindings`. During the
  maintenance window, migrate the sole user's stored combo and delete the old
  storage key before the final frontend is released. Shipped runtime reads only
  the final key and action id; it contains no old-key branch.
- `useNexusController` owns the document-level executor for `Nexus.Open`, every
  configured destination binding, and Go to Today, including while Nexus is
  closed. `WorkspaceHost` retains pane-next/pane-previous bindings.
- The input label and placeholder are `Find anything…`.
- The exact external open event is `Nexus.OpenRequested` with
  `NexusOpenIntent`; the distinct `Nexus.Open` identifier belongs only to the
  keybinding registry.
- The exact one-shot URL protocol is
  `?nexus=1&intent=Root|WebSearch|QuickAction&q=...&action=...`: Root admits
  neither payload field, WebSearch requires only nonblank `q`, and QuickAction
  requires only a registered `action`. The parser rejects every other
  combination and strips accepted Nexus parameters with `history.replaceState`.
- `/browse` remains a permanent redirect ingress. With `q` it targets
  `/?nexus=1&intent=WebSearch&q=...`; without `q` it targets
  `/?nexus=1&intent=Root`. The old
  `?launcher=1&lane=...` protocol is deleted.

### Zero state

Zero state renders, in order:

1. up to five navigation rows: all open panes in workspace order, then most
   recent internal history rows not already represented, until the shared cap;
2. exactly New Chat, New Note, New Page, and Import.

Rules:

- There is no Resume/Continue concept separate from open and recent rows.
- New Note reuses Today Capture and creates a note on today's page.
- Library and Podcast remain searchable capabilities and retain their existing
  contextual/mobile entry points; they are not zero-state desktop actions.
- Places and settings are searchable, not a permanent button wall.

### Find and retrieval

| Source | Threshold | Debounce | Exact admitted contract |
|---|---:|---:|---|
| Local | 1 character | none | all open panes, render-environment-admitted `DESTINATIONS`, and `QUICK_ACTION_REGISTRY` entries |
| Resource openables | 1 character | first character immediate; refinements 80 ms | every typed item returned by `/api/resource-items/openables/search` |
| Canonical owned search | 2 characters | 160 ms after Openables is terminal | contributor, media, podcast, episode, video, content chunk, fragment, page, note block, highlight, message, evidence span, conversation, artifact, and reader apparatus item |
| Live Web Search | explicit continuation only | existing owner | `/api/web/search`; never `web_result` rows from persisted canonical Search |

- Local rows and the first active identity commit synchronously for each query
  revision.
- Successful Openables responses use a 32-query, invocation-scoped LRU keyed
  by normalized query. Reopening Nexus and every successful Nexus-owned
  resource mutation clear it; mutation invalidation also revalidates the active
  query identity. The modal prevents concurrent pane mutation during an
  invocation. The endpoint projects ranked candidates in bounded batches until
  20 admitted routes exist.
- Canonical owned retrieval is enrichment: it starts only after Openables is
  ready or failed and the 160 ms quiet period elapses. Rapid query revisions
  therefore never launch stale deep SQL before first usable rows commit.
- Canonical Search uses `SearchQuery` with Web excluded.
- A bare URL produces the exact-rank `Import URL` entry and opens Add with the
  URL prefilled. It never ingests on selection.
- For non-URL queries of at least two characters, append `Ask Nexus about …`,
  `Search the web for …`, and `See all results for …` in that fixed order after
  capped owned results. Continuations are not ranked and cannot be displaced by
  the owned-result cap.
- Ask enters the existing Chat creation workflow with the query.
- Search Web enters `NexusPage.WebSearch`; See All opens canonical Search with
  the serialized `SearchQuery`.
- Web Search renders live provider results only. Selecting one opens Add with
  its URL prefilled; it does not silently ingest.
- Result rows show type, label, owner/source, matched excerpt, and open state
  only when those facts already exist.
- Deep occurrences group under their canonical owner/open pane. Occurrence,
  owner, activation route, and pane identities are never inferred from labels or
  rewritten URLs.

### Selection stability and prefetch

- Each query revision atomically commits synchronous rows and their first active
  `NexusEntryKey`.
- Provider arrivals may reorder the uncommitted tail but never change the active
  identity. Once the user arrows or points to a row, arrivals also preserve that
  row and every surviving row above it.
- If the active row disappears, select the surviving row at the same index, or
  the preceding row when no such successor exists.
- Physical pointer movement may change the active row or cell. Result or layout
  reflow beneath a stationary pointer must not change virtual selection.
- Enter snapshots the active key from the committed view before dispatch.
- `useNexusController.setActiveEntry` is the sole prefetch owner. Hover and
  Arrow Up/Down call it. It warms only known internal pane targets; workflows,
  continuations, and external URLs do not prefetch.

### Activation

| Input | Contract |
|---|---|
| click / `Enter` | `Follow`: activate exact pane; otherwise navigate the active pane |
| Shift+click / `Shift+Enter` | `Fork`: always create a fresh pane after the origin |
| mobile workflow default | existing `Adopt`; mobile explicit Open another tab remains `Fork` |
| Meta/Ctrl/Alt, middle-click, external/native link gesture | browser/platform owned |

Rules:

- Activation is one value carried from entry selection through continuation,
  mutation commit, pane-cap recovery, and final target activation.
- Desktop workflows capture `Follow` from Enter/click and `Fork` from
  Shift+Enter/Shift+click. A breakpoint change preserves the captured value.
- `Shift+Enter` never means Ask.
- A committed mutation is never repeated after activation rejection or retry.
- At the 12-pane cap, retain the exact target, captured activation, and
  completion record. Manage Tabs changes panes; Open retries activation only.
- `source` is observability/history metadata and never reconstructs activation.
- Selection history records only after `NavigationAccepted`.

### Keyboard, focus, and actions

| Key | Behavior |
|---|---|
| Arrow Up/Down | move active result |
| `Enter` | snapshot and execute primary action with Follow |
| `Shift+Enter` | snapshot and execute primary action with Fork |
| configured `Nexus.Open` binding while open | open selected entry's action page |
| Escape in actions/workflow | return to prior Nexus page, respecting dismissal guards |
| Escape with query | clear query |
| Escape on empty root | close and restore invocation focus |
| Left/Right, Home/End, selection, deletion | input-owned text editing |

- Enter and Shift+Enter are ignored when
  `nativeEvent.isComposing || nativeEvent.keyCode === 229`.
- While results are active, the combobox keeps DOM focus and
  `aria-activedescendant` owns result focus.
- The selected entry's `Actions for {label}` control sits outside the listbox,
  remains pointer-accessible at every desktop width, and renders only when
  secondary actions exist.
- Invoking the configured binding with no secondary actions is a no-op.
- The action page is a labelled `menu` within the Nexus dialog. Opening it moves
  focus to its first `menuitem`; closing it restores the input and selected
  entry.
- A result option has one activation and no nested interactive descendants.
- Closing after navigation never steals focus from the destination.

## Final Structure and Ownership

```text
AuthenticatedShell
└── Nexus
    ├── useNexusController
    │   ├── shared session/pages/workflows
    │   ├── global keybinding and open-intent ingress
    │   ├── desktop result orchestration
    │   └── dispatch → workspace/resource/domain owners
    ├── desktop → DesktopNexus
    └── mobile  → existing SwitchboardSheet + NexusButton
```

| Concern | Sole owner |
|---|---|
| Shared session, workflows, retained activation, source lifecycle, ingress | `components/nexus/useNexusController.ts` |
| Desktop presentation and focus | `components/nexus/desktop/*` |
| Desktop entry projection, dedupe, stable merge | `lib/nexus/results.ts` |
| Deterministic desktop rank | `lib/nexus/ranking.ts` |
| Mobile presentation and pre-existing result behavior | existing `components/switchboard/*`, `lib/switchboard/*` |
| Nexus entry/target/action/page types | `lib/nexus/model.ts` |
| Quick creation/acquisition semantics | `lib/nexus/quickActions.ts` |
| Contextual resource actions | existing resource-action catalog projected by `lib/nexus/actions.ts` |
| Side effects and activation outcomes | `lib/nexus/dispatch.ts` |
| External event and URL intents | `lib/nexus/events.ts` |
| Keybinding persistence and matching | `lib/keybindings.ts`, `lib/keybindingsProvider.tsx` |
| Canonical search transport/projection | `lib/search/*`, `/api/search` |
| Live Web Search transport | `lib/nexus/webSearch.ts`, `/api/web/search`, backend `/web/search` |
| Search candidate scoring | `python/nexus/services/search/ranking.py` |
| Usage history/frecency | `python/nexus/services/nexus_history.py` |
| Exactly-once selection replay | existing `resource_mutations` ledger/service |

Nexus never owns domain mutations, pane creation, search retrieval, resource
policy, destination identity, or mobile ranking/merge behavior. Share canonical
contracts; do not force unlike desktop/mobile result algorithms into a hollow
generic helper.

## Capability Contract

`NexusEntry` is a presentation projection, not a new domain registry:

```text
NexusEntryKey =
  | { kind: "Pane", paneId }
  | { kind: "Destination", destinationId }
  | { kind: "Resource", occurrenceRef }
  | { kind: "QuickAction", actionId }
  | { kind: "ImportUrl", normalizedUrl }
  | { kind: "Continuation", id: "Ask" | "SearchWeb" | "SeeAll" }

NexusRankTier =
  | "Exact"
  | "Prefix"
  | "Token"
  | "Alias"
  | "OpenContext"
  | "FuzzyTitle"
  | "Metadata"
  | "FullText"

NexusEntry = {
  key: NexusEntryKey,
  label,
  metadata?,
  snippetSegments?,
  primaryAction: NexusAction,
  secondaryActions: NexusAction[],
  rank: { tier: NexusRankTier, score, frecency }
}

NexusAction = { id, label, icon, target: NexusTarget }
```

`key.kind` is the entry family; do not duplicate it with `NexusEntry.kind`.
DOM ids derive from the serialized key only at render.

Hard-rename the exhaustive target union to PascalCase discriminators:

```text
NexusTarget =
  | InternalHref
  | ResourceOpen | ResourceShare | ResourceChat
  | Ask | QueueAdd | NewConversation
  | Share | CopyExternalLink
  | PaneOpen | PaneClose | OpenToday
  | OpenAdd | OpenTodayCapture | CreatePage | CreateLibrary
  | PodcastDiscovery | OpenWebSearch
```

- Delete `set-lane`, `browse-acquire`, direct `add-url`, and query-derived
  `create-note`.
- `CreateLibrary`, `PodcastDiscovery`, and `OpenWebSearch` are concrete Nexus
  page transitions, not generic command targets or entry-key special cases.
- Preserve QueueAdd projection for canonical media, episode, and video results;
  `lib/nexus/results.ts` owns its call site.
- Extend `AddSeed.Content` with optional `initialUrlDraft`. Bare-URL Import and a
  selected Web result set it; all existing Add callers omit it.
- Every selectable entry has exactly one primary action.
- Secondary actions derive only from the canonical resource-action catalog,
  workspace pane capabilities, or quick-action registry.
- `NexusTarget` dispatch remains one exhaustive switch. Components do not call
  mutations, pane APIs, `window.location`, or resource executors directly.

Open/page contracts:

```text
NexusOpenIntent =
  | Root
  | Add { seed }
  | QuickAction { actionId }
  | WebSearch { query }

NexusPage =
  | Root
  | Find { query, scope }
  | Actions { entry, actions }
  | WebSearch { query, status }
  | TodayCapture { sessionId, activation }
  | CreatePage { pageId, submit, activation }
  | CreateLibrary { nameDraft, libraryId, submit, activation }
  | Add { sessionId, activation }
  | PodcastDiscovery { query, sessionId, activation }
  | ActivationBlocked { retained }
  | ManageTabs { retained }

RetainedActivation = {
  target,
  activation,
  source,
  completion,
  returnTo
}
```

`RetainedActivation` exists only in `ActivationBlocked` and `ManageTabs`.
NavigationAccepted or Cancel clears it; Manage Tabs, source refresh, and
breakpoint changes preserve it. Branch every union exhaustively.

## Result Composition and Ranking

```text
zero state =
  open panes
  + recent internal history not already open
  + Chat / Note / Page / Import

typed owned =
  local panes
  + destinations / capabilities
  + resource openables
  + canonical search rows

final =
  ranked capped owned rows
  + fixed Ask / SearchWeb / SeeAll tail
```

- `lib/nexus/results.ts` owns desktop projection, dedupe, queue-action
  projection, and stable progressive merge.
- `lib/switchboard/merge.ts` remains the mobile owner; do not extract or replace
  it in this cutover.
- Deduplicate by `NexusEntryKey`; an exact open pane represents its target above
  closed/resource occurrences.
- Rank lexicographically by tier, source score, bounded frecency, fixed source
  order, then serialized semantic key.
- Frecency never crosses a tier and never defeats Exact or Prefix.
- Do not sum unrelated arbitrary score scales.
- The checked-in ordering fixture must pin the final semantic-key tiebreak.

### Search-score correction

The backend currently applies `TYPE_WEIGHTS` before per-type min-max
normalization, which cancels the weights. Hard-cut the order:

1. normalize raw scores within each result type;
2. apply the type weight to the normalized value;
3. divide by the maximum configured positive weight to retain `[0, 1]`;
4. sort and project that final score.

Carry API `score` through `SearchResultRowViewModel`; do not replace it with
`1`. Do not change the HTTP Search schema.

Add one small mixed fixture proving exact documents, notes, highlights,
conversations, contributors, reader apparatus, content chunks, fragments,
evidence spans, and media ordering. Do not name or seed `passage_anchor`, which
is not a public `/search` result type. No new eval framework.

## Nexus History API and Storage

Hard rename and simplify the current capability:

```text
NexusHistorySource =
  "Static" | "Workspace" | "Recent" | "Oracle" | "Search" | "Ai"

GET /me/nexus-history?query=...

NexusHistoryOut = {
  recent: [{
    target_href,
    label_snapshot,
    source,
    last_used_at
  }],
  frecency_by_href: Record<InternalHref, number>
}

POST /me/nexus-selections

NexusSelectionRecordRequest = {
  client_mutation_id,
  query,
  target_href,
  label_snapshot,
  source: NexusHistorySource
}

NexusSelectionRecordOut = {
  use_count,
  last_used_at
}
```

- Wire fields are exact snake_case; unknown and old fields are rejected.
- `client_mutation_id` is 1–120 characters; `query` is optional and bounded by
  the current 500-character ingress limit; `label_snapshot` is 1–120 characters.
- `target_href` is a required canonical supported internal route.
  Nonnavigating and external actions are not recorded.
- History identity and frecency join by canonical `target_href`, derived once
  from an internal-navigation primary target. `NexusEntryKey` is never a wire or
  storage key.
- The client mints one stable `client_mutation_id` per accepted selection.
- The handler uses `resource_mutations` with scope
  `Nexus.SelectionRecord`, canonical full-request hashing, `{}` changed lanes,
  and the response above. Replay of the same id/payload returns the memo without
  incrementing usage; reuse with different payload returns the existing
  idempotency-key mismatch conflict.
- Usage update and replay memo commit in one transaction.
- History returns at most five recent internal targets. Frecency is bounded and
  applies only within one rank tier.

### Migration

One migration owns this exact order:

1. record preflight counts grouped by `target_kind` and `source`;
2. delete every row whose `target_kind <> 'href'`;
3. assert every retained row has `target_kind = 'href'` and non-null
   `target_href`;
4. rename `command_palette_usages` to `nexus_usages`, including model,
   relationship, constraints, and indexes;
5. rename `title_snapshot` to `label_snapshot`;
6. replace uniqueness with
   `(user_id, query_normalized, target_href)` and drop duplicate `target_key`;
7. drop `target_kind` and make `target_href` non-null;
8. drop the old source-value `CHECK`, then map sources one-to-one:
   `static→Static`, `workspace→Workspace`, `recent→Recent`, `oracle→Oracle`,
   `search→Search`, `ai→Ai`;
9. validate the final source vocabulary in the application owner; add no new
   business-enum `CHECK`.

Preserve every href aggregate, count, timestamp, label, source, and canonical
href. Dropped `target_key` is intentionally canonicalized to that href. Deleted
action/prefill history is not recoverable. The reverse migration reconstructs
retained rows with
`target_kind='href'`, `target_key=target_href`, and the exact inverse six-value
source mapping; it does not recreate deleted non-href rows.

Migration tests seed href/action/prefill and all six source values, prove the
deletion/preservation counts, and prove forward/reverse fidelity for retained
href rows.

Delete `/me/palette-history`, `/me/palette-selections`, their web proxies,
schemas, services, and old imports in the same maintenance window. Create exact
web proxies for `/api/me/nexus-history`, `/api/me/nexus-selections`, and
`/api/web/search`. No compatibility view, alias, dual-write, or fallback.

## Failure and Recovery Contract

- Local projection, impossible union states, malformed same-system payloads, and
  activation/identity mismatches are defects and reach the existing boundary.
- Openables and canonical Search each own `Idle | Loading | Ready |
  RetryableFailure`. A typed source failure preserves query, committed rows,
  active identity, and other successful sources; its retry control sits outside
  the listbox.
- Web Search owns the same status shape. Provider-unavailable retains the query
  and exposes Retry on the Web Search page.
- Query revision aborts stale work. Expected abort/cancellation is silent;
  delayed success or failure from an old revision is ignored.
- Authentication failures use the global unauthenticated owner.
- Workflow typed failures stay on their workflow page and retry with the same
  replay identity. Defects are never converted to retryable UI.
- ActivationBlocked retains the committed completion plus exact activation.
  Open retries only activation; Cancel returns to `returnTo`.
- Selection logging is a separate post-navigation mutation. A typed logging
  failure reports non-blocking feedback and may retry only the log with the same
  `client_mutation_id`; it never retries navigation. A defect reaches the
  existing defect boundary.
- Prefetch consumes expected cancellation only. It never changes visible state
  or hides a same-system defect.

## Visual and Performance Contract

- One near-opaque warm one-column surface using existing canvas, ink, spacing,
  radius, focus, and motion tokens.
- Width `min(720px, calc(100vw - 48px))`; maximum height `70dvh`.
- Rows are at least 44 px high; type labels and excerpts remain subordinate to
  the primary label.
- Actions live in the shell footer/action page, never inside result options.
- No preview column, lane pills, sigil legend, permanent per-row buttons,
  rainbow type colors, or decorative glass effects.
- Rename `--z-palette` and `--palette-glass-*` globals to the minimal Nexus
  tokens still used; delete unused glass tokens.
- Input/local results paint synchronously.
- Named p95 gates on the existing benchmark corpus:
  - open to focused/input-ready: `<50 ms`;
  - keystroke to local rows committed: `<50 ms`;
  - accepted open-pane activation to pane paint: `<100 ms`;
  - openables/deep first usable results: `<250 ms`.
- Provider timing emits exactly one sample per revision: the first eligible
  source whose identity-current rows commit. The losing timer is canceled.
  Cold and warm runs each record 20 samples and report winner source plus p95.
- Abort stale provider work on every query revision.
- Reduced motion removes nonessential transition.

## Hard-Cut File Plan

Create/move:

- `apps/web/src/components/nexus/Nexus.tsx`;
- `apps/web/src/components/nexus/useNexusController.ts`;
- `apps/web/src/components/nexus/{AddPanel,AddPanelBoundary,TodayCapturePanel}.tsx`;
- `apps/web/src/components/nexus/{useAddContentSession,useTodayCaptureSession,addContentSessionModel}.ts`;
- `Nexus.test.tsx`, `AddPanel.test.tsx`, `TodayCapturePanel.test.tsx`,
  `useAddContentSession.test.tsx`, and `addContentSessionModel.test.ts`;
- `AddPanel.module.css` and `TodayCapturePanel.module.css`;
- `apps/web/src/components/nexus/Nexus.module.css`;
- `apps/web/src/components/nexus/desktop/{DesktopNexus,DesktopNexusInput,DesktopNexusResults,DesktopNexusRow,DesktopNexusActionsPage,DesktopNexusWebSearch}.tsx`;
- `DesktopNexusInput.test.tsx` and `DesktopNexusRow.test.tsx`;
- `apps/web/src/components/nexus/desktop/desktopNexus.module.css`;
- `apps/web/src/lib/nexus/{model,results,ranking,actions,dispatch,events,quickActions,webSearch,performance}.ts`;
- migrated tests for results, ranking, actions, dispatch, events, quick actions,
  and `architectureInvariants.test.ts`;
- `apps/web/src/app/api/me/{nexus-history,nexus-selections}/route.ts`;
- `apps/web/src/app/api/web/search/route.ts`;
- `python/nexus/{schemas,services}/nexus_history.py`;
- one `migrations/alembic/versions/*_nexus_usage_hard_cutover.py`.

Delete after moves and call-site conversion:

- obsolete desktop files `LauncherSurface`, `LauncherInput`, `LauncherList`,
  `LauncherRow`, `LauncherLaneChips`, `LauncherFooter`, and
  `launcher.module.css`;
- obsolete library owners `parseLauncherInput`, lane/sigil model, old providers,
  and their dead tests;
- the emptied `components/launcher` and `lib/launcher` directories;
- `python/nexus/{schemas,services}/command_palette.py`;
- web/backend palette-history and palette-selection routes;
- `docs/cutovers/universal-launcher-hard-cutover.md`;
- Launcher/palette outstanding issues made dead by this cutover.

Do not glob-delete either old directory before moving retained workflows,
styles, tests, quick actions, dispatch/actions logic, and architecture
invariants.

Edit:

- `AuthenticatedShell`, `AppNav`, Notes, Libraries, Podcasts, Switchboard, OPML,
  and Android-shell imports/callers;
- `lib/keybindings.ts`, `lib/keybindingsProvider.tsx`, and
  `settings/keybindings/{KeybindingsPaneBody,KeybindingsPaneBody.test}.tsx`;
- `components/ui/MobileSheet.module.css` for the renamed Nexus z-index token
  only; computed style and behavior must not change;
- `lib/switchboard/model.ts` and Switchboard components only for renamed shared
  controller/model imports; retain `lib/switchboard/merge.ts` behavior;
- `lib/search/{types,searchViewModel}.ts` to retain score;
- `lib/api/useDebouncedFetch.ts` for identity-carrying success/error state and
  retained data on failed retry;
- `python/nexus/services/search/{ranking,candidates}.py`;
- `python/nexus/services/resource_items/openables.py` for bounded ranked
  projection;
- DB models, `me` routes, API router/proxy guards, `globals.css`,
  `browse/page.tsx`, workspace bootstrap/query parsing, and their tests;
- E2E: rename `e2e/tests/launcher.spec.ts` to `nexus.spec.ts`; update
  `auth.spec.ts`, `authors.spec.ts`, `consumption-stats.spec.ts`,
  `hydration-determinism.spec.ts`, and `mobile-sheets.spec.ts`;
- path/architecture guards:
  `lib/libraries/placementResidue.test.ts`,
  `libraries/[id]/LibraryPaneBody.ac4.test.tsx`,
  `podcasts/PodcastsPaneBody.test.tsx`, `appnav/AppNav.test.tsx`,
  `switchboard/SwitchboardRoot.test.tsx`, and renamed
  `lib/androidShell.nexus.test.tsx`;
- active architecture/module/mobile docs plus relevant `docs/dreams/*` and
  `docs/horizons/*` references. Immutable migration history may retain history.

Retain:

- pre-existing `components/switchboard/*` behavior/styles and
  `lib/switchboard/*` mobile algorithms; additive WebSearch uses their existing
  row and activation primitives;
- `/api/search`, resource openables, backend `/web/search`, `/api/browse`, and
  Browse service used by Podcast Discovery;
- the Browse client made private to Podcast Discovery;
- existing domain workflow clients and resource/workspace owners.

Scoped negative gate after implementation:

```text
Launcher | launcher | command_palette | palette-history | palette-selections
open-launcher | OPEN_LAUNCHER | launcher=1
LauncherLane | LANE_SIGIL | set-lane
```

The gate applies to `apps/web/src`, `python/nexus`, `e2e`,
`docs/architecture.md`, `docs/modules`, `docs/dreams`, and `docs/horizons`.
Cutover/migration history is excluded. Do not grep for bare `lane` or `sigil`;
those words belong to unrelated retained domains.

## Implementation and Deployment

1. Write red behavior tests for entry/binding, URL intent, disposition,
   retained activation, stable selection, source failure, narrow-pointer
   actions, ranking, Web Search, and new history API.
2. Add migration tests and the exact forward/reverse migration.
3. Rename the shared session/workflow/model owners and migrate mobile imports
   without changing mobile behavior.
4. Correct Search score order and retain API score.
5. Build the desktop surface, fixed continuations, and explicit Web Search page.
6. Switch every ingress and global binding; then delete old surface, provider,
   parser, event, API, storage, and naming paths.
7. Update active docs and run focused static, unit, component,
   service-integration, real-stack E2E, migration, performance, and scoped
   negative-grep gates.

Deploy in one maintenance window:

1. stop old frontend writes and record production preflight counts;
2. migrate the sole browser keybinding record;
3. run the database migration;
4. deploy backend and frontend final states;
5. hard reload and smoke Nexus open, Find, Web Search, create, pane-cap retry,
   history replay, `/browse`, and mobile Switchboard.

There is no mixed-version compatibility period. Rollback deploys the paired
previous backend/frontend and runs the reverse migration for retained href rows.
The explicitly deleted non-href history remains deleted.

## Acceptance Criteria

- **AC1:** Desktop has one Nexus surface. `Nexus.Open` is configurable, displayed
  in Settings, and globally executes with all destination/Today bindings. No
  scoped old naming or bootstrap path remains.
- **AC2:** Empty Nexus shows at most five deduplicated open/recent internal rows
  and exactly Chat/Note/Page/Import; no Resume/Continue row exists.
- **AC3:** The retrieval matrix is covered source-by-source: all local registry
  entries, one-character openables, every listed two-character canonical type,
  and no Web result in blended Find.
- **AC4:** Enter/click Follow and Shift+Enter/Shift+click Fork for panes,
  destinations, resources, deep occurrences, continuations, Web-result Import,
  and every target-producing workflow.
- **AC5:** Create/Import commits survive pane-cap rejection and retry the exact
  captured activation without replaying mutation.
- **AC6:** Exact/open/prefix outrank full text; type weights affect mixed order;
  frontend preserves score; the semantic-key tiebreak is fixture-pinned.
- **AC7:** From the first synchronous commit, provider arrivals preserve active
  identity; after movement they preserve the surviving prefix; pre-move Enter
  executes the committed identity.
- **AC8:** Result options have no interactive descendants. Tests cover Arrow
  navigation, input-owned Home/End, both IME signals, narrow pointer Actions,
  screen-reader name/state, focus return, dismissal guards, and reduced motion.
- **AC9:** Contextual actions derive from existing owners; QueueAdd remains
  reachable; every action executes through one exhaustive PascalCase Nexus
  dispatch.
- **AC10:** Selection recording uses `client_mutation_id` plus
  `resource_mutations`; identical replay does not increment, mismatch conflicts,
  and only NavigationAccepted internal hrefs record.
- **AC11:** Migration tests prove explicit non-href deletion, complete href
  preservation, six-value mapping, target-href uniqueness, and retained-row
  reverse fidelity.
- **AC12:** Existing mobile Root/Find/Create behavior and styling remain
  unchanged; additive WebSearch uses existing row/Adopt/Fork grammar; migrated
  imports, architecture invariants, component tests, and mobile E2E pass.
- **AC13:** `/browse` and the exact new URL intent open live Web Search;
  `/api/web/search` reaches the existing provider; canonical Find remains
  persisted-owned only.
- **AC14:** Each source's loading/failure/retry state preserves successful rows,
  query, and selection; stale aborts are silent; defects reach boundaries.
- **AC15:** Named performance gates pass on 20-sample warm/cold runs with one
  first-usable winner per revision, source metadata, and p95 output.
- **AC16:** Active docs name final owners; scoped negative greps and
  `git diff --check` pass.
