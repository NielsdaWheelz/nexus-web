# loaded suggestions keep fetching in inactive panes

status: open (source-confirmed; request-count reproduction pending)
origin: 2026-10-14 lectern latency diagnosis, source `367da80e0`
area: web / suggestions query lifecycle

`apps/web/src/components/collections/SuggestionsSection.tsx:84-87` disables
inactive queries only while `rows === null`. after any successful load, an
inactive pane still follows consumption, entries and media-query revisions.
`MediaSummaryProvider.tsx:190-196` invalidates queries on window focus,
online, pageshow and document visibility. `useResource.ts:143-191` restarts
the request when its key changes. quick reads gates all reads on `isActive`
(`QuickReadsSection.tsx:30`). this contradicts `docs/modules/connections.md`'s
inactive-key contract and can repeat a multi-second corpus scan offscreen.

prerequisite: preserve retained rows and the existing activation refresh.
gate the suggestions query for the entire inactive lifetime. broader
heartbeat invalidation remains in `consumption-heartbeats-refetch-lists.md`.

acceptance: load suggestions, deactivate its pane, publish relevant revisions
and restore browser focus: no inactive suggestions read starts. reactivation
refreshes once while retaining usable rows. no implementation in this diagnosis.
