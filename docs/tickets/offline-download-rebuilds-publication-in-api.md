# offline downloads rebuild unchanged publications inside the api

- status: open
- origin: 2026-09-13 workspace architecture investigation; checkout `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: offline artifact production / foreground resource ownership

## evidence

`python/nexus/api/routes/offline_reading.py:188-220` admits up to two package
assemblies and runs each in an api-owned thread. each download calls
`build_offline_reading_archive_file`; there is no reuse of a previously verified
archive for the same publication generation and package contract.

`python/nexus/services/offline_reading_delivery.py:123-150` captures, projects,
verifies, encodes, and hashes the publication on every call. publication capture
materializes every fragment in `reader_publication.py:490-508`. projection
serializes a complete reader member at `offline_reading_delivery.py:208-215`;
file verification reads and parses that complete member again at
`offline_reading_packages.py:360-365`. the contract permits a 64 mib reader
member (`schemas/offline_reading_package.py:39`). that byte ceiling is not a
measured bound on its live python models, native html trees, and encoded bytes.

the outer zip and assets are file-streamed, and admission is bounded. this is
repeated document compilation in the foreground api, not an allegation that
the whole zip is resident or that this route caused the observed production
memory kills. allocation cost and production invocation remain unmeasured.

## prerequisites and proposed fix

profile supported large publications with concurrent foreground navigation.
produce and verify an immutable package in the existing isolated worker owner,
identified by publication generation and package/reader contract versions.
publish its object reference only after verification. api download remains
authorization, generation attestation, and bounded byte delivery. choose
eager production at publication or durable first-download preparation based on
measured demand; both reuse completed artifacts and deduplicate preparation.
preserve token authority, native verification, publication replacement fences,
and pending progress. define artifact retention and owned cleanup explicitly.

## acceptance

through `./scripts/test`, prove repeated downloads of an unchanged publication
reuse verified bytes without api document projection; changed publications
cannot expose mixed generations; failed preparation publishes no artifact;
account isolation and supported native package/progress migration hold. compare
foreground peak memory and latency during preparation and transfer with exact
artifact and workload receipts. record storage and first-download latency costs.
