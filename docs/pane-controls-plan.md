# compact collection controls

status: implemented; owner waived incomplete live verification for merge on 2026-09-25
origin: 2026-09-25 user approval of [the review](pane-controls-review.md)
authority: replaces the presentation, content and verification proposals in
that review and `collection-controls-plan.md`; retain the earlier domain/data
contracts. a subsequent user request authorized implementation and temporary
live proof on an isolated branch.

## goal, scope, final state

make collections compact, understandable and directly operable: one quiet
input/order/filters row; editors disclosed; applied constraints visible.
cover author works, chats, notes index, libraries index, library entries,
followed podcasts, episodes, lectern, search, browse and imports.

remove collection menus' redundant "search this pane". preserve `Pane.Search`
dispatch, cmd/ctrl+f, document find and page/note editor filtering. preserve all
existing membership, permissions, options, default orders, retrieval and source
lifetimes. no new filters, query syntax, endpoints, persistence/schema changes,
dependencies, saved views, sticky chrome, row redesign or general toolbar engine.

## behavior and content

one interaction/content designer owns the following vocabulary and evaluates
each package's actual rendering. reuse domain label helpers and existing typed
view/status records; no parallel copy registry or content schema.

| feature | required behavior/content | good means |
| --- | --- | --- |
| input | visible local `filter <noun>`; remote forms retain their actual search labels and submission controls | noun and match scope are truthful; no full-text claim for metadata matching |
| order | compact native `Select`, full visible criterion/direction, accessible `sort <noun>`; fixed order is text | e.g. `oldest published`, `recently added`, `title a–z`; no stacked caption or icon-only meaning |
| filters | labelled `filters` trigger only when fields exist; badge counts displayed structured constraints, excluding text/order | editor fields retain labels; current options come from domain helpers |
| applied state | removable chips for actual exclusions, outside the editor; no chips for unrestricted defaults | include authors, selected kinds, scope and applicable dates; `no content types` differs from all types; imports' default bounded history window remains visible |
| results | complete: `24 works`; narrowed: `8 of 24 works`; partial: `8 matches in 50 loaded; loading more`; retained: `updating; showing previous results`; failed retained: `update failed; showing previous results`; failed: `results unavailable` or a loaded count plus `loading failed` | totals refer to the current domain view; use matching language only for active text; incomplete/old rows never masquerade as a successful complete result; retain retry/error owners |
| remote draft | when nonempty committed text differs from draft, show `search: <query>` outside the editor; reuse imports' existing query chip instead of adding a duplicate | names the submitted query, not a claim that retained rows match it; retain previous-results status. new summaries are read-only; no new query state/removal command or structured-filter count contribution |

render in the existing body scrollport on its ordinary surface; remove the
tinted outer panel. aim for 32px desktop controls and a 40–48px idle control
row; use existing coarse-input sizing with at least 44px touch targets. align
to collection rows. keep input useful and current order readable. allow
content-driven wrapping at narrow pane widths and enlarged text; no automatic
three-group stacking, clipped labels or horizontal toolbar scrolling. place
chips and concise status together at the list boundary; no dedicated idle
reset row. controls survive valid loading/empty/error states; retain invalid
url reset recovery and imports' initial unresolved-summary behavior.

- entry never focuses the input. explicit cmd/ctrl+f reveals, focuses and
  selects the active pane's input; retain responsive handoff and native browser
  find when unsupported. local typing filters immediately.
- text clear affects only text; chip removal affects its field; `clear filters`
  removes structured constraints while preserving draft/committed text and order.
  apply existing domain normalization when dependencies change: browse kind
  changes can reset incompatible source/order. never preserve an invalid view;
  show every resulting value. imports clears its existing set of structured
  fields, including date bounds, while preserving text/tab/inspector selection;
  reset restores the current tab's default date window.
- `reset view` clears text/facets and restores the domain default order/scope
  within the current route. put it in the filters editor when useful; sort-only
  panes show a quiet reset beside non-default sort. text-only local changes use
  the input clear. search's scope facet resets to all; author/library identity
  and imports tab/selection stay. never render an idle disabled reset.
