# Canonical Collection Row Hard Cutover

> **Superseded (2026-07-22):**
> [`library-sorting-hard-cutover.md`](library-sorting-hard-cutover.md) collapses
> the "resonance list, gallery entries, list entries" three-way split of
> `LibraryPaneBody` this document references into one view controller.

**Status:** Implemented and locally verified · 2026-07-21 · adversarially
reviewed

**Posture:** One coordinated hard cut. No gallery, density, thumbnail row,
legacy author row, swipe path, compatibility state, fallback renderer, or feature
flag survives. Rollback is git-revert-of-the-merge-commit only; there is no
feature flag, dual-render path, or partial-rollback surface by design.

Governing standards: `docs/rules/{boundaries,cleanliness,codebase,frontend,
simplicity,testing,control-flow}.md`.

This document supersedes the Gallery, density, row-thumbnail, composite-list
keyboard, swipe, and author-work rendering portions of
[`collection-surface-hard-cutover.md`](collection-surface-hard-cutover.md). It
does not replace that document's presenter, collection, connection, or pane-kit
ownership. It also supersedes only the author-work row presentation in
[`lightweight-author-deduplication-hard-cutover.md`](lightweight-author-deduplication-hard-cutover.md)
and the Gallery/publisher presentation in
[`library-reading-time-hard-cutover.md`](library-reading-time-hard-cutover.md);
their data, cursor, identity, and estimate contracts remain. It supersedes both
the words “comfortable” and “inherits Gallery or density” in §3 **and** the §10
“Presentation:” wiring sample of
[`resonance-reading-slate-hard-cutover.md`](resonance-reading-slate-hard-cutover.md)
(the `signals`, `view="list"`, `density="comfortable"` instructions there): the
Slate now composes through the canonical view-model with no `signals`/`view`/
`density` surface. All four superseded documents describe already-shipped code;
“supersede” here means this follow-on cutover changes that live behavior, and the
prose in those documents is void only for the portions named above.

Open questions: none.

## 0. Council decision

One compact adaptive row is the sole collection form. It prioritizes identity
and next action, not source metadata or display preferences.

```text
desktop   Title                                  state   …
          Author(s) · date · context

mobile    Title (maximum two lines)                       …
          Author(s) · date · compact state (one line)
```

- Title is primary. Credits and date are quiet identity. Consumption is one
  compact expression. Exceptional processing/sync state appears only when it
  requires attention.
- Publisher, progress bars, standing Related controls, reorder icons, and
  duplicate badges do not appear at rest. No collection row has a thumbnail,
  cover/poster column, kind icon, or generated identity token.
- Every media-bearing surface uses the same `CollectionRow` implementation:
  EPUB, web article, PDF, video, podcast show, podcast episode, Lectern, Reading
  Slate, Library, Search media hits, and author works.
- Same renderer does not mean identical endpoint payloads. Presenters surface
  the truthful facts their owning domain provides; they never fabricate absent
  activity, time, capabilities, or actions.
- Author works use the canonical row and omit the page contributor. A quiet role
  fact such as `Translator` remains when it explains why the work is present.

The meta-rule is: **one stable anatomy, context-owned content, details on
demand**. The product chooses the hierarchy once instead of asking the user to
configure it. This is one opinionated form, not a display setting removed and
left unreplaced; the row’s hierarchy is fixed and its content is context-owned.

## 1. Goals, scope, and non-goals

### Goals

- Make the normal row scannable at desktop and phone widths without a second
  action row.
- Expose title, useful credits, date, one activity signal, and one action menu
  when those facts exist.
- Collapse duplicate rendering, focus, gesture, and display-state paths.
- Preserve native accessibility, truthful capabilities, lazy connections, and
  manual drag reorder — with a keyboard and a single-pointer non-drag reorder
  alternative (§5).
- Lower total code and state.

### Scope

- Remove Gallery and comfortable/compact state from every `CollectionView`
  consumer, including non-media collections.
- Replace the shared row view-model and responsive layout in place.
- Remove collection-row thumbnails for every kind. `ResourceThumb` remains for
  the media detail header and other non-collection owners; it has no collection
  row API.
- Consolidate author works into `CollectionView -> CollectionRow -> ResourceRow`.
- Put connections/related behind the existing overflow menu.
- Make the overflow trigger the sole mouse/touch drag activator for reorderable
  Library and Lectern rows, backed by `Move up`/`Move down` menu commands.
