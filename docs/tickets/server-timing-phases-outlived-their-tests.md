# server-timing phases outlived their tests

status: open · origin: 2026-09-28, cleanup/delete-write-only-telemetry · area: api / auth / bff

`nexus_auth` (`python/nexus/auth/middleware.py:226`), `nexus_api`
(`python/nexus/middleware/request_id.py:72-76`), `nexus_openables`
(`python/nexus/api/routes/resource_items.py:88-92`) and `nexus_bff` plus its
allow-list (`apps/web/src/lib/api/proxy.ts:23,132,220-222`) came with the
interaction-budget work (cb3d17b40, ab6452cdf). the tests that read them went in
022d7f661, and their client half, the nexus user timing, went in
cleanup/delete-write-only-telemetry. `docs/architecture.md` keeps them "during
manual diagnosis" (e880b64c0), so they stay.

open question: does anyone read them in devtools? if not, they are per-request
header work on every response with no reader.

resolved when: the api/auth/bff reauthor deletes all four phases and the
architecture.md sentence, or confirms the keep and deletes this ticket.
