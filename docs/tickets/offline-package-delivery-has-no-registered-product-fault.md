# the server preparation, status and transfer owner has no sensitivity witness

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: offline package delivery / sensitivity

## what is wrong

`testdata/faults/manifest.json` holds 211 faults, 47 of them offline-related, and
**none** names `python/tests/service/test_offline_reading_package_delivery.py` or
`python/tests/kernel/test_offline_reading_publication_package.py`. the
server-owned invariants this slice introduces therefore have no sensitivity
witness of any kind: 202-until-verified minting (a token must be unmintable while
no archive row exists), preparation dedup, the typed status transitions, and the
schema-2 publication closure checks in `_verify_publication_members`.
`native-download-generation-substitution` exercises selected-generation binding
through this server, so that one invariant has a witness; the rest do not.

the default mechanism cannot substitute here.
`python/nexus_test_control/sensitivity.py:526-538` routes a changed owner without
a declared fault to `SensitivityMethod.BASE`, and `behavioral_red`
(`sensitivity.py:299-312`) accepts a BASE run **only** when it fails with
`proof_result=behavioral_assertion_failure`. both of these owners fail closed
under BASE: the service proof imports `nexus.services.offline_reading_preparation`
(absent at `7fa89b88c8`), and the kernel proof imports
`nexus.schemas.reader_publication` and calls
`build_offline_reading_manifest_from_entries(package_schema_version=…)` and
`verify_offline_reading_zip(publication_limits=…)`, none of which exist in the
base signatures. that is exactly the hard-cut case
`docs/local-rules/testing-standards.md:140-155` reserves the
`changed_owner_red: coherent-fault` opt-in for, and 86 faults already use it —
fourteen of them added on this branch for peer owners.

## prerequisites

none. each fault must be product-only, with its canonical node, patch SHA-256,
expected assertion fingerprint and pinned owner source digests.

## proposed fix

register one coherent product fault per invariant class:

- a patch that mints before the archive row exists — must fail the 202 assertion
  at `python/tests/service/test_offline_reading_package_delivery.py:213-218`.
- a patch dropping the unit-key uniqueness rejection at
  `python/nexus/services/offline_reading_packages.py:617` — against the schema-2
  verifier proof.
- the typed-failure assertion with its own fault.

capture each red run and cite it. a broader journey is the wrong instrument:
these failure modes are service-local, and a journey would make the witness
slower and less precise.

## acceptance

every named invariant has an observed red followed by green, from the same
executor, cited by run id.
