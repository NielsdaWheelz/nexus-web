# Pane Search Foundation Hard Cutover

Status: IMPLEMENTED
Type: hard cutover
Date: 2026-07-29

Open questions: none. The approved product decisions are sufficient.

Governing contracts:

- `docs/rules/{boundaries,cleanliness,codebase,concurrency,control-flow,correctness,errors,frontend,function-parameters,keys-and-identities,naming,overrides,simplicity,tagged-unions,testing,timing}.md`
- `docs/cutovers/{workspace-pane-publication-contract,resource-inspector-and-universal-dossiers,desktop-nexus-switchboard,reader-location-history,complete-collection-lists,resource-native-pages-and-notes}-hard-cutover.md`

## Decision

Ship one pane-local Search interaction with two closed capabilities:

| Capability | Surfaces | Result presentation |
| --- | --- | --- |
| `FilterRows` | finite inventories; Page/Note direct items | filter primary rows in place |
| `FindOccurrences` | Chat and readable media/documents | select occurrences in the document; Companion result list |

`Cmd/Ctrl+F` always means Search in the active capable pane. `Cmd/Ctrl+K`
remains global Nexus retrieval. The shell owns interaction grammar; each domain
owns searchable data, matching, filters, locators, activation, and reading
safety.

This foundation defines no universal search engine. Dependent hard cutovers own:

1. collection, Page, and Note filtering;
2. EPUB Find;
3. Chat Find;
4. web article, video/podcast transcript, and standalone Artifact Find;
5. PDF Find.

This document is authoritative for shared types and composition. Child specs
refine domain behavior and import these contracts; they do not restate or fork
them.

Land foundation runtime with the first dependent producer; do not merge unused
production infrastructure. A domain cuts over atomically: it never exposes its
old search and Pane Search together.

## Goals

- One learnable header affordance and shortcut across pane-local search.
- Local, immediate row filtering during existing exhaustive hydration and after
  completion.
- Exact, ordered document occurrences with contextual Companion rows.
- One immutable **Go back to reading position** origin; no return stack.
- Search previews never become reading progress, engagement, completion,
  playback, URL, or pane-history input.
- Existing pane publication, `PaneToolbar`, action, Resource Inspector,
  `ResourceList`, `ResourceRow`, keybinding, and mobile projection owners remain
  authoritative.

## Scope

In:

- shared publication, bar, controls, shortcut, focus, and result-state grammar;
- local row-filter composition, without domain field policy;
- Find session generations and adapter boundary, without format matching;
- transient Search results in the existing desktop/mobile Companion;
- reading-origin and preview-safety invariants;
- Nexus shortcut teaching and duplicate primitive cleanup.

Format algorithms and route migrations are owned by the five dependent
cutovers. Land shared runtime with the first child; keep foundation status
incomplete until one filter and one Find producer exercise both branches. This
is not permission to migrate every domain in one change.

## Non-goals

- Global, cross-resource, semantic, fuzzy, stemmed, regex, AI, or saved search.
- A common matcher across PDF, EPUB, iframe, transcript, and canonical text.
- New backend/BFF endpoints, indexes, workers, database schema, migrations,
  analytics, URL state, or workspace persistence.
- Virtualization, query operators, facets, result ranking, or search history.
- Searching Page/Note backlinks, descendants, or linked-resource contents.
- Replacing native browser Find on panes that publish no Pane Search capability.
- **Continue from here**, multiple origins, or a reader-local navigation stack.

## Target Behavior

1. A collapsed Search icon follows Companion and precedes Options. Its
   label/tooltip/accessible name uses the capability word — **Filter** on
   `FilterRows` panes, **Find** on `FindOccurrences` panes — never the bare
   global word Search. When available, a persistent Return icon follows
   Search. Search toggles one row below the header.
2. The row reuses `PaneToolbar`. Opening focuses and selects the query.
   Repeating `Cmd/Ctrl+F` does the same.
3. Mobile receives the same action through existing mobile pane chrome and the
   same toolbar row; document results use the existing Companion sheet.
4. `FilterRows` shows query plus domain-owned filter/sort controls. It preserves
   source order and has no Match case, Whole word, count ordinal, Previous,
   Next, or Companion results.
5. `FindOccurrences` shows query, result ordinal/count, Previous, Next, optional
   scope, Match case, Whole word, Show results, and mirrors the header's
   persistent Return action when available.
6. The first Ready match becomes active and previews. `Enter` selects Next;
   `Shift+Enter` selects Previous. Navigation wraps and announces the wrap.
   Empty and failed states never move the document.