- Remove row swipe and ordinary-list roving focus.
- Delete adjacent code made unreachable by this cut.

### Non-goals

- No new universal row endpoint, backend action schema, database migration,
  cache, AI, personalization, or user preference.
- No rewrite of Library, Search, Podcast, Lectern, Resonance, contributor, or
  resource-graph domain contracts.
- No attempt to give compact endpoints facts they do not own. In particular,
  author works remain a mixed media/podcast/Project Gutenberg projection; they
  do not embed `MediaOut` or Library-only reading time.
- No detail-page, reader, `ItemCard`, chat-context-card, filter, sort, or
  navigation redesign.
- No new reorder mode, move-to-top/bottom commands, handle icon, row-wide drag,
  submenu, or connection sheet. (`Move up`/`Move down` live inside the existing
  `…` menu; they are the accessibility alternative, not a new visible control.)
- No migration behavior for old `view`/`density` URLs. Those keys are no longer
  parsed, generated, or preserved. Verified: `view`/`density` are read only by
  the deleted `collectionViewState`/`useCollectionDisplayState` modules and are
  never scrubbed on mount today, so dropping the parser leaves the keys inert in
  bookmarked URLs, matching this app’s existing behavior toward every other
  unrecognized query param. Incidental framework tolerance is not a compatibility
  contract.

## 2. Target behavior and visual rules

### Information priority

1. **Title:** linked/button primary; one line at normal widths, at most two at
   narrow widths.
2. **Identity:** at most two useful contributor credits, then `+N`; publication
   date follows. The current author is removed on author detail.
3. **Context:** only a fact that explains the row here: search snippet, Slate
   reason, author role, web-article source host, or similar surface-owned reason.
4. **Activity:** exactly one quiet, tabular expression.
5. **Actions:** at most one surface-owned primary control plus one `…` menu.

Publisher, language, provider, content kind, and added/updated time stay off the
normal media row. Source host is permitted as a surface-owned context fact for
the web-article kind, where it is a load-bearing trust and identity signal; it
stays off other kinds. A mixed-target surface may show kind only when it is
necessary to disambiguate destinations.

### Identity and imagery

No collection row renders imagery or another leading identity token. This is a
deliberate space and hierarchy decision across text, video, and podcast kinds:
title, contributors, date, context, and activity carry identity in the compact
index. Domain-provided cover/poster art remains available to detail surfaces but
does not enter `CollectionRowView`; `CollectionRow` never passes a leading slot.
`ResourceRow.leading` is deleted because its only production caller is
`CollectionRow` (test-only use does not retain it). Reintroducing row visual
identity requires a separate evidence-backed cutover; this contract has no
speculative token API.

### Typographic contract

“Editorial” and “type-forward” are enforced by type, not by a density budget.
The implementation owns these values as the single source of the row’s visual
character:

- **Title:** `var(--text-base)`, `var(--weight-semibold)`,
  `var(--leading-snug)`, and `var(--tracking-tight)`. At 320px it remains legible
  at up to two lines without collapsing leading.
- **Rhythm:** identity, date, and context share one supporting line separated by a
  middle dot with spaces (` · `); the `≈` approximation glyph is preserved. The
  line uses `var(--text-sm)`, `var(--weight-regular)`, and
  `var(--leading-normal)` in the existing muted text color.
- **Spacing:** the collapsed grid uses `var(--space-2)` block/inline padding and
  at most `var(--space-1)` between title and support. Existing type and spacing
  tokens are the only scale; this cut adds no row-specific design-token system.
- **Height:** content and leading determine height. The result is compact without
  clipping or compressed leading; there is no fixed-height target.

### Activity grammar

The view-model carries decoded numeric facts plus an explicit modality
(`Read` / `Listen` / `Watch`); `CollectionItemKind` is not used to infer modality
because its `media` variant covers documents and video. `CollectionRow` performs
all abbreviation, locale formatting, percentage conversion, and accessible-label
expansion at render.

| State | Visible form (text kind shown; verb varies by kind) |
| --- | --- |
| Unread, total known | `Unread · ≈18 min` |
| Unread, total absent | `Unread` |
| In progress, both known | `42% · ≈5 min left` |
| In progress, partial facts | the truthful available subset (at least one fact) |
| Finished | `Finished` |
| Podcast show with unplayed | `3 new` |
| No consumption contract | no activity slot |
| Exceptional operation | `Processing`, `Sync failed`, etc.; normal ready is silent |

