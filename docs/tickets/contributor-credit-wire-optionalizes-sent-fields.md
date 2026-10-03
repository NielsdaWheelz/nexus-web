# contributor credit wire optionalizes sent fields

status: open · origin: 2026-10-02 search boundary review, baseline 56b889bdc6708d2d913982e22e7566a141b024d6 · area: typed wire / contributors

`python/nexus/schemas/contributor_credit.py:11-18` gives five nullable output
fields `None` defaults: contributor handle/display name, href, raw role and
ordinal. serialization sends these keys even when null, but generated
`ContributorCreditOut` marks them optional. this conflicts with
`docs/local-rules/typed-wire.md` and leaves consumers unable to rely on the
actual required-key contract. search's own output fields are corrected; this
shared nested owner remains unchanged.

prerequisite: update both constructor owners (`services/contributor_credits.py:355`
and `services/browse/models.py:248`) to supply each value explicitly. confirm
other model-validation paths already carry these keys.

fix: remove the nullable defaults from the shared output model, preserve all
serialized bytes, regenerate the web wire, and remove optional-key handling
only where it serves this same-deploy contract.

acceptance: generated credit fields are required and nullable, embedded credit
responses remain byte-identical including handle-less discovery facts, and
`./scripts/test` passes.
