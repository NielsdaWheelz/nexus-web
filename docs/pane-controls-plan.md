# pane controls specification and implementation plan

status: implemented and qualified; disposable proof removed · owner decisions: 2026-10-13 · baseline: `16763c3cd`
review: independent shell, query and reader adversarial passes; live/static results in [verification](pane-controls-verification.md).
owner exception: successful upstream youtube discovery/newest qualification waived on 2026-10-13; recorded as unverified, not pass.

give workspace panes one control grammar: identity, document navigation and
queries above scrolling content. reuse the existing header, reader, domain
controllers and primitives. the implementation lives in an isolated worktree.

## scope and decisions

- desktop: every supported query input stays visible; navigation and find coexist.
- mobile: collection and row-filter controls stay visible in pane chrome. find
  starts collapsed; opening it preserves navigation; close clears and collapses.
  retain the existing reader chrome retreat and safe-area/keyboard policy.
- clear text removes draft and applied text immediately, preserving facets and
  sort. browse returns to its empty-query state; other surfaces recompute under
  their remaining constraints. cancel pending commits of the old draft.
- inline options replace filter popups/sheets. booleans and existing sets use
  checkboxes; singular choices use radios; sort retains a native select.
- scope is workspace panes. public-share and downloaded-reader hosts are not
  redesigned. shared reader api changes require their existing behavior to pass.
- no header-height fix: the owner withdrew that concern; the headers match.

non-goals: backend/schema/url redesign, new multiple-selection semantics,
ranking or pagination changes, reader ingestion or progress redesign, new
features, pane keep-alive/persistence redesign, global navigation redesign,
new runtime dependencies or test platform.

accepted costs: persistent rows consume height; inline options temporarily
shrink content; compact mobile find needs disclosure state; native controls
limit styling; preserving singular filters limits selection to one value.
correct cancellation requires a shared reader api migration. a bounded region
for chips/options adds one local vertical scroll area on crowded panes.
browse exposes its existing youtube-only sort in mixed-source plans; it adds a
control to default browse instead of hiding meaningful incoming state.
temporary live tests are deleted after qualification, so their acceptance cases
and observed results must remain documented.

## composition and capability contract

`PaneShell` owns placement, mobile disclosure and shortcut routing. shared
controls own appearance and keyboard/disclosure behavior. domains own query
meaning, request timing, results, counts, facets, sort, urls and pagination.
`lib/documentReader` owns document structure, positioning and saved progress.

```text
pane
  stationary controls
    SurfaceHeader
    navigation when supported
    query when supported and visible under the mobile rule
      inline options when expanded
  existing content region
    existing content scrollport
    existing reader map rail when supplied
```

retain `auto minmax(0, 1fr)`. move controls outside the body scrollport; add no
sticky offset stack or outer scrolling pane. keep `.routeContent` as the
collection-return anchor root. readers keep their document scrollport.
canvas dragging starts only from the identity header's noninteractive region;
query, navigation and options never initiate dragging.

replace the chrome exclusion union in `lib/panes/paneChrome.tsx` with:

```ts
type PaneQuery =
  | {
      readonly kind: "Controls";
      readonly label: string;
      readonly content: ReactNode;
      readonly focusInput: () => boolean;
    }
  | { readonly kind: "Find"; readonly find: FindController | null };

interface PaneChrome {
  readonly header?: PaneHeaderPublication;
  readonly navigation?: { readonly label: string; readonly content: ReactNode };
  readonly query?: PaneQuery;
  readonly actionSubject?: ResourceActionSubject;
  readonly menuActions?: readonly ActionDescriptor[];
  readonly refresh?: PaneRefresh;
}
```

absent query means unsupported. null find means a promised source is resolving:
show a disabled desktop field; disable mobile find; leave native browser find
available. ordinary controls expose readiness through `focusInput()` returning
false. `Controls.content` must render the shared query toolbar, directly or
through a domain adapter. navigation renders the shared reader navigation.