The accessible label expands abbreviations and approximation (for example
“about 5 minutes left to read”); this requires the numeric value, which is why
the view-model never pre-formats time into display strings. There is no progress
bar chrome, proportional underline, percentage pill, state icon, or second
rendering of the same fact. Library retains its canonical reading-time estimate.
Timed media may derive total or remaining duration from its existing listening
payload where that payload carries millisecond timing (footer-audio-activated
items); video rows and other projections that carry only a progress fraction
render percent and omit time rather than estimating it. Other contexts omit time
rather than estimating it again.

### Responsive contract

- The collapsed row is a grid, not a wrapping main block followed by a full-width
  side block.
- Desktop: content, activity/exception, and actions are stable columns.
- Narrow: title remains beside the action target; identity/context/activity share
  one clamped supporting line. Nothing creates a dedicated action row.
- The visible ellipsis is small; its hit target is at least 44px on coarse
  pointers and at least 24px on fine pointers (WCAG 2.5.8), and it does not
  enlarge the glyph.
- Normal row height is governed by the typographic contract and its vertical
  rhythm, not by a fixed pixel ceiling. It stays a compact two-line anatomy
  (title of at most two lines plus one supporting line); it must not balloon into
  a card or compress the declared leading.
- No horizontal overflow at 320px, 390px, or 200% zoom.
- Expanded panels and `ConnectionRail` occupy a full row below the collapsed
  anatomy and do not change the base contract.

## 3. Final architecture

```text
existing domain DTO
  -> strict boundary decoder            (keeps Presence<T> unflattened)
  -> pure present<Context>()            (selects facts; keeps Presence<T>)
  -> CollectionRowView
  -> CollectionView (state + one list path)
  -> ResourceList (<ul>)
  -> CollectionRow (composes content)
  -> ResourceRow (renders slots)
```

- `CollectionView` owns loading/error/empty/ready composition, panels, optional
  reorder orchestration (including the existing view-transition machinery), and
  row transitions. It has no display-mode branch.
- `ResourceList` owns only reusable semantic `<ul>` markup, its accessible label,
  and list styling. `CollectionView` owns empty rendering and item keying;
  sortable item position belongs to `SortableList`. `ResourceList` is not a
  listbox/grid and has no custom arrow, Home/End, typeahead, or hidden-control
  focus protocol. If no production caller needs more than a bare `<ul>` after
  the rewrite, inline it into `CollectionView` rather than retain an empty layer.
- `ResourceRow` owns the compact grid, primary activation, supporting line, and
  the **rendering** of the activity/exception, optional primary control, menu,
  and expansion **slots**. It knows no domain, route, or DnD policy. It is worth
  its own unit because the grid, responsive reflow, hit targets, and native focus
  order are testable in isolation without domain fixtures.
- `CollectionRow` **composes the content** of those slots: it formats activity
  (numeric facts → display + accessible label), maps `ExceptionalStatus` to
  tone+label through an exhaustive helper, composes action-menu commands from
  truthful capabilities, owns lazy related/connection expansion, and owns the
  optional reorder activator. Each concern has exactly one owner: composition in
  `CollectionRow`, rendering in `ResourceRow`.
- Pure presenters own selection and ordering of truthful row facts. Panes own
  fetch/mutation state and callbacks. `ActionMenu` remains the action primitive;
  `SortableList` remains the reorder owner.
- Author work gets one pure `presentContributorWork` adapter. There is no author
  row component or author row CSS.
- Naming convention: `Resource*` names domain-free UI primitives (`ResourceList`,
  `ResourceRow`); `Collection*` names the domain binders (`CollectionView`,
  `CollectionRow`, `CollectionRowView`).

## 4. Frontend contract

Illustrative final shape; exact imported domain types remain canonical:

```ts
declare const publicationDateBrand: unique symbol;

interface ProgressFraction {
  readonly value: number; // boundary-validated finite value in [0, 1], never a percent
}

interface PositiveMinutes {
  readonly value: number; // boundary-validated integer >= 1
}

interface PositiveCount {
  readonly value: number; // boundary-validated integer >= 1
}

type PublicationDate = string & {
  readonly [publicationDateBrand]: true; // validated partial ISO date or instant
};

type ConsumptionModality = "Read" | "Listen" | "Watch";

type InProgressActivity =
  | {
      kind: "InProgress";
      modality: ConsumptionModality;
      fraction: { kind: "Present"; value: ProgressFraction };
      remainingMinutes: Presence<PositiveMinutes>;
    }
  | {
      kind: "InProgress";
      modality: ConsumptionModality;
      fraction: { kind: "Absent" };
      remainingMinutes: { kind: "Present"; value: PositiveMinutes };
    };

type CollectionActivity =
  | {
      kind: "Unread";
      modality: ConsumptionModality;
      totalMinutes: Presence<PositiveMinutes>;
    }
  | InProgressActivity
  | { kind: "Finished"; modality: ConsumptionModality }
  | { kind: "Unplayed"; count: PositiveCount };

type CollectionContext =
  | { kind: "Text"; text: string }        // Slate reason, author role, web host, disambiguating kind
  | { kind: "Snippet"; segments: EmphasisSegment[] };

type ExceptionalStatus =
  | {
      kind: "MediaProcessing";
      status: Exclude<MediaProcessingStatus, "ready_for_reading">;
    }
  | {
      kind: "PodcastSync";
      status: Exclude<PodcastSyncStatus, "complete">;
    };

interface ConnectionSummaryView {
  total: number;
  dominantKind: Presence<EdgeKind>;
  topPeers: readonly ConnectionEndpointOut[];
}

interface CollectionRowView {
  id: string;
  kind: CollectionItemKind;
  primary: ResourceRowPrimary;
  title: { text: string; segments?: EmphasisSegment[] };
  contributors: readonly ContributorCredit[];
  publicationDate: Presence<PublicationDate>; // formatted only at render
  context: Presence<CollectionContext>;
  activity: Presence<CollectionActivity>;
  exceptionalStatus: Presence<ExceptionalStatus>;
  connections: Presence<ConnectionSummaryView>;
  relatedMediaId: Presence<string>;  // real DTO field; never parsed from href
  actions: readonly ActionDescriptor[];
  selected: boolean;
}
```

There is no `lead`, `signals[]`, `related[]`, `view`, `density`, `swipeActions`,
generic metadata bag, preformatted publisher, preformatted time/date string, or
duplicated progress representation. The former preseeded `related[]` peer list is
deleted, not folded into another field: `connections` is the existing batch
summary, `relatedMediaId` is the explicit lazy-lookup capability, and
`CollectionRow`'s hook owns loaded related state.

- **Presence reaches render.** Decoders, domain models, presenters, and
  `CollectionRowView` keep `Presence<T>` unflattened, per `boundaries.md` and
  `frontend.md`. Presenters may select and map a present value into another rich
  value, but they preserve the `Present`/`Absent` classification. `CollectionRow`
  is the render boundary and the sole layer that pattern-matches Presence into
  rendered content or visual omission. Optional properties remain only for
  component-local presentation syntax such as emphasized title segments; they do
  not encode decoded domain absence.
- **Illegal states.** `InProgress` requires a present fraction, present remaining
  time, or both; an activity containing neither cannot be constructed. `Unread`
  with absent total time is legal and renders `Unread`. `Unplayed` carries a
  positive count, so `0 new` cannot render.
- **Rich values, not display primitives.** Source decoders or the existing
  source-owned derivation helper own the finite `[0, 1]` fraction and
  positive-integer minute/count guarantees; presenters only select those values,
  and the renderer does not clamp or revalidate them. The view-model carries a
  fraction rather than a percentage and carries numeric value objects rather
  than display strings. `CollectionRow` derives percentages, formats
  dates/durations, and expands the accessible label at render. Neutral owners
  live in `lib/consumption/activityFacts.ts` and
  `lib/dates/publicationDate.ts`; source/domain code never imports presentation
  contracts to construct them.
- **Exhaustive operation status.** `ExceptionalStatus` reuses the complete
  existing status vocabularies and excludes only their normal silent states.
  Its renderer has no default branch; adding a domain status is a compile error
  until presentation is chosen.

### Capability contract

- A menu command exists only when the pane supplies its truthful capability and
  handler. Rendering parity never mints action parity.
- A present `connections` value with `total > 0`, or a present
  `relatedMediaId`, adds one leading **Connections and related** menu command.
  Invocation closes the menu, lazily loads as today, and toggles the existing
  inline `ConnectionRail`.
