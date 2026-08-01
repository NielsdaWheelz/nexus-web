# Mobile Nexus Switchboard — Hard Cutover

**Status:** Implemented · Rev 2 · 2026-07-27

**Type:** Hard cutover — no legacy mobile path, fallback, compatibility shim,
feature flag, or dual entry point.

**Superseded Nexus contract (2026-07-31):**
[`nexus-intent-router-hard-cutover.md`](nexus-intent-router-hard-cutover.md)
replaces this document's dashboard Root, mobile-only Places projection,
separate Find page, scope chips, `SwitchboardRowModel`, and mobile-only merge.
This file is implementation history for all replaced clauses.

**Historical follow-up authority (2026-07-30):**
[`mobile-nexus-full-screen-task-hard-cutover.md`](mobile-nexus-full-screen-task-hard-cutover.md)
replaces `SwitchboardSheet` with `SwitchboardTask`.
[`daily-pages-quick-capture-hard-cutover.md`](daily-pages-quick-capture-hard-cutover.md)
then deletes Today Capture and its workflow/recovery variants, maps Quick Note
to pane-native append, and keeps Today as a Place. The single Nexus control,
Root inventory, activation, focus, Back, accessibility, performance, and data
contracts remain authoritative.

This document supersedes the mobile surface contracts in
[`universal-launcher-hard-cutover.md`](universal-launcher-hard-cutover.md),
[`app-navigation.md`](../modules/app-navigation.md), and
[`panes-tabs.md`](../modules/panes-tabs.md), plus the NavSheet/keyboard-obstruction
contracts in [`overlays.md`](../modules/overlays.md) and the affected pane-state
contracts in [`workspace.md`](../modules/workspace.md). Desktop navigation and
the desktop Launcher remain supported.

**Approved follow-ups (2026-07-30):**
[`mobile-nexus-control-hard-cutover.md`](mobile-nexus-control-hard-cutover.md)
supersedes the control's visual anatomy. After that prerequisite,
[`mobile-nexus-full-screen-task-hard-cutover.md`](mobile-nexus-full-screen-task-hard-cutover.md)
supersedes only the following presentation-era clauses in this document:

1. § Sheet behavior's one-`MobileSheet` owner and backdrop/drag dismissal
   grammar.
2. § Mobile viewport's `reportMobileSheetKeyboardInset` capability name.
3. The `MobileSheet`-exclusive `useKeyboardInset` and no-new-reader gates;
   the lifecycle hook becomes the sole keyboard-geometry importer, while
   `FloatingActionSurface` retains its unrelated raw placement reader.
4. The visual rule assigning dialog, keyboard, history, scrim, motion, and
   return-focus ownership directly to `MobileSheet`; shared lifecycle owns the
   common mechanics and each semantic surface owns its presentation.
5. The hard-cut final-state rule retaining one mobile Nexus `MobileSheet` and
   forbidding a second semantic mobile surface primitive.

The controller, pages, workflows, guards, focus, Back, accessibility,
performance, obstruction-unregister, API, data, and persistence contracts
remain normative. The historical clauses below are retained as the implemented
2026-07-27 state, not as instructions to restore the sheet after the approved
follow-up.

## One-line

Replace mobile NavSheet + LauncherSheet + separate Add controls with one
thumb-reachable Nexus Switchboard: instant tab switching, universal owned-resource
Find, fixed Places, explicit quick actions, and one in-sheet workflow stack.

## Locked decisions

- No open product questions block implementation.
- “New note” is today-page quick capture through the existing note session.
- “Annotation” means a highlight note: an existing `note_block` attached through
  a `resource_edges.origin = "highlight_note"` relationship. No annotation
  resource kind is added.
- One Nexus-logo control with the open-pane count is the only mobile global
  entrance.
- The control lives in the lower thumb zone; the top bar is pane chrome only.
- Open panes use stable workspace order. Recent state never reorders them.
- Switchboard opens reuse an exact pane and otherwise create one (`Adopt`).
  Explicit duplicate is `Fork`.
- The root has no mode tabs and does not focus the keyboard.
- Libraries, Chats, Notes, Podcasts, and Lectern are Places, not peer modes.
- External discovery/acquisition is separate from owned-resource Find.
- Switchboard Find admits internal route activations only. It never renders web
  or external activations.
- Nexus gestures and paginated openable-resource retrieval are outside this
  cutover.

## Scope

In scope: the authenticated mobile-web and Android-web-shell projections,
mobile pane chrome, mobile global-access surface, bounded recently-closed pane
state, one bounded read-only resource-items projection, canonical search
classification/owner identity, replay-safe page/library creation, shared
quick-action definitions, shell obstruction/session ownership, and their
current docs/tests.

Desktop rail/Launcher root behavior, domain resource models, collection panes,
ingest semantics, and workspace persistence remain outside the behavior
cutover. Shared internals change only where a second real caller requires one
owner. Desktop may render a workflow carried across a breakpoint; that does not
make the workflow newly discoverable from the desktop root.

## Goals

- **G1 — One entrance.** Every common mobile global job begins at the Nexus
  control and reaches its target or workflow in one additional tap.
- **G2 — State before retrieval.** Open panes render synchronously from the
  workspace; no request blocks first paint.
- **G3 — One Find.** Open panes, destinations, direct resources, highlights,
  highlight notes, messages, libraries, and deep content merge into one stable
  result list.
