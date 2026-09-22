# collection controls: implementation contract

status: implemented and live-verified in `feat/collection-controls`
origin: 2026-09-22 user request and adversarial council review
authority: this plan supersedes implementation proposals in the
[research report](collection-controls-council.md).

## goal and scope

visible controls, shared rows, truthful state. author works default to original
publication **oldest first**.

cover author works, chats, notes index, libraries index, library entries,
followed podcasts, podcast episodes, lectern, browse, search, and imports.
preserve current membership, permissions, supported filters, actions, and all
other default orders. author works retain current contributor/catalogue scope.

non-goals: new filters, metadata enrichment, preferences, query engine, row
redesign, database schema, endpoints, permanent dependencies, or unrelated cleanup.
document/editor find, pickers, and transcripts retain their own interactions.

## target behavior

- show one control band on valid collection entry, before results settle, and
  through empty/error states. disable only controls requiring unavailable data.
  route code-loading retains the existing pending shell; invalid views retain
  explicit reset recovery instead of invented valid controls. imports keeps
  loading/error+retry until its initial summary determines its unqualified view.
- order: text input, domain filters/sort, status/actions. use applied-filter
  chips for constraints with disclosed editors. no outer disclosure, close
  command, duplicate toolbar, or hidden-state marker; individual menus remain.
- show current sort in words; fixed orders get a label, never an unsupported
  selector. wrap at pane width using existing tokens. labels, selected sort,
  and focus indicators remain legible without page overflow.
- input clear removes text only; removing a filter preserves text and sort.
  `reset view` clears text and domain filters and restores the surface default
  sort. preserve route identity, imports tab/inspector selection, and
  library/author scope. domain owners implement reset and its availability.
- opening/mounting never focuses an input. `Pane.Search` focuses the active
  collection input; it is a focus command, not a disclosure. escape first
  belongs to an open editor; otherwise, in a local filter input, it clears text
  without resetting sort or hiding controls. remote forms retain draft/commit
  behavior: escape never implicitly submits an empty query. preserve transient find.
- preserve local filtering versus remote query execution. counts distinguish
  partial/complete data. label retained rows during updates/failures; never
  claim the new view succeeded while showing the old one.
- retain url-owned domain state, visit-local text, in-place focus/scroll
  continuity, and latest-request-wins commits. new source/visit retires local
  text; changing only a domain view does not.
- render the band first in the existing body scrollport, on desktop/mobile.
  it stays mounted and scrolls with results: no disclosure, automatic hiding,
  sticky positioning, second scrollport, or new mobile motion behavior.

## composition and capability contract

`pane owner → view codec/retrieval → presenter → CollectionView → CollectionRow
→ ResourceRow`; the same owner publishes controls to `PaneShell`.
imports retains `ResourceList`/`ResourceRow` and its operational controls.

add this optional capability to the existing primary-chrome publication:

```ts
interface PaneCollectionPublication {
  readonly label: string;
  readonly content: ReactNode;
  readonly focusInput: () => boolean;
}
// PanePrimaryChromePublication.collection?: PaneCollectionPublication
```

- `content` composes the existing `PaneToolbar variant="Refinement"`,
  `Input`, `SelectField`, buttons, and `AppliedFilters`. sort uses the filter
  slot; status/reset use controls. no new node-slot wrapper or field schema.
- extend existing publication equality/cleanup; keep content/callback references
  stable. reject stale route publications. retain control identity across
  same-visit in-place refinements, never across source changes.
- `collection` cannot coexist with `search` or `instrument`; reject invalid
  composition. `search` plus `instrument` remains valid for document find.
  collection renders in the body; transient search/instrument keep their
  existing contextual track. no collection mobile-height registration.
- `focusInput` returns true only after revealing and focusing a mounted,
  enabled, non-inert input with existing scrollport/mobile inset clearance.
  invoke only for an explicit active-pane request; reuse existing responsive
  command handoff. `preventScroll: true` alone is insufficient when offscreen.
  native control focus must survive same-source refinement.
- separate local filter state/input/status mechanics from transient search
  publication inside the existing pane filter owner. collections use the
  mechanics and publish `collection`; page/note editors retain `search`.
  one owner for local query lifecycle and partial-result announcements.
