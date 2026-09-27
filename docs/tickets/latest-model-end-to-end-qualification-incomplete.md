# latest model end-to-end qualification incomplete

status: open · origin: 2026-09-25 latest-model cutover · area: generation release proof

## problem and evidence

the implemented cohort is nexus api/worker/host `d6b06991c`, repaired web
`a50401623`, llm-calling `6a7093f7`, llm-tools `d305da8f`, kernel
`937434b0`, and codex cli 0.157.1. the isolated stacks have not been deployed.
the nonsecret current evidence and exact
limits are in [the verification receipt](../codex-shell-cutover-verification.md).
`./scripts/test` is static only.

all 15 codex browser/native model-effort cells passed on `d6b06991c` before
the repaired web. a background note dossier completed strict json on older
`c792536af`, but did not execute its requested write; no other background
role is live-qualified. model-originated shell create/read, outside-chat read,
replay/undo and successful `web.search` were proved on `d6b06991c`. the
repaired web passed six draft reload/collision journeys. all 41
openai/gemini/deepseek browser cells passed on web `a50401623` and backend
`d6b06991c`, with an independent native/ledger read. a final provider
function-tool continuation passed with two completed native turns. prior
interrupted/mixed-source receipts do not count.
one `gpt-6-sol/medium` codex turn passed on the repaired web with an
independent native/ledger read.

anthropic's 20 nexus cells are blocked because the owner explicitly declined
the required standard-retention acknowledgement. the four xai cells lack a key
and carry an explicit owner waiver, not a pass. actual codex auth refresh is
unproved. the older `a80087ffb` worker-crash replay receipt proves its own
source only. source comparison found the kernel generation/decision files
unchanged from its pins; nexus's provider no-tool journal and chat publication
path unchanged except generation-api closure, a no-op without a codex bearer;
llm-calling changed strict-json tool-bearing decoding and codex execution.
this supports a narrow replay inference, not an exact-final crash proof.
remaining shell lifecycle denials, all twelve background roles and
background effect/list/undo are tracked separately.

## prerequisite and acceptance

complete the remaining shell-plan denials and background roles,
and observe actual auth refresh using an independent disposable credential.
run anthropic's 20 cells only after the owner changes the retention decision.
keep xai marked waived. retain temporary proofs until the complete acceptance
contract is met; never relabel blocked or historical evidence as a final pass.
