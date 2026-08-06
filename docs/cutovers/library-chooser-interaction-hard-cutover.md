# Library Chooser Interaction — Hard Cutover

**Status:** PARTIALLY SUPERSEDED by
`canonical-resource-action-menu-hard-cutover.md` (2026-08-05). The chooser's
responsive interaction, grouping, search, Create, and failure-state rules stay
authoritative. The flat placement capability/API contract in §5 and any
Default-exclusion or local action-cache rule do not; use the canonical typed
destination/relation/availability contract and awaited reconciliation path.

**Original status:** IMPLEMENTED · 2026-07-27

**Type:** hard cutover; one final path, no legacy UI, fallback, alias, flag, or
backward-compatible cursor.

## 0. Decision

Replace every media/podcast library selector with one compact chooser language:

```text
stable field or Libraries… action
  -> anchored desktop chooser / existing mobile sheet
  -> selected or current libraries first
  -> other libraries alphabetically; ranked when destination search is active
  -> search, toggle, optional create, optional load more
```

The chooser floats outside normal form layout. It does not expand a form,
Launcher row, Share card, or accepted-item row.

There are no open product or architecture questions. This specification locks
the 80/20 defaults below.

Prerequisite and authority:

- Complete and verify
  [library-all-and-smart-views-hard-cutover.md](library-all-and-smart-views-hard-cutover.md)
  first. Do not implement the two cutovers concurrently.
- That predecessor owns Default → All identity, the reserved `All` name, and
  destination meaning/copy. This document adopts those decisions and owns the
  downstream chooser topology, interaction, ordering, and responsive surface.
- This document supersedes only that predecessor's
  `LibraryDestinationDisclosure` / `LibraryDestinationPicker` component
  topology. Its copy and identity contracts remain normative.

This document also supersedes:

- the chooser interaction/presentation rules in
  [library-placement-resource-action-hard-cutover.md](library-placement-resource-action-hard-cutover.md);
- [add-content-intake-hard-cutover.md](add-content-intake-hard-cutover.md) §3.6
  and its picker/no-cache residue clauses; and
- the picker component/presentation rules and writable-destination ordering,
  cursor grammar, and cursor-error semantics in
  [android-share-library-destinations-hard-cutover.md](android-share-library-destinations-hard-cutover.md).

Their ingest, placement authorization, capability, route, request, and response
contracts remain normative.

## 1. Goals And Boundary

### Goals

- Make current placement obvious before search.
- Make a known library fast to find by name.
- Remove layout reflow, oversized desktop dialogs, and duplicate picker chrome.
- Preserve one visual/keyboard language across standing placement and intake.
- Keep permission and mutation truth authoritative.
- Reuse the existing mobile sheet, anchored-position, layered-dismissal, focus,
  destination, and placement primitives.

### In scope

- Media/podcast `Libraries…` placement.
- Add Content draft, per-row, OPML, and accepted-item library controls.
- `/share` media destinations.
- Podcast subscription destinations.
- Chooser presentation, responsive surface, ordering, focus, dismissal,
  loading, creation, paging, and post-command reconciliation.
- Existing placement-list ordering and writable-destination ordering/cursor.
- Consolidation and deletion listed in §8.

### Non-goals

- Changing All/Unfiled, reserved-name, or default-library semantics/copy.
- Favorites, recents, pinning, shortcuts, drag/drop, AI suggestions, bulk
  taxonomy, hierarchy, tags, or library management.
- New permission, capability, mutation, ingest, or create semantics.
- New API route, table, migration, index, persistent cache, prefetch service, or
  generic popover framework.
- Redesigning library browsing, filtering, membership, Share, Launcher, or
  podcast subscription.
- Showing default/system libraries in standing placement.

### Accepted 80/20 limits

- Writable destination search remains substring search over at most 50 rows per
  page; placement filters its complete returned inventory locally.
- Placement inventory is fetched on every new standing-placement session.
- Destination results persist only while their field remains mounted.
- No cross-surface or cross-session result cache exists.
- One mutation runs at a time per chooser.
- A concurrent rename may move a row between destination pages; no snapshot or
  immutable sort-key subsystem is introduced.

