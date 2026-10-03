# aligned deploy omits the reviewed model-cutover snapshot

status: open; release blocker
origin: 2026-10-02 kernel historical-uncertainty verdict
area: aligned release / migration 0246

evidence: `deploy/hetzner/deploy.sh:25,105` accepts the source sha and invokes
`release.py` with that argument alone. `release.py:625–628,729–740` requires
`--model-cutover-snapshot` before crossing `0246`. source reviewed at metadata
`57c1861fb` and native candidate `a3540e3dcbb79a0235ef21fba67fb5c6966bcfbd`.
the normal aligned entrypoint cannot supply its controller's required input.

fix owner: release. forward the reviewed snapshot through the existing aligned
entrypoint to the existing controller; keep missing/malformed-input validation
before shutdown. keep identity comparison after drain and before disposition or
migration.
direct backend invocation alone does not qualify aligned api/worker/web release.
the separate archival disposition and verified backup remain prerequisites.

acceptance: the aligned entrypoint forwards the exact snapshot path. missing or
malformed input refuses before shutdown; drift refuses after drain, before
disposition or migration. prove the composed path on the restored actual starting
revision before separately
authorized production release. no production execution is recorded here.
