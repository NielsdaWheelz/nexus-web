# pane query toolbar specification

status: implemented and live-qualified, 2026-10-15. decisions: 2026-10-14.
audit baseline: `367da80e0c1beb1c426f6d2d72201b0733809b50`.
review: independent architecture, geometry and interaction reviewers.
evidence: [verification](pane-query-toolbar-verification.md).

merge integration: upstream `7bc7c8a13` moved search presentation into
`search/SearchControls.tsx` and replaced the resource-filter adapter with
`components/notes/OutlineEditor.tsx`. migrate those current publishers; keep
the removed adapter deleted. the public toolbar contract is unchanged.

make pane controls legible, stable and subordinate to content. one spatial
grammar; explicit domain semantics. repair the existing owners, not the system
around them. this narrows the presentation work in the
[existing controls plan](pane-controls-plan.md); its other contracts stand.

## scope and decisions

- all existing `PaneQueryToolbar` consumers: collection filters, browse,
  search, imports, resource row filters and reader find.
- fix sort alignment, clear-induced width movement, repeated default counts
  and unnecessarily separate summary/reset rows.
- include the separately approved browse unicode-length correction; correct
  its search-count noun in the same browse work item.
- retain native controls, inline options, domain query timing, defaults,
  urls, pagination, source identity and mobile find disclosure.
- no backend, wire, storage or url schema changes; no new search capabilities,
  menus, creation flows, persistence, responsive state machine, registry,
  runtime dependency or permanent test infrastructure. adjacent tickets stay separate.

accepted costs: narrow/enlarged controls consume more height; an empty input
reserves clear-button space; native selects limit styling. changed views keep
a contextual count beside reset even when the header repeats it. deleting the
disposable tests removes future automated regression coverage; retain their
acceptance cases and observed evidence. no compatibility path or feature flag.

## final composition and geometry

```text
existing identity / navigation
query row
  query entry: [input with reserved clear slot] [optional search submit]
  controls: [existing operation actions] [filters/options] [label + native sort]
bounded details
  wrapping summary: [applied text] [chips] [visible status] [reset view]
  associated error, when present
  inline options, when expanded
existing scrolling content
```

1. `PaneShell` retains placement, `primaryPane` container, density and the
   measured refinements cap. no new measurement engine or fixed header height.
2. primary groups wrap, align at their starts, with 12px between groups and
   8px within groups/between rows. preserve existing responsive pane insets:
   16px desktop, 12px below 480px, 8px below 360px/on mobile. use existing
   spacing tokens. dom order equals visual/tab order.
3. query entry grows; preferred minimum is `min(13rem, 100%)`, or
   `min(18rem, 100%)` with submit. at pane width `<=32rem`, query entry takes
   the first row and controls follow. use the pane container, not the viewport.
   input/submit may wrap at enlarged text; previous/next buttons stay together.
4. at ordinary widths, sort label and selected value share one control line.
   move the whole sort group to another row before stacking its label above
   the select. when stacked, it occupies its own row; never center a single
   field against a two-line peer. `SelectField` owns this intrinsic behavior:
   remove the inherited full-width wrapper conflict, allow shrinking/wrapping,
   use native intrinsic value width; let content determine when it stacks.
   `Stacked` forms keep their layout. no clipping, ellipsis or horizontal
   scrolling substitutes for readable authored labels and selected values.
5. retain pane minima of 32px for fine pointers and 44px for coarse pointers.
   extend the declared density contract in `PaneShell.controlRow` with
   `--pane-control-block-size: auto`, `--pane-control-line-height: 1.25` and
   `--pane-control-padding-block: var(--space-1)`. `Button` and sized
   `Input`/`Select` consume them: content-driven height, pane size token as
   minimum, 4px vertical padding. outside panes, preserve existing height and
   intrinsic minimum. select wrapper has no padding or independent coarse
   height. preserve non-pane sizing defaults, textarea/bare-field
   behavior, focus treatment, field/button radii and horizontal padding.