## 2. Final Product Contract

### Structure

```text
standing resource placement
  ResourceMenu Libraries…
  -> LibraryPlacementController
  -> LibraryPlacementOverlay
  -> LibraryChooserSurface
  -> LibraryEntryEditor adapter
  -> LibraryChooser

accepted Add placement
  addContentSessionModel + useAddContentSession
  -> LibraryChooserSurface
  -> LibraryEntryEditor adapter
  -> LibraryChooser

intake destination selection
  LibraryDestinationField
  -> LibraryChooserSurface
  -> LibraryDestinationPicker adapter
  -> LibraryChooser
```

`LibraryChooser` owns only controlled search/list presentation and keyboard
interaction. `LibraryChooserSurface` owns only responsive placement, portal,
dismissal, and focus. The two adapters retain distinct domain state:

- `LibraryEntryEditor` consumes authoritative placement capabilities and sends
  callbacks to either the standing-placement controller or Accepted Add's
  existing batch-placement state machine.
- `LibraryDestinationPicker` searches writable destinations and edits a
  parent-owned local selection committed only by the parent workflow.

Do not merge their transport, authorization, or mutation state machines.

### Visible behavior

- A compact field remains in normal layout. Its summary never expands in place.
- Desktop opens a viewport-clamped chooser anchored to that field or to the
  resource-menu toggle that invoked `Libraries…`.
- Mobile opens the existing `MobileSheet`.
- Search is sticky at the top.
- `Selected` / `In these libraries` is always first and remains visible while
  filtering. Search filters only the other-library section.
- Selected rows and standing-placement other rows are case-insensitively
  alphabetical. Standing placement filters its complete list by client-side
  substring. Writable-destination other rows preserve server exact → prefix →
  contains rank, then alphabetical order within each rank.
- Rows are one line: color dot, name, selected check, and pending/read-only
  state. Read-only rows visibly show a lock and `Read only`; their full reason
  remains accessible. Delete repeated `Included` / `Not in` metadata lines.
- Long names use single-line ellipsis inside the 360–420px surface. The
  accessible name remains complete.
- Desktop interactive rows are at least 36px high; coarse-pointer/mobile rows
  are at least 44px high.
- Empty inventory and no-match copy are distinct.
- Creation remains a final explicit row for a valid, fully searched query. A
  created library is inserted, selected, and does not close the chooser.

### Context-owned truth

The chooser never hard-codes one empty meaning for all callers:

| Context | Selected section / collapsed empty summary |
|---|---|
| Existing resource placement | API-returned non-default placements / no collapsed field |
| Media intake / Android Share | selected additional named libraries / `No additional libraries` |
| Podcast subscription / OPML | selected named libraries / `No libraries selected` |

`emptyLabel` is required and caller-owned; shared components define no default.
Populated summaries use alphabetized selected names: one name; two as `A, B`;
three or more as `A, B +N`. Summary text ellipsizes without changing its
accessible name.

Labels such as `Libraries`, `Libraries for new subscriptions`, and
`Libraries for accepted items` remain owned by the host workflow. This cutover
does not reinterpret empty selection as Unfiled or as a complete placement set.

## 3. Interaction And Accessibility

### Desktop

- The anchor and primary return-focus target are the same stable element.
- Width is 360–420px; height is content-sized up to the viewport clamp.
- Focus search on open.
- Outside pointer, `Escape`, or the explicit close command closes only the
  chooser and restores the anchor, or the supplied fallback if it disappeared.
- Browser Back closes a modal-contained chooser before its parent. A base-page
  desktop chooser does not add a history entry.
- When opened inside Launcher or another modal, portal into that containing
  `[role="dialog"]`; never portal a modal-owned chooser to `document.body`.
- Extract the existing `ActionMenu` modal-aware portal-container rule into one
  small UI owner used by both `ActionMenu` and `LibraryChooserSurface`.