- One genuinely primary surface command may remain visible: e.g. Slate Add or
  Lectern Play. Everything else belongs in `ActionMenu`. This one-optional-primary-
  plus-overflow anatomy is fixed; it is not a configurable or duplicate surface.
- `sortable` exists only under the current backend/caller eligibility: editable
  manual ordering, supported destination, and complete loaded order.
- Disabled/busy reorder disables drag and the reorder commands only. The rest of
  the menu remains operable.

## 5. Reorder and action-menu interaction

Reorder has three layered paths on the reorderable Library and Lectern rows: two
menu commands (the discoverable, single-pointer, voice- and touch-AT-reachable
path), a pointer-drag accelerator, and a keyboard accelerator.

- **Menu commands.** When `sortable` is eligible, the `…` menu’s leading group
  contains `Move up` and `Move down` (each disabled at the corresponding end of
  the list). These are the WCAG 2.5.7 single-pointer, non-drag alternative and the
  voice-control- and touch-screen-reader-reachable reorder path (touch AT
  intercepts long-press-drag, so drag alone is unreachable there). They are hidden
  until the already-present overflow menu opens, are `Move up`/`Move down` only
  (no move-to-top/bottom), and add no standing visible control — so they satisfy
  accessibility without reintroducing row clutter or a separate handle.
- **Drag accelerator** on the `…` trigger: mouse movement beyond 8px, or a
  touch hold of 250ms within 8px tolerance, begins a drag. An
  in-flight drag is cancelable with `Escape` and returns the row to its origin
  (WCAG 2.5.2). Drag completion suppresses the following click, so it never opens
  the menu. Touch scroll before activation is not captured. `SortableList`
  replaces the existing `PointerSensor` with
  `useSensor(MouseSensor, { activationConstraint: { distance: 8 } })` and
  `useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })`.
  Pen has no drag accelerator in this cut and uses the same menu commands as
  every other single-pointer input; no custom sensor or pointer-type branching
  is introduced.
- **Keyboard accelerator:** `Alt+ArrowUp` / `Alt+ArrowDown` while the trigger is
  focused moves one position. `aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"`
  exposes it as an accelerator only; discovery rests on the visible `Move up`/
  `Move down` commands and a visually-hidden `aria-describedby` hint on the
  trigger, not on `aria-keyshortcuts` alone (its AT support is uneven). Because
  the roving-focus composite is removed (§7), native Tab lands and **rests** focus
  on the `…` trigger, which is the reachable target Alt+Arrow requires — a state
  the old auto-clicking composite made unreachable.

The `…` trigger is simultaneously a menu button, a drag activator, and a keyboard
reorder control. Its contract is explicit:

- Its accessible name is `More actions for {title}` so assistive technology and
  voice control can distinguish rows. Drag and reorder remain secondary behaviors
  described by the visually-hidden `aria-describedby` hint added by this cut.
- `@dnd-kit`’s `KeyboardSensor` is removed from the sensor set so Space/Enter/
  arrow reach the menu cleanly and only `Alt`+arrow reorders.
- `SortableList` exposes `setActivatorNodeRef` and its mouse/touch listeners to
  the row. `CollectionRow` attaches only those to `ActionMenu`'s trigger; it does
  **not** spread `useSortable().attributes` onto the button. `ActionMenu` remains
  the sole owner of the native button role, `aria-haspopup="menu"`, and
  `aria-expanded`. The trigger adds only its unique name, `aria-describedby`,
  `aria-keyshortcuts`, and test/data attributes. There is no `aria-pressed` or
  `aria-roledescription` on either the button or list item.

Reorder feedback:

- `SortableList` owns one `role="status"` polite live region and announces
  position **and total** after any reorder — for example “Moved to position 3 of
  20”. Pointer-drag completion announces through the same region. `polite` is
  correct: the user initiated the move and rapid moves must not flood an
  assertive channel.
- After any reorder (drag, `Move up/down`, or `Alt`+arrow) focus returns to the
  moved row’s `…` trigger.
- A completed misorder is reversible via `Move up`/`Move down`.

The whole row is not draggable: it contains navigation, contributor links, text
selection, controls, and vertical scrolling. There is no separate drag button and
no `KeyboardSensor` competing for the menu button’s Space/Enter/arrow keys.
`@dnd-kit` stays because pointer reorder is an approved capability.

## 6. API and intra-system composition

Public HTTP routes, request schemas, response schemas, BFF proxies, database
schema, and mutation APIs are unchanged.

