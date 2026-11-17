# load more did not continue during a live head check

at `88e041447`, lab `20261117-144453-a80ecf29c0c4`, firefox's grouped-count
journey clicked `load more` at 608880ms while NPR Politics had 100 loaded rows.
no cursor-bearing entries request followed; subsequent reads returned the first
100 items with a non-null next cursor and `recurring.work_in_flight=true`.
the assertion for 200 rows failed. this is not evidence of an append then reset.

the native input attachment in `20261117-152944-84861cf497e3` proves the cause:
firefox emits window focus while already focused, after pointer-down. the
foreground stamp refetches and disables the button before pointer-up, so no
click fires. the list's flight guard never receives the intent.

the fix in `lib/consumption/refresh.ts` recognizes actual blur-to-focus returns;
repeated focus cannot interrupt an activation. live proof is pending.

resolved when a controlled concurrent refresh establishes the exact refusal
path and an admitted paging activation either advances or gives explicit
unavailability, with coherent cursor and prefix ownership.
