# a library the viewer cannot see replaces its pane with /libraries

status: open · origin: 2026-10-09 workspace harness baseline (J11.unauthorized-resource-is-pane-local) · area: libraries / pane state

a deep link to a library another user owns (the api answers a masked 404)
navigates that pane to `/libraries` instead of rendering a not-found state:
the strip then shows two identical Libraries panes and the address is
`/libraries`. cause: `apps/web/src/lib/libraries/useLibraryEntries.ts:239`
does `router.push("/libraries")` on a 404.

impact: low. a stale or foreign library link silently becomes a duplicate
libraries pane.

fix: render the pane's own not-found state on 404, as media does.

resolved when: harness J11.unauthorized-resource-is-pane-local passes (its
xfail removed): the pane stays on the requested href with a not-found state and
one Libraries pane.
