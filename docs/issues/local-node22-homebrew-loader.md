# local node22 cannot load its homebrew dependency

on the macbook on 2026-11-12, `/opt/homebrew/opt/node@22/bin/node --version`
aborted: `Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.34.dylib`.
the binary resolves to `node@22/22.23.3_3/bin/node`; the current simdjson keg is
`5.1.1` and lacks that library. the default node is 26.13.0, while `.node-version`
requires 22. local builds/checks relying on homebrew node22 cannot start.

release preparation used a private node22.23.2 archive, checked against node's
published sha256 list. no homebrew packages or global runtime selection changed.

repair the local node22/simdjson package pairing. resolved when the homebrew
node22 binary starts and reports the intended version, with normal dynamic
linking and no library-path override or fabricated compatibility symlink.
