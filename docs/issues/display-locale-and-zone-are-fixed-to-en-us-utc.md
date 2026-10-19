# display locale and zone are fixed to en-US and UTC

status: open · origin: 2026-10-10 visual primitives reauthor (cleanup/visual-primitives-reauthor), spec question 6 · area: web / render environment

`lib/renderEnvironment/server.ts` (`loadRenderEnvironment`) returns
`displayLocale: "en-US"` and `displayTimeZone: "UTC"` for every viewer, chosen in
`12ed3059d` so the server and the client format dates identically at hydration.
every surface that formats through `useRenderEnvironment()` therefore shows
english month names and utc times, whatever the viewer's language or zone.

this is a product decision, not a visual primitive: where a viewer's locale and
zone come from (account setting, `Accept-Language` plus a zone cookie written by
the client, or the browser after hydration) and how first paint stays
deterministic.

what to do: decide the source; if per viewer, carry it into
`RenderEnvironment` from the server (cookie or account) so the first paint and
hydration still agree.

resolved when: a viewer whose browser is set to another locale and zone sees
dates in them on first paint with no hydration warning, or the owner records
that en-US/UTC is the intended product behaviour and this ticket is deleted.
