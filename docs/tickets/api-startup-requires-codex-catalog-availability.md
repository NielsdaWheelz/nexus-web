# api startup requires a reachable codex catalogue

status: open · origin: 2026-09-15, restoration memory review · area: api availability

`python/nexus/app.py:189` constructs the generation catalogue and awaits
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