- local escape clears text; nested editors dismiss first. preserve the exact
  remote rules: search clear commits through debounce, escape clears draft only;
  browse clear/escape clear draft only and submit executes; imports clear removes
  committed text, escape clears draft only. no shared remote query callback.
- desktop filters use a labelled anchored form, not an aria menu containing
  arbitrary fields; phone uses existing `MobileSheet`. apply fields immediately
  and keep the editor open for multiple changes. dismissal preserves effects.
  keyboard dismissal returns to the trigger; outside click respects its target.
- preserve focused native controls across updates. before removing a focused
  chip, focus its next/previous removal control, else the filters trigger.
  clear-filters focuses an available editor field before its action disappears;
  reset closes the editor and returns to its stable trigger; sort-only reset
  focuses the persistent sort control before resetting. late responses
  never reclaim focus. presentation-mode changes close the editor and settle
  focus on its trigger; committed state and collection text survive.
- one owner announces settled local counts, including restoration after clear;
  quiet initial mounting and no per-keystroke or duplicate exhaustion/error
  announcements. preserve readable empty-state recovery and partial-result truth.

## architecture and capability api

`domain view/retrieval → presenter → existing collection rows` and
`domain controls → collection publication → PaneShell` remain the composition.
domains own state, legal combinations, options, reset and requests; shared
components own layout, disclosure and immediate focus settlement.

- keep `PaneCollectionPublication { label, content, focusInput }` unchanged.
  `focusInput(): boolean` succeeds only after revealing/focusing a usable input.
  keep source fences, publication cleanup/equality and in-place navigation.
- extend existing `PaneToolbar` with `variant="Collection"` and a `summary`
  node slot for that variant. existing slots remain: `search` = owned input/form;
  `filters` = current order + filter trigger; `controls` = conditional actions.
  `summary` holds applied state/count. retain `Refinement`/`Instrument` for their
  current non-collection consumers; these are distinct capabilities, not legacy.
- `PaneCollectionBar` remains the local-input/status adapter. add only an
  `appliedFilters` node slot, compose concise status into `summary`, and retain
  its current query callbacks. remote forms use the collection toolbar directly.
- add one `CollectionFilterEditor` with `activeCount`, stable `triggerRef`,
  `children`, `onClearFilters`, optional `onResetView` (present when useful).
  it owns open state and focus; callbacks mutate domain state only. reuse
  `FloatingActionSurface`, existing dismissal/portal primitives and
  always-mounted `MobileSheet(active)`; mount one interactive field tree.
- reuse `AppliedFilterChip {id,label}` and `AppliedFilters` for removable chips
  only, with a stable focus-return target. delete `onClearAll` and its button;
  the editor owns the sole `clear filters` action. existing empty-state recovery
  reuses the same domain operation. derive badge count from structured
  chips, not `activeLibraryDomainControlCount`, which includes sort.
- keep view codecs and status unions. give collection status a concise visual
  projection without changing transient editor filtering semantics. lift search's
  existing selected-author label resolution to one owner shared by editor/chips;
  no second fetch/cache. explicitly project selected kinds outside `KindChips`.
- repair library's `clearDomainFilters → resetView` conflation; adapt imports'
  `withoutImportsFilters` reuse because it also clears committed text. retire
  deferred post-request refocus effects where action-time focus replaces them.

## exclusive packages

frontend paths are relative to `apps/web/src/`. d records reds first; a freezes
the small shared interfaces above before b/c integrate. designers advise within
each package; one owner edits each file. d alone edits docs and temporary proof.

