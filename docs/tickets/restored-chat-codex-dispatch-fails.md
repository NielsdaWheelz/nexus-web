# restored chat codex dispatch fails

status: open; deferred by user · origin: 2026-09-15 ecbe manual check · area: generation

## evidence

user reports chat does not work on deployed
`ecbe838ede7a3e85ee83d7c76c34c0383f94c43b` and explicitly accepts follow-up
after deployment. interactive logs at21:50:34 show
`GenerationContractDefect: invalid_request is a host defect`, raised by
`codex_generation_contract.normalized_failure` (line519), then
`GenerationUncertain` after durable dispatch. the subsequent21:51:05 attempt
refuses the unresolved codex dispatch. metadata generation reaches the same
contract failure at21:56:51. no new-service oom/restart accompanied these errors.

private receipt: `/tmp/nexus-release-255/interactive-ecbe838e-manual.log`.
owned release mcp proof only establishes network/auth rejection; earlier
three-turn generation qualification did not exercise tools. neither proves
this product path. no successful tool use or leave/reopen recovery is claimed.

## follow-up and acceptance

inspect the retained host terminal and original generation request to identify
the invalid request at its owner. preserve unresolved dispatch evidence; do
not reset state or blindly resend a draft. repair the contract or request and
use the owned reconciliation path for affected work. close after one new
tool-using chat completes and leaving/reopening preserves the outcome without
a duplicate send; separately verify affected metadata generation.