- **G4 — Explicit creation.** Note, page, chat, library, import, and podcast
  discovery are visible actions, not ranked command-palette interpretations.
- **G5 — Preserve context.** Find, Places, and completed workflows open with
  `Adopt`; they never replace the source pane.
- **G6 — One owner per capability.** Reuse workspace activation, `ResourceRef`,
  resource actions, search candidates, domain clients, `MobileSheet`, and the
  existing Add/today-note sessions.
- **G7 — Lower complexity.** Delete the mobile navbar/palette model and every
  mobile-only branch, style, test, and event consumer it leaves dead.

## Non-goals

- No desktop navigation or desktop Launcher interaction redesign.
- No top-level resource-type tabs, customizable navigation, or plugin system.
- No `/api/switchboard`, command bus, routing system, overlay primitive, search
  engine, or resource kind.
- No general category browser inside Switchboard. Places open their existing
  panes; dense `/search` and collection panes remain canonical.
- No access-history database migration. Existing Launcher history remains
  desktop-owned and supplies only an optional Find ranking boost.
- No persisted recently-closed stack, exact closed-pane scroll restoration,
  offline index, voice interface, or learned intent classifier.
- No Nexus swipe/long-press accelerators or other hidden gesture vocabulary.
- No openables cursor, infinite scroll, or `Load more`; Switchboard consumes one
  bounded top-result projection.
- No page/podcast pagination cleanup outside endpoints already consumed here.
- No automatic execution from pasted text or inferred intent.

## Target behavior

### Mobile chrome

- The top bar contains Back when available, the pane title/identity, and one
  pane overflow menu.
- Forward and every published pane action move into that menu. Bounded reader
  format navigation remains in the existing pane toolbar.
- The top bar contains no Nexus/Home, global navigation, Search, Add, tab-count,
  or Launcher control.
- The fixed Nexus control shows the Nexus mark and exact open-pane count. Its
  accessible name is `Open Nexus, 1 tab` or `Open Nexus, {count} tabs`.
- Tap opens Switchboard Root. The control has no swipe, long-press, context-menu,
  or multitouch behavior.
- The control and every mobile scroll owner consume the shell obstruction
  capability defined below. They never infer clearance from the current
  `--mobile-bottom-obstruction` constant.

### Root

Root opens without a keyboard or remote fetch and keeps these fixed regions:

1. Header: Nexus, Account menu, Done.
2. Places: Lectern, Libraries, Podcasts, Chats, Notes. Membership/order is a
   `SWITCHBOARD_PLACE_IDS` projection of `DESTINATION_REGISTRY`; identity is not
   duplicated. Stats, Atlas, and Oracle are intentionally Find-only on mobile.
3. Quick: Note, Page, Chat, Library, Import, Podcast.
4. Open: every primary pane in `primaryPaneOrder`, including minimized panes.
5. Recently closed: up to five session-local snapshots, shown only when nonempty.
6. Anchored `Find anything…` field.

Open-row selection restores/activates the exact pane and closes Switchboard.
Close removes the row, records the snapshot, and leaves Switchboard open.
Recently-closed selection restores the exact pane/history at its former order
position, subject to the pane cap.

### Find

- Tapping `Find anything…` enters Find and focuses the input.
- Local open-pane and destination matches render in the same update as the
  draft.
- A nonblank one-character query starts lexical openable-resource retrieval.
- At two characters, the existing hybrid `/search` request starts in parallel.
- Results merge in this fixed order:
  1. exact open pane;
  2. exact resource/destination label;
  3. recent label;
  4. other label/metadata match;
  5. deep content match.
- Find does not invent one merge identity. Pane rows retain `PaneId`;
  destinations retain `DestinationId`; resource rows retain occurrence
  `ResourceRef`; grouping uses owning-resource `ResourceRef`; pane matching uses
  the workspace owner’s normalized primary-route identity. History href is a
  ranking signal only.
- The canonical `/search` projection supplies both occurrence
  `resource_ref` and `owner_resource_ref`. Switchboard never infers ownership
  from a result type or URL.
- The workspace route owner derives a locator-independent primary-route identity
  from the supplied internal activation. An owner matching an open pane is
  represented by that pane; matching deep occurrences remain grouped beneath it.
- Deep passages group below their owning resource. Selection activates the
  exact occurrence/locator supplied by search.
- Result insertion never moves the active row or any row above it.
- Scope chips appear only after a query:
  `All | Media | Notes | Highlights | Chats | Libraries | People`.
  One mapping owner translates a scope to openable schemes and canonical
  `SearchQuery` profiles. `All` explicitly excludes `web`.
- Canonical search defines `Highlights` as saved `highlight` results plus only
  `note_block` results proven by a visible `highlight_note` edge. That
  classification is applied inside candidate retrieval before ranking/limit and
  is projected explicitly; adding all note blocks to the Highlights result-type
  tuple is forbidden.
- Search failure is explicit and retryable for the failed source. It does not
  erase successful local or other-source results. Same-system decode drift
  defects; it never becomes an empty result set.
- Primary selection uses `Adopt`. `Open another tab` in row actions uses `Fork`.
  Pane-cap rejection keeps Switchboard open and offers `Manage tabs`.
- Every admitted result has `ResourceActivation.kind = "route"` and uses
  workspace dispositions. External discovery remains in explicit acquisition
  workflows.

Canonical search wire additions:

```ts
interface SearchResultBaseOut {
  resource_ref: string;       // exact result/occurrence
  owner_resource_ref: string; // primary resource receiving the occurrence
}

interface SearchResultNoteBlockOut extends SearchResultBaseOut {
  type: "note_block";
  note_origin: "note" | "highlight_note";
}
```

`search_owner_ref(result)` is one exhaustive backend owner: direct pane
resources own themselves; message owns conversation; highlight/fragment/media
passage/apparatus owns media; a note-owned chunk owns its note block; and an
artifact/revision owns the canonical visible subject chosen by artifact routing.
Web results retain external ownership for canonical `/search`, but Switchboard
never requests them. `WorkspaceActivationRouteId` is an opaque frontend key
derived by the pane-route owner from the owner’s internal route with
locator-only query/hash state removed.

### Places and Quick

All Place selections use `Adopt`.

| Action | Behavior |
| --- | --- |
| Note | Open the existing today-capture editor in the same sheet. Autosave/draft recovery remain owned by the note session. |
| Page | Create an untitled page, focus its title, then `Adopt` its canonical route. |
| Chat | `Fork` a fresh `/conversations/new` pane. |
| Library | Open a name form; create through `createLibrary`, then `Adopt` the created library route. |
| Import | Open the existing Add workflow with URL focus; URL, file, and OPML remain inside that workflow. |
| Podcast | Open focused podcast discovery; selecting an owned podcast opens it and selecting an external podcast explicitly subscribes, then opens it. |

The registry stores only current behavior: stable id, semantic label, icon,
keywords, category (`Create | Acquire`), and a closed target union. It has no
permissions, plugin metadata, optional executors, or future action slots.
Its stable ids are `Nexus.Quick.Note`, `Nexus.Quick.Page`,
`Nexus.Quick.Chat`, `Nexus.Quick.Library`, `Nexus.Quick.Import`, and
`Nexus.Quick.Podcast`.

Projection membership is explicit:

- `SWITCHBOARD_QUICK_ACTION_IDS` contains all six actions in the order above.
- `DESKTOP_CREATE_ACTION_IDS` contains Chat, Page, and Note only. Those three
  existing desktop rows derive semantics from the shared registry while
  retaining their current labels/order.
- Existing desktop Add rows remain query-conditioned and provider-owned.
  Library and Podcast do not become desktop-root commands.

### Sheet behavior

- One mounted `MobileSheet` owns Root, Find, actions, today capture, library
  creation, Add, and podcast discovery.
- Pages replace each other inside the sheet; sheets never stack.
- Backdrop, drag, Escape, and browser/hardware Back all request the same
  transition: a nested page pops once; Root or a recovery root-level state
  dismisses. Workflow guards may block that transition. No typed dismissal
  reason is added to `MobileSheet`.
- Add keeps its existing running/dirty dismissal guard.
- Today Capture has no inherited dirty-sheet guard. Its shell-owned session
  synchronously checkpoints a recoverable draft before a dismissal transition,
  keeps an in-flight flush alive across projection/dismissal, and allows
  dismissal after that checkpoint. If checkpointing fails with unsaved content,
  dismissal is blocked and Retry/Discard is explicit.
- Successful navigation suppresses return focus; nonnavigating dismissal
  restores the Nexus trigger.
- Account reuses one extracted Account menu: Settings uses `Adopt`; Sign Out
  remains the existing POST form.

## Capability and intra-system contract

| Intent | UI owner | Capability owner | Disposition |
| --- | --- | --- | --- |
| Switch open pane | Switchboard Root | workspace store | exact activate/restore |
| Restore closed pane | Switchboard Root | workspace store | restore snapshot |
| Open Place | Switchboard Root | destination registry + workspace activation | `Adopt` |
| Find direct resource | Switchboard Find | resource-items openable search | `Adopt` |
| Find deep content | Switchboard Find | existing `/search` | `Adopt` |
| Duplicate result | row actions | workspace activation | `Fork` |
| Today capture | today-capture panel | shell-owned today session + existing note API | `Adopt` Today |
| Create page/library/chat | quick-action registry | shell workflow controller + domain clients + dispatch | table above |
| Import media/OPML | existing Add panel/session | ingest/podcast owners | `Adopt` result |
| Discover/subscribe podcast | podcast panel | existing browse + subscription owners | `Adopt` result |
| Resource actions | row actions | universal resource-action catalog | catalog policy |

Switchboard components never call pane creation, domain mutations, `window.location`,
or resource activation directly. They emit typed targets to the existing
`dispatchTarget`/workspace seams.

For shell-owned Launcher/Switchboard calls, `dispatchTarget` receives
`activateWorkspaceTarget` from the workspace context and returns:

```ts
type DispatchOutcome =
  | { kind: "Stayed" }
  | { kind: "NavigationAccepted" }
  | {
      kind: "NavigationRejected";
      reason: "PaneLimitReached";
      target: WorkspaceTarget;
    };
```

The controller closes only for `NavigationAccepted`. The window/message ingress
remains an adapter for callers outside this React ownership tree; it is not the
Switchboard result path.

The caller, not dispatch, knows whether a mutation committed. Any pane-cap
rejection transitions to shell-owned `ActivationBlocked`. If page, library,
import, or subscription creation already committed, that state carries the
completion and canonical target. `Manage tabs` transitions to `ManageTabs`,
which renders Root/Open plus the retained target. `Open` retries activation
only: acceptance clears the state and closes; another rejection retains it.
`Cancel` explicitly discards the retained target. Dismissal and viewport changes
do not discard it. A committed domain mutation is never repeated or rolled back.