| owner | exclusive files/responsibility | designer and adversarial focus |
| --- | --- | --- |
| a: shared controls | `components/ui/{PaneToolbar,AppliedFilters}` and css; `components/workspace/{PaneCollectionBar,PaneFilterRowsStatus,PaneShell,usePaneCollectionInput}` and css; new `CollectionFilterEditor` there; `lib/panes/paneFilterRows.ts` | control hierarchy, touch/focus, counts; reject remote query ownership or global instrument restyling |
| b: local collections | `app/(authenticated)/{authors/[handle],conversations,notes,libraries,libraries/[id],podcasts,podcasts/[podcastId],lectern}/*PaneBody*`; `lib/contributors/workView.ts`, `lib/collections/updatedTitleIndexView.ts`, `lib/libraries/{libraryView,libraryIndexView}.ts`, `lib/podcasts/{episodeView,subscriptionView}.ts`, `lib/lectern/view.ts` | truthful nouns/order/chips, clear/reset and focus; no retrieval/codec changes beyond required view operations |
| c: remote forms | `app/(authenticated)/{search,browse}/*PaneBody*`; `components/imports/{ImportsWorkspace,importsWorkspaceModel}` and css; `components/contributors/ContributorFilter.tsx` and its single-owner label extraction; `components/search/KindChips.tsx` | actual query/committed state, author labels, bounded dates; reject hidden constraints or changed execution policy |
| d: proof/closure | task-owned temporary live scripts/fixtures; this plan, research/earlier-plan authority links, `docs/modules/{panes-tabs,workspace,library}.md`, affected architecture passages, tickets/register | independent outcome and residue review; preserve unrelated work |

changes outside these files need a concrete acceptance failure and adversarial
review. do not turn an awkward local helper into an unrelated cleanup project.

## temporary red / green / refactor

the explicit user request authorizes temporary live tests for this change.
`./scripts/test` and ci remain static-only. justification: static checks cannot
prove layout, focus, hidden query state or real request/result continuity.
reuse an isolated real stack and authentication: browser → bff → api → database;
disposable data through ordinary paths, enough rows to cross actual pagination.
remote-provider prerequisites must work before their assertions count. no mocks,
auth bypasses, production data edits, new test seams or permanent test framework.
label browser transport delay/abort as fault injection; do not fabricate responses.

| acceptance | smallest meaningful proof |
| --- | --- |
| a1: surface coverage | smoke all eleven collections: applicable compact controls, no duplicate menu item, supported order/options, no idle reset/empty filter trigger; exercise empty/loading/error/invalid-view states on representative owners in a2–a4 |
| a2: intent/focus | author sort-only + library multi-facet: query, order, chip removal, structured clear, full reset; assert exact preserved fields, domain normalization and stable focus; delayed completion cannot steal it |
| a3: honest results | query matching an unloaded row; partial drain/failure/retry; changed sort with retained old results; no false final zero, total or successful new-view claim |
| a4: remote/ownership | search/browse/import query execution/clear/escape policies; visible differing committed query; authors/kinds/date chips; imports clear versus reset date bounds and retained tab/selection; lectern authored default and alternate sorts; fixed order on search/imports/applicable browse views |
| a5: keyboard/accessibility | two panes, offscreen cmd/ctrl+f, nested escape, outside target, last-chip/reset focus; unchanged page/note/document find and unsupported-pane browser find; actual screen-reader quiet mount + restored count after escape/button clear |
| a6: design | designer inspects representative idle/active/empty states at wide/narrow pane, 320px phone/coarse input and 200% text enlargement: useful input, readable order, target sizes, no clipping/overflow; verify physical touch on the changed sheet path |

1. red: write/run these assertions before application changes; first prove the
   stack works. capture real failures for excess layout, duplicate menu, clear
   scope/announcement and hidden committed query. preservation cases may pass.
   independent review must accept assertions and genuine reds before coding.
2. green: implement a–c; run the same assertions and `./scripts/test`. each
   package's designer judges content/rendering; an independent reviewer attacks
   scope, invariants, assertions and proposed simplifications before proceeding.
3. refactor: resolve concrete objections and remove duplication/dead paths;
   rerun affected live assertions and static checks after material changes.
4. delete only task-owned tests, fixtures, credentials and dependencies after
   all acceptance passes on the final implementation. retain a terse evidence
   record here: sha, runtime/device, commands, genuine reds, greens and limits.
   run `./scripts/test` on the final tree. blocked checks are never passes;
   retain unfinished proof and ticket blockers rather than deleting it.