- Library continues to batch-compose `MediaOut`, credits, consumption, and
  `readingTimeEstimate` through `LibraryEntryOut`.
- Podcast episode lists continue to batch-hydrate ordered `MediaOut` rows.
- Lectern keeps `LecternItemOut`; Slates keep `SlateTarget + SlateReason`; Search
  keeps its relevance-owned result projection; Podcasts keep subscription rows
  with their existing `unplayedCount`.
- The `Media` and `Episode` presenters remain two distinct projections of the same
  `MediaOut` payload; unifying their output into one stable anatomy is presenter
  work, not a shared DTO — no endpoint changes.
- Millisecond timing for remaining-duration derivation exists only on
  footer-audio activations; `OpenPaneActivation` (video, podcast-without-audio)
  carries no `positionMs`/`durationMs`, so those rows present percent only. No DTO
  gains a “remaining” field; derivation is frontend arithmetic where the ms
  payload already exists.
- `GET /contributors/{handle}/works` keeps its strict camelCase, cursor-ordered
  title/href/kind/date/role-fact projection. `presentContributorWork` maps that
  projection directly and removes the redundant credited name from the at-rest
  role label; it carries over the existing role-vocabulary map and date-format
  logic verbatim.
- No client parses a resource ID out of `href`, performs per-row hydration, or
  calls a second endpoint to imitate another surface. `relatedMediaId`, when
  present, originates from a real domain field on the existing payload; it is
  never derived from `href`.
- Reject a new media/podcast/Gutenberg author-work union: it would reopen
  reading-time, podcast, capability, transaction, and decoder ownership merely
  to make two visual surfaces share data. Parity here means anatomy and truthful
  priority, not payload equality.
- Library reorder and Lectern ordering mutations remain their sole persistence
  owners. The dual-purpose trigger changes input composition only.

This boundary is deliberate: canonical presentation belongs in the web view
model; canonical domain facts remain with their services.

## 7. Hard deletions and file plan

### Delete

- `apps/web/src/components/collections/CollectionDisplayControls.{tsx,module.css}`
- `apps/web/src/components/collections/CollectionGalleryCard.{tsx,module.css}`
- `apps/web/src/components/collections/ReadStateBadge.tsx`
- `apps/web/src/lib/collections/{collectionViewState.ts,collectionViewState.test.ts,useCollectionDisplayState.ts}`
- `apps/web/src/lib/ui/{useCollectionKeyboard.ts,useRowSwipe.ts}`
- test-only dead chain
  `apps/web/src/components/chat/{ResourceChatTab,ContextRefChatList}.{tsx,module.css}`
  and `apps/web/src/__tests__/components/ResourceChatTab.test.tsx`
- author-specific work-row markup/styles (`AuthorPaneBody` work-row JSX and the
  `.works`/`.workList`/`.workRow`/`.workTitle`/`.workMeta`/`.workKind`/`.workFacts`/
  `.fact` rules in `authors/[handle]/page.module.css`) and the separate
  Library/Lectern reorder buttons; remove the now-dead style rules and tests with
  them

These files are live in production today across the seven display-state PaneBody
surfaces plus `CollectionRow`/`CollectionView`/`ResourceList`; only the chat chain
is independently dead. Delete them in the same change as the paired rewrites
below, never ahead of it.

### Change

- Collection owners:
  `components/collections/CollectionView.tsx` (no companion `module.css` exists),
  `components/collections/CollectionRow.{tsx,module.css}`,
  `components/ui/{ResourceList,ResourceRow}.{tsx,module.css}`,
  `components/sortable/SortableList.tsx`, `lib/collections/types.ts`, and the
  focused collection/guard tests. Update the allowlists and hard-coded deleted
  paths in `apps/web/src/lib/ui/paneSurfaceCutover.guards.test.ts` in the same
  change (it currently names `CollectionGalleryCard.tsx`, `useCollectionDisplayState.ts`,
  and the `ResourceRow`/`ResourceList`/`CollectionRow` allowlist).
- Presenters: `lib/collections/presenters/*` and
  `lib/resonance/presentSlateItem.ts`; remove thumbnail/swipe/publisher projection
  and emit named context/activity with numeric facts.
