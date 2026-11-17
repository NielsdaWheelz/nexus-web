# deleting a library with feed history can hold up unrelated writes

observed at `ef44ba92d` in lab `20261117-123829-322884d44b63` on 2026-11-17:
after admitting 12 real podcast and 3 article subscriptions and stopping them,
`DELETE /libraries/bab0af18-9d10-4da6-b530-07e851b3a8ad` took 57,482.79ms.
the browser's 30-second request deadline expired before the eventual 204.
two subsequent library creates returned 409 `Resource is busy; try again` after
10-second lock timeouts on `users`; later cleanup also exhausted three
serializable attempts. private evidence is the run's `api.log`.

impact: bulk history cleanup can leave an unknown client outcome and delay
unrelated account writes. `services/libraries.py:delete_library` owns the
viewer-locked transaction; its exact slow statements remain unmeasured.

the sigla driver avoids an unnecessary delete: it stops its exact subscriptions,
uses unique library names and leaves final data removal to the disposable lab.
this does not qualify product deletion. investigate its transaction/query work
with a comparable public-feed dataset, then verify bounded deletion, preserved
retention semantics and responsive unrelated writes without exhausted busy errors.
