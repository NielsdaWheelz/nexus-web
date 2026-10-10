# the podcasts/browse rewrite is over its line budget

status: open · origin: 2026-10-10 podcasts/browse web rewrite (branch `cleanup/podcasts-browse-reauthor`) · area: podcasts, browse / reauthoring

The rewrite measures 4,163 formatted lines (prettier 3.9.9 `--no-config`, the
design's §4.1 files) against a 3,000 cap and a 2,790 design budget; the four
page stubs (12 lines) left the slice when the workspace rewrite (#542) deleted
them. Before it, the same surface was 8,105 (41 files, stubs included). No
behaviour was cut for budget (coordinator decision R2). After the trims that
removed real duplication (one view-select composition shared by browse and both
podcast panes, `LoadMoreFooter`, one conflict-cancel path), what remains is
behaviour the design keeps. The adversarial review added 59 lines: its fixes
(a visit snapshot served once, one announcement per query, the refused-query
and refused-cursor branch, progress on a retried first load, a preview-position
defect that stops navigation, no episode list beside a failed head) and the
unpacking of template literals that had hidden nested calls on one line.
Formatted lines, budget in parentheses:

`lib/podcasts/api.ts` 242 (190), `lib/podcasts/paneState.ts` 449 (200; on 2026-10-10 the authors reauthor moved its generic server-state hooks to `lib/api/serverState.ts`, counted in neither slice),
`lib/browse/api.ts` 45 (55), `lib/browse/query.ts` 113 (100),
`presenters/browse.ts` 92 (90), `presenters/podcast.ts` 49 (60),
`BrowsePaneBody.tsx` 591 (300), `browse.module.css` 115 (75),
`BrowsePreviewPaneBody.tsx` 378 (245), `AcquisitionControl.tsx` 417 (280),
`AcquisitionControl.module.css` 40 (40), `PodcastOverview` 81 + 68 (90 + 65),
`PodcastSubscriptionSettingsOverlay` 191 + 24 (150 + 20), `PodcastViewBar.tsx`
168 (100), `PodcastsPaneBody.tsx` 317 (210), `PodcastDetailPaneBody.tsx` 530
(340), `PodcastEpisodeList.tsx` 210 (150), detail `page.module.css` 43 (30).

where the lines go:
- `paneState.ts`: the design's own §4.2 contract (exported list/value/page
  types) formats to ~60 lines before any code; the two hooks and the
  once-served visit snapshot are ~200; the
  failure-copy table, `useCommand` and `podcastRefresh` ~90; two helpers every
  async handler in the slice needs (`useThrowLater`, `modeledApiError`) and the
  shared row-status helper ~40.
- `BrowsePaneBody.tsx`: the J1 toolbar (draft and commit, clear, Escape, 1–200
  help, committed-search label, three selects, chips, reset) ~150; fan-out,
  visit restore, per-section requests and the refused-query branch ~110;
  section rows, failure rows, Load more ~100; summary and the once-per-query
  live region ~50; imports ~50.
- the detail pane: head + episodes + lifecycle + poll + chrome as designed, plus
  failure notices for head, episodes, commands and the lost stream; the
  overview facts alone are ~40 formatted lines.
- `AcquisitionControl.tsx`: every J3 branch (picker and create, conflict dialog,
  key discipline, delivery-unknown retry, permission review, position transfer).
- prettier puts each JSX attribute and object field on its own line once a
  line passes 80 columns; the design's estimates assumed denser forms.

impact: 1,163 lines (39 %) over the cap; no behaviour impact. the rewrite still
removes 3,942 formatted lines from this surface.

resolved when: the owner accepts the overrun, names behaviour to cut, or a
later pass finds an honest simplification (candidates: one podcast-pane view
hook absorbing filter-rows, url replace and the collection publication, ~60
lines; python keyset pages, ticket `podcast-lists-need-keyset-continuations`,
which would delete the continuation echo and 409 restart).