- features own typed options, draft/committed queries, validation, execution,
  reset, errors, and cancellation. shell/toolbar own presentation and focus.
- chrome publications replace whole records. imports passes its companion
  into the workspace and moves its sole primary-chrome publisher there; compose
  controls and companion together. the unresolved branch publishes companion
  only; the resolved view publishes both. only one branch owns publication.
- set search `queryNavigation: "in-place"` in `paneRouteModel.ts`; retain its
  existing remote draft/commit and return-state contracts. other collection
  routes already declare in-place refinement.
- preserve presenters/capabilities. replace the author-work role table with
  `lib/contributors/vocab.ts`. move `AppliedFilters` to a shared owner when
  reused. delete replaced markup/styles.

## author api and data contract

retain `GET /contributors/{handle}/works`, its bff descriptor, envelope,
`ContributorWorkItem`, `Presence<PublicationDate>`, and `CollectionPage` schemas.

| view query, excluding pagination | meaning |
| --- | --- |
| no `sort` or `direction` | original publication ascending; canonical |
| `sort=published&direction=desc` | original publication descending |
| `sort=title&direction=asc` | title a–z |
| `sort=title&direction=desc` | title z–a |

reject redundant `published+asc`, partial pairs, duplicate owned keys, and
unknown values. frontend shows invalid-view/reset and never commits seed rows;
cold direct invalid navigation makes no works request. existing link-intent
prefetch remains outside that assertion. api returns `E_INVALID_REQUEST`.
preserve unrelated pane parameters.
also repair library decoding to reject duplicate `sort`, `direction`,
`projection`, and `completion` keys, matching its existing backend contract.

date source: media `original_published_date`; podcast and catalogue-only works
are undated. retain provider `issued` in its owner, never in author chronology.
use the existing author row context for `publication date unknown`.

publication sorts use `(date_missing asc, partial_iso_date chosen_direction,
title asc, href asc)`. preserve existing title sort plans. missing dates remain
last in either direction; partial dates keep their year/month/day precision.
apply visibility, ordering, and keyset pagination to the whole relation in sql.

rename the nondefault frontend variant `PublishedOldest` to `PublishedNewest`.
coordinate codec, labels/options, canonical seed, and server default. increment
the existing works cursor family from v2 to v3: changed date meaning can leave
the old plan hash unchanged. accept only v3; old cursors yield
`E_INVALID_CURSOR`, changed revisions retain `E_COLLECTION_CHANGED` recovery.
do not reverse fetched rows, normalize retired urls, decode old cursors, or
silently fall back to a default.

## non-overlapping work packages

paths are relative to `apps/web/src/` unless prefixed otherwise.

| owner | exclusive files/responsibility | depends on |
| --- | --- | --- |
| a: chronology and codecs | `python/nexus/services/{contributors,contributor_credits}.py`; relevant gutenberg date comment; `lib/contributors/workView.ts`; `lib/libraries/libraryView.ts`; canonical author seed in `lib/panes/paneResourceLoaders.ts` | api contract above |
| b: shared interaction | `lib/panes/{panePublications,paneSearch,usePaneFilterRows}.ts`; `components/workspace/{PaneShell,PaneSearchBar,PanePrimaryChrome}` and their css; existing input/status mechanics, toolbar and applied-filter owners; workspace search command plumbing if required | capability above |
| c: surface adoption | collection pane bodies listed in scope; `components/imports/ImportsWorkspace.tsx`; `lib/panes/paneRouteModel.ts`; author-work presenter; page/note editor call-site adaptation only if b changes its interface | a and b interfaces |
| d: proof and closure | temporary live checks/fixtures; this plan's completion record; affected module docs and tickets | tests start before implementation; final proof after a–c |

c removes collection `search` publications and body toolbar copies; browse,
search, and imports publish the same capability while retaining their own forms.
b removes collection-only expansion/retention/close branches after c migrates.
keep mechanisms still used by editor/document find. no dual publication path,
compatibility flag, or old/new runtime switch in the final tree.

independently review each package against contracts, real callers, failure
states, and simpler existing owners. resolve objections before acceptance;
record deferred findings in tickets. d verifies composition.

## temporary red / green / refactor proof

the user's explicit workflow overrides the repository's default restriction
for this task only. author a temporary executable live-check script and fixture
manifest outside tracked application code. `./scripts/test` and ci remain
static-only and unchanged.