7. Scope is a selector, not a checkbox. Default is the entire resource. A child
   may add one exact current chapter/section scope; omit it when ownership
   cannot be resolved exactly.
8. Companion rows are in document order, show structural metadata plus typed
   context/match text, and activate the same occurrence as Previous/Next.
9. Desktop keeps Companion open while activating results. Mobile closes the
   existing sheet after activation so the occurrence is visible.
10. `Escape` or Close ends the current query, clears transient marks, collapses
    the row, and restores prior Companion state. It does not return the reader.
    The revealed location and **Go back to reading position** remain.
11. First successful occurrence activation captures an exact origin before
    moving. Later activations retain it. Return restores once and retires it.
12. Route/source/revision replacement cancels query work, marks, result surface,
    and origin. Pane inactivity alone does not.
13. Count/status uses a polite live region. A rejected activation moves
    nothing and announces through that same region. Preview never steals focus
    from the query or result row; Close returns focus to Search; Return
    restores the format-owned reading focus when the origin contains one.

The approved collection successor amendment below extends items 4 and 13 for
`FilterRows`: collapsed domain state remains discoverable, and immediate row
filtering receives a nonvisual polite count/status announcement.

## Product Rules

1. **Search** is the umbrella interaction. Inventory behavior is **Filter**;
   document behavior is **Find**. Global Nexus retrieval remains **Search**.
2. Query text is literal data. The foundation neither parses operators nor
   sends query text to generated code, selectors, HTML, or regex source.
3. Find defaults to case-insensitive, Whole word off, and Entire resource.
   The shared input boundary caps queries at 256 codepoints; empty is idle and
   one codepoint is valid. Child specs define exact Unicode matching against
   their canonical source.
4. Results are deterministic and document ordered. Ranking is forbidden.
5. Search state is visit-local and ephemeral: no URL, local storage, workspace
   schema, server, history, or resume persistence.
6. Shell open/collapse/focus state is separate from domain query/result state.
7. A result identity is derived from exact content revision plus a stable
   format-owned logical locator. DOM node identity, array index alone, and
   display text are invalid identities.
8. Snippets are text segments, never HTML or raw `<b>` transport.
9. Search result activation is a preview intent, not generic navigation,
   transcript seek, reader focus, or resource activation.
10. Unsupported or stale activation rejects without approximate scrolling or
    fallback.

## Final Architecture And Ownership

```text
Cmd/Ctrl+F or Nexus "Search this pane"
  -> one cancelable active-pane Search request
  -> active PaneShell consumes only when its route publishes PaneSearch
  -> PaneShell opens/focuses PaneSearchBar

route/domain owner
  -> PanePrimaryChromePublication.search
  -> FilterRows: local derived rows
  -> FindOccurrences: usePaneFind + format-owned adapter
       -> document preview
       -> transient resource-search publication
       -> existing Resource Inspector hosts
```

| Concern | Sole owner |
| --- | --- |
| capability values/equality | `paneSearch.ts` + `panePublications.ts` |
| active-pane request event | `paneSearchEvents.ts` |
| shortcut arbitration | `WorkspaceHost` |
| expanded state, focus, shared controls/actions | `PaneShell` / `PaneSearchBar` |
| FilterRows collapsed-state marker and spoken status | `PaneShell` / `PaneSearchBar` |
| query generations, active occurrence, wrap | `usePaneFind` |
| rows, filters, sorts | collection/domain owner |
| searchable source, matcher, scopes, locator, preview | dependent format adapter |
| origin and progress/playback fence | mounted reader/format owner |
| transient result presentation | Resource Inspector + workspace host |
| global retrieval | Nexus and `/search`, unchanged |

Route bodies publish one memoized capability through
`PanePrimaryChromePublication.search`. Do not add a search context, registry,
DOM probe, route table, or second publication channel.

## Capability Contract

Canonical internal types:

```ts
interface PaneSearchBase {
  readonly query: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly onQueryChange: (query: string) => void;
  readonly onDismiss: () => void;
}

type PaneSearchPublication =
  | (PaneSearchBase & {
      readonly kind: "FilterRows";
      readonly filters?: ReactNode;
      readonly controls?: ReactNode;
    })
  | (PaneSearchBase & {
      readonly kind: "FindOccurrences";
      readonly result: PaneFindResult;
      readonly scope: PaneFindScopeControl;
      readonly matchCase: boolean;
      readonly wholeWord: boolean;
      readonly onMatchCaseChange: (value: boolean) => void;
      readonly onWholeWordChange: (value: boolean) => void;
      readonly onStep: (direction: "Previous" | "Next") => void;
      readonly onActivate: (key: PaneFindResultKey) => void;
      readonly onShowResults: (trigger: HTMLButtonElement | null) => void;
      readonly resultsExpanded: boolean;
      readonly returnToReadingPosition:
        | { readonly kind: "Unavailable" }
        | {
            readonly kind: "Available";
            readonly onReturn: () => void;
          };
    });

type PaneFindResult =
  | { readonly kind: "Idle" }
  | { readonly kind: "Searching" }
  | {
      readonly kind: "NoMatches";
      readonly completeness: "Complete" | "Partial";
    }
  | {
      readonly kind: "Ready";
      readonly completeness: "Complete" | "Partial";
      readonly rows: readonly PaneFindResultRow[];
      readonly activeKey: PaneFindResultKey;
    }
  | { readonly kind: "TooManyMatches"; readonly threshold: number }
  | {
      readonly kind: "Failed";
      readonly message: string;
      readonly onRetry: () => void;
    };

interface PaneFindResultRow {
  readonly key: PaneFindResultKey;
  readonly context: readonly string[];
  readonly snippet: readonly EmphasisSegment[];
}

type PaneFindResultKey = string & {
  readonly __paneFindResultKey: unique symbol;
};

interface EmphasisSegment {
  readonly text: string;
  readonly emphasized: boolean;
}

interface PaneFindScopeOption {
  readonly kind: "EntireResource" | "Narrow";
  readonly id: string;
  readonly label: string;
}

type PaneFindScopeControl =
  | { readonly kind: "EntireResource" }
  | {
      readonly kind: "Selectable";
      readonly selectedId: string;
      readonly options: readonly PaneFindScopeOption[];
      readonly onChange: (id: string) => void;
    };
```

`PaneFindResultKey` is an opaque branded string. The adapter constructs it from
its frozen source identity and logical locator through a canonical, injective
encoding — canonical JSON of the structured identity, never ad hoc delimiter
concatenation — so distinct locators cannot collide. Consumers compare but
never parse it; the single brand cast carries the repository-standard
assertion token. `Ready` requires non-empty, unique ordered rows and an
`activeKey` present exactly once. `Selectable` requires one selected option
and one `EntireResource` option; format specs own any additional option. Scope
ids are adapter-owned opaque tokens. With no exact narrow scope, publish
`EntireResource` and render no selector. `Unavailable`/`Available` reuses the
existing capability pairing; do not mint `Absent` or optional-callback
variants.

`usePaneFind(adapter)` owns session/query generations, abort, stale-settlement
rejection, input scheduling (one named duration constant), active key,
stepping, and publication projection. Stale settlements are discarded
silently; they never surface as `Failed`. `Failed` models expected, modelable
failures only: each child closes an adapter error union, and the producer maps
it to `message` through one exhaustive `*ErrorMessage` helper; defects throw.
The adapter owns preparation, literal matching, exact preview, presentation
clear, and return:

```ts
interface PaneFindAdapter {
  prepare(request: PaneFindPrepareRequest): Promise<PaneFindSession>;
  find(request: PaneFindRequest): Promise<PaneFindResponse>;
  preview(request: PaneFindPreviewRequest): Promise<PaneFindPreviewReceipt>;
  clearPresentation(request: PaneFindSessionRequest): Promise<void>;
  returnToReadingPosition(request: PaneFindSessionRequest): Promise<void>;
}
```

Every request carries `sessionId`, exact source identity, and `AbortSignal`;
queries and previews also carry `queryId`. Responses echo the relevant
identities. Abort where possible and reject every late identity regardless.
Dependent specs close the request/response unions; no optional capability bags.

Preview positioning is side-effect-free by construction. Where a format has no
such path today — EPUB cross-section movement exists only as navigation that
writes progress and URL — the child builds one as new construction; it never
reuses navigation, restore-session, or seek paths.

### Implemented collection FilterRows successor amendment

The collection cutover owns this hard-cut amendment to the implemented
`FilterRows` branch:

```ts
interface PaneFilterRowsUnit {
  readonly singular: string;
  readonly plural: string;
}

type PaneFilterRowsStatus =
  | {
      readonly kind: "Partial";
      readonly visibleCount: number;
      readonly loadedCount: number;
      readonly unit: PaneFilterRowsUnit;
    }
  | {
      readonly kind: "Complete";
      readonly visibleCount: number;
      readonly totalCount: number;
      readonly unit: PaneFilterRowsUnit;
    };

type PaneFilterRowsPublication = PaneSearchBase & {
  readonly kind: "FilterRows";
  readonly rowStatus: PaneFilterRowsStatus;
  readonly activeDomainControlCount: number;
  readonly filters?: ReactNode;
  readonly controls?: ReactNode;
};
```

Counts are non-negative integers. `activeDomainControlCount` counts domain
View/Filter/Sort controls whose value differs from that surface's canonical
default; the local query is excluded. The domain owns these projections.

`PaneShell` renders one persistent visual marker and changes the accessible
label to **Filter, N controls active** whenever a collapsed Filter has active
domain controls. It does not force the row open. The same descriptor drives
desktop and mobile chrome.

`PaneSearchBar` derives one visually hidden, atomic, polite announcement from
`rowStatus` while the effective query is nonempty:

- Partial:
  **N matching {unit} among L loaded; loading remaining {plural unit}.**
- Complete: **N matching {unit} of M total.**

Only the announcement is debounced through one named short duration; row
filtering remains synchronous. This live region is accessibility feedback, not
visible result-count chrome or a Find ordinal. Empty query is silent. Canonical
publication equality includes every scalar status/control value; producers
still memoize React nodes and callbacks. `{unit}` uses singular only when N is
one; otherwise it uses plural.

`FilterRows` deliberately has no adapter interface. Its owner derives visible
rows from canonical rows, publishes existing domain controls, and may report
Partial until the existing exhaustive-list owner reports Complete. This
subsection is implemented in source by
`collection-pane-search-filter-sort-hard-cutover.md`; its production deployment
remains part of that child cutover's atomic release gate.

## Collection, Page, And Note Boundary

Assume `complete-collection-lists-hard-cutover.md` is implemented. Primary
inventories filter locally; Pane Search does not call their list endpoints.
Existing domain sort/filter state remains authoritative and composes as:

```text
loaded canonical rows -> domain filters -> literal query -> domain sort/order
```

The exhaustive-list owner alone advances Partial to Complete. Pane Search
neither starts nor keys that loading.

The collection cutover defines searchable row fields and filter combinations.
No universal row schema enters this foundation.

Page/Note search uses the same `FilterRows` contract over the current hydrated
`surface.orderedItems`:

- direct outgoing links/bullets only, one level deep;
- visible direct-item text only, matching the text the row currently renders —
  including locally inserted items whose body has not yet echoed from the
  server;
- authored/source order;
- no incoming links, grandchildren, target-content dereference, or `/search`.

Global Page search remains title-only; global Note body search is unchanged.

## Transient Companion Contract

`resource-search` is a route-keyed transient surface in the sole
`resource-inspector` group. It is not a `WorkspaceSecondarySurfaceId` and never
enters persisted `WorkspaceSecondaryState`.

- Extend `PaneSecondaryPublication` with separately typed transient surfaces.
- `WorkspaceHost` owns transient activation by pane + route key.
- Published `resultsExpanded` is a pure projection of that host activation
  state; no second owner derives it.
- Opening results preserves the underlying Companion visibility and active tab.
- Closing/ending Find restores that exact state.
- Hosts render Search results as a temporary active tab beside durable tabs.
- A route with no durable Companion publication (standalone Artifact) is a
  first-class host case: while its transient surface is active, hosts render
  that tab alone with no durable tab strip, and ending it returns the pane to
  no Companion. The at-least-one-surface publication invariant applies to
  durable publications only; `useResourceInspector` remains the sole durable
  publisher, and such routes opt into the group through `paneRouteModel.ts`
  without acquiring durable state.
- Selecting a durable Companion tab ends the transient presentation and selects
  the durable tab normally.
- Result-panel unmount never owns query, results, active key, or origin.
- Desktop and mobile hosts render the same transient publication; no new group,
  drawer, sidecar, sheet, width policy, or persistence field exists.

The result body reuses `ResourceList` and `ResourceRow`. Extract the repeated
`{ text, emphasized }` shape to one shared `EmphasisSegment` type and renderer;
remove the five private shape copies (collections, global Search, Nexus,
desktop Nexus, resource-target) and their three private renderers, and collapse
the duplicated `<b>` transport parser to its one global-Search owner. Do not
repurpose `HighlightSnippet`, which has different quote anatomy.

## Reading Position Safety

Each Find adapter uses one `SearchPreview` lease beside its existing
progress/activity owner:

