# vercel main candidate build rate limited

status: open · origin: 2026-10-04, cleanup/linear-02 (#524) · area: release / vercel candidate

main merge `031c3c95de81f25306b4e17fd656d9eeaf72218c` has no successful exact-commit vercel candidate:
its context is `failure`, with `Deployment rate limited — retry in 24 hours.`.
the reviewed pr head `6456797e58c8a0ec5d926cd8eecf3dd225a5617a` passed all
four checks, including its preview. that preview is a different commit.

observed `2026-10-05T02:50:30.923272+00:00`; context updated `2026-10-05T02:44:36Z`.
[vercel status target](https://vercel.com/niels-erik-nandals-projects?upgradeToPro=build-rate-limit). exact-head receipts:
`/tmp/nexus-linear-02-20261004/hosted-premerge-receipt.json` and
`/tmp/nexus-linear-02-20261004/merged-head-status-observation.json`.
[backend candidate job](https://github.com/NielsdaWheelz/nexus-web/actions/runs/37256581384/job/111594855868) is `completed`,
conclusion `success` at this observation. production serving and
promotion were not inspected or attempted.

prerequisite: the platform admits the normal exact-target build after its quota
clears. publish the selected main commit through the existing candidate flow;
record its own status and artifact. paired production release remains a separate
[release owner](production-release-pending-since-7dc68929b.md).

resolved when vercel reports success with an artifact for the selected exact
main commit. a passing pr preview or backend candidate alone does not qualify it.