6. keep the boxed `Input`; position the existing clear button inside its
   wrapper and reserve `--pane-control-size` plus text clearance unconditionally.
   clear mounts only for nonempty draft/applied text: no idle tab stop. entered text
   never runs underneath it. retain the actual input/ref across all changes.
   use 16px clear/filter/inline-select glyphs; scope select styling to `Inline`.
7. one compact summary wraps status, chips and trailing reset together; reset
   has no dedicated row. expanded options remain below it in the existing
   single bounded vertical scrollport. preserve content access and keyboard
   scrolling; do not add another overflow container.

## ownership and public contract

domains publish existing `PaneChrome.query` capabilities. `PaneShell` places
them. `PaneQueryToolbar` composes existing `Input`, `Button`, `SelectField` and
`AppliedFilters`; domain adapters supply `RadioGroup`/`ChoiceField` content.
shared presentation performs no normalization, fetching, debounce, ordering,
count inference or url mutation.

the existing toolbar prop contract stays, with two changes:

```ts
readonly status: {
  readonly id: string;
  readonly content: ReactNode;
  readonly visible: boolean;
};
// delete input.maxLength and its forwarding after removing the browse caller.
```

`visible` controls sighted presentation only. keep the same status subtree
mounted in the same place; apply `sr-only` to its wrapper when false. preserve
its described element, unique id and domain-owned live announcement. do not
add another visibility flag to `PaneFilterRowsStatus`, another announcer or
conditional mounting. `actions` remains the existing operation-actions slot.

add one pure helper beside the existing collection status formatters:

```ts
paneFilterRowsStatusVisible(input: {
  readonly status: PaneFilterRowsStatus;
  readonly identityCount: number | null;
  readonly atDefaultView: boolean;
}): boolean
```

return false ONLY for `Complete`, default view, and known
`identityCount === visibleCount === totalCount`. identity count means the
count actually rendered for these same committed rows. pending, absent or
different-scope counts use `null`. derive header metadata once and reuse it;
numeric coincidence is insufficient. derive `canReset` once from each
domain's existing exact predicate, including raw whitespace; use it for both
`onReset` and `atDefaultView: !canReset`. changed facets/sort keep status visible.

resource row filters have no identical identity count and declare
`visible: true` directly; browse, search, imports and find do likewise.
preserve their distinct idle/status semantics.

details are visible iff status is visible, chips exist, nonempty applied text
differs from draft, an error exists, options are expanded, or reset exists.
derive this from props/disclosure, never `ReactNode` truthiness. otherwise the
region has zero visual height and no tab stop; accessible status remains.
if the region still owns focus when its last visible content disappears,
return focus to the live input in `useLayoutEffect`, before paint. never take
focus that moved elsewhere. existing clear/reset/chip/escape contracts stand.

submitted searches remain forms; local filters/find remain labelled groups.
details/options stay outside the search form. do not add `role="toolbar"`:
that implies an arrow-navigation contract this mixed form does not implement.
see the [aria toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/).

## content and capability contracts

each feature owner pairs an engineer with a content designer. designers own
the copy below, pluralization, truthful scope and narrow-layout legibility;
they review real empty, active, pending and failed states. no new content schema
or generic renderer: use existing domain unions, choices and chip models.

| feature / designer | behavior and content standard |
|---|---|
| collections | retain `Filter items/libraries/entries/works/chats/pages/shows/episodes` as applicable. default complete count appears once when identity owns it. retain existing complete, partial, retained and failed formatters, including zero. partial means loaded scope, never promised completion. |
| resource row filters | retain the unique idle row count and source-specific input label. do not suppress it because another resource count happens to match. |
| search and imports | preserve search's existing reactive timing and imports' explicit `Search` submit/`Refresh`. retain applied-result scope, pagination and failure facts. draft changes never relabel older results as current. |
| browse | `Search across sources` / `Search`; `YouTube sort`, `Relevance`, `Newest first`; mixed scope retains `Other sources: relevance`. summary says `{settled} of {planned} search/searches finished`, with existing surfaced/unavailable counts. finished includes failed searches; provider success remains distinct. |
| reader find | retain idle/searching/match/partial/wrapped/failure copy and announcement timing. preserve previous/next, results, retry, return and close; mobile close and scope semantics stay intact. |
| shared controls | `Clear text` removes draft/applied text, retaining facets/order; `Clear filters` removes structured constraints; `Reset view` restores existing domain defaults. `Filters`/`Options` count structured chips only. `Results for: {appliedValue}` identifies nonempty applied text differing from draft. |

