status: open
origin: 2026-09-25 pane-controls implementation
area: collection controls / live verification

an isolated loopback browser → bff → api → database stack runs with ordinary
password auth, two author works and 105 disposable library entries. the
pre-change proof ran 20 cases: 11 passed, six genuine product assertions
failed (idle reset, sort-reset focus, duplicate menu search, restored-count
announcement, hidden browse committed query, absent imports filters trigger),
and three were blocked. a later imports continuation test established a
separate genuine red: one real cursor transport abort left `50 of 107 imports`
looking settled, with no failure or retry owner. after the imports repair, the
expanded run reports 26/30 pass, zero product failures and four blocked cases.
it includes real library second-page delay, unloaded-row match, failed
continuation plus user retry, retained-sort delay; imports failed-continuation
retry and History reset/selection retention; two-pane shortcut, lectern sort,
facets and focus, quiet initial count and facet-only announcement, wide/320px
coarse geometry, and simulated 200% root text. the 200% select clip was fixed
with a smaller 13px native sort select and collection-specific inset; this
trades base type size for a complete readable value. the added assertions were
not run against pre-change code, so their passes are not claimed as reds.

blockers: two search cases receive `/api/search` http 500 because the local
openai credential is rejected by the provider with http 401 `invalid_api_key`.
followed-podcast smoke receives `/api/podcasts/subscriptions` http 404 because
`PODCASTS_ENABLED=false` without Podcast Index credentials. podcast-detail
smoke lacks an ordinary subscribed-show fixture. no dummy credentials or
fabricated responses were used. actual screen-reader behavior, physical touch,
actual browser/os 200% text settings, unsupported-pane native find, and the
other unexercised a1–a6 edge states remain NOT_RUN; css root text simulation
is distinct evidence.

prerequisites: provide working isolated search and Podcast Index credentials;
subscribe a disposable show through the ordinary api; exercise the remaining
device/accessibility and edge cases. rerun the live proof and `./scripts/test`
on the final tree. delete the task proof and this ticket only after all
required acceptance passes; blocked and NOT_RUN never count as passes.
