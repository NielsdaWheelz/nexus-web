# webkit workspace persistence during source navigation

status: open; intermittent, not reproduced on immediate repeat
origin: 2026-10-16 compact chat details live qualification
area: workspace / persistence / webkit

a real webkit located-source journey passed shift, keyboard, native browser
modifier, 320px expanded details and 200% content zoom, but emitted an uncaught
error naming `/127.0.0.1:58710/api/me/workspace-session due to access control
checks.` chromium, firefox and chromium touch passed the same journey. an immediate
webkit repeat passed all checks without a browser exception. a
browser-owned popup was closed during this journey; teardown versus product
failure is not yet distinguished.

prerequisites/fix: reproduce with exact timing and capture request/exception
ownership before changing workspace persistence; no details-specific transport
fallback. isolated external receipt: `navigation-webkit-results.json`.

acceptance: locate and repair a product cause, or establish that the exception
belongs solely to disposable popup teardown and record that verification limit.