## live proof receipt (2026-09-25, interim)

isolated loopback stack: web `64860`, bff to api `64861`, app postgres
`64840`, separate supabase auth `64850`; ordinary password sign-in and
throwaway author/library data. the temporary proof ran from the linked checkout
with a mode-600 fixture env file. its sha256 was:
`5e3e9e87189cfe5167e296a3bff9c8b4127e08b9837dfbefbec9bdcd3aa77cc1`.

pre-change: 11/20 pass, six genuine reds (idle reset, sort-reset focus,
duplicate menu search, restored-count announcement, hidden browse committed
query, absent imports filters trigger), three blocked. an added imports
continuation assertion then established another genuine red: after one real
cursor transport abort, `50 of 107 imports` still appeared as a settled count.
current expanded run: 26/30 pass, zero product failures, four blocked (search
×2: provider 401 → api 500; followed podcasts: index disabled → api 404;
podcast detail: no subscribed fixture). 105 library entries cross the real
100-row page boundary; a unique match appears only after its held second page.
107 import entries cross the real 50-row page boundary; after an aborted
continuation, the visible count names failure, offers one retry, and the retry
returns a real 200. browser transport delay/abort also exercised partial
loading and retained-sort status; no responses were fabricated. two-pane
Pane.Search dispatch, lectern alternate sort, last-chip focus, and imports
History reset with selection retention passed. temporary screenshots were
inspected and then discarded. the 320px coarse viewport
and css root 200% text simulation fit, but actual physical touch, screen reader,
and browser/os text enlargement are NOT_RUN. added library, pagination, focus,
and geometry checks were authored after cutover began; their passes are not
pre-change reds. implementation commit `72b6bbd42`; on the final linked tree,
`./scripts/test`, `node --check .pane-controls-live-proof.mjs`, and
`git diff --check` passed. the authenticated real-stack proof again reported
26/30 pass and exit 2 solely for the four named blocks. see
[ticket](tickets/pane-controls-live-proof-blocked.md).

## hard cutover, costs, completion

delete the collection menu branch, old expanded collection field layouts,
idle reset/status markup, replaced styles/imports, duplicate facet-label owners
and obsolete delayed-focus paths. retain shared primitives still used by
document/editor instruments. no flags, adapters, aliases, old/new branches or
compatibility paths. deploy normally; rollback is the prior build, no migration.

costs: secondary facets take an extra click; input/order consume width; active
chips and narrow/zoomed views may wrap; scrolling controls require return travel;
native selects limit styling; the compact sort select uses 13px rather than
15px base type to show its full value under simulated 200% text; valid
dependent-field changes may reset order;
phone sheets interrupt direct result inspection; divergent-query summaries may
add a row; test deletion removes
ongoing regression detection. these are deliberate, bounded trade-offs.

done: a1–a6 pass, designer/adversarial objections are resolved, final static gate
passes, tests/retired paths are absent and owning docs match. delete the resolved
tickets `collection-controls-reserve-too-much-pane-space`,
`collection-menu-search-duplicates-existing-input`,
`clearing-collection-filter-suppresses-result-announcement`,
`library-clear-filters-resets-text-and-order`, and
`remote-query-draft-clear-hides-applied-text`, plus their register entries.
record any other unfixed discovery immediately as its own ticket.

## owner-authorized closeout deviation (2026-09-25)

the owner explicitly requested test cleanup, commit, pr, merge, and cleanup
with the known search block. the temporary proof and isolated fixtures were
removed despite step 4 above. the four provider/fixture cases were blocked,
not passed; actual screen reader, physical touch, browser/os text enlargement,
unsupported-pane native find, and other unexercised edge states remain not run.
this is a verification waiver for this merge, not completion of a1–a6. the
[open ticket](tickets/pane-controls-live-proof-blocked.md) retains what must be
checked when the prerequisites exist. deletion also removes repeatable
regression coverage for the tested journeys.
