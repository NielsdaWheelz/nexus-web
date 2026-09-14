# controller experiment limits are injected into every local-stack proof environment

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: test controller / capacity fixtures

## what is wrong

`python/nexus_test_control/services.py:451` supplies
`API_READ_ADMISSION_LIMITS`, `IMAGE_DECODER_LIMITS` and
`READER_PUBLICATION_LIMITS` to **every** local-stack proof environment, not only
to the capacity lane. every ordinary proof therefore runs against
controller-chosen experiment numbers, and the branch's tuning was done against
them (see the gate 0/a ticket).

it cannot simply be removed: `python/nexus/config.py:1300` and
`python/nexus/api/read_admission.py:92` fail closed without all three profiles,
and `python/tests/capacity/test_api_reader_capacity.py` reads them straight out
of `os.environ` as its scenario inputs and asserts on them (`retry_after == '1'`).
choosing different ordinary-stack numbers would mean inventing unqualified
budgets, which the spec forbids ("numeric budgets are qualification outputs") —
`deploy/env/env-prod-backend.example` still carries `<qualified>` placeholders, so
there is nothing committed to copy.

## prerequisites

the capacity proof must pass its own envelope rather than reading the ambient
environment, and `docs/local-rules/testing-standards.md` §9 must record the
local-stack fixture contract: which profile an ordinary proof runs under, and why
that is not a production number.

## proposed fix

give `test_api_reader_capacity.py` an explicit scenario envelope; leave the
ordinary local stack one clearly-labelled fixture profile whose only claim is
"large enough not to be the subject of the proof"; record both in §9.

## acceptance

no ordinary proof's behaviour depends on a controller-chosen capacity number, the
capacity proof asserts against the envelope it was given, and §9 names the
fixture contract.