retain the existing publisher/store and companion controller. the find arm is
needed because the shell already owns companion results; do not add context,
registry or runtime commands to hide that dependency. header identity and
resource actions keep their existing owners.
`SurfaceHeader` remains the sole title/subtitle/menu/inspector presentation.

pane source identity remains `visitId:routeId:pathname`, excluding query and hash.
share its derivation as `paneSourceKey(runtime)` in `lib/panes/paneRuntime.tsx`.
key shell disclosure and companion results by this identity, never by breakpoint.
find owns its query lifetime through required `ownerKey` in
`useFind({ ownerKey, source, presentation? })`; migrate all three callers.
owner change resets query, preferences, captured scope and results, even while
collapsed. cleanup captures the actual departing source/operation; it never
clears a replacement through `sourceRef.current`. shell does not imperatively
retire find controllers. expose fresh owner state immediately; finish outgoing
cleanup before replacement work. ordinary domain query/view lifetimes stay
unchanged; inactive panes unmounted by mobile keep their existing reset behavior.

## shared query presentation

one `components/workspace/PaneQueryToolbar.tsx` owns the input and clear button,
optional submit, options disclosure, sort, summary and wrapping. its props are:

| prop | contract |
|---|---|
| `inputRef` | the actual input ref, used for focus/select without scrolling |
| `input` | `label`, `placeholder`, `value`, `appliedValue`, `onChange`, `onClear`; optional `disabled`, `error`, `maxLength`, `keyShortcuts`, `onKeyDown` for existing domain constraints/find stepping |
| `submit` | optional `{ onSubmit, disabled? }`; renders a visible search action and handles form submission |
| `options` | optional `{ label, activeCount, content, onClear? }`; toolbar owns expansion; derive count from displayed structured-constraint chips, excluding text/sort, using existing domain grouping |
| `sort` | optional `{ label, value, choices, onChange }`; choices are value/label pairs |
| `chips` | optional existing applied-filter items and removal callback |
| `status` | `{ id, content }`; domain supplies the described status element and owns announcements |
| `actions` | optional domain controls: find matches/results/return, imports refresh |
| `onReset` | optional domain reset; absent when already at the default view |

order: input/clear, submit or match actions, options, sort. chips/status and
expanded option fields share one bounded region below; the active count stays
beside options. expanding options adds fields without hiding applied chips.

controllers own draft/applied values; immediate filters supply the same value.
the toolbar shows clear when either is nonempty and “results for: …” when
applied text is nonempty and differs from draft. it owns no fetch, debounce,
url parsing or filter state. preserve input limits, submit/debounce behavior,
invalid-view handling and retained/partial/failure semantics except clear.

reuse `Input`, `Button`, `SelectField`, `AppliedFilters`, existing status
owners, contributor lookup and date inputs. introduce only small labelled
native checkbox/radio field primitives if no suitable primitive exists. options
are ordinary jsx fieldsets; do not invent a filter-schema interpreter.
radio names are unique per mounted group, including across panes. imports'
`had_failures` is tri-state: “any”, “had failures”, “no recorded failures”.

clear text retains input focus. clear filters preserves text/sort. browse's “youtube sort” applies only to its
youtube section; mixed plans state that other sources keep relevance. retain
newest through filter removal while that section participates; reset it to
relevance only when a chosen scope excludes youtube. reset view
clears text/facets/sort to domain defaults, retaining resource context and imports
selection. focus the input before reset; use a surviving option/trigger before
clear-filters removes its focused action. reuse `AppliedFilters`' neighbour/input
focus restoration on chip removal. collapse preserves filters and returns focus
to its trigger when a focused descendant disappears. applied constraints,
including find's enabled case/word/scope options, stay accessible without
reopening options; many chips may require vertical scrolling.

desktop input escape clears when draft or applied text is nonempty; otherwise
it propagates. escape within options only collapses options. mobile find escape
closes find; explicit mobile close does the same. enter/shift-enter in find step
next/previous match;
submitted search uses enter to submit. only the active, capable pane consumes
cmd/ctrl+f, and existing overlay ownership takes precedence.
desktop menu find/filter commands focus the permanent input; they never hide
it. only mobile find offers close; ordinary controls have no hide command.

