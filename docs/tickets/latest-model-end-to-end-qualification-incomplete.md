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
15 codex browser/bff/api/db/worker journeys, complete linux isolation and
busy-time resource fit,
actual credential refresh, forbidden native-tool
attempts, and full reopened-work proof have not passed. `./scripts/test` is
static only and cannot qualify these journeys.

an isolated ubuntu/aarch64 vm ran the exact committed nexus host source
`00ba59483daeee1ababcc6272a1caad6a92d909b` under the named production apparmor,
read-only, private-egress and 448 mib/no-extra-swap limits. authenticated uds
catalog exposed the exact three gpt-6 models and five efforts each. one
policy-owned `media_summary` gpt-6-luna/low strict-json turn passed admission,
generation and terminal, then `docker stop --time 45` exited 0 with no socket
or native process. receipt: `/tmp/nexus-codex-qual-00ba5948-receipt.md`
(sha256 `ac68ae612c20aa72a053ab01ee0a38e69619f59d502c856ee14ff5ef60ce7a9e`).
this proves configured confinement at host startup, one paid uds turn and
graceful teardown; the limits were enforced but busy-time use was not sampled.
the receipt does not cover all denied-target network checks, the browser path,
worker mcp, refresh or replay.

## prerequisite and acceptance

run the 15 codex configurations and browser-to-worker journeys end to end
through the pinned nexus stack. prove frozen mcp auth,
forbidden native/delegation attempts, cancellation/process death, complete
linux isolation and busy-time resource fit, and replay without duplicate paid
calls or effects.
keep temporary live proofs until their required cases pass; report waived xai
cells separately from passes.