## Architecture and frontend structure

`Launcher` remains the shell-mounted cross-form-factor owner:

```text
Launcher
├── useLauncherController → state + sessions + workflow mutations + dispatch
├── desktop → existing LauncherSurface + desktop projection
└── mobile  → SwitchboardSheet + Switchboard projection controller
                 ├── Root
                 ├── Find
                 ├── Actions
                 ├── TodayCapture
                 ├── CreatePage
                 ├── CreateLibrary
                 ├── Add
                 ├── PodcastDiscovery
                 ├── ActivationBlocked
                 └── ManageTabs
```

The mobile projection does not construct `LauncherLane`, `LauncherSection`,
`LauncherView`, or blended ranked items. Shared domain targets, dispatch, Add
session, resource actions, and destination identities remain below both
projections.

`Launcher` owns the sole open-event listener, open/closed state, exhaustive
cross-viewport page, retained activation, lifted Add session, and lifted Today
Capture session/draft identity. Controllers receive those owners; they do not
subscribe or construct sessions independently. Only the active viewport
projection fetches.

`useLauncherController` remains the capability/workflow owner and calls domain
clients. `useSwitchboardController` owns mobile presentation state and emits
typed workflow events/callbacks only; nothing under `components/switchboard/**`
performs a domain mutation.

```ts
type LauncherPage =
  | { kind: "Root" }
  | { kind: "Find"; query: string; scope: SwitchboardFindScope }
  | { kind: "Actions"; item: LauncherItem; actions: LauncherAction[] }
  | { kind: "TodayCapture"; sessionId: string }
  | { kind: "CreatePage"; pageId: string; submit: ReplayableSubmitState }
  | {
      kind: "CreateLibrary";
      nameDraft: string;
      libraryId: string;
      submit: ReplayableSubmitState;
    }
  | { kind: "Add"; sessionId: string }
  | { kind: "PodcastDiscovery"; query: string; sessionId: string }
  | { kind: "ActivationBlocked"; retained: RetainedActivation }
  | { kind: "ManageTabs"; retained: RetainedActivation };

type SwitchboardItem =
  | {
      kind: "OpenPane";
      paneId: string;
      activationRouteId: WorkspaceActivationRouteId;
    }
  | { kind: "ClosedPane"; paneId: string }
  | { kind: "Destination"; destinationId: DestinationId }
  | {
      kind: "Resource";
      occurrenceRef: string;
      ownerRef: string;
      activationRouteId: WorkspaceActivationRouteId;
      subject: ResourceActionSubject;
      label: string;
      summary: string;
      match: "Exact" | "Metadata" | "Deep";
    };

type RetainedActivation = {
  target: WorkspaceTarget;
  source:
    | "Find"
    | "Place"
    | "TodayCapture"
    | "Page"
    | "Chat"
    | "Library"
    | "Import"
    | "Podcast";
  completion: Presence<CommittedWorkflow>;
  returnTo:
    | { kind: "Root" }
    | { kind: "Find"; query: string; scope: SwitchboardFindScope };
};

type CommittedWorkflow =
  | { kind: "TodayCapture"; replayId: string }
  | { kind: "Page"; replayId: string }
  | { kind: "Library"; replayId: string }
  | { kind: "Import"; replayId: string }
  | { kind: "PodcastSubscription"; replayId: string };

type ReplayableSubmitState =
  | { kind: "Ready" }
  | { kind: "Running" }
  | { kind: "Retryable"; message: string };

type SwitchboardFindScope =
  | "All"
  | "Media"
  | "Notes"
  | "Highlights"
  | "Chats"
  | "Libraries"
  | "People";
```

Controller state is one exhaustive union, not parallel booleans. Raw Find and
library drafts remain strings until submit. The Add and Today session owners
remain mounted at `Launcher` and are referenced by session identity; rendering a
panel never creates or resets them. Same-system payloads decode once at the API
boundary. Derived result groups, pane count, active row, and loading presentation
are not stored.

`ActivationBlocked` and `ManageTabs` are root-level dismissal states: dismissal
closes the overlay but preserves the variant for the next open. Every other
non-Root dismissal pops once. Only explicit `Cancel` or successful activation
clears a retained target.

### Cross-viewport projection

| Shell page | Mobile projection | Desktop projection | Focus after change |
| --- | --- | --- | --- |
| Root | Switchboard Root | existing Launcher root | projection heading |
| Find | Find with query/scope | existing Launcher query; mobile scope retained but not exposed/applied | query input |
| Actions | Switchboard actions | existing Launcher actions | actions heading |
| TodayCapture | Today panel | same Today panel | editor |
| CreatePage | creation progress/retry | same carried progress/retry | status heading or Retry |
| CreateLibrary | library form | same carried form; not a desktop-root command | name input |
| Add | Add panel | existing Add panel | session-owned target |
| PodcastDiscovery | podcast panel | same carried panel; not a desktop-root command | query input |
| ActivationBlocked | recovery decision | same recovery decision | recovery heading |
| ManageTabs | Root/Open plus retained target | Launcher root plus retained target | Open heading |