keep existing authored sort labels; unknown podcast order uses the bounded
label `Unsupported order`, preserving the raw value and existing error/reset
behavior. no silent valid-order substitution. a designer must shorten any
authored option label that fails enlarged-text acceptance, preserving meaning.

browse length correction: remove native `maxLength: 200`; retain the full
editable draft and existing trim + nfc normalization + code-point validation
at submission. accept at most 200 normalized code points; reject 201 and
remaining c0/c1 controls, through both enter and submit, without truncation or
query publication. retain the associated error and composition handling.
native maxlength counts [utf-16 units](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/maxlength),
which is not this domain contract. `lib/browse/query.ts` remains the validator.

## non-overlapping work packages

paths below are relative to `apps/web/src/` unless prefixed `docs/`.
one writer per file; reviewers challenge contracts before edits and inspect
each package's diff and evidence after it. shared contract precedes adapters;
publish one coherent cutover, with no partially migrated public api.

| owner | files and responsibility |
|---|---|
| a: shared controls engineer + interaction designer | `components/workspace/`: `PaneQueryToolbar.{tsx,module.css}`, `PaneShell.module.css`; `components/ui/`: `Field.module.css`, `Button.module.css`. implement composition, explicit visibility, stable clear and declared geometry. change `SelectField.tsx`/`Select.tsx` only if css cannot satisfy their public contract. remove dead maxlength forwarding after c. |
| b: surface engineer + collection/search/find designers | `lib/panes/paneFilterRows.ts`; `components/notes/OutlineEditor.tsx`, `components/imports/ImportsToolbar.tsx`, `components/find/FindBar.tsx`; collection publishers below and `app/(authenticated)/search/SearchControls.tsx`. derive truthful status visibility, migrate props and bound unsupported sort copy. preserve `PaneFilterRowsStatus` announcement implementation. |
| c: browse engineer + browse content designer | `app/(authenticated)/browse/BrowsePaneBody.tsx` only: migrate explicit status visibility, remove native length bound, correct search-count wording; preserve execution and validation owners. |
| d: verification engineer | disposable external harness/configuration/fixtures only; real red/green evidence, responsive/keyboard review and cleanup. no product seams or permanent tooling. |
| integrator | this plan, `docs/modules/workspace.md`, `docs/modules/visual-system.md`, scoped links in the old controls plan, new `docs/pane-query-toolbar-verification.md`, and the five scoped tickets/register entries. update canonical behavior docs when implementation lands. |

b's collection publishers under `app/(authenticated)/`:
`lectern/LecternPaneBody.tsx`, `libraries/LibrariesPaneBody.tsx`,
`libraries/[id]/LibraryPaneBody.tsx`, `authors/[handle]/AuthorPaneBody.tsx`,
`conversations/ConversationsPaneBody.tsx`, `notes/NotesPaneBody.tsx`,
`podcasts/PodcastsPaneBody.tsx`,
`podcasts/[podcastId]/PodcastDetailPaneBody.tsx`.

## red / green / refactor acceptance

the owner explicitly authorizes a disposable external live-test harness on
an isolated local stack for this task. the permanent
[verification contract](local-rules/testing-standards.md) and `./scripts/test`
remain unchanged. implementation followed the approved planning phase.