- Reuse `useAnchoredPosition`, `useDismissOnOutsideOrEscape`,
  `useHistoryDismiss`, and `useReturnFocus`. Do not adapt
  `FloatingActionSurface`; its layer and selection contract differ.
- Register `useHistoryDismiss` only for modal-contained desktop choosers.
  `MobileSheet` owns mobile Back dismissal; do not register it twice.

### Mobile

- Reuse `MobileSheet`; keep it mounted and drive it with `active`.
- `LibraryChooserSurface` requires `layer: "modal" | "palette"`; Add/OPML use
  `palette`, while standing placement, Share Capture, and podcast detail use
  `modal`. There is no inferred/default layer.
- Initial focus is sheet chrome so opening does not summon the keyboard.
- A user tap moves focus to search.
- Preserve the existing mobile-chrome visible lock.
- Back/`Escape` closes exactly the top chooser sheet before its parent surface.

### Combobox/listbox

- Search is a labelled text input with `role="combobox"`,
  `aria-controls`, `aria-expanded`, and `aria-activedescendant`.
- The result container is one `aria-multiselectable="true"` listbox with named
  groups. Options expose `aria-selected`; unavailable options expose
  `aria-disabled` and an accessible reason.
- DOM focus stays on search. Arrow keys and Home/End move the active option;
  Enter activates it. These are the only intercepted text-input navigation
  keys while the listbox is active.
- Pointer and keyboard toggles are equivalent. Every other native text-editing
  key remains browser-owned.
- A persistent `role="status"` announces loading/counts; expected errors use
  `role="alert"` and Retry.
- Color, icons, and position are redundant cues, never the only state signal.
- An in-flight create command is the only destination-field dismissal lock.

## 4. Frontend Contracts And State

### Shared view

Use closed variants; do not add a generic option renderer:

```ts
type LibraryChooserItemInteraction =
  | { kind: "Enabled" }
  | { kind: "Pending" }
  | { kind: "ReadOnly"; reason: string };

interface LibraryChooserItem {
  id: string;
  name: string;
  color: string | null;
  selected: boolean;
  interaction: LibraryChooserItemInteraction;
}
```

`LibraryChooser` accepts controlled query, named selected/other groups,
load/error/status state, toggle, optional create, and optional load-more.
Adapters project their existing decoded DTOs into this local view type. The
shared view performs no fetch and sends no mutation.

Adapters must provide disjoint groups: subtract every selected ID from the
other group after paging/deduplication. One library ID renders as exactly one
option with exactly one DOM option ID.

### Surface/session

Hard-cut placement open options to one meaning per field:

```ts
interface LibraryPlacementOpenOptions {
  anchor: ReturnFocusTarget;
  returnFocusFallback: Presence<ReturnFocusTarget>;
}
```

`anchor` owns positioning and primary focus return. Delete `returnFocusTo` from
this placement contract; do not retain an alias.

`LibraryDestinationField` replaces `LibraryDestinationDisclosure`. It always
mounts its picker adapter, renders the compact trigger/summary in flow, and
opens the shared surface outside flow. Closing preserves query and last-good
results while the field remains mounted. Its required `emptyLabel` is rendered
only when selection is empty and has no shared default.

### Destination search

```text
Closed
  -> Open: immediately GET the preserved normalized query; bypass debounce
Open + query change
  -> keep last-good rows visible and aria-busy
  -> empty query: GET immediately
  -> non-empty query: debounce for DESTINATION_QUERY_DELAY_MS = 180
Create/LoadMore
  -> one operation; retain current rows; expose local error and retry
```

One request-generation/abort owner covers open, search, and Load More. Every
open/query request invalidates and aborts the prior read, including Load More;
closing aborts reads but retains query and last-good results. Load More binds
the active generation and normalized query, and a stale response cannot commit.
Latest response wins.

Selection remains controlled by the parent. Selected items are never duplicated
as both chips and ordinary rows. Search state is adapter-owned, not copied into
Add, Share, or podcast surfaces.