- Callers: Search, Libraries, Library detail (three `CollectionView` call sites in
  `LibraryPaneBody` — resonance list, gallery entries, list entries — all three
  must be migrated), Podcasts, Podcast episodes, Notes, Conversations, Lectern,
  Reading Slate, Settings, password, identities, and keybindings; remove display
  state and fixed density/view props.
- Reorder hosts: `LibraryPaneBody`, `LecternPaneBody`, and their local styles/tests;
  pass the shared activator and expose `Move up`/`Move down` commands instead of
  rendering a control.
- Author: `AuthorPaneBody`, its module CSS/tests (regenerate or delete the
  screenshot baselines under `authors/[handle]/__screenshots__`), plus a small
  `presentContributorWork` beside the other collection presenters. Carry over the
  role-singular vocabulary map and the multi-precision work-date formatter that
  live in `AuthorPaneBody` today; losing them is a silent content regression, not
  just a styling one. The adapter must tolerate an open-ended `contentKind`
  (arbitrary `media.kind` plus the `podcast`/`project_gutenberg_ebook` literals)
  without kind-specific branching.
- Move `ResourceThumbSpec` beside `ResourceThumb`; collection types no longer own
  a detail-header thumbnail contract. Remove `ResourceRow.leading`, its styles,
  and its test-only fixture; `ResourceThumb` remains owned by the existing detail
  surfaces.

### New tests

Deleting `collectionViewState.test.ts`, `ResourceChatTab.test.tsx`, and the
author-row tests is a net coverage change; name the replacements per
`testing.md` §13:

- `lib/collections/presenters/presentContributorWork.test.ts` (unit) — role-label
  normalization, date formatting, mixed/unknown `contentKind`, no page-contributor
  repeat.
- An activity-grammar unit test (pure formatting) covering every §2 state,
  per-modality verb, and accessible-label expansion.
- A `CollectionRow` component test (browser tier, real Chromium) for the dual `…`
  trigger: click-opens-menu, sub-8px-move-still-clicks, 9px-drag reorders without
  opening, 250ms-touch-hold drags, touch-scroll stays scroll, `Alt`+arrow moves
  and announces, focus returns to the trigger, and `Move up`/`Move down` reorder.
- An `AuthorPaneBody` component test rewrite asserting render through
  `CollectionRow`, pagination append, **append focus repair** (`toHaveFocus` on the
  first newly-appended title — currently implemented but unasserted), and
  empty/error states.

### Keep

`PaneSurface`, `ResourceThumb` detail usage, `ActionMenu`, `SortableList`,
`@dnd-kit`, `ConnectionRail`, `ContributorCreditList`, domain endpoints,
`ItemCard`, row panels, primary surface controls, resource actions, and all
surface-owned mutation/capability rules.

## 8. Cutover sequence

These steps describe implementation and review order within a single working
branch, not independently shippable commits; the tree may not type-check between
steps. Only the final state (after step 6) is required to build, and only that
state is committed and merged as one change.

1. Replace the row view-model and presenters; add the author-work presenter.
2. Rewrite the shared row/list grid and native focus contract.
3. Compose the dual `…` menu/reorder activator and the `Move up`/`Move down`
   commands; remove swipe and separate reorder controls.
4. Remove display controls/state and migrate every caller in the same change.
5. Delete Gallery, author-row, obsolete focus/gesture, dead chat, styles, tests,
   imports, and URL-state artifacts; sync the guard-test allowlists.
6. Run gates fail-fast: type/lint first, then focused unit/browser tests, then
   the API-unchanged gate, then the standard web release gate. The API-unchanged
   gate is concrete: `git diff --name-only HEAD -- apps/api python migrations supabase apps/web/src/app/api`
   prints nothing. This checks backend routes/schemas,
   migrations/database ownership, and web BFF proxies without falsely rejecting
   this cutover document. Ship one web build; no mixed rendering state is
   releasable. Focused scope:
   `components/collections/**`,
   `components/ui/{ResourceList,ResourceRow}*`, `components/sortable/**`, and the
   `search`/`libraries`/`podcasts`/`notes`/`conversations`/`lectern`/`authors`/
   `settings` panes.

## 9. Acceptance criteria

- **AC-1 One form:** no Gallery/density controls, types, URL codec, props, CSS
  selectors, tests, or runtime branches remain. Verified by a `.guards.test.ts`
  file-walk (repo precedent: `paneSurfaceCutover.guards.test.ts`) asserting zero
  references and `existsSync === false` on deleted files.
