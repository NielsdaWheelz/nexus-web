# api startup requires a reachable codex catalogue

status: open; catalog recovery unverified · origin: 2026-09-15, restoration memory review · area: api availability

`python/nexus/app.py:167-171` constructs the generation catalogue and awaits
`startup()` in production. catalogue definition refresh calls the codex host;
`GenerationCatalogRefreshError` escapes the api lifespan if it is unavailable.
`deploy/hetzner/docker-compose.yml:69` instead documents that host unavailability
must not block unrelated api readiness. the composition startup dependency
alone does not establish that behavior.

this is a source-level finding, not an observed production outage. keep model
admission closed when its catalogue is unavailable while allowing unrelated
reader/import api routes to start. resolve the intended catalogue lifecycle at
its owning boundary, then verify startup with an unavailable host and recovery
when the host returns. do not recreate a browser or release simulation suite.

the 2026-09-27 reliability candidate removed external catalog i/o from api
startup. a fresh local api at database `0247` started with no codex socket;
`/version` and saved chat reads returned 200 while `/llm-catalog` returned
typed 503. recovery when a real host returns remains unverified on this tree.

the change merged in pr #412 (`27e961be6`); static pr checks passed, but no
merged-source host-down/host-return journey was run. close after an authenticated
saved read stays available through host loss and catalog admission recovers when
the pinned host returns, without restarting unrelated api routes.