### Standing placement mutation

```text
Ready
  -> command running: initiating row pending; all commands disabled
  -> failure: preserve prior state; expected error + Retry
  -> acknowledged: project only the server-confirmed relation
                   reconcile canonical action snapshot, then authoritative GET
  -> unknown settlement: observe authoritative relation
       desired relation -> canonical reconciliation
       unchanged relation -> replay the same idempotent command identity
  -> GET success: replace projection and capabilities; Ready
  -> transient GET failure: ReconcileFailed; show confirmed flip,
                             disable commands, offer Retry
  -> terminal target-gone GET: Unavailable; offer Close only
```

- Never project a relationship change before command acknowledgement.
- Do not mutate the decoded DTO. Derive the confirmed-relation overlay by
  destination identity.
- Availability and inherited provenance come only from the strict inventory.
- Closing may abort list GET but not an active mutation. A closed or newer
  session cannot receive stale state; reopening fetches afresh.
- Close exits every failure state. Retry exists only for modeled transient
  failures; terminal missing/inaccessible targets do not enter a retry loop,
  and same-system defects throw.

### Accepted Add placement

`addContentSessionModel.ts` and `useAddContentSession.ts` retain the existing
Accepted-item `Unloaded | Loading | Ready | Updating | Reconciling |
LoadFailed | CommandFailed` state and bounded multi-media
mutation/reconciliation behavior. They supply controlled rows/callbacks to the
shared view; this cutover does not replace that state machine or impose the
standing controller's projection rules on it.

## 5. Capability And API Contract

Standing placement consumes the canonical closed
`destination × relation × availability` inventory. Saved in Nexus is a physical
Media destination; visible named Libraries include direct, absent, inherited,
system-managed, authority-blocked, and subscription-blocked states. Every
mutation reauthorizes in its existing service owner.

Current routes:

```text
GET    /api/libraries/writable-destinations
POST   /api/libraries

GET    /api/media/{mediaId}/libraries
POST   /api/media/{mediaId}/libraries
PUT    /api/media/{mediaId}/saved-in-nexus
DELETE /api/media/{mediaId}/saved-in-nexus
DELETE /api/media/{mediaId}/libraries/{libraryId}

GET    /api/podcasts/{podcastId}/libraries
PUT    /api/libraries/{libraryId}/podcasts/{podcastId}
DELETE /api/libraries/{libraryId}/podcasts/{podcastId}
```

Media add and Saved PUT are idempotent bodyless commands. Media removals and
Podcast add/removals return typed collection revisions. Podcast writes reuse a
stable `Idempotency-Key`; named Podcast placement requires an active
subscription and never creates one.

### Canonical ordering

- `library_entries.list_item_libraries`: `lower(name) ASC, name ASC, id ASC`.
- Writable destination blank query: alphabetical.
- Non-empty query: exact rank, prefix rank, contains rank; within each rank,
  `lower(name) ASC, name ASC, id ASC`.
- SQL owns remote ordering. The client sorts only parent-owned selected values
  that are not a server page.

Hard-cut the opaque writable-destination cursor to:

```json
{
  "k": "library_destinations:v2",
  "viewer_id": "UUID",
  "q": "normalized query",
  "rank": 0,
  "normalized_name": "lower-case name",
  "name": "original name",
  "id": "UUID"
}
```

- Normalize `q` once at service ingress by trim + lower-case.
- Keyset paging follows the exact ascending order tuple.
- Decode the exact object, viewer, and normalized query. Any mismatch, unknown
  key, old timestamp cursor, or malformed value returns
  `400 E_INVALID_CURSOR`.
- Delete `updated_at` and `created_at` from destination ordering and cursor
  code. The `:v2` discriminator makes the new sort-key grammar explicit and
  follows this module's versioned-cursor precedent. Accept only v2; add no
  compatibility decoder for the old unversioned kind.
- Keep current limit, response schema, BFF, and strict frontend decode.

No database migration or index is justified for this one-user bounded list.

## 6. Intra-System Ownership

