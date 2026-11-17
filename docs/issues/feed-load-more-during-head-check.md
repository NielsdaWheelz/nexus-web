# load more did not continue during a live head check

at `88e041447`, lab `20261117-144453-a80ecf29c0c4`, firefox's grouped-count
journey clicked `load more` at 608880ms while NPR Politics had 100 loaded rows.
no cursor-bearing entries request followed; subsequent reads returned the first
100 items with a non-null next cursor and `recurring.work_in_flight=true`.
the assertion for 200 rows failed. this is not evidence of an append then reset.

impact: a visible paging activation can make no progress during refresh.
`apps/web/src/lib/api/useServerList.ts:193` refuses work while a flight exists;
that is a candidate boundary, not an instrumented causal finding. the sigla
return proof waits for the actual head check and list refresh to settle.

resolved when a controlled concurrent refresh establishes the exact refusal
path and an admitted paging activation either advances or gives explicit
unavailability, with coherent cursor and prefix ownership.