- **AC-2 One renderer:** every scoped media source, including author works,
  reaches `CollectionRow`; no bespoke work/media list item remains. Verified by
  the guard test plus an `AuthorPaneBody` component test.
- **AC-3 Information:** title, truthful contributors/date/context, one activity
  expression, exceptional status, and actions follow the priority rules.
  Publisher, thumbnails, cover/poster imagery, and generated identity tokens
  never render in collection rows (explicit negative `queryBy*` assertions).
- **AC-4 Compact reflow:** at 320px, 390px, and desktop there is no horizontal
  overflow; title is at most two lines, supporting copy at most one, state/menu do
  not wrap. Verified by extending `expectNoDocumentHorizontalOverflow` to the
  migrated panes and `getBoundingClientRect` line/height checks. Real browser
  **200% zoom** is a named manual release check because no existing harness can
  emulate it faithfully; CSS `zoom` is not accepted as a substitute. The
  automated 320px reflow check and manual 200% check are both required and are
  recorded separately.
- **AC-5 Actions:** `…` is visible, natively tabbable, at least 44px on coarse and
  24px on fine pointers, and the only standing secondary affordance.
  Connections/related load only after its menu command.
- **AC-6a Keyboard/menu reorder:** `Alt`+arrows and `Move up`/`Move down` move and
  announce position and total; focus returns to the trigger; `Move up`/`Move down`
  are the single-pointer non-drag path and are disabled at the list ends.
  Component tier (extends the existing keyboard reorder test).
- **AC-6b Mouse/touch reorder:** click opens; sub-8px motion still clicks; 9px
  drag reorders without opening; 250ms touch hold drags; touch scroll stays
  scroll; `Escape` cancels an in-flight drag. This needs real pointer/touch event
  sequencing; verify in the browser component tier if its Playwright provider
  reproduces `@dnd-kit` activation math, otherwise in a named new E2E spec using
  `page.mouse`/`page.touchscreen`.
- **AC-7 Native keyboard:** title, contributor links, primary control, and menu
  follow DOM Tab order. No ArrowRight, Shift+F10, Home/End, typeahead, or hidden
  `tabIndex=-1` collection contract remains. Existing section headings and
  landmarks retain structural navigation for supporting assistive technology;
  this cut does not claim that a heading lets plain-Tab keyboard users skip the
  list and does not introduce a speculative listbox or skip-link system.
- **AC-8 No duplicate gesture/state:** no swipe action, progress bar, duplicate
  percentage, read-state pill, or normal-ready badge remains.
- **AC-9 Author integrity:** pagination, append focus repair, empty/error states,
  mixed target kinds, and role facts remain; the page contributor is not repeated.
  Append focus repair gets an explicit `toHaveFocus` regression assertion.
- **AC-10 Boundaries:** no route/schema/database change, N+1 read, href-ID parsing,
  compatibility decoder, fallback, second row DTO, or domain capability leak is
  introduced. Verified by an empty
  `git diff --name-only HEAD -- apps/api python migrations supabase apps/web/src/app/api`
  result and a guard check for no new per-row fetch or `href` parsing.
- **AC-11 Cleanliness:** named deletions are gone, adjacent unreachable artifacts
  are removed, guard-test allowlists are in sync, `rg` source gates pass, and every
  remaining abstraction has a production caller.

## 10. Verification record

- A follow-up adversarial audit closed the remaining boundary gaps: web-result
  publication dates are preserved, Library podcast sync status is decoded at
  ingress, transcript controls obey entitlement after expansion, renderer unions
  defect exhaustively, bidi titles retain automatic direction, and the pointer
  test exercises the exact 7px/9px activation boundary.
- Focused type, changed-file ESLint, CSS-token, unit (15 files / 185 tests), and
  real-browser (10 files / 59 tests) collection/caller gates passed. The
  production web build passed.
- The API-unchanged gate printed nothing; `git diff --check` passed.
- Manual 200% browser zoom was verified separately in Chromium at physical
  widths 640, 780, and 1920 (effective CSS widths 320, 390, and 960). At each
  width `devicePixelRatio === 2` and document `scrollWidth === clientWidth`;
  narrow titles stayed at one or two lines, the secondary line stayed singular,
  fine-pointer menu targets measured 32px, and Chromium's accessibility tree
  exposed the expanded activity phrase. The temporary audit route, extension,
  screenshot, and browser profiles were removed after recording the result.