Changing breakpoint/orientation never calls a workflow initializer, rotates a
replay id, clears a draft/query, or returns focus to the old projection. The
desktop root otherwise keeps its current lanes, ranking, labels, contextual Add
rows, and keyboard behavior.

### Replay-safe workflows

One logical submit owns one stable replay identity from workflow creation until
canonical success or explicit discard. Buttons serialize submission, but
serialization is not the replay guarantee.

```ts
interface CreatePageRequest {
  page_id: string; // client-minted UUID
  title: string;
}

interface CreateLibraryRequest {
  library_id: string; // client-minted UUID
  name: string;
}
```

- Page creation requires client-minted `page_id: UUID` in
  `CreatePageRequest`. Retrying the same id returns the same viewer-owned page
  and never inserts another.
- Library creation requires client-minted `library_id: UUID` in
  `CreateLibraryRequest` with the same create-if-absent/return-existing rule.
- The create transaction inserts the resource and required ownership/membership
  facts atomically. A same-id conflict reloads under the same operation, returns
  the canonical entity only when owner and normalized create payload match, and
  otherwise returns a typed conflict. The server never silently mints a
  replacement.
- Today Capture keeps its existing stable draft block identity across save
  retries.
- Add keeps one stable capture/import identity per logical staged item. URL and
  file retries reuse the existing session-held idempotency keys. OPML replay is
  an integration-proven ensure over canonical feed, subscription, and requested
  library memberships; the session retains a hash of normalized OPML plus
  sorted destination ids as its logical replay identity.
- Podcast subscribe is an ensure operation over canonical podcast plus unique
  subscription/library membership. Replay returns current canonical ownership;
  it does not create a second subscription.
- New Chat only opens `/conversations/new`; no server mutation occurs until the
  existing message-send replay contract.

The page/library request changes are hard cutovers: all clients change in the
same branch and no server-generated-ID fallback remains. The resource UUID is
the namespaced create replay key, so no replay table or database migration is
introduced.

### Recently closed

The workspace remains the only pane-state owner. Add a bounded ephemeral stack
to `WorkspaceStoreProvider`, outside persisted `WorkspaceState`:

```ts
interface ClosedPaneSnapshot {
  pane: WorkspacePrimaryPaneState;
  secondaryPane: Presence<WorkspaceAttachedSecondaryPaneState>;
  orderIndex: number;
}
```

- Cap at five, newest first; insertion order is recency—no timestamp.
- A valid close snapshots primary/attached-secondary state before removal.
  Close-last still mints the canonical fallback workspace before dispatch and
  records the closed pane. Re-closing the same restored pane replaces its older
  snapshot.
- Restore is one atomic workspace reducer action. It rejects at 12 panes before
  mutation; duplicate primary or secondary pane identity is an invariant
  defect and changes nothing.
- Successful restore inserts at the clamped former index, restores the original
  pane id/current visit, makes the activated pane visible, clamps primary and
  secondary widths against current metrics, normalizes secondary attachment and
  parent identity through current route policy, and activates the pane.
- Restore reapplies per-pane history bounds and the global 48-entry budget. It
  removes the snapshot only after the normalized state succeeds.
- Persistence/session codecs remain unchanged. A reload clears recently closed.

## Openable-resource API

Add one read-only projection; do not extend target search with
`purpose = "open"` because its admission and `existingLinkId` semantics are
authoring-specific.

`POST /api/resource-items/openables/search`
proxies to `POST /resource-items/openables/search`.

```ts
interface ResourceOpenableSearchRequest {
  q: string; // trimmed, 1..500
  schemes: Presence<ResourceScheme[]>; // Present is nonempty and unique
}

interface ResourceOpenableSearchResponse {
  items: ResourceItem[];
}
```

Rules:

1. Retrieve through `reference_candidates`: one-character lexical
   exact/prefix/substring/FTS, direct targets only, no embedding.
2. Admit only viewer-visible, nonmissing resources whose
   `ResourceActivation.kind` is exactly `route`.
3. Support exact canonical `ResourceRef` input.
4. Apply scheme scope, canonical-ref dedupe, visibility, and openability before
   the result limit.
5. Use one bounded candidate-retrieval pass with existing
   `REFERENCE_CANDIDATES_PER_SOURCE = 50` and new
   `OPENABLE_SEARCH_RESULT_LIMIT = 20`; underfill is valid and no refill
   loop/cursor exists.
6. Project with existing `resource_item_out`; do not map storage/search types to
   refs in the client.
7. Return `Presence`, never null/omission, for request filter absence.
8. Perform no mutation, passage materialization, link lookup, history write, or
   fallback query.

`openables.py` calls the candidate owner once and retains its own admission and
projection. `targets.py`, its cursor, and its refill policy remain unchanged.

The canonical `ResourceItem` client boundary becomes strict once:
all `ResourceItemOut` routes serialize the existing by-alias camel-case wire;
`decodeResourceItem` accepts only that exact shape, requires every
field/capability/version, rejects extra/alternate casing, and maps to the
frontend type. Replace the permissive `normalizeResourceItem`; do not create an
openables-only decoder.

## Find composition

```text
query draft
├── synchronous: workspace panes + destination registry
├── q.length ≥ 1: openables search + existing history boost
│                  (SWITCHBOARD_OPENABLE_DEBOUNCE = 80 ms, abort stale)
└── q.length ≥ 2: existing /search
                       (SWITCHBOARD_DEEP_DEBOUNCE = 160 ms, abort stale)
                         ↓
       strict decode → identify → group → stable merge
                         ↓
     occurrence ref + owner ref + activation route id
                         ↓
             dispatchTarget(..., Adopt)
```