use a task-owned worktree/configuration, distinct database/storage/auth data,
ports, auth project, browser profile and processes. `LOCAL_COMPOSE_PROJECT`
alone does not isolate fixed local auth ports/project or `.dev-ports`.
create fixtures through ordinary product/auth interfaces; exercise browser
→ web/bff → real api → local services. no production writes, auth bypasses,
synthetic success bodies or test-only production branches. use semantic
[locators](https://playwright.dev/docs/locators); delaying/aborting real
[requests](https://playwright.dev/docs/network) may expose loading/failure.
minimum fixtures: ordinary disposable-user sign-in, one collection beyond its
actual page size, a page/note row list, and a locally processable document
admitted through normal import/worker for find. no direct table seeding.
run full flows in firefox; other engines get the specified native-control
smokes. widths below mean measured css pane widths after zoom, not device
pixels. use actual browser settings for zoom/text checks; manual evidence is
appropriate where the harness cannot control those settings.

| case | acceptance / evidence |
|---|---|
| 1. geometry | lectern/libraries at 611px and normal text: input and sort boxes align within 1 css px, label inline. at 320px: query first, controls wrap coherently. at actual 200% browser zoom/text enlargement and 390px coarse-pointer sizing: allow own-row/stacked sort, require readable labels and no horizontal toolbar overflow. root-font substitution alone is insufficient. inspect valid and unsupported sort labels; smoke native selects/clear in chromium, firefox and webkit. |
| 2. stable entry | empty → first character → clear leaves input bounds unchanged within 1 css px, including draft/applied divergence. same input node, selection and options disclosure survive pane resize. clear preserves facets/order and focus. |
| 3. summary | default complete collection has one visible count and no empty details tab stop; changed text, whitespace, facet or sort has meaningful status plus reset. zero/partial/retained/failed states remain truthful. resource filters keep their unique idle count. described/live nodes persist, with no new announcers or duplicate text updates; focus never remains on collapsed details. |
| 4. refinements | keyboard opens options, changes native radios/checkboxes, removes chips, clears filters, resets and escapes with specified focus. many chips/expanded options stay inside one bounded details scrollport while content remains reachable. no accidental search submit or pane drag. |
| 5. semantics | real paginated collection larger than one page proves partial scope; held/failed real requests prove updating/failure feedback. browse draft b/applied a still identifies a until submit; clear retires old text. search timing, imports refresh and representative reader find navigation/return/mobile close retain behavior. source census verifies every adapter migrated. |
| 6. browse correctness | against one real local nexus source, `"a".repeat(200)`, `"\u{1F600}".repeat(200)` and `"e\u0301".repeat(200)` retain their entered value and reach the real request normalized. 201 normalized code points remain editable but produce no search via enter/click; use `"a\u0001b"` for an interior control that survives sanitization/trim. assert the draft before submission. separately, a submitted query with default kind/source scope counts eight searches, not eight providers. provider availability is separate from accepted query length, never fabricated success. |

reflow and enlargement are behavior checks, not a claim of full accessibility
conformance. spoken announcement claims require actual assistive-technology
observation; retain the [existing verification debt](tickets/pane-controls-live-proof-blocked.md)
for anything unobserved. see [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
and [resize text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html).
check a non-pane form and pane navigation after primitive changes. do not
replay unrelated reader ingestion, playback, offline or release qualification.

1. freeze contracts; independent reviewer attacks each invariant and fixture.
2. record real failing target cases against the starting implementation tree: alignment, repeated
   count, clear movement, browse length and noun. existing preserved behavior
   may already pass; do not manufacture red. source evidence is not a live pass.
3. implement a; migrate b/c; run the same cases to green and `./scripts/test`.
4. refactor at existing owners, remove superseded layout/unused props/styles;
   reviewer checks ownership, content and every adapter. rerun affected cases
   and required static checks after edits. no compatibility/default visibility
   branch, duplicate toolbar, route-specific offsets or sibling-internal css.
5. retain sanitized served-source sha plus any uncommitted diff identity,
   commands, red/green outcomes, screenshots and material limits in the
   verification record. delete harness, dependencies,
   task profiles/credentials/fixtures and only task-owned services. retain no
   executable tests. delete resolved tickets after evidence, update register
   and canonical docs; unresolved acceptance stays open and explicitly blocks
   calling this cutover complete.

resolved tickets: `pane-query-sort-alignment`, `pane-query-redundant-status-rows`,
`pane-query-clear-shifts-input`, `browse-input-length-unit-mismatch`,
`browse-summary-counts-searches-as-sources`. their evidence is retained in the
verification record; the resolved ticket files are deleted at cutover.
