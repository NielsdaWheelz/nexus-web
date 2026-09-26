# latest model end-to-end qualification incomplete

status: open · origin: 2026-09-25 latest-model cutover · area: generation release proof

## problem and evidence

the final provider commit passed 61 of 65 api configuration cells; xai's four
cells are owner-waived without a credential. five live three-turn continuation
journeys passed. pinned 0.157.1 passed all 15 gpt-6 model/effort cells through
the provider runtime with usage and exact requested text; ultra was rejected
before dispatch. the nonsecret per-cell receipt is
`/tmp/codex15_receipt_9350.jsonl` (sha256
`12ea945866dc67dc8cd40b5556e0605fc4d9436acc309df93960cb463773dc1a`). pinned 0.157.1
completed authenticated, model-originated https mcp calls in both text and
strict-json modes, with missing/wrong bearer rejected. empty native execution
environments and delegation disablement were verified in those turns. the
15 codex browser/bff/api/db/worker journeys, linux
isolation/resource fit, actual credential refresh, forbidden native-tool
attempts, and full reopened-work proof have not passed. `./scripts/test` is
static only and cannot qualify these journeys.

## prerequisite and acceptance

run the 15 codex configurations and browser-to-worker journeys end to end
through the pinned nexus stack. prove frozen mcp auth,
forbidden native/delegation attempts, cancellation/process death, linux
isolation/resource fit, and replay without duplicate paid calls or effects.
keep temporary live proofs until their required cases pass; report waived xai
cells separately from passes.
