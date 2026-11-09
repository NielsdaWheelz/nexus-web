# production fluid-memory allowance recovery

on 2026-11-09 the hobby team `niels-erik-nandals-projects` was soft-blocked for
fluid-memory overage. five projects share its allowance; nexus and skidbladnir
returned `402 DEPLOYMENT_DISABLED`.

evidence: the team api reported `FAIR_USE_LIMITS_EXCEEDED`,
`blockedDueToOverageType=fluidDuration`, `blockedAt=1794250935137`; the owner
received a 300% alert against 360 gb-hours. legacy request reports attributed
high-usage days to nexus, but do not expose the deduplicated fluid billing meter.
paid observability queries were unavailable. exact route-level billed shares
remain unmeasured.

the deployed source held node proxy requests open for passive writing, media and
suggestion streams. the finite-observation change removes those lifetimes and
qualifies a bounded foreground profile locally. local qualification does not
unblock the provider or establish production billing.

hosting, billing changes and quota recovery remain outside this change. follow
[the paired release procedure](release-finite-observation.md) after service is
available. resolve when the team is unblocked, ordinary deployed web/native
journeys work, and measured usage for the declared profile fits its allowance.