- Extract the existing inline `/api/browse` fetch into its domain client when
  adding podcast discovery; do not copy it into Switchboard.
- Reuse `parseSearchInput`, `SearchQuery`, and resource-action subjects.
  Extend canonical search schemas/projection/strict normalization with
  `owner_resource_ref` and highlight-note classification.
- Backend search replaces the result-type-only Highlights mapping with one
  semantic retrieval profile. One frontend `findScopes.ts` owns scope-to-scheme
  and scope-to-profile mappings; `All` sends explicit non-web kinds.
- The controller commits only the latest request key. Aborted work is not an
  error. No source silently broadens, retries through another endpoint, or
  substitutes stale data.

| Scope | Openables schemes | Canonical `/search` profile |
| --- | --- | --- |
| All | `Absent` (all route-admitted direct schemes) | Documents + Notes + Highlights + Conversations + People; never Web |
| Media | `media`, `podcast` | Documents |
| Notes | `page`, `note_block` | Notes |
| Highlights | `highlight` only | Highlights semantic profile, including highlight-note blocks |
| Chats | `conversation`, `message`, `artifact`, `artifact_revision` | Conversations |
| Libraries | `library` | none |
| People | `contributor` | People |

In particular, Highlights never requests `note_block` from openables and never
client-filters general Notes. Highlight notes enter only through the canonical
server-side Highlights profile.

### Mobile viewport and obstruction

`MobileViewportProvider` is shell-mounted and is the sole composition owner:

```ts
type MobileFixedObstructionId = "Nexus" | "Player";

interface MobileViewportCapability {
  registerFixedObstruction(
    id: MobileFixedObstructionId,
    element: HTMLElement,
  ): () => void;
  reportMobileSheetKeyboardInset(px: number): () => void; // MobileSheet only
}
```

- Nexus control and active player report their measured fixed rectangles through
  named registrations backed by `ResizeObserver`.
- Duplicate active registration for a closed obstruction id defects. Unmount or
  inactive state unregisters synchronously.
- Safe-area inset and the union of active fixed rectangles produce
  `--mobile-content-bottom-clearance`; shared scroll-owner styling consumes it
  in reader, chat, collection, and other pane roots.
- Nexus positioning consumes the player obstruction and safe area from the same
  owner.
- `MobileSheet` remains the only caller of `useKeyboardInset`; it reports that
  value into the provider and consumes the provider’s overlay keyboard channel.
  Reports are ordered by active sheet; releasing the newest report restores the
  preceding sheet’s inset, or zero when none remains. No new component reads
  `visualViewport`.
- Opening Switchboard hides/inerts the Nexus control, so fixed-control and sheet
  geometry never compete.

Delete the constant interpretation of `--mobile-bottom-obstruction`. A scroll
owner may add domain padding above the published clearance but may not
recalculate safe area/player/Nexus/keyboard geometry.

## Visual, accessibility, and performance rules

- One column; high contrast; 48px interactive targets; visible focus; no
  horizontal text truncation without an accessible full label.
- Places and Quick are compact labeled controls. Results use title plus at most
  one metadata line. Accent is reserved for current selection and the Nexus
  mark; Nexus surfaces remain neutral.
- Open rows show only synchronously owned pane/resource facts. They do not fetch
  decoration, capture screenshots, or create a preview store.
- `MobileSheet` keeps dialog, focus trap, keyboard inset, back history, scrim,
  reduced-motion, and return-focus ownership.
- Initial focus is the sheet heading, not Find. Find focus follows an explicit
  user action.
- Root must paint from local state before awaited work.
- Performance marks run against a production build using Playwright’s Pixel 7
  viewport/touch profile, lockfile-pinned Chromium, and 4x CPU slowdown. The
  authenticated shell/pane data are warm; `nexus-open` starts with Switchboard
  unopened. After five setup iterations, collect 50 samples.
- `nexus-open` measures handler entry to the first painted Root-ready marker;
  `nexus-local-find` measures input handling to local-row commit;
  `nexus-pane-activate` measures row activation to target-pane ready. Gates are
  p95 `<100 ms`, same-frame local results, and p95 `<100 ms`, respectively.
- `nexus-openables` measures request start through strict decode/result commit
  over 100 queries against a warm real backend fixture with at least 10,000
  owned resources and 100,000 indexed chunks; p95 is `<250 ms`. Verification
  records `EXPLAIN (ANALYZE, BUFFERS)`, bounded SQL count, and exactly one
  candidate-retrieval pass.
- Retain current rows while remote work resolves. Delay visual busy indication
  by `SWITCHBOARD_BUSY_DELAY = 150 ms`; announce remote completion/failure
  through one polite live region.
- Touch/focus intent uses existing `paneWarm`; warming never changes state.

## Hard-cut final state

Delete:

- `components/appnav/NavSheet.tsx` and its tests/styles.
- `components/launcher/LauncherSheet.tsx`.
- Mobile rendering of `LauncherLaneChips`, blended Launcher rows, command/add
  header buttons, Nexus/Home top-bar button, and Forward button.
- Mobile NavSheet open state, handlers, focus handoffs, history entries, DOM
  ids, CSS, tests, and launcher-handoff listeners.
