status: open
origin: 2026-09-13 bounded workspace verification review
area: test controller / sensitivity

`workflow_sensitivity_request` (`sensitivity.py:488–563`) selects BASE for
changed whole-file owners even when the registered product fault is applicable.
against real base `7fa89b88c8342bca9edfb46a6d20053c49555fb2`, 49 changed
declared-fault vitest/gradle owners take that path. new native conversion classes
and reader source modules do not exist there; compilation/import failure cannot
prove the behavioral oracle. explicit candidate fault runs already demonstrate
real assertion failures, e.g. native list `d55a85e4810c5cde` and find
`582036fe1ac37426`.

prerequisite: explicitly review the existing coherent-fault exception's owner
contract. permit canonical whole-file vitest/gradle owners to opt in with exact
file-byte SHA-256, the existing product-only applicable patch, and expected
assertion fingerprint. keep BASE the default, reject qualified/noncanonical
owners and digest drift, and require behavioral red then green. no automatic
fallback or invented baseline. each registration proves only its named risk.

acceptance: the controller mechanism itself fails behaviorally against BASE;
its corrected policy/routes pass real repository fixtures and existing guards.
each newly opted-in reader proof receives independent review and same-run
fault sensitivity in the PR portfolio.

## 2026-09-14 adversarial review — the native half, and a missing mechanical guard

the same routing defect applies to roughly fifteen **native** proof owners added
on this branch: they declare a product fault but carry no
`changed_owner_red: coherent-fault` opt-in, so sensitivity routes them to a BASE
checkout where the classes they exercise do not exist and the proof cannot
compile. a compilation failure is not a behavioral red.

eleven of those owners are also absent from `testdata/proofs.json`, so
changed-source routing cannot select them precisely and falls back to the
conservative whole-capability sweep. they should be registered under the risk
each protects — `reading-progress` for the progress-choice and legacy-conversion
owners, `citation-provenance-identity` for the publication identity/embed/epub
owners, `auth-privacy-secrets` for the SVG and installed-access owners — with
their real product-source globs. leaving them unregistered quietly converts a
targeted registry into a run-everything sweep and makes the coherent-fault pins
impossible.

the guard this ticket assumes exists does not:
`python/nexus_test_control/policy.py:2016-2022` only rejects a fault whose proof
path names a non-canonical node **when the path is registered**
(`canonical is not None`). an owner absent from `proofs.json` passes, and nothing
checks that the owner resolves at the configured base. add that check with the
opt-in work.
