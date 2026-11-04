# menus that open complete need latency data

resource-action reads have no production latency distribution. choosing between
the current delayed trailing region and one fully prepared menu therefore lacks
the measurement that would justify delaying local verbs.

`apps/web/src/components/ui/ActionMenu.tsx` owns the five-second preparation
budget, locked placement and `more actions` retry row.
`apps/web/src/lib/actions/useResourceActions.ts` fetches
`GET /resource-items/{ref}/actions` on each open. feedback homes keeps those
contracts; it does not establish their latency distribution. historical isolated
lab timings are not percentiles.

resolved when production p50, p95 and p99 are measured and the menu preparation
decision is taken from them, explicitly accounting for local verbs.
