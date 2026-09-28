# restored chat codex dispatch fails

status: open; successor staged, production outcome unverified · origin: 2026-09-15 ecbe manual check; reviewed 2026-09-27 · area: generation

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

the successor at remote main `fbd08ba68` replaces frozen mcp with the approved
codex shell and private generation api. an isolated pre-merge cohort completed
browser chat and model-originated create/read/undo; see
`docs/codex-shell-cutover-verification.md`. the final merged tree is not
live-qualified and production still pointed to
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` in the 2026-09-27 read-only
check. these successor results do not identify the original `invalid_request`
or settle its uncertain run.

## follow-up and acceptance

preserve the original uncertain dispatch evidence; do not reset it or blindly
resend a draft. preflight its disposition under the approved old-history reset.
close only after the final integrated shell release serves a production
tool-using chat and same-run reopen without duplicate effects, and affected
background generation has its own passing proof. the original failure cause
may remain unknown; do not claim it was specifically repaired.
