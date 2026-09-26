# latest-model web search live proof unqualified

status: open · origin: 2026-09-26 latest-model qualification · area: codex model tools

## problem and evidence

the isolated final-stack `web.search` run `7e4f8d86-096f-4883-9014-984d9dfb87dd`
reached Brave, which rejected the task-configured subscription token with HTTP
422 / `SUBSCRIPTION_TOKEN_INVALID`. a separate bounded direct request with the
same task credential and documented parameters returned the same safe code.
the key value and response body were not retained. the run's billed-once tool
position remains `Uncertain`; do not replay or settle it by inference.

## prerequisite and acceptance

provide a valid protected Brave Search credential for a fresh isolated run.
prove a model-originated `web.search` call, successful worker result and durable
tool position/projection, and an answer using a specific returned fact. preserve
the prior uncertain position as evidence until explicit repair or disposable
test-database teardown.
