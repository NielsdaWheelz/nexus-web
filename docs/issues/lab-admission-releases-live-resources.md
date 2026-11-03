# lab admission can release capacity before the runtime is gone

at fetched main `aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306`,
`python/scripts/disposable_runtime.py:411-413` starts separate host process
groups, and the lab also starts detached containers. host-slot descriptors are
held only by the runner (`619-651`, `1362-1363`). a hard-killed runner therefore
releases its slot while its services can survive. another checkout can acquire
that slot and fail on its fixed ports (`665-677`); released admission also does
not prove released memory. checkout recovery is explicitly manual (`38-42`).

observed during feedback-homes qualification on 2026-11-02: runner pid27016
for `20261102-201924-92036acadcdd` disappeared while its recorded host groups
and detached stores survived. why the runner exited is unknown; this was not
a deliberate crash test. a different checkout acquired unlocked slot4 and
failed before its driver because `127.0.0.1:31030` remained held by
`c0ea2872190a`, the exact run's postgres container. its compose working directory
was the owning `p2-l4/docker`. several later runs hit the same occupied port.

the owner verified current commands and working directories against the run's
`launches.json`, drained only those groups, and ran both recorded recovery
commands successfully. container, volume and network queries for its exact
compose/auth labels were empty; the port had no listener. only then were the
recorded private inputs, socket directory and matching checkout lock removed.
no shared slot state, daemon settings or unrelated runtime changed. the
interrupted qualification run has no final result and must be rerun.

accepted limit of the parallel-labs change: hard kills require manual recovery.
the operator reconciles exact recorded ownership before reusing the affected
checkout or ports; never kill a saved pid blindly. automatic prevention would
require separately scoped admission recovery. resolved when supervisor loss
cannot admit replacement work against occupied capacity, and recovery leaves
an unrelated lab intact.