| Concern | Final owner |
|---|---|
| Shared controlled presentation | `components/libraries/LibraryChooser.tsx` + CSS |
| Responsive/layered surface | `components/libraries/LibraryChooserSurface.tsx` + CSS |
| Placement view adapter | `components/libraries/LibraryEntryEditor.tsx` |
| Placement surface/session | `components/libraries/LibraryPlacementOverlay.tsx`, `lib/libraries/placementController.tsx` |
| Standing placement state/client | `lib/libraries/useLibraryPlacement.ts`, `libraryPlacement.ts` |
| Accepted Add placement state | `components/launcher/addContentSessionModel.ts`, `useAddContentSession.ts` |
| Destination field/adapter | `components/libraries/LibraryDestinationField.tsx`, `LibraryDestinationPicker.tsx` |
| Destination transport/create | existing `lib/libraries/client.ts` |
| Portal-container invariant | new `lib/ui/transientPortalContainer.ts`; also consumed by `components/ui/ActionMenu.tsx` |
| Standing placement policy | existing resource action/catalog/composition owners |
| Placement query policy | `python/nexus/services/library_entries.py` |
| Writable search/cursor policy | `python/nexus/services/library_governance.py` |
| Living docs | `docs/modules/library.md`, `docs/modules/sharing.md`, `docs/architecture.md` |

Do not introduce a chooser context/provider, reducer framework, backend
“chooser” service, barrel export, or second library client.

## 7. Implementation Files

### Add

- `apps/web/src/components/libraries/{LibraryChooser,LibraryChooserSurface,LibraryDestinationField}.tsx`
  and adjacent CSS/tests.
- `apps/web/src/lib/ui/transientPortalContainer.ts` and focused test.

### Move/modify

- Move `components/LibraryDestinationPicker*` under
  `components/libraries/`; update it to the adapter contract.
- Placement:
  `components/libraries/{LibraryPlacementOverlay,LibraryEntryEditor}*`,
  `lib/libraries/{placementController,useLibraryPlacement}*`,
  `lib/resources/resourceActionExecution*`,
  `components/{collections/CollectionRow,workspace/PaneShell}.tsx`.
- Intake callers:
  `components/launcher/{AddPanel,addContentSessionModel,useAddContentSession}*`,
  `components/OpmlImportPanel*`,
  `app/share/ShareCapture*`, and
  `app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody*`.
- Pinned architecture/unit/E2E contracts:
  `apps/web/src/lib/launcher/architectureInvariants.test.ts`,
  `apps/web/src/__tests__/components/PaneShell.test.tsx`,
  `e2e/tests/library-placement.spec.ts`, and
  `e2e/tests/share.spec.ts`.
- Layer owner: `components/ui/ActionMenu*`.
- Backend:
  `python/nexus/services/{library_entries,library_governance}.py` and focused
  library/media/podcast tests.
- Living and superseded docs named in §§0 and 6.

### Delete

- `apps/web/src/components/LibraryDestinationDisclosure*`.
- Old root `apps/web/src/components/LibraryDestinationPicker*` after the direct
  move; no re-export.
- `apps/web/src/components/libraries/LibraryEntryPanel.tsx`; accepted Add
  placement uses `LibraryChooserSurface` directly.
- Inline/disclosure `presentation` variants, picker chip strip, desktop
  placement `Dialog`, local `ActionMenu.resolvePortalContainer`, timestamp
  destination cursor/order code, superseded tests/styles/comments/selectors,
  and dead imports.

## 8. Hard-Cut Rules

- One chooser view, one responsive surface, one destination adapter, and one
  placement adapter remain.
- No inline expanded picker, desktop placement dialog, nested accepted-item
  dialog, or mobile-only picker remains.
- No compatibility component, prop variant, import alias, cursor decoder,
  feature flag, fallback surface, or deprecated comment remains.
- Do not generalize this into arbitrary taxonomy/multi-select UI.
- Update old normative docs in the same implementation change; do not leave
  contradictory final-state prose.