use an isolated runnable local stack, real supabase session, browser → bff →
api → postgres, and real read-only provider access for browse. create local
fixtures through existing services or fixture sql; no auth bypass, production
data mutation, mocked result arrays, or test-only production seam. need more
than 100 author works to cross the actual browser page boundary; generate them
in one fixture setup, with exact/partial/equal dates, equal titles, unknowns,
a podcast, catalogue `issued`, and an inaccessible media target.

| acceptance | live assertion |
| --- | --- |
| shared visibility | every scoped surface exposes its applicable controls once its view is known, through loading and zero results; one band, correct current state, no focus theft; imports preserves its companion and unresolved-view recovery |
| author chronology | browser drain and api `limit=2` traversal agree: complete, unique, authorized rows; oldest default, newest alternative, unknowns last, stable ties; gutenberg release never appears as work publication |
| strict boundaries | all four valid views work; redundant/duplicate/malformed views fail; capture a v2 title-order cursor and replay the same query/dataset/revision after cutover: rejection proves changed date meaning cannot reuse an unchanged plan; cold invalid navigation issues no works request and never commits seed rows |
| continuity | text matching a work beyond page one does not report final absence while loading; rapid sort changes, refresh, retry, back/return, and responsive replacement retain correct query, focus, and committed order |
| domain preservation | authored library/lectern order survives filtering/reset; remote search/browse execute their real queries; imports retain recovery controls; filter removal/reset preserve the specified scope |
| keyboard/layout | narrow desktop pane and phone at 320 css px, 200% zoom, keyboard traversal and escape work without page overflow/occlusion; offscreen focus command reveals the input; page/note/document find still opens and closes; reader controls survive find dismissal |

1. red: run target assertions against current behavior; capture genuine failures
   for hidden controls, wrong default and false publication date. existing
   correct boundary assertions may already pass.
2. green: implement a–c; run the same live assertions and `./scripts/test`.
3. refactor: remove duplication/retired paths; independently review each
   package; rerun the same assertions and static gate after material changes.
4. delete temporary tests, test data, credentials, and dependencies/artifacts
   created solely for them. keep only terse red/green command results and manual
   scenarios in the completion record; rerun `./scripts/test` on the final tree.
   unavailable live prerequisites remain a ticket, never a claimed pass.

## cutover, costs, and completion

ship web/api changes as one coordinated release and reload open clients before
resuming. no database migration. old explicit ascending urls now require reset;
old cursors require a fresh first page. no compatibility implementation.

costs: controls consume initial height and scroll away; options/defaults remain
domain-specific; local text is not shared in urls; more works become undated;
deleted tests provide no ongoing regression detection.

done: all acceptance evidence is green; no retired collection control path or
temporary test artifact remains; `docs/modules/{workspace,panes-tabs,media-metadata}.md`
describes the new contract. delete resolved tickets for visibility, author
default/date semantics, role duplication, and library duplicate keys; update
their register entries. update the existing stale-doc ticket only for references
actually repaired; leave unrelated work open. record observed results here.

## completion record

- red live checks caught the hidden author control, newest-first default,
  catalogue release date in author chronology, and accepted retired view forms.
  temporary checks lived outside the repository and were deleted after green.
- green api checks used an authenticated isolated postgres stack and 108 visible
  works: whole-relation keyset traversal, permissions, four strict views, stable
  ties, unknown dates last, and v2 cursor rejection passed. the same author
  collection passed browser pagination, sorting, filtering beyond page one,
  invalid-view reset, focus, return, refresh, and responsive checks.
- browser checks covered visible controls on all eleven scoped surfaces; real
  gutenberg browse, people search, imports failure/retry and detail companion,
  library and lectern authored order after filter/reset, and page, note, and
  readable-document find. search escape left the committed remote query intact;
  imports clear returned focus to its input. a 320px viewport and 200% zoom had
  no horizontal overflow in checked layouts.
- `./scripts/test` passed after implementation; rerun on the final tree after
  artifact cleanup. the web and api must ship together. old explicit ascending
  author urls and v2 cursors require reset or a fresh first page. the visible
  band consumes initial height and scrolls away; local text is visit-local;
  podcast/catalogue-only works are undated; no permanent regression tests remain.
