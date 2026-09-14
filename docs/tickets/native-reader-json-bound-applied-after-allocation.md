# native reader response budget is applied after allocation

- status: open
- origin: 2026-09-13 bounded workspace implementation
- area: native reader transport

`HttpOfflineReaderProgressOriginClient.kt:93–94,115–116` and
`OfflineReadingOriginClient.kt:142–143,299–300,317–318` call `body.bytes()` before
checking the one-mib json budget. a larger response is completely allocated first.
this is a source-level gap; no native memory kill was observed.

fix: use one bounded response reader in `OfflineReadingHttp.kt`; stop at the
existing limit before whole-body materialization. keep strict protocol decoding.

acceptance: the real http client rejects an oversized/chunked response after bounded
consumption; ordinary and error envelopes still decode. all proofs use `./scripts/test`.
