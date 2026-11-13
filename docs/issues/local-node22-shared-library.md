# local node 22 cannot start

problem: the homebrew node 22 executable cannot load its linked simdjson library.
this blocks using that installed runtime for native browser qualification.

evidence, 2026-11-12: `/opt/homebrew/opt/node@22/bin/node --version` fails with
`Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.34.dylib`.
the executable resolves to `node@22/22.23.3_3`; installed simdjson is `5.1.1`.
the ordinary `node` command is version `26.13.0`.

repair the local package installation consistently through its owner. resolved
when that node 22 executable starts and runs the canonical playwright driver.
the companion change does not alter global packages.