1. capture the exact live reading origin before the first move; reject if
   unavailable;
2. fence both owner-reachable persistence pipelines: the reader cursor save —
   one PUT that also writes engagement and completion, including the lifecycle
   flush that captures the live viewport on hide, deactivation, pagehide, and
   unmount — and consumption-activity measurement publication, which today
   publishes before programmatic-scroll suppression;
3. preserve the pre-preview progress/activity locator through visibility loss,
   pane deactivation, pagehide, and unmount;
4. release the fence synchronously on the next trusted reader input, then let
   that genuine input follow normal progress rules;
5. keep the return origin until Return, source replacement, or route exit.

Playback persistence has no reachable fence: the listening heartbeat belongs
to the global player. Its only protection is Product Rule 9 — Search code
never calls seek, resume, or transcript-click paths. URL and pane history are
safe by construction when preview never calls the location-replace seam or
navigation.

Do not use a timeout, scroll-distance heuristic, boolean scattered across
renderers, or post-hoc progress repair. Children absorb the existing one-shot
programmatic-scroll suppression flag into the lease; the two mechanisms never
stack. This origin is the scoped, single-origin passage-return affordance that
`reader-location-history-hard-cutover.md` lists as a non-goal; this document
supersedes that non-goal for Search preview only. Pane history remains
destinations-only.

## Shortcut And Nexus Composition

- Add bindable `Pane.Search: Meta+f`; existing `Meta` means Cmd or Ctrl. The
  dotted id follows the global-identifier rule beside `Nexus.Open`; legacy
  `pane-next`/`pane-previous` stay un-renamed in this cut.
- `WorkspaceHost` checks the binding before its editable-target early return
  and before pane-next/previous — a check placed after that guard never fires
  inside Page/Note editors — then dispatches one cancelable
  `Pane.SearchRequested` event. Build the channel as a cancelable variant of
  the existing pulse-channel primitive; do not mint a second bespoke
  window-event pattern.
- Only the active `PaneShell` with a current route-keyed publication consumes
  it, deciding synchronously inside the dispatch from current refs, never from
  captured render state. Prevent native Find only when consumed.
- Do not skip editable targets inside the active pane; Page/Note use the same
  shortcut. An owning modal/dialog or keybinding capture may prevent it first.
- Add one static, searchable Nexus result: **Search this pane**, with the
  formatted current binding and target `PaneSearch`. Nexus renders no shortcut
  hints today; add one optional entry hint field rendered through the existing
  combo formatter.
- Nexus dispatches the same request and closes only when a pane consumes it
  (`NavigationAccepted` iff consumed, else `Stayed`). Do not create a general
  command registry or add Pane Search to Create/Acquire quick actions.

## API, State, And Persistence

There is no external API or schema change. Foundation APIs are the TypeScript
publication, adapter, transient-surface, and request-event contracts above.

No search field enters:

- HTTP payloads or query parameters;
- backend models or database tables;
- pane URLs, history visits, workspace serialization, or return mementos;
- reader cursor/progress payloads;
- global `/search` or Nexus ranking.

## Hard Cut And Cleanup

- Delete each converted domain's old inline search input, submit/debounce path,
  client use of server-list query filtering, duplicate filter/sort chrome,
  shortcut listener, matcher, highlight layer, and stale tests in its dependent
  cutover.
- Re-home the create-Library form from `PaneToolbar.filters` to
  `SectionOpener.actions` in the first child; the current form is an action, not
  a Filter control.
- Delete duplicate snippet segment types/renderers when the foundation lands.
- Extend canonical publication equality; do not compare search values in
  `PaneShell`, hooks, or producers.
- Memoize React nodes, arrays, options, and callbacks at producers. Equality
  does not compensate for unstable values.
- Never use `window.find`, shell-level DOM text scraping, raw `<b>` snippets in
  Pane Search, native-Find fallback inside a capable pane, compatibility
  exports, feature flags, dual paths, or legacy query decoding. A format
  adapter may search its own rendered document only where that rendering is the
  format's canonical text (standalone Artifact), and still yields
  revision-scoped structured locators, never DOM-node identities.
- Do not widen global Search, `QUICK_ACTION_REGISTRY`, resource capabilities, or
  workspace persistence to host Pane Search.

## Files

Foundation owners:

- new `apps/web/src/lib/panes/paneSearch.ts`,
  `paneSearchEvents.ts` (a cancelable generalization of the pulse-channel
  primitive in `apps/web/src/lib/reader/pulseEvent.ts`), `usePaneFind.ts`, and
  focused tests;
