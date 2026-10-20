# resource action reads can wait a minute before they are sent

status: open
origin: 2026-10-14 session entry qualification (main #607/#616), carried by the actions
reauthor's main replay
area: resource actions / web transport

every More menu reads `GET /resource-items/{ref}/actions` when it opens and shows
"Loading actions…" until the read lands. principal-actions removes the direct-add
controls' per-row preflight; quick reads and transcript adds now use the shared
lectern owner. the old snapshot cache's ticket
(`resource-menu-opens-with-actions-blocked.md`, deleted: menus no longer open blocked)
carried production consumer evidence that still applies to these reads:

2026-10-14 consumer `3839`: four h2 action reads spent 91,185–105,376 ms before
`requestStart`, then 1,388–1,470 ms in the request; a later read spent 57,670 ms after
`requestStart` and its successor took 679 ms. pre-send queueing is real but does not
explain every delay; no backend cause is assigned. receipts under
`/tmp/nexus-session-entry-release-20261014/firefox-qualification/`
(`03-action-read-timing.json`, `03-actions-later.json`,
`production-consumer-3839-receipt.json`).

impact: under fetch-on-open a queued read delays complete menu publication.
the action-menu cutover aborts at five seconds and offers retry; this bounds the
visible wait but does not repair transport queueing. direct-add controls no longer
produce that read storm.

current qualification: disposable run `20261020-013220-44e6adaae207` passed an
unintercepted browser/bff/api check with real streams active: the read began within
one second and completed within measured normal api latency. this local stack
does not establish production http2 behavior or resolve the observations above.

what to do: find what holds the browser's requests before send (connection limit, a
long-lived stream on the same origin, service worker) and whether the delayed in-request
times are api latency.

acceptance: on a production-like session with streams open, a menu's action read starts
within a second of opening and lands within the api's normal latency.