use labelled form/group semantics, ordinary tab order and native text editing.
the options button has `aria-expanded`/`aria-controls`; collapsed controls leave
focus order. use [disclosure semantics](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
do not add `role="toolbar"` without its
[keyboard contract](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/).

## reader navigation and find

one `lib/documentReader/chrome/ReaderNavigation.tsx` takes the existing `Reader`.
derive position from reader state; keep no second position or section store. pdf page
identity follows the captured reading line; next is disabled at the viewport end
even when the last page is visible below that line.
text uses canonical publisher sections: previous, position/total, next, section
selector. pdf uses previous, page/total, next, page-number entry and existing
zoom. validate page entry as an integer in `1..pages`; invalid entry shows field
feedback and makes no jump. enter commits; blur/escape discard an uncommitted
page draft. before the first text section, previous is disabled and next reaches
the first section. documents without sections omit section navigation.
transcript reading navigation inspects text; playback chapter controls remain
owned by playback.

`FindBar` becomes an adapter to the shared query toolbar. case, whole-word and
scope controls move into inline options. match count, previous/next and results
remain readily available. reader find has no sort. retain the existing companion
results and explicit return/continue-reading actions.

replace `FindController.open/close` with `clear()`; `setQuery("")` uses that same
operation. expose hosted find only after the existing `state.restored` and
attached surface are ready. the empty field is not an active session. the first
nonempty query captures the current section/page scope once, before searching.
later typing, options changes and focus retain that scope. show the captured
section name/page number. add `FindSource.narrowLabel: string | null` for the idle
capability label; `prepare()` still returns the captured scope label. options
can be selected while idle without capturing a position. expose both labels
through `FindController`. if narrowing is requested without a captured scope,
the source returns existing `FindOutcome.Failed` with an actionable message;
text must not search everything, and pdf must not invent page 1. whole-document
search may proceed without a narrow scope. retry retains the captured scope.
retain the existing debounce and automatic first-match reveal.
clear aborts work, empties query/results/paint and releases captured scope;
case/word/narrowing preferences survive within the pane source. pane retirement
starts fresh. a changed publication `FindSource.key` within the same pane aborts
old geometry work, retains text/preferences, prepares once after restore and
reruns. if narrowing support disappears, keep the selected option reversible
and labelled unavailable until unchecked; refuse instead of broadening.
default is whole document. existing origin invalidation on publication change
still applies; never reinterpret an old reading origin against new content.

shell clear also retires transient companion results without invoking the
companion close action that would steal input focus. mobile close additionally
collapses and returns focus through existing mobile chrome focus handling.
mount, reveal and cmd/ctrl+f never start or reset a find session. preserve the
active pane's input and options across breakpoint changes. shell records
disclosure on find invocation or focus/click within its query region; close
resets it. entering mobile exposes find when it has text or that disclosure,
including empty focused input and expanded options. no second options store.
shell owns the chrome hold exactly while active, mobile and
find-visible; collapse/retirement release it. remove `FindBar`'s unconditional hold.

clear never returns to the held reading spot automatically or adopts a match as
progress. preserve the reader's first departure across chapter/find inspections.
the search anchor and held reading origin are distinct. conversation find keeps
its source-owned return origin across clear; explicit return, owner retirement
or existing publication/path invalidation ends it. include `ownerKey` in that
source's lifetime; do not redesign chat scroll restoration. closing
companion results preserves the live query and paint.

find navigation cancellation is owned by the existing navigator. hard-cut both reader and navigator to
`inspect({ target, signal? }): Promise<NavOutcome>`. migrate every caller; no
overload or compatibility path. pre-aborted calls return `Cancelled` before
capture/flush. link abort only to that request and remove the listener on settle;
an old abort must not cancel a newer chapter jump. pdf page positioning,
text-layer readiness and match positioning must be ONE navigator request;
a newer jump cancels the entire sequence. check abort after waits, before
geometry writes. cancellation does not roll back completed movement; existing
failure rollback remains.

add transient `ReaderTarget` arm `{ kind: "pdfMatch"; page: number; index: number }`
using `PdfHit`'s one-based page/zero-based match index. `PdfSurface.position`
owns the sequence through its existing geometry helpers, never recursive
inspection. verify `viewer.findController.selected` still names that hit before
using the selected highlight. a missing match is unavailable, not successful
page arrival; a changed selection is cancelled. aggregate movement across both
positioning phases. no changes to locators, saved progress or deep-link schemas.

hard-cut `FindSource.reveal` to `Promise<FindReveal>`:

```ts
type FindReveal =
  | { readonly kind: "Shown" }
  | { readonly kind: "Cancelled" }
  | { readonly kind: "Failed"; readonly message: string };
```

`FindController.activate()` stays boolean: true only for `Shown`; cancellation
is quiet; failure uses the existing failed state. a cancelled preview never closes the
mobile results sheet as though it succeeded. migrate text, pdf, conversation
and artifact adapters together; generic find does not import reader outcomes.

## geometry and content design

retain the header token and identity model. one shell control-row density owns field,
button and select sizes: start with 40px minimum rows, 32px desktop controls,
44px coarse-pointer targets with 16px text; use existing scalable tokens and let text grow.
routes cannot choose competing sizes. the preferred reader-column width stays
the default; manually narrowed non-pdf panes may reach 320px and keep that width
across typography changes. pdf retains its intrinsic minimum. use component props or declared context
tokens, never selectors reaching into another module's internals.

respond to pane width, including 320px desktop panes. wrap action groups onto
another line; never require horizontal scrolling to reach clear, find stepping,
sort or close. chips, status and optional fields share the only refinement
scroll area, including with options closed. cap it at
`min(16rem, max(0, usablePaneHeight - baseChromeHeight) / 2)`; base chrome is
identity/navigation/primary query rows, and usable height excludes existing
safe-area, app/player and keyboard clearances. extend the existing shell
measurement; publish one declared size token, not another geometry engine.
transient placements use `offsetPx` relative to the visible reading line,
positive below and negative above; no saved locator or wire schema changes.
text resize/realisation preserves its last measured passage, and
pdf fitting and explicit zoom preserve the live reading line through the existing
navigator's internal `reflow({ placement, change })` operation. it clears stale
input intent, preserves mode/origin and never adopts progress; an active jump
keeps authority. pdf.js page boxes retain their external content-box contract.

public layout contract: toolbar marks one `[data-pane-query-refinements]` slot;
shell subtracts its height from the stack to avoid a circular cap and publishes
`--pane-query-refinements-max-height`, consumed only by that slot.
mobile clearance measures the full stack. when the keyboard leaves insufficient
space for content, clear/close must remain reachable; dismissing it restores
space. pure focus or disclosure must not scroll content to top, emit reading
activity, or write a
cursor. a smaller viewport may clamp scroll at the end; preserve the visible
content anchor through the existing owner, not a second restoration engine.

each feature owner also owns its design/copy and must obtain a separate design
review before integration. its designer writes the actual labels, actions and
state copy against these content rules:

| feature | good content and concrete rules |
|---|---|
| identity | one canonical title and one useful support line; full accessible title survives truncation; whole-collection count here, filtered count beside query; no repeated headings |
| queries/options | name the scope: “filter items”, “search across sources”, “search imports”; actions: “clear text”, “filters”, “clear filters”, “reset view”; preserve actual resource names; label native groups and singular choices honestly |
| reader | “find in book/article/transcript/pdf”; “previous section/page”, “select section”, “page”; find disclosure says “options”; scope names its captured destination; no fictional chapters or decorative sort |
| result state | “3 of 12 items” only for a known complete set; “3 matches in 100 loaded” for partial scope; “loading…” only during work; “update failed; showing previous results” when retained; existing domain retry remains actionable |

idle controls stay quiet; announce changed settled results through existing
status owners. no fake “loading more” for a partial set that is not loading.
use existing product casing and terminology in implementation; this document's
lowercase examples describe wording, not a global copy-style migration.

## work ownership and hard cut

paths below are relative to `apps/web/src/`. one writer owns each row; dependencies
are interfaces, not shared editing. freeze the contracts above before parallel
implementation. adjacent owners review the boundary before integration.

| owner | exclusive files and work |
|---|---|
| shell architect/designer | `lib/panes/paneChrome.tsx`, `lib/panes/paneRuntime.tsx` identity helper, `components/workspace/PaneShell.tsx` and css, `Companion.tsx`, `components/ui/SurfaceHeader.tsx` and css; composition, disclosure, focus, drag boundary and shell retirement; mobile host changes only for existing measurement/hold contract |
| query engineer/designer | new shared query toolbar/focus helper and native choice primitives; shared field/button token changes if needed; `PaneFilterRowsStatus`, `lib/panes/paneFilterRows`, resource-row filter adapter; every collection/page/note publisher listed below |
| reader engineer/designer | `components/find/*`, `lib/find/*`, reader navigation, `lib/documentReader/*` inspection migration, media chrome/body/hostedReader, conversation/artifact find publishers; preserve non-workspace consumers |
| live-test engineer | disposable external harness, real fixtures, baseline/final receipts; no production seams or edits to feature files |
| integrator/reviewer | this plan and owning docs, issue register, final `PaneToolbar` deletion; resolves boundary conflicts, checks full producer census, reviews design and rejects unsupported passes |

query publisher census: lectern; libraries index/detail; author works;
conversations index; notes index; podcasts index/detail; browse; search; imports
(`ImportsList`/`ImportsToolbar`); page and daily-date through `PagePaneBody`; note
through `NotePaneBody`. migrate their existing `usePaneChrome` calls together.
find publishers: media, individual conversation, artifact. retain unavailable
and resolving states; unsupported panes gain no query capability.

delete replaced `PaneCollectionBar`, `PaneSearchBar`, `CollectionFilterEditor`
and orphaned css; `PodcastViewBar` and its podcast-owned generic `useViewControls`;
`KindChips`; `usePaneTransientFilterRows`/`PaneFilterRowsSearch`; duplicate
input/clear/sort markup and obsolete hidden-status presentation. preserve
podcast-specific url helpers in their domain owner. remove `PaneToolbar` after
its last navigation/query consumer migrates. delete old `collection/search/instrument`
chrome fields and search-versus-navigation switching. keep no parallel renderer,
compatibility shim or feature flag. verify remaining callers before every deletion.

the inspection signature affects 17 feature calls in 10 files, plus runtime
forwarding: reader scrollport, text/pdf surfaces, text/pdf find, contents, map
rail, media body/chrome/hostedReader. the reader owner migrates all in one cut.

## live acceptance and execution

the owner explicitly requests temporary live red/green/refactor tests, then
deletion. this is a task-scoped exception to the default in
[testing standards](local-rules/testing-standards.md). keep `./scripts/test`
unchanged as the permanent gate; it includes shelf/extension builds and static
checks, not a unit suite. the temporary proof remains outside the checkout; no test platform is added.

use a task-owned temporary directory outside the checkout for the browser driver,
its pinned dependencies and artifacts. run the actual browser → web/bff → api →
database/auth/object storage path using the existing local stack. admit fixtures
through ordinary product apis: a long paginated collection, structured text with
repeated terms, a real pdf, and real browse/search/podcast results. use valid
provider credentials when required; unavailable fixtures/credentials are blockers.
do not substitute fake responses, auth bypasses or runtime hooks.

scope browser actions with [accessible locators](https://playwright.dev/docs/locators).
[network interception](https://playwright.dev/docs/network) may delay/release or
abort real traffic for race/failure cases; successful response bodies stay real.
assert observable behavior, result/url coherence and canonical reader-state
readbacks; do not assert component names or copied implementation constants.

| case | required observation |
|---|---|
| 1 pinned controls | scroll long lectern/library/browse results; query, sort and header remain usable; ctrl-f focuses without jumping the list |
| 2 reader composition | article/epub/pdf/transcript: open find and step matches while section/page navigation remains available; disabled limits and direct destinations work |
| 3 common geometry | adjacent fields share density; 320px pane at 900px height, 200% text at 600×900, and 390×600 mobile with coarse targets; also open the real keyboard; primary controls/body stay reachable, many long chips scroll even with options closed |
| 4 inline options | keyboard expand/collapse/reset/last-chip removal preserves focus; counts/chips agree for grouped kinds, formats, imports dates/text and find options; incoming `had_failures=false` is representable; option-label clicks/drags never pan workspace |
| 5 clear and reset | browse/search/imports: draft/applied text clear together; old requests/debounces cannot publish as current; only already-settled snapshots may remain with explicit previous-results status; browse shows its empty state immediately; facets/sort survive; reset preserves context/selection |
| 6 find lifecycle | visibility/focus does not capture scope; first query does; later navigation preserves narrowed scope; clear removes highlights/results, starts no positioning and adopts no position; completed movement is not rolled back |
| 7 cancellation | delay real pdf reveal before page arrival and during text-layer readiness; clear, replace query or issue a newer page jump, then release: no stale positioning/paint/success; newer navigation still lands |
| 8 progress | after settled baseline reading, find, chapter jumps, options and clear leave saved cursor/revision/completion unchanged; explicit return reaches first origin; explicit continue retains its existing behavior |
| 9 ownership | two panes keep independent queries, radio states and urls; active pane receives shortcut; overlays win; unsupported/resolving panes keep native find; distinguish new visit, same-visit query/hash refinement and publication reload |
| 10 mobile and resize | find initially collapses; opening preserves navigation; close/escape clears/collapses; options escape only collapses options; query, empty focused input and expanded options survive resize; collapsed find releases chrome retreat |
| 11 data continuity | partial, retained, failed and paginated results remain honest; delayed/failing continuation cannot masquerade as a complete set; back/forward restores the list anchor |
| 12 full migration | smoke every publisher in the census and the unchanged public/offline readers after the shared inspection api cut |

run cases 1–12 in chromium; repeat geometry, focus, mobile and reader-navigation
cases in firefox and webkit. perform a focused real mobile/webview check for
keyboard clearance and chrome motion. emulated input does not prove physical
touch or assistive-technology behavior; record any unverified distinction.

execution order, with an independent adversarial review at each gate:

1. review this contract, content rules and producer census for contradictions.
2. write the temporary cases; capture the original build's genuine failures and
   already-passing preservation cases. setup failures are not product reds.
3. implement the agreed contracts; query and reader work can proceed independently
   behind the frozen shell api. integrate all producers before delivery.
4. get target cases green; review async ownership, reader progress, keyboard
   behavior, copy and actual narrow layouts. fix causes at their owners.
5. refactor/delete duplication; rerun affected live cases and `./scripts/test`.
   record immutable baseline sha, final sha/diff digest, served-build identity,
   fixture ids, environment, baseline/final outcomes and material limits.
6. delete only task-owned tests, fixtures, harness dependencies and temporary seams;
   rerun `./scripts/test` and inspect the final diff. retain concise case outcomes,
   not a permanent test framework. blocked cases remain open, never pass by waiver.

update current contracts in `docs/modules/workspace.md`, `panes-tabs.md`,
`reader-implementation.md`, `reader-design-rationale.md`, `visual-system.md` and
the relevant architecture passages when implementation lands; link instead of
duplicating rules. correct the retired unit-test/harness claims. remove resolved
tickets/register entries only after their acceptance is met; preserve unrelated
verification debt. no release, merge or deployment is part of this change.