- new `apps/web/src/components/workspace/PaneSearchBar.tsx` plus styles/test;
- new `apps/web/src/components/resource-inspector/PaneSearchResults.tsx` plus
  styles/test;
- `apps/web/src/lib/panes/panePublications.ts`;
- `apps/web/src/components/workspace/{PanePrimaryChrome,PaneShell,WorkspaceHost,SecondaryPaneShell,MobileSecondaryPaneHost,SecondarySurfaceTabs,SecondarySurfacePanels}.tsx`
  and focused tests;
- `apps/web/src/components/ui/{SurfaceHeader,PaneToolbar}.tsx` — the header
  renderer hosting the Search/Return actions and the reused toolbar row — and
  `apps/web/src/components/appnav/MobilePaneBar.tsx`;
- `apps/web/src/lib/panes/paneRuntime.tsx`,
  `apps/web/src/lib/panes/paneSecondaryModel.ts`, and tests;
- `apps/web/src/components/resource-inspector/inspectorSurfaces.ts` and tests;
- `apps/web/src/lib/dossiers/useResourceInspector.ts` and tests;
- `apps/web/src/lib/{keybindings,keybindingsProvider}.ts`/`.tsx`,
  Keybindings Settings, and tests;
- `apps/web/src/lib/nexus/{model,ranking,results,dispatch}.ts`,
  `apps/web/src/components/nexus/useNexusController.ts`, and focused tests;
- new shared emphasis type/renderer plus the current duplicate owners in
  collections, global Search, Nexus, desktop Nexus, and
  `ResourceTargetListbox`.

Dependent format/list files belong only in their named child cutover. Update
`docs/modules/{workspace,panes-tabs,reader-implementation}.md` when code lands.

## Implementation Order

1. Add pure contracts, equality, request event, and shared emphasis primitive.
2. Add shell row/actions, active-pane shortcut, and Nexus teaching entry.
3. Add transient Resource Inspector composition for desktop and mobile.
4. Add `usePaneFind` generation/state orchestration.
5. Land with the first child; exercise the other capability in the next bounded
   child before marking foundation implemented.
6. Migrate remaining children atomically; delete old paths per domain.
7. Update canonical docs and run residue gates after the last child.

## Acceptance Criteria

1. Search action, `Cmd/Ctrl+F`, and Nexus command open/focus only the active
   capable pane; `Cmd/Ctrl+K` and unsupported-pane native Find remain unchanged.
2. Filter panes render only matching local rows, preserve domain order, reuse
   existing filters/sorts, expose no Find-only controls, mark active collapsed
   domain state, and announce debounced Partial/Complete row status.
3. Find panes expose the shared controls, wrap correctly, announce state, and
   reject stale session/query/source results.
4. Companion results are ordered, typed, keyboard reachable, activate exact
   occurrences, restore prior Companion state, and never persist.
5. First preview captures one exact origin; repeated jumps do not replace it;
   Close does not return; Return restores once; no Continue action exists.
6. Preview/return causes no progress/activity/completion/playback/URL/history
   change, including lifecycle flush. Genuine later input resumes normal rules.
7. Route/source/revision changes clear all ephemeral state; pane inactivity does
   not corrupt it.
8. Page/Note filtering is direct-item-only and never calls global Search or
   traverses the graph.
9. No backend, database, URL, workspace schema, new secondary group, generic
   command registry, compatibility path, fallback, or duplicate snippet shape
   remains.
10. Pure contract/state tests, shell/Companion integration tests, accessibility
    tests, each child adapter corpus, and one real-stack result-jump/return
    journey pass.

## Residue Gates

```text
rg 'window\.find' apps/web/src
rg 'key\s*===\s*.[fF].' apps/web/src
rg 'Meta\+f|Pane\.Search' apps/web/src
rg 'type="search"' apps/web/src/app apps/web/src/components
rg 'emphasized: boolean' apps/web/src
rg 'parseSnippetSegments' apps/web/src
rg 'resource-search' apps/web/src/lib/workspace apps/web/src/lib/panes
```

Expected residue: no `window.find`; non-Find key checks and the reader
focus-mode chord only; the keybinding default, Settings row, arbitration
owner, Nexus teaching entry, and their tests; deliberate non-pane search
inputs; one shared `EmphasisSegment` declaration; one global-Search transport
parser; and the transient publication/runtime owners only. Do not regress to
name-based `interface`/`type` greps: today's duplicates include a `type` alias
and an anonymous inline shape such gates cannot see.
