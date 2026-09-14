# offline reader descriptor requires decoding the complete publication

- status: open
- origin: 2026-09-13 workspace architecture review; checkout `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: offline reader / browser and native-webview residency

`apps/web/src/lib/offlineReading/OfflineReaderAdapters.ts:87-103` starts
reading the complete reader member in the source constructor, calls
`response.text()`, decodes the document, and retains its promise. even
`loadDescriptor` waits for that complete graph. individual epub section reads
then select from the resident document. the package contract allows a 64 mib
reader json member (`python/nexus/schemas/offline_reading_package.py:39`).
this is a source-level scaling hazard; the member ceiling is not a measured
browser memory envelope, and this does not explain the api memory kills.

prerequisites: introduce the revision-bound descriptor and unique bounded
reading units described in `reader-source-lacks-publication-revision.md`.
preserve native verification, account/lease authority, and current package and
progress migration obligations.

fix: package independently addressable verified units. load the compact
descriptor independently; decode only units needed by the active reader and
an explicitly bounded working set. retain complete navigation and canonical
locations. packaging the whole publication for download must not require
materializing the whole publication for display.

acceptance: through `./scripts/test`, a supported large downloaded publication
opens its descriptor and selected unit without decoding all other units;
complete traversal, offline find, selection, generation fencing, and native
no-network behavior remain correct. measure peak residency and transition
latency, and preserve existing packages until their supported migration ends.
