# sign-out refusal can be buried by unrelated workspace conditions

lab8 simultaneous sign-out reaches the refusal without a session post, but the
other-tab instruction is absent. each page leads with a workspace/storage warning
and a collapsed extra-item button. `AccountMenu.tsx` reports via a rank-3 workspace
offer; higher-priority conditions keep that required instruction unmounted.

the sign-out owner now presents one refused state in its existing account dialog,
replacing the workspace offer. close/cancel returns idle without repeating journal
restoration; retry captures a fresh runtime token. existing restoration, purge
ordering and phase-specific failure messages are unchanged.

awaiting verification: prove other-tab and simultaneous refusal, private-memory
preservation, retry and all sign-out branches. no checks or runtime verification
have run for this fix. evidence: lab8 `writing-recovery-simultane-183e2--other-tab-s-private-memory/`
under `artifacts/playwright-targets`, failure at the first refusal assertion.
