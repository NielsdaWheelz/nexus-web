# synapse cancellation requires a missing prepared checkpoint

status: open · origin: 2026-09-15 ecbe production observation · area: synapse jobs

## evidence

background worker on deployed
`ecbe838ede7a3e85ee83d7c76c34c0383f94c43b` reports
`AssertionError: synapse cancellation requires the Prepared checkpoint` at
21:56:26 utc. `llm_execution.py:331` first aborts admission after the job claim
is lost; `synapse.py:306` then requires a Prepared checkpoint while publishing
the cancellation. the child failure is surfaced as a worker job failure at
21:56:27. no oom/restart occurred; this is a distinct state-transition defect.

private receipt: `/tmp/nexus-release-255/background-ecbe838e-manual.log`.

## follow-up and acceptance

inspect the retained job/admission state and claim-loss path. make cancellation
respect the actual durable admission boundary without inventing a Prepared
record or erasing evidence. add a cheap deterministic case for this interleaving
and verify the owning job reaches its correct terminal state. no automatic
reset or replay is authorized by this ticket.
