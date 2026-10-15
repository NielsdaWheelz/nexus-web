# a resource's More menu opens with every canonical action blocked

status: open · origin: 2026-10-10 workspace host reauthor (cleanup/workspace-host-reauthor), c2wh harness · area: resource actions / web

opening a media pane's More menu calls the menu model's `refresh`
(`ContextualActionMenu` / `ResourceActionMenu` `onOpenChange`), which reconciles
the subject's action snapshot (`POST /api/resource-items/action-snapshots/resolve`).
while that read is in flight the cache entry is `Reconciling` and
`useOptionalResourceActionMenuModel` blocks every descriptor with "Actions are
refreshing." (`apps/web/src/lib/actions/resourceActionRuntime.tsx:530-540`), so
the menu a user just opened lists Open, Libraries…, Chat about this…, Share… and
the rest disabled for one round trip.

evidence: c2wh harness J4.header-per-pane-kind (baseline f47b91d75 and the
rewrite) reads the menu right after it opens: all 15 canonical media
actions are "(disabled)". a probe (`host/harness/probe-r5.mjs`) that opens the
menu 5 s after load reads only the expected blocks (Light theme (current),
Download for offline, re-enrich metadata) at open and again 6 s later: nothing
stays disabled, the block lasts one reconcile.

not a defect of the host slice; re-enrich metadata stays blocked while the
media's enrichment job is `queued` (the sealed harness stack never starts it),
which is the snapshot's own answer.

2026-10-14 actual `3839` consumer evidence: `03` metadata and expanded history
eventually opened. four h2 action reads spent 91,185–105,376 ms before
`requestStart`, then 1,388–1,470 ms in the request. a later read spent 57,670 ms
after `requestStart`; its successor took 679 ms. pre-send queueing is real but
does not explain every delay; no backend cause is assigned. `usePaneIsVisible`
means not minimized, not canvas intersection. receipts under
`/tmp/nexus-session-entry-release-20261014/firefox-qualification/`:
`03-action-read-timing.json`, `03-actions-later.json`,
`production-consumer-3839-receipt.json`.

what to do: keep the last good snapshot actionable while an open-triggered
reconcile runs (block only commands whose verb the reconcile can invert), or
reconcile on pane focus instead of on menu open.

acceptance: a media pane's More menu, opened after its snapshot is Ready, never
shows its canonical actions disabled for a reconcile.
