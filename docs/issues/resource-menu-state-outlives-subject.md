# resource menu state can outlive its subject

status: implementation repaired; exact same-document visit qualification open.

original problem: the old resource reader retained unkeyed facts across ref
changes; a reused mobile header could expose commands for its previous subject.

current source: `lib/actions/useResourceActions.ts` keys facts by ref and exact
signal and aborts/forgets on replacement. `ActionMenu` binds its invocation to the
explicit subject; `PaneShell` publishes `paneSourceKey(runtime)` through mobile
chrome, including visit identity. source review passes. live pending departure
and different-resource checks use hard navigation and prove unmount retirement;
they do not independently prove same-document replacement of a visit to the same
resource in a reused mobile header.

resolved when supported same-document visit/resource replacement during pending
and ready phases retires the old invocation without late publication or focus
theft, including a same-resource new visit. do not add an internal store test seam.
