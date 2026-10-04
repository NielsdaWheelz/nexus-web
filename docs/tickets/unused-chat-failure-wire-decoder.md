# unused chat failure wire decoder

status: open · origin: 2026-10-04 sol read-only reachability audit, `921e69daa8936d75f066e39aef66bdc560b6ae8a` · area: chat / private web source

`apps/web/src/lib/conversations/chatFailureContract.ts:1–54` has no incoming
module/export reference in the tracked js/ts import graph. next.js conventions,
pane dynamic registries, extension/offline/ingest and build roots were included;
the only two nonliteral imports load pinned pdf assets. the private web package
has no export map and this module is not a framework entrypoint. whole-repo
symbol search finds its decoders only here. this leaves an obsolete private
failure grammar alongside live native outputs; no user failure was observed.

first re-admit current consumer/entrypoint closure. then delete this module,
preserving live `ExpectedChatFailure` types, failure renderers and callers.
source-qualified evidence: `/tmp/nexus-private-source-reachability-screen.json`
and `/tmp/nexus-private-unused-export-screen.final.json`.

resolved when: the file and dangling references are absent, live failure owners
remain byte-exact, and the canonical `./scripts/test` passes. no implementation
or runtime verification was performed in this audit.