- Generic mobile `CreatePanel`/`open-create`; rename the retained capability to
  `TodayCapturePanel`/`TodayCapture`.
- Every dead mobile-only Launcher/AppNav branch exposed by those deletions.

Retain:

- Desktop `NavRail`, Account menu, Launcher surface/lanes/keybinding, `/search`,
  resource/collection panes, Add session, and domain routes.
- One shell-mounted `Launcher`, one `MobileSheet`, one dispatch owner, one
  destination registry, and one workspace activation owner.

Negative gates:

- No `NavSheet`, `nav-sheet`, `LauncherSheet`, or mobile `"Navigation"` dialog.
- No mobile reference to `LauncherLane`, `SELECTABLE_LANES`, or
  `LauncherLaneChips`.
- No global Search/Add/Nexus control in mobile top-bar markup.
- No `Follow` disposition from Switchboard Place, Find, or completed workflow
  opens.
- No external/web activation in Switchboard Find or its openables response.
- No direct pane creation/navigation or domain mutation in
  `components/switchboard/**`.
- No `purpose = "open"` in resource-target schemas/services.
- No openables cursor/refill loop/shared paging extraction.
- No Nexus swipe/long-press/context-menu gesture handler.
- No second `ResourceItem` decoder, alternate field casing/defaults, or retained
  permissive `normalizeResourceItem`.
- No new `visualViewport` reader; `MobileSheet` remains the sole keyboard-inset
  reader.
- No server-generated fallback identity for page/library create.
- No `annotation` `ResourceScheme`, `/api/switchboard`, second mobile sheet
  primitive, or compatibility event.

## Implementation slices

1. **Canonical prerequisites.** Add search owner/classification projection,
   strict canonical `ResourceItem` decoding, and replay-safe page/library create
   contracts with focused backend/frontend tests.
2. **Workspace contract.** Add atomic ephemeral recently-closed
   snapshot/restore and behavior tests.
3. **Shared shell capabilities.** Lift Add/Today sessions, add exhaustive
   workflow/recovery state, extract Quick/Place projections and browse client,
   and keep dispatch exhaustive.
4. **Openable Find API.** Add the bounded route-only schema, service, route,
   proxy, client, and integration/load tests.
5. **Switchboard.** Build model/controller/root/find/workflow/recovery
   projections on `MobileSheet`; reuse Add and rename Create to TodayCapture.
6. **Chrome and geometry cutover.** Replace NavSheet/top-bar
   globals/LauncherSheet; add the shell obstruction owner, bottom Nexus control,
   and shared scroll clearance; delete residue.
7. **Hardening.** Intent warming, visual polish, a11y, performance
   instrumentation, contract docs, Android instrumentation, negative gates, and
   real-stack E2E.

Each slice lands in the same hard-cutover branch. No slice ships a selectable
old/new path.

## Acceptance criteria

- **AC1.** Mobile renders one Nexus global trigger and no navbar, command
  button, separate Add button, NavSheet, or mobile Launcher palette.
- **AC2.** Root opens without keyboard/network dependency and shows Places,
  Quick, stable-order panes, optional recently closed, and Find.
- **AC3.** Any open pane activates/restores in Nexus + row tap; close stays in
  Root; restore atomically normalizes identity, visibility, widths, secondary
  attachment, and global history budget or reports pane-cap rejection.
- **AC4.** Nexus has a 48px target, no hidden gesture handlers, and announces
  `1 tab` versus `{count} tabs` correctly.
- **AC5.** Top chrome contains Back, pane identity, and one pane menu; Forward
  and published actions are reachable from the menu.
- **AC6.** One-character Find returns openable lexical resources; two-character
  Find progressively adds `/search` results without selection jumps.
- **AC7.** Find includes media, pages, note blocks, highlights, highlight notes,
  conversations/messages, libraries, podcasts, and contributors when present.
  Highlights includes only server-classified highlight-note blocks in addition
  to saved highlights.
- **AC8.** Occurrence, owner, activation-route, pane, and destination identities
  remain distinct. Exact owner/open matches project through the existing pane;
  all Find activations are internal `Adopt`, explicit duplicate is `Fork`, and
  no external/web result appears.
- **AC9.** A deep match opens its owner at the supplied locator. No passage or
  annotation resource is materialized.
- **AC10.** Note is today capture; Page, Chat, Library, Import, and Podcast
  follow the target behaviors above and preserve the source pane. Retrying a
  response-lost Page/Library/Import/Subscription logical submit creates no
  duplicate.
- **AC11.** A pane-cap rejection after a successful mutation retains the
  created target in `ActivationBlocked`/`ManageTabs` and can open it after tab
  management without repeating the mutation; dismissal and projection changes
  do not lose it.
- **AC12.** All sheet dismissal sources pop once before Root dismissal; Add
  guards dirty/running work; Today Capture checkpoints/recoveries are lossless;
  focus, keyboard, browser/hardware Back, reduced motion, player/Nexus
  positioning, and final-content clearance remain correct.
- **AC13.** Openable search is read-only, one-character, route-only, bounded to
  one candidate pass/top 20, pre-limit deduped/admitted, strictly decoded by the
  sole canonical decoder, and has no cursor.
- **AC14.** Breakpoint/orientation changes preserve every page, Add/Today
  session, query/draft/replay id, retained target, and focus contract according
  to the projection table. Desktop root behavior changes only as stated.
