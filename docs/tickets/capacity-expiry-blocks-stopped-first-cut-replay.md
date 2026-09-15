# capacity expiry blocks stopped first-cut replay

status: open · origin: 2026-09-15, restoration forward-recovery review · area: release qualification

## evidence

in `deploy/hetzner/release.py:_apply_once`, an ordinary first-cut attempt with
no forward-fix pointer still requires fresh capacity evidence before resuming
`WritersStopped`, `BackupVerified`, or `DataMutationStarted`. if paused for more
than 72 hours, its proof expires. standalone qualification cannot refresh it:
`_converge_resource_limits` expects all incumbent writers running when no
forward-fix pointer exists, but those phases deliberately stopped them.

this source-proven limitation predates the current forward fix. automatic
refresh now covers activated attempts; it does not cover these earlier ordinary
phases. the current 066 recovery has a forward-fix pointer and is unaffected.

## next action and acceptance

after the current restoration, define expiry recovery at the committed phase
boundary. keep the original first-cut prequalification, exact candidate binding,
fresh proof before promotion, and database-safe stopped-writer contract. never
restart an unqualified predecessor after `DataMutationStarted` or treat expiry
as a measured permanent failure.

prove the supported recovery for each stopped phase and preserve the immutable
failed-evidence rule. use cheap pure timing/phase regressions through
`./scripts/test`; keep real host recovery outside the automated portfolio.
