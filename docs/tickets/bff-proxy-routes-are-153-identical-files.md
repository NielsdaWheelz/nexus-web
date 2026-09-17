# 153 bff route files are the same proxy handler

status: open · origin: 2026-09-17 slop sweep (claude session) · area: web bff ·
oi-153

`find apps/web/src/app/api -name route.ts | wc -l` is 175 files / 2280 lines. of
those, 153 import `proxyToFastAPI` and contain nothing else — no `new Request`,
no `NextResponse`, no decode — plus per-file `runtime` / `dynamic` /
`revalidate` boilerplate, about 1766 lines. comparing every proxy target literal
against its own directory path (with `[param]` rewritten to `${param}` and
`encodeURIComponent()` stripped) gives 152 identities and exactly five remaps:
`media/from-url` -> `/media/from_url`, `walknotes/transcribe` ->
`/walknotes/transcribe-audio`, `stream-token` -> `/internal/stream-tokens`,
`media/[id]/offline-reading-token` and `offline-reading/account-binding` ->
their `/internal/...` equivalents.

fix: replace them with one `apps/web/src/app/api/[...path]/route.ts` exporting
the five verbs, and keep the roughly 22 routes that add logic (the five remaps,
the four non-structured proxy policies, consumption, csp-report, telemetry,
contributors, me/workspace-session, `media/[id]/assets/[...assetKey]`,
extension/session) as explicit shadowing routes. the guard must be an explicit
denylist of first segments `{internal, docs, redoc, openapi.json, livez, readyz,
stream}` plus the exact webhook paths `{billing/stripe/webhook, ingest/email,
auth/handoff-codes, auth/handoff-codes/consume, offline-reading/packages/*}`:
diffing the 234 FastAPI routes against the BFF directories shows that an
`internal`-only guard would newly expose `/api/docs`, `/api/openapi.json` and
the rest to the browser.

the trade-off to state plainly: the BFF stops being an allowlist of FastAPI
paths and becomes a denylist. if that inversion is refused, the same 153 files
still collapse into one catch-all driven by a literal table of allowed path
patterns — same saving, allowlist preserved.

prerequisite: none; the remap table and the denylist above are the whole
contract.

related and declined: WB-03 (collapsing 32 never-mounted `page.tsx` stubs into
one catch-all) is not worth doing — `next typegen` derives typed routes from
those files and a catch-all would widen typed hrefs to `string` for about 90
lines.

acceptance: one catch-all plus the explicit routes; every denied path returns
404 from the BFF; a browser pass over imports, reader, chat and player shows no
new 404; `bun run typecheck` and `./scripts/test` pass.
