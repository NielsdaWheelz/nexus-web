# the verb rail's state outlives its row

status: open · origin: 2026-11-02 palette s3 · area: web / nexus controller (s2)

`useNexusController` keeps `rail = { key, focus, filter }` until something calls
`closeRail`. when the rail's row leaves the list (a pane closed elsewhere, a local
match found missing, a recent pick removed, playback ended) the list's `remove`
path (`useNexusController.ts`, the `setList` updater, `gone` set) retires the armed
row but leaves `rail` naming the vanished key. the presenters render no rail (the
row is gone) and hand focus back to the query, but `submit` returns early while
`rail !== null` and `escape` spends its first press closing the invisible rail.

impact: after such a removal enter does nothing and the first escape does nothing
until the user presses escape once more or types. rare (a row must vanish while its
rail is open), silent.

evidence: by reading. `submit` starts `if (rail !== null) return;`; `escape` and
`guardClose` start `if (rail !== null) { setRail(null); ... }`; nothing clears
`rail` when its key leaves `allRows`. the verb sheet wants "a retired armed row
closes its rail and announces `selection no longer available`".

fix: where the controller computes `gone`, clear a rail whose key is in it (and
announce the retirement), outside the `setList` updater.

resolved when: closing a pane from the strip while its tab row's rail is open in
nexus leaves enter and escape working on the next press.
