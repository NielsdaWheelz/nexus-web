# podcast lists page with a viewer revision the web must echo

status: open · origin: 2026-10-10 podcasts/browse web rewrite (branch `cleanup/podcasts-browse-reauthor`) · area: podcasts / collection pages

`GET /podcasts/subscriptions` and `GET /podcasts/{id}/episodes` are revisioned
collection pages: a continuation must carry `cursor` together with
`collection_revision` (`python/nexus/schemas/collection_page.py:91-93`), and the
server answers 409 `E_COLLECTION_CHANGED` once the viewer's family has moved.
`useServerList` (`apps/web/src/lib/api/serverState.ts`, shared with the author pane since 2026-10-10) therefore keeps
`(cursor, revision)` as one opaque continuation, and on 409 reloads the asked-for
prefix once (one page longer for a Load more) before showing the error with
Retry. The echo and that recovery exist only for these routes (design T1, Q1).

impact: a 409 re-reads the whole loaded prefix in chunks of 200 instead of
continuing; listening writes make that routine (ticket
`listening-writes-bump-podcast-collection-families`). The podcast slice's own
churn is gone (2026-10-10 python reauthor: ingest moves only the show's
audience, only when it inserted or changed an episode; sync status, settings and
backfill progress move nothing); what remains is consumption's listening bumps,
media-fact writers (ticket `media-fact-writers-bump-every-viewer`) and the
coupling with the authors slice, which now shares `useServerList` (A2). The
volatile sorts (unplayed count, latest episode) are why the python reauthor kept
the revision guard.

fix: move both lists to `parse_manual_page_query` (`collection_page.py:111`)
with keyset cursors that need no revision; then delete the continuation revision
and the `E_COLLECTION_CHANGED` restart from `useServerList`.

acceptance: both routes page by cursor alone; `useServerList` sends no
`collection_revision` and has no `E_COLLECTION_CHANGED` branch; the harness
journey D6 (load more while playing) passes with no 409.