- **AC15.** All negative gates pass and the deleted terms have no production,
  test, style, or current-doc owners. Architecture, overlays, workspace,
  app-navigation, panes/tabs, and universal-Launcher docs describe the final
  owners without contradictory legacy rules.
- **AC16.** Named performance marks meet the stated sample/p95 gates, candidate
  SQL work is bounded, and focused Android shell instrumentation passes.

## Verification

- Unit: Switchboard state/reducer, stable merge/ranking, scope mappings, quick
  and Place projections, occurrence/owner/route identity, recovery transitions,
  recent-close normalization, cross-viewport table, and exhaustive dispatch.
- Browser: Root/Find focus, no initial keyboard focus, one-sheet transitions,
  every dismissal source, Add guard, Today checkpoint/recovery, account menu,
  absence of gesture handlers, reduced motion, player/Nexus/keyboard clearance,
  pane overflow, recovery dismissal/reopen, and all projection changes.
- Backend integration: every admitted scheme, visibility/missing/openability
  masking, route-only exact ref, one-char query, pre-limit dedupe, bounded work,
  no writes; Highlights pre-limit classification and `owner_resource_ref`;
  concurrent/response-lost page/library create replay.
- Real-stack E2E: switch/close/restore panes; Find exact/deep/highlight-note;
  create note/page/chat/library; import; podcast subscribe; pane cap; browser
  Back; retained-target recovery; every orientation transition.
- Performance: production-build named marks with the pinned samples, endpoint
  SQL-count assertion, and recorded `EXPLAIN (ANALYZE, BUFFERS)`.
- Android: focused `MainActivityTest` instrumentation for hardware Back through
  nested Switchboard pages, external navigation exclusion/handoff, file picker,
  re-entry, and orientation; run `make test-android`.
- Gates: `make check`, focused backend integration, `make test-front-unit`,
  `make test-front-browser`, and targeted `e2e/tests/launcher.spec.ts`,
  `app-navigation.spec.ts`, and `mobile-sheets.spec.ts` replacements, plus the
  focused Android target.

## Files

Create:

- `apps/web/src/components/switchboard/{SwitchboardSheet,SwitchboardRoot,SwitchboardFind,SwitchboardRow,SwitchboardPodcastPanel,CreateLibraryPanel,NexusButton,useSwitchboardController}.tsx`
  plus bounded CSS/tests.
- `apps/web/src/lib/switchboard/{model,findScopes,merge,places}.ts` plus unit tests.
- `apps/web/src/lib/launcher/quickActions.ts`.
- `apps/web/src/lib/resources/openableResources.ts`.
- `apps/web/src/lib/browse/client.ts`.
- `apps/web/src/lib/mobileViewport/{MobileViewportProvider,model}.tsx`/`.ts`
  plus unit/browser tests.
- `python/nexus/schemas/resource_openables.py`.
- `python/nexus/services/resource_items/openables.py`.
- `apps/web/src/app/api/resource-items/openables/search/route.ts`.

Modify:

- `AuthenticatedShell.tsx`; `components/launcher/{Launcher,LauncherSurface,AddPanel}.tsx`;
  `lib/launcher/{model,providers,dispatch,launcherEvents}.ts`; extract/lift the
  Today session from `CreatePanel.tsx`.
- `components/appnav/{AppNav,NavTopBar,NavAccount,navModel}.tsx`/`.ts` and
  `AppNav.module.css`; rename `NavTopBar` to `MobilePaneBar`.
- `lib/workspace/{store,schema}.tsx`/`.ts` and focused tests.
- `components/{GlobalPlayerFooter,ui/MobileSheet}.tsx` and their CSS/tests;
  `WorkspaceHost.module.css`, `ChatSurface.module.css`, reader/media roots, and
  every authenticated primary mobile scroll owner found by the clearance audit.
- `lib/resources/resourceItems.ts` and every caller/test of
  `normalizeResourceItem`.
- `lib/search/{types,normalizeSearchResult,kinds,query}.ts` and tests.
- `lib/notes/api.ts`; `lib/libraries/client.ts`; Add/podcast workflow owners and
  replay tests.
- `python/nexus/api/routes/{resource_items,notes,libraries}.py`;
  `python/nexus/schemas/{search,notes,library}.py`;
  `python/nexus/services/search/{kinds,query,candidates,projection,results}.py`;
  `python/nexus/services/search/retrievers/notes.py`;
  `python/nexus/services/{notes,library_governance}.py`.
- `apps/android/app/src/androidTest/java/app/nexus/android/MainActivityTest.kt`.
- `docs/architecture.md`; `docs/modules/{overlays,workspace,app-navigation,panes-tabs}.md`;
  `docs/cutovers/universal-launcher-hard-cutover.md`; affected tests.

Rename:

- `components/launcher/CreatePanel*` → `TodayCapturePanel*`.

Delete:

- `components/appnav/NavSheet.tsx`, `NavSheet.test.tsx`.
- `components/launcher/LauncherSheet.tsx`.
- Dead styles, tests, event branches, and mobile Launcher/AppNav code identified
  by the negative gates.

## Data and migration

No database schema or data migration. Recently closed is ephemeral. Openable
search is read-only. Page/library create requests now require caller-minted
resource UUIDs; existing UUID primary keys supply replay identity without new
storage. Existing workspace, resource, search, note, library, podcast, ingest,
and access-history persistence remain authoritative.
