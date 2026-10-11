# a server value keyed by the empty string never refetches

status: open · origin: 2026-10-10 model tools rewrite (harness T6/T5b, first branch run) · area: web server state

`apps/web/src/lib/api/serverState.ts` `useServerState` loads a key that is not
`null` (`key === null` is the only skip), but `refetch` reruns only when
`heldRef.current?.key` is truthy. a caller whose key is `""` gets its first load
and then no `stale` change and no `refetch()` ever reloads it. the settings
"Assistant writes" history first used its query string as the key, which is empty
without a generation filter: Load older and the post-undo reread did nothing
(harness T6, T6m, T5b failed). it now keys `assistant-writes?<query>`.

proposed fix: test `key !== null` in `refetch` as the load effect does (one line;
`lib/api` belongs to the collection-revisions slice, which owns the change).

acceptance: a `usePaneFreeServerValue` keyed `""` rereads on a `stale` change.