- `rg` residue gates cover deleted names, old import paths, old presentation
  variants, timestamp cursor keys, the old unversioned destination cursor, and
  desktop placement `Dialog`.
- The `returnFocusTo` → `anchor` gate is scoped to
  `placementController.tsx`, `LibraryPlacementOverlay.tsx`, and
  placement-specific unit expectations. The identifier remains valid in other
  overlay contracts; do not use a repository-global ban.

## 9. Implementation Order

1. Complete and verify the All/Smart predecessor; reconcile its shared files
   and copy before starting this cutover.
2. Add failing server ordering/cursor and browser interaction tests.
3. Hard-cut SQL ordering/cursor and focused API tests.
4. Add the controlled chooser and responsive surface using existing UI hooks.
5. Adapt standing placement and Accepted Add without merging their machines.
6. Replace destination disclosure/inline callers with the field/surface.
7. Delete old components, variants, wrapper, styles, tests, and local portal
   helper; update living/conflicting docs.
8. Run residue searches, focused checks, and the real-stack flow.

Do not retain intermediate adapters between steps.

## 10. Acceptance Criteria

- Every chooser shows selected/current libraries first. Placement groups are
  alphabetical; destination search is exact/prefix/contains ranked and
  alphabetical within each rank.
- Searching never hides the current selection.
- Reopen immediately requests the preserved query; clearing requests empty
  immediately. Non-empty typing is debounced, latest-wins, and does not blank
  last-good results.
- Open/search/Load More share one generation/abort owner. A query change drops
  in-flight Load More, and selected/other groups never duplicate an ID or
  option DOM ID.
- Opening a chooser in Add, Share, OPML, a draft row, or an accepted row changes
  no surrounding geometry.
- Desktop anchoring, modal-local portal/layer, outside dismissal, one-layer
  `Escape`, history-enabled Back, mobile sheet behavior, and deterministic
  focus return pass.
- Empty Media intake/Android Share says `No additional libraries`; empty
  podcast subscription/OPML says `No libraries selected`. Populated collapsed
  summaries follow the one/two/`+N` contract.
- Read-only placement remains visible with a lock, `Read only`, and an
  accessible reason; long names ellipsize without truncating accessible names.
- No UI membership projection occurs before `204`; after `204` the row updates
  immediately and capabilities stay disabled until authoritative
  reconciliation.
- Standing transient reconciliation failures offer Retry; target-gone is
  Close-only. Accepted Add retains its existing independent placement machine.
- Writable pages are stable under alphabetical keyset paging; a pre-cutover
  cursor fails with `400 E_INVALID_CURSOR`, and only
  `library_destinations:v2` is accepted.
- Placement/destination authorization, creation, ingestion, and response schemas
  are unchanged.
- No new route, persistence, cache, generic framework, fallback, legacy path,
  or duplicate owner exists.

## 11. Verification

- Pure/component: disjoint grouping, summaries, keyboard, ellipsis/accessibility,
  immediate versus debounced search, shared-generation stale suppression,
  create/Load More, transient/terminal reconciliation failure, and Accepted Add
  adaptation.
- Browser: anchored geometry without reflow, modal-local layering, outside and
  one-layer dismissal, mobile focus, focus return.
- Backend integration: blank/query ordering, exact page boundaries, viewer/query
  cursor binding, v2-only/old/malformed cursor rejection, unchanged permissions.
- Real stack: one media `Libraries…` add/remove flow and one Add Content
  destination-selection/submit flow.
- Migrate the path/role assertions in
  `apps/web/src/lib/launcher/architectureInvariants.test.ts`,
  `apps/web/src/__tests__/components/PaneShell.test.tsx`,
  `e2e/tests/library-placement.spec.ts`, and `e2e/tests/share.spec.ts`; no old
  dialog, `aria-pressed`, chip-removal, picker-path, or placement
  `returnFocusTo` assertion survives.
- Run focused TypeScript, ESLint, formatting, Ruff, Pyright, diff, and residue
  checks; broad-suite expansion is not part of this cutover.
