# lab execution capacity changes an unchanged web build

at fetched main `aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306`,
`python/scripts/disposable_runtime.py:665-693` derives ten service ports from
the acquired host slot. `1099-1103` includes that slot in the sole cached web
package key. the same clean checkout, commit and public auth key rebuild when
concurrent activity makes it acquire the other slot (`1112-1140`).

this unnecessarily ties compilation to admission order. public origins are
build inputs, so merely dropping the slot from the key would serve the wrong
configuration. this is established by source; rebuild cost was not measured.

separate checkout endpoint allocation from execution capacity while preserving
the canonical production build and fresh per-run private data. resolved when
an unchanged checkout reuses its correct package under different admission
orders, and concurrent checkouts retain distinct service endpoints.
