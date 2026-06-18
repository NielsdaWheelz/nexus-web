# Codebase cleanliness audit

Status: superseded.

This historical audit has been retired as implementation guidance. It was
generated before the current-only artifact hard cutover and contained findings
that assumed app-level content versions, source versions, artifact hashes,
fingerprints, prompt hashes, source-set versions, note revisions, and dual API
compatibility fields still existed.

Current cleanup work must follow:

- `docs/rules/cleanliness.md`
- `docs/rules/layers.md`
- `docs/local-rules/module-apis.md`
- `docs/cutovers/current-only-artifacts-hard-cutover.md`
- the live module docs in `docs/modules/`

Do not use this file as a backlog. If a cleanliness issue still exists, cite the
current code and current rules directly. Historical recommendations from the
retired audit are not a compatibility contract and must not revive deleted
version, revision, hash, or fingerprint lanes.
