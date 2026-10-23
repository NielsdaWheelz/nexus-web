# lab admission can release capacity before the runtime is gone

at fetched main `aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306`,
`python/scripts/disposable_runtime.py:411-413` starts separate host process
groups, and the lab also starts detached containers. host-slot descriptors are
held only by the runner (`619-651`, `1362-1363`). a hard-killed runner therefore
releases its slot while its services can survive. another checkout can acquire
that slot and fail on its fixed ports (`665-677`); released admission also does
not prove released memory. checkout recovery is explicitly manual (`38-42`).

this is a source-derived failure path, not an executed crash reproduction.
reproduce with an owned disposable lab: kill only its supervisor, inspect its
surviving resources, then request another lab from a different checkout.

accepted limit of the parallel-labs change: hard kills require manual recovery.
the operator reconciles exact recorded ownership before reusing the affected
checkout or ports; never kill a saved pid blindly. automatic prevention would
require separately scoped admission recovery. resolved when supervisor loss
cannot admit replacement work against occupied capacity, and recovery leaves
an unrelated lab intact.
