# mac homebrew node cannot load simdjson

on 2026-11-10, `/opt/homebrew/opt/node@22/bin/node --version` failed with
`dyld: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.34.dylib`.
the referring binary was `/opt/homebrew/Cellar/node@22/22.23.3_3/bin/node`;
the resolved simdjson5.1.1 path also lacked that library.

this breaks commands selecting that binary. the wire20 client build used the
existing working mise node22.23.2; global packages were not changed.

repair the homebrew dependency linkage through its package owner. resolved
when the named binary starts and the relevant locked client build succeeds
without changing its runtime/dependency contract.
